/**
 * BeamDesk signaling server.
 *
 * Responsibilities (and nothing more - screen content never touches this server):
 *  - verify that each device owns the ID it registers (Ed25519 signature over a challenge),
 *  - relay connection setup messages between two online devices,
 *  - answer presence queries for the address book,
 *  - hand out STUN/TURN configuration (with short-lived TURN credentials),
 *  - serve the web app.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { deviceIdFromPublicKey, registrationMessage, verifySignature } from '@beamdesk/core/identity';
import { APP_VERSION, LIMITS, type ServerToClient, type SignalKind } from '@beamdesk/core/protocol';
import { fromBase64Url } from '@beamdesk/core/util';
import type { Config } from './config.ts';
import { DeviceRegistry } from './registry.ts';
import { hasTurn, iceServersFor, type SelfIce } from './ice.ts';
import { securityHeaders, StaticSite } from './static.ts';

const SIGNAL_KINDS = new Set<SignalKind>(['offer', 'answer', 'ice', 'auth', 'pending', 'auth-result', 'bye', 'invite']);
/** Deeper JSON than this is never legitimate and can blow the stack in Number()/String()/stringify. */
const MAX_JSON_DEPTH = 16;
/** Outgoing bytes queued for one client before we stop sending to it (slow or malicious reader). */
const MAX_BUFFERED = 1024 * 1024;
const SIGNAL_RE = /^[A-Za-z0-9_-]{1,64}$/;

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private readonly rate: number;
  private readonly burst: number;

  constructor(rate: number, burst: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

interface Client {
  ws: WebSocket;
  /** Rate-limit key: IPv4 address or IPv6 /64 network. */
  ip: string;
  challenge: string;
  id: string | null;
  name: string;
  alive: boolean;
  /** Set once the connection is being torn down; further messages are ignored. */
  closing: boolean;
  registerAttempted: boolean;
  messages: TokenBucket;
  bytes: TokenBucket;
  /** Connection requests, invites and "is this ID online?" probes are rate limited separately. */
  requests: TokenBucket;
  presence: TokenBucket;
  registerTimer: ReturnType<typeof setTimeout> | null;
  /** Built-in relay as this client reaches it (host mode only). */
  selfIce: SelfIce | null;
}

/** Returns false if the JSON text nests deeper than `max` (strings are skipped). */
export function jsonDepthOk(text: string, max = MAX_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \\ */) i++;
      else if (c === 34 /* " */) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123 /* [ { */) {
      if (++depth > max) return false;
    } else if (c === 93 || c === 125) depth--;
  }
  return true;
}

/** Groups IPv6 clients by /64 (one customer network) and unwraps IPv4-mapped addresses. */
export function rateLimitKey(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head] = ip.split('%');
  const parts = head.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${full.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export interface ServerOptions {
  /** Serve HTTPS/WSS with this certificate (TLS 1.3 only). */
  tls?: { key: string; cert: string };
  /**
   * The server's own STUN/TURN relay (host mode). `endpointFor` gets the host name the client used
   * to reach this server (from its Host header, null if unusable) and returns the relay address
   * that client should use.
   */
  selfIce?: { secret: string; endpointFor(requestHost: string | null): { host: string; port: number } };
  /** Upper bound on open TCP connections. */
  maxConnections?: number;
  /**
   * Limits on raw TCP connections per client address, checked before any TLS work (host mode,
   * where clients connect directly; never behind a reverse proxy).
   */
  perIpConnections?: { concurrent: number; perSecond: number; burst: number };
}

/** A client connection that does not arrive over TCP (host mode's beacon tunnel). */
export interface VirtualConnection {
  send(frame: string): void;
  close(): void;
  onframe: ((frame: string) => void) | null;
  onclose: (() => void) | null;
}

export interface BeamServer {
  http: http.Server;
  listen(): Promise<number>;
  close(): Promise<void>;
  stats(): { clients: number; registered: number; devices: number };
  /**
   * Serves a tunneled client like a WebSocket one. `key` takes the place of its IP address for
   * rate limits; `selfIce` is the built-in relay as that client can reach it (null: none).
   */
  attach(conn: VirtualConnection, opts: { key: string; selfIce: SelfIce | null }): void;
}

/** Just enough of a `ws` WebSocket for onConnection(), backed by a VirtualConnection. */
class VirtualSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly bufferedAmount = 0;
  private readonly conn: VirtualConnection;

  constructor(conn: VirtualConnection) {
    super();
    this.conn = conn;
    conn.onframe = (f) => {
      if (this.readyState !== WebSocket.OPEN) return;
      // Same limit as for WebSocket messages.
      if (f.length > LIMITS.wsMessageBytes) return this.terminate();
      this.emit('message', Buffer.from(f), false);
    };
    conn.onclose = () => this.ended();
  }

  send(data: string): void {
    if (this.readyState === WebSocket.OPEN) this.conn.send(data);
  }

  /** The tunnel has its own keepalive; answer pings at once. */
  ping(): void {
    queueMicrotask(() => this.emit('pong'));
  }

  close(): void {
    this.terminate();
  }

  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.conn.close();
    this.ended();
  }

  private ended(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }
}

/** The host part of a Host header if it is a plain IP address or DNS name, else null. */
export function requestHost(header: string | undefined): string | null {
  if (!header || header.length > 300) return null;
  const m = /^(?:\[([0-9a-f:.]+)\]|([^:]+))(?::\d{1,5})?$/i.exec(header.trim());
  const host = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
  if (net.isIP(host)) return host;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) ? host : null;
}

export function createBeamServer(config: Config, options: ServerOptions = {}): BeamServer {
  const site = new StaticSite(config.webRoot);
  const registry = new DeviceRegistry(config.dataDir);
  const online = new Map<string, Client>();
  const perIp = new Map<string, number>();
  /** New IDs per network: stops one network from squatting IDs or bloating the registry. */
  const newIdsPerIp = new Map<string, { bucket: TokenBucket; seen: number }>();
  /** New WebSocket connections per network (each one costs a signature verification). */
  const connectionsPerIp = new Map<string, { bucket: TokenBucket; seen: number }>();
  const newIdsGlobal = new TokenBucket(config.newDevicesGlobalPerHour / 3600, Math.max(1, config.newDevicesGlobalPerHour / 4));
  const bucketFor = (map: Map<string, { bucket: TokenBucket; seen: number }>, key: string, rate: number, burst: number) => {
    let e = map.get(key);
    if (!e) {
      e = { bucket: new TokenBucket(rate, burst), seen: 0 };
      map.set(key, e);
    }
    e.seen = Date.now();
    return e.bucket;
  };
  const turn = hasTurn(config) || !!options.selfIce;
  const serverInfo = { name: config.serverName, version: APP_VERSION, requiresKey: !!config.accessKey, turn };

  // Timeouts must be constructor options: assigned later as properties, Node ignores them,
  // which leaves the server open to slowloris (half-sent headers held forever).
  const httpOptions = { headersTimeout: 15_000, requestTimeout: 30_000, connectionsCheckingInterval: 5_000, keepAliveTimeout: 5_000 };
  const handler: http.RequestListener = (req, res) => {
    const url = req.url ?? '/';
    const headers = securityHeaders(isSecure(req, config.trustProxy));
    // Public, read-only facts: the desktop app (origin app://beamdesk) reads them too.
    const open = { ...headers, 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (url === '/healthz' || url === '/api/health') {
      // Private servers do not tell strangers how many devices use them.
      return json(res, open, 200, { ok: true, version: APP_VERSION, online: config.accessKey ? undefined : online.size });
    }
    if (url === '/api/info') {
      return json(res, open, 200, { ...serverInfo, downloadUrl: config.downloadUrl });
    }
    if (site.handle(req, res, headers)) return;
    if (url === '/' && !site.enabled) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`${config.serverName} signaling server ${APP_VERSION} is running.\nBuild the web app (npm run build:web) to serve it here.\n`);
    }
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  };
  const server: http.Server = options.tls
    ? https.createServer(
        {
          ...httpOptions,
          key: options.tls.key,
          cert: options.tls.cert,
          minVersion: 'TLSv1.3',
          // A TLS handshake that has not finished in 10 s is not a real client.
          handshakeTimeout: 10_000,
          ALPNProtocols: ['http/1.1'],
        },
        handler,
      )
    : http.createServer(httpOptions, handler);
  if (options.maxConnections) server.maxConnections = options.maxConnections;
  const tcpLimits = options.perIpConnections;
  if (tcpLimits) {
    const open = new Map<string, number>();
    const rate = new Map<string, { bucket: TokenBucket; seen: number }>();
    server.on('connection', (socket: net.Socket) => {
      const ip = rateLimitKey(socket.remoteAddress ?? 'unknown');
      const n = open.get(ip) ?? 0;
      if (n >= tcpLimits.concurrent || !bucketFor(rate, ip, tcpLimits.perSecond, tcpLimits.burst).take()) {
        socket.destroy();
        return;
      }
      open.set(ip, n + 1);
      socket.once('close', () => {
        const left = (open.get(ip) ?? 1) - 1;
        if (left <= 0) open.delete(ip);
        else open.set(ip, left);
      });
    });
    const sweep = setInterval(() => {
      for (const [ip, e] of rate) if (Date.now() - e.seen > 600_000) rate.delete(ip);
    }, 60_000);
    sweep.unref();
    server.once('close', () => clearInterval(sweep));
  }
  if (options.tls) {
    // Failed handshakes (scanners, old clients) are normal on an open port: just drop them.
    server.on('tlsClientError', (_err, socket) => socket.destroy());
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsMessageBytes, perMessageDeflate: false });
  const virtual = new Set<VirtualSocket>();
  let closed = false;

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = rateLimitKey(clientIp(req, config.trustProxy));
    if (
      (perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp ||
      wss.clients.size + virtual.size >= config.maxClients ||
      !bucketFor(connectionsPerIp, ip, 0.5, 60).take()
    ) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const self = options.selfIce;
    const selfIce = self ? { ...self.endpointFor(requestHost(req.headers.host)), secret: self.secret } : null;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, selfIce));
  });

  function onConnection(ws: WebSocket, ip: string, selfIce: SelfIce | null): void {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    const client: Client = {
      ws,
      ip,
      challenge: crypto.randomBytes(32).toString('base64url'),
      id: null,
      name: '',
      alive: true,
      closing: false,
      registerAttempted: false,
      messages: new TokenBucket(40, 200),
      bytes: new TokenBucket(256 * 1024, 1024 * 1024),
      requests: new TokenBucket(0.5, 15),
      presence: new TokenBucket(0.2, 5),
      registerTimer: null,
      selfIce,
    };
    client.registerTimer = setTimeout(() => {
      if (!client.id) shutdown(client, 4001, 'register timeout');
    }, 10_000);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => {
      if (client.closing) return;
      try {
        onMessage(client, data, isBinary);
      } catch (err) {
        // Never let one bad message take the whole server down.
        console.error('[server] message handling failed:', (err as Error).message);
        fail(client, 'bad-request', 'invalid message', true);
      }
    });
    ws.on('close', () => {
      if (client.registerTimer) clearTimeout(client.registerTimer);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
      if (client.id && online.get(client.id) === client) online.delete(client.id);
    });
    ws.on('error', () => ws.terminate());
    send(client, { t: 'hello', challenge: client.challenge, server: serverInfo });
  }

  function onMessage(client: Client, data: RawData, isBinary: boolean): unknown {
    if (isBinary) return fail(client, 'bad-request', 'binary frames are not supported');
    const text = data.toString();
    if (!client.messages.take() || !client.bytes.take(text.length)) return fail(client, 'rate-limited', 'slow down');
    if (!jsonDepthOk(text)) return fail(client, 'bad-request', 'message nested too deeply', true);
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return fail(client, 'bad-request', 'invalid JSON');
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return fail(client, 'bad-request', 'invalid message');

    if (m.t === 'register') return onRegister(client, m);
    if (m.t === 'ping') return send(client, { t: 'pong' });
    if (!client.id) return fail(client, 'not-registered', 'register first');

    const rid = Number.isSafeInteger(m.rid) ? m.rid : 0;
    switch (m.t) {
      case 'signal':
        if (text.length > LIMITS.signalBytes + 1024) return fail(client, 'too-large', 'signal too large');
        return onSignal(client, m);
      case 'presence': {
        // Address-book refresh only: throttled so the ID space cannot be scanned quickly.
        if (!client.presence.take()) return send(client, { t: 'presence', rid, online: {} });
        const ids: unknown[] = Array.isArray(m.ids) ? m.ids.slice(0, 100) : [];
        const result: Record<string, boolean> = {};
        for (const id of ids) if (typeof id === 'string' && /^\d{9}$/.test(id)) result[id] = online.has(id);
        return send(client, { t: 'presence', rid, online: result });
      }
      case 'ice':
        return send(client, { t: 'ice', rid, ice: iceServersFor(config, client.id, client.selfIce) as RTCIceServer[] });
      default:
        return fail(client, 'bad-request', 'unknown message type');
    }
  }

  function onRegister(client: Client, m: any): void {
    if (client.id || client.registerAttempted) return fail(client, 'bad-request', 'already registered', true);
    client.registerAttempted = true; // one signature verification per connection
    const key = typeof m.key === 'string' ? m.key.slice(0, 256) : '';
    if (config.accessKey && !safeEqual(key, config.accessKey)) {
      return fail(client, 'access-key', 'This server requires a valid access key (Settings → Network).', true);
    }
    if (typeof m.pk !== 'string' || typeof m.sig !== 'string') return fail(client, 'bad-request', 'missing key', true);
    let id: string;
    try {
      id = deviceIdFromPublicKey(fromBase64Url(m.pk));
    } catch {
      return fail(client, 'bad-request', 'invalid key', true);
    }
    if (!verifySignature(m.pk, registrationMessage(client.challenge), m.sig)) {
      return fail(client, 'bad-signature', 'signature check failed', true);
    }
    if (!registry.has(id)) {
      if (registry.size >= config.maxDevices) return fail(client, 'server-full', 'This server cannot register more devices.', true);
      const perNetwork = config.newDevicesPerHour > 0 ? bucketFor(newIdsPerIp, client.ip, config.newDevicesPerHour / 3600, config.newDevicesPerHour * 2) : null;
      if ((perNetwork && !perNetwork.take()) || (config.newDevicesGlobalPerHour > 0 && !newIdsGlobal.take())) {
        return fail(client, 'rate-limited', 'Too many new devices right now. Try again later.', true);
      }
    }
    if (!registry.claim(id, m.pk)) {
      return fail(client, 'id-conflict', 'This ID belongs to another device.', true);
    }
    const previous = online.get(id);
    if (previous && previous !== client) {
      send(previous, { t: 'replaced' });
      previous.id = null;
      shutdown(previous, 4002, 'replaced');
    }
    if (client.registerTimer) clearTimeout(client.registerTimer);
    client.id = id;
    client.name = typeof m.name === 'string' ? m.name.slice(0, LIMITS.nameChars) : '';
    online.set(id, client);
    send(client, { t: 'registered', id, ice: iceServersFor(config, id, client.selfIce) as RTCIceServer[] });
  }

  function onSignal(client: Client, m: any): unknown {
    const { to, sid, kind } = m;
    if (typeof to !== 'string' || !/^\d{9}$/.test(to)) return fail(client, 'bad-request', 'invalid target');
    if (typeof sid !== 'string' || !SIGNAL_RE.test(sid) || !SIGNAL_KINDS.has(kind)) return fail(client, 'bad-request', 'invalid signal');
    if (to === client.id) return fail(client, 'bad-request', 'cannot signal yourself');
    const expensive = (kind === 'offer' && !m.data?.restart) || kind === 'invite';
    if (expensive && !client.requests.take()) {
      return send(client, { t: 'undeliverable', to, sid, reason: 'rate-limited' });
    }
    const target = online.get(to);
    if (!target) {
      // "Offline" answers reveal presence: they cost a request token so IDs cannot be scanned this way.
      if (expensive || client.requests.take()) send(client, { t: 'undeliverable', to, sid, reason: 'offline' });
      return;
    }
    if (!send(target, { t: 'signal', from: client.id!, sid, kind, data: m.data })) {
      send(client, { t: 'undeliverable', to, sid, reason: 'rate-limited' });
    }
  }

  /** Returns false if the message was dropped because the receiver is not reading fast enough. */
  function send(client: Client, msg: ServerToClient): boolean {
    if (client.ws.readyState !== WebSocket.OPEN) return false;
    if (client.ws.bufferedAmount > MAX_BUFFERED) {
      if (client.ws.bufferedAmount > 4 * MAX_BUFFERED) shutdown(client, 4004, 'too slow');
      return false;
    }
    client.ws.send(JSON.stringify(msg));
    return true;
  }

  function shutdown(client: Client, code: number, reason: string): void {
    if (client.closing) return;
    client.closing = true;
    client.ws.close(code, reason);
    // ws keeps the socket in CLOSING until the peer answers; do not let it linger.
    setTimeout(() => client.ws.terminate(), 1000).unref();
  }

  function fail(client: Client, code: Extract<ServerToClient, { t: 'error' }>['code'], message: string, fatal = false): void {
    send(client, { t: 'error', code, message, fatal });
    if (fatal) shutdown(client, 4003, code);
  }

  // Drop connections that stopped answering pings (sleeping laptops, dead NAT mappings).
  let lastPrune = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (now - lastPrune > 3600_000) {
      lastPrune = now;
      registry.prune();
    }
    for (const [ip, e] of newIdsPerIp) if (now - e.seen > 3 * 3600_000) newIdsPerIp.delete(ip);
    for (const [ip, e] of connectionsPerIp) if (now - e.seen > 600_000) connectionsPerIp.delete(ip);
    for (const c of online.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    http: server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject); // e.g. EADDRINUSE: the port is taken
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : config.port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        closed = true;
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        for (const ws of virtual) ws.terminate();
        wss.close();
        registry.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    stats: () => ({ clients: wss.clients.size + virtual.size, registered: online.size, devices: registry.size }),
    attach(conn, opts) {
      const ip = `virtual:${opts.key}`.slice(0, 80);
      if (closed || wss.clients.size + virtual.size >= config.maxClients || (perIp.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
        conn.close();
        return;
      }
      const ws = new VirtualSocket(conn);
      virtual.add(ws);
      ws.once('close', () => virtual.delete(ws));
      onConnection(ws as unknown as WebSocket, ip, opts.selfIce);
    },
  };
}

function json(res: http.ServerResponse, headers: Record<string, string>, status: number, body: unknown): void {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** True when the browser reached us over HTTPS (directly or through a trusted proxy). */
function isSecure(req: http.IncomingMessage, trustProxy: number): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (!trustProxy) return false;
  const proto = req.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() === 'https';
}

function clientIp(req: http.IncomingMessage, trustProxy: number): string {
  if (trustProxy > 0) {
    // Each trusted proxy appends the address it received the request from. Count `trustProxy`
    // entries from the right; anything further left came from the client and can be forged.
    const fwd = req.headers['x-forwarded-for'];
    const raw = Array.isArray(fwd) ? fwd.join(',') : fwd;
    const list = raw?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    const ip = list[list.length - trustProxy] ?? list[0];
    if (ip) return ip.slice(0, 64);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
