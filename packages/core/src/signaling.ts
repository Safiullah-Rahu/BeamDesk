/**
 * Connection to the BeamDesk signaling server.
 * Registers this device (proving ownership of its ID with a signature), relays
 * peer-to-peer signals and keeps itself alive across network changes.
 */
import { Identity, registrationMessage } from './identity.ts';
import { APP_VERSION, LIMITS, type Platform, type ServerInfo, type ServerToClient, type SignalKind } from './protocol.ts';
import { Emitter } from './util.ts';

export type SignalingState = 'offline' | 'connecting' | 'online' | 'replaced' | 'error';

export interface IncomingSignal {
  from: string;
  sid: string;
  kind: SignalKind;
  data: any;
}

export interface SignalingOptions {
  /** One server address, or several ways to reach the same server (tried at once, first answer wins). */
  url: string | string[];
  identity: Identity;
  name: string;
  platform: Platform;
  accessKey?: string;
  /** Opens the socket (default: the global WebSocket). Node tests use it for pinned TLS. */
  createWebSocket?: (url: string) => WebSocket;
}

type Events = {
  state: SignalingState;
  signal: IncomingSignal;
  undeliverable: { to: string; sid: string; reason: string };
  error: { code: string; message: string };
};

const FATAL = new Set(['id-conflict', 'access-key', 'bad-signature', 'server-full']);

export class SignalingClient extends Emitter<Events> {
  state: SignalingState = 'offline';
  ice: RTCIceServer[] = [];
  server: ServerInfo | null = null;
  lastError: { code: string; message: string } | null = null;

  private ws: WebSocket | null = null;
  /** Sockets still racing to be the connection (several addresses for one server). */
  private candidates: WebSocket[] = [];
  private activeUrl = '';
  private opts: SignalingOptions;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private rid = 0;
  private pending = new Map<number, (msg: any) => void>();
  private cleanupGlobal: (() => void) | null = null;

  constructor(opts: SignalingOptions) {
    super();
    this.opts = { ...opts };
  }

  get id(): string {
    return this.opts.identity.id;
  }

  /** The address in use (the first one while not connected). */
  get url(): string {
    return this.activeUrl || this.urls[0] || '';
  }

  private get urls(): string[] {
    return (Array.isArray(this.opts.url) ? this.opts.url : [this.opts.url]).filter(Boolean);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.installGlobalListeners();
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.cleanupGlobal?.();
    this.cleanupGlobal = null;
    this.closeCandidates();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    }
    this.failPending();
    this.setState('offline');
  }

  /** Reconnect with new options (e.g. after the device name or server changed). */
  reconfigure(patch: Partial<SignalingOptions>): void {
    this.opts = { ...this.opts, ...patch };
    if (!this.stopped) {
      this.stop();
      this.start();
    }
  }

  /** Take over after another window/tab replaced this connection. */
  reclaim(): void {
    this.stop();
    this.start();
  }

  send(to: string, sid: string, kind: SignalKind, data: unknown): boolean {
    return this.raw({ t: 'signal', to, sid, kind, data });
  }

  presence(ids: string[]): Promise<Record<string, boolean>> {
    if (!ids.length) return Promise.resolve({});
    return this.request({ t: 'presence', ids: ids.slice(0, 100) }).then((m) => m.online ?? {}, () => ({}));
  }

  /** Fresh ICE servers (TURN credentials are short-lived). Falls back to the last known list. */
  async refreshIce(): Promise<RTCIceServer[]> {
    try {
      const m = await this.request({ t: 'ice' }, 4000);
      if (Array.isArray(m.ice)) this.ice = m.ice;
    } catch {
      /* use cached */
    }
    return this.ice;
  }

  /** Resolves once online (or rejects after `timeoutMs`). */
  waitOnline(timeoutMs = 10_000): Promise<void> {
    if (this.state === 'online') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(this.lastError?.message ?? 'Cannot reach the BeamDesk server'));
      }, timeoutMs);
      const off = this.on('state', (s) => {
        if (s === 'online') {
          clearTimeout(timer);
          off();
          resolve();
        } else if (s === 'error' || s === 'replaced') {
          clearTimeout(timer);
          off();
          reject(new Error(this.lastError?.message ?? 'Disconnected from the server'));
        }
      });
    });
  }

  private request(msg: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(rid, (m) => {
        clearTimeout(timer);
        if (m === null) reject(new Error('disconnected'));
        else resolve(m);
      });
      if (!this.raw({ ...msg, rid })) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(new Error('offline'));
      }
    });
  }

  private raw(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (msg.t !== 'register' && this.state !== 'online') return false;
    const text = JSON.stringify(msg);
    if (text.length > LIMITS.wsMessageBytes) return false;
    this.ws.send(text);
    return true;
  }

  private open(): void {
    this.clearTimers();
    this.closeCandidates();
    this.setState('connecting');
    const urls = this.urls;
    const sockets: WebSocket[] = [];
    let lastError = '';
    for (const url of urls) {
      try {
        sockets.push(this.connectTo(url, sockets));
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    if (!sockets.length) {
      this.lastError = { code: 'bad-url', message: `Invalid server address: ${lastError || 'none set'}` };
      this.setState('error');
      return;
    }
    this.candidates = sockets;
  }

  private connectTo(url: string, race: WebSocket[]): WebSocket {
    const ws = this.opts.createWebSocket ? this.opts.createWebSocket(url) : new WebSocket(url);
    ws.onmessage = (e) => {
      if (this.ws !== ws) {
        if (this.ws || this.candidates !== race) {
          ws.onclose = null;
          ws.close();
          return;
        }
        // The first address that answers becomes the connection; the others are dropped.
        this.ws = ws;
        this.activeUrl = url;
        this.candidates = [];
        for (const other of race) {
          if (other === ws) continue;
          other.onclose = null;
          other.onmessage = null;
          try {
            other.close();
          } catch {
            /* ignore */
          }
        }
      }
      this.onMessage(e.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.clearTimers();
        this.failPending();
        if (this.stopped || this.state === 'replaced' || this.state === 'error') return;
        this.setState('offline');
        this.scheduleReconnect();
        return;
      }
      if (this.candidates !== race) return;
      race.splice(race.indexOf(ws), 1);
      if (!race.length) {
        // No address answered.
        this.candidates = [];
        if (this.stopped) return;
        this.setState('offline');
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    return ws;
  }

  private closeCandidates(): void {
    const list = this.candidates;
    this.candidates = [];
    for (const ws of list) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = Math.min(15_000, 500 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let m: ServerToClient;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.t) {
      case 'hello': {
        this.server = m.server;
        const { identity, name, platform, accessKey } = this.opts;
        this.raw({
          t: 'register',
          pk: identity.publicKeyB64,
          sig: identity.sign(registrationMessage(m.challenge)),
          name,
          platform,
          version: APP_VERSION,
          key: accessKey || undefined,
        });
        break;
      }
      case 'registered':
        this.ice = Array.isArray(m.ice) ? m.ice : [];
        this.attempt = 0;
        this.lastError = null;
        this.lastPong = Date.now();
        this.setState('online');
        this.pingTimer = setInterval(() => this.heartbeat(), 20_000);
        break;
      case 'signal':
        if (m.from && m.sid && m.kind) this.emit('signal', { from: m.from, sid: m.sid, kind: m.kind, data: m.data });
        break;
      case 'undeliverable':
        this.emit('undeliverable', { to: m.to, sid: m.sid, reason: m.reason });
        break;
      case 'presence':
      case 'ice': {
        const cb = this.pending.get(m.rid);
        if (cb) {
          this.pending.delete(m.rid);
          cb(m);
        }
        break;
      }
      case 'pong':
        this.lastPong = Date.now();
        break;
      case 'replaced':
        this.setState('replaced');
        this.ws?.close();
        break;
      case 'error':
        this.lastError = { code: m.code, message: m.message };
        this.emit('error', this.lastError);
        if (m.fatal || FATAL.has(m.code)) {
          this.setState('error');
          this.ws?.close();
        }
        break;
    }
  }

  private heartbeat(): void {
    if (Date.now() - this.lastPong > 50_000) {
      // Silent dead connection (e.g. laptop woke up on another network): recycle it.
      this.ws?.close();
      return;
    }
    this.raw({ t: 'ping' });
  }

  private installGlobalListeners(): void {
    const g = globalThis as any;
    if (typeof g.addEventListener !== 'function') return;
    const kick = () => {
      if (this.stopped) return;
      if (this.state === 'offline' || this.state === 'connecting') {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.attempt = 0;
        if (!this.ws && !this.candidates.length) this.open();
      } else if (this.state === 'online') {
        this.heartbeat();
      }
    };
    const onVisible = () => {
      if (g.document?.visibilityState === 'visible') kick();
    };
    g.addEventListener('online', kick);
    g.document?.addEventListener?.('visibilitychange', onVisible);
    this.cleanupGlobal = () => {
      g.removeEventListener('online', kick);
      g.document?.removeEventListener?.('visibilitychange', onVisible);
    };
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  private failPending(): void {
    for (const cb of this.pending.values()) cb(null);
    this.pending.clear();
  }

  private setState(s: SignalingState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }
}
