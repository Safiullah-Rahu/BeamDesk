/**
 * BeamDesk beacon: reach a home server that cannot accept connections at all (carrier-grade
 * NAT, no port forwarding, a firewall) through public Nostr relays used as dumb mailboxes.
 *
 * The home server keeps outgoing connections to a few relays and listens on a "topic" that only
 * holders of its connection code can compute. A device that has the code opens an encrypted
 * tunnel to it through the relays and speaks the normal signaling protocol inside; the screen
 * session itself then goes directly between the devices (WebRTC), as always.
 *
 * Handshake (Noise NK with a pre-shared key, built from X25519, HKDF-SHA256 and AES-256-GCM):
 *   code:   S = server's static X25519 public key, K = 128-bit access key (the PSK)
 *   client: e  (fresh)                  es = DH(e, S)          k1 = HKDF(es, K, "init" ‖ …)
 *           → INIT  [e, time, AEAD_k1()]                     the server learns: client knows K
 *   server: e' (fresh)                  ee = DH(e', e)         k2 = HKDF(es ‖ ee, K, "accept" ‖ …)
 *           ← ACCEPT [e', AEAD_k2(info)]                     the client learns: server holds S
 *   both:   transport keys = HKDF(es ‖ ee, K, "transport" ‖ …), one per direction, forward secret.
 *
 * Relays see random topics that change every day, random one-time Nostr keys, sizes and
 * timing, and the IP addresses that connect to them. They cannot read, change, replay or
 * inject messages: every frame is authenticated and numbered.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { nostrKeypair, RelayPool, signEvent, type NostrEvent, type SocketFactory } from './nostr.ts';
import { concatBytes, fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from './util.ts';
import type { HomeAddress } from './joincode.ts';

/** Ephemeral event kind (20000–29999: relays pass these on without storing them). */
export const BEACON_KIND = 25510;

/** Independent public relays; the beacon uses all of them at once, so any one may fail. */
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub'];

const LABEL = utf8('BeamDesk-beacon-v1');
const VERSION = 1;
const T_INIT = 1;
const T_ACCEPT = 2;
const T_DATA = 3;
const T_CLOSE = 4;
const HEADER = 14; // version, type, connection id (8), sequence (4)
const CHUNK = 16 * 1024; // plaintext per event: well inside what public relays accept
const MAX_FRAME = 256 * 1024;
const HANDSHAKE_SKEW_S = 120;
const REORDER_WAIT_MS = 8000;
const IDLE_MS = 75_000;

export interface BeaconInfo {
  name: string;
  /** Where the server can currently be reached directly (they change; the code may be old). */
  addresses: HomeAddress[];
}

// ------------------------------------------------------------------ crypto

const day = (ms = Date.now()) => Math.floor(ms / 86_400_000);

/** The day's meeting point: only someone with the code can compute it. */
export function beaconTopic(psk: Uint8Array, serverKey: Uint8Array, d = day()): string {
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, d);
  return bytesToHex(hmac(sha256, psk, concatBytes(LABEL, utf8('topic'), serverKey, n)));
}

export function beaconKeypair(): { secret: Uint8Array; public: Uint8Array } {
  const secret = x25519.utils.randomSecretKey();
  return { secret, public: x25519.getPublicKey(secret) };
}

export const beaconPublicKey = (secret: Uint8Array) => x25519.getPublicKey(secret);

function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array | null {
  try {
    const s = x25519.getSharedSecret(secret, pub);
    return s.some((b) => b !== 0) ? s : null;
  } catch {
    return null;
  }
}

function initKey(es: Uint8Array, psk: Uint8Array, serverKey: Uint8Array, e: Uint8Array, ts: Uint8Array): Uint8Array {
  return hkdf(sha256, es, psk, concatBytes(LABEL, utf8('init'), serverKey, e, ts), 32);
}

function sessionKeys(es: Uint8Array, ee: Uint8Array, psk: Uint8Array, serverKey: Uint8Array, e: Uint8Array, ts: Uint8Array, e2: Uint8Array) {
  const ikm = concatBytes(es, ee);
  const ctx = concatBytes(serverKey, e, ts, e2);
  const t = hkdf(sha256, ikm, psk, concatBytes(LABEL, utf8('transport'), ctx), 64);
  return {
    k2: hkdf(sha256, ikm, psk, concatBytes(LABEL, utf8('accept'), ctx), 32),
    toServer: t.slice(0, 32),
    toClient: t.slice(32, 64),
  };
}

const keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();
function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  let k = keyCache.get(raw);
  if (!k) {
    k = crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, k);
  }
  return k;
}

function nonce(dir: number, seq: number): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = dir;
  new DataView(n.buffer).setUint32(8, seq);
  return n;
}

async function seal(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }, await aesKey(key), data as BufferSource));
}

async function unseal(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }, await aesKey(key), data as BufferSource));
  } catch {
    return null;
  }
}

function header(type: number, cid: Uint8Array, seq: number): Uint8Array {
  const h = new Uint8Array(HEADER);
  h[0] = VERSION;
  h[1] = type;
  h.set(cid, 2);
  new DataView(h.buffer).setUint32(10, seq);
  return h;
}

interface Packet {
  type: number;
  cid: Uint8Array;
  cidHex: string;
  seq: number;
  head: Uint8Array;
  body: Uint8Array;
}

function parsePacket(content: string): Packet | null {
  if (content.length > 90_000) return null;
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(content);
  } catch {
    return null;
  }
  if (raw.length < HEADER || raw[0] !== VERSION) return null;
  const cid = raw.slice(2, 10);
  return { type: raw[1], cid, cidHex: bytesToHex(cid), seq: new DataView(raw.buffer, raw.byteOffset).getUint32(10), head: raw.subarray(0, HEADER), body: raw.subarray(HEADER) };
}

// ------------------------------------------------------------------ reliable, ordered stream

/**
 * Both ends: frames (strings) are length-prefixed into a byte stream, cut into numbered,
 * encrypted chunks, one Nostr event each. Chunks are put back in order; duplicates (every relay
 * delivers a copy) are dropped; a chunk missing for too long ends the connection.
 */
class Stream {
  private sendSeq = 0;
  private recvSeq = 0;
  private readonly pending = new Map<number, { close: boolean; data: Uint8Array }>();
  private outbox: Uint8Array[] = [];
  private inbuf: Uint8Array = new Uint8Array(0);
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly cid: Uint8Array;
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  /** 0: client to server, 1: server to client (part of every nonce). */
  private readonly dir: number;
  private readonly emit: (content: string) => void;
  private readonly onFrame: (f: string) => void;
  private readonly onEnd: () => void;
  closed = false;
  lastSeen = Date.now();

  constructor(o: { cid: Uint8Array; sendKey: Uint8Array; recvKey: Uint8Array; dir: number; emit: (c: string) => void; onFrame: (f: string) => void; onEnd: () => void }) {
    this.cid = o.cid;
    this.sendKey = o.sendKey;
    this.recvKey = o.recvKey;
    this.dir = o.dir;
    this.emit = o.emit;
    this.onFrame = o.onFrame;
    this.onEnd = o.onEnd;
  }

  write(frame: string): void {
    if (this.closed) return;
    const body = utf8(frame);
    if (body.length > MAX_FRAME) return;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, body.length);
    this.outbox.push(len, body);
    // A few milliseconds of batching turns a burst of signaling messages into one event.
    this.flushTimer ??= setTimeout(() => this.flush(), 30);
  }

  private flush(): void {
    this.flushTimer = null;
    if (!this.outbox.length) return;
    const data = concatBytes(...this.outbox.splice(0));
    for (let i = 0; i < data.length; i += CHUNK) this.sendChunk(T_DATA, data.subarray(i, i + CHUNK));
  }

  /** Chunks are encrypted one at a time, so sequence numbers leave in order. */
  private sendChunk(type: number, plain: Uint8Array): void {
    const seq = ++this.sendSeq;
    const head = header(type, this.cid, seq);
    this.chain = this.chain
      .then(async () => {
        const ct = await seal(this.sendKey, nonce(this.dir, seq), head, plain);
        this.emit(toBase64Url(concatBytes(head, ct)));
      })
      .catch(() => this.onEnd());
  }

  async receive(p: Packet): Promise<void> {
    if (this.closed || p.seq <= this.recvSeq || this.pending.has(p.seq) || this.pending.size >= 256) return;
    const plain = await unseal(this.recvKey, nonce(this.dir ^ 1, p.seq), p.head, p.body);
    if (!plain || this.closed || p.seq <= this.recvSeq || this.pending.has(p.seq)) return;
    this.lastSeen = Date.now();
    this.pending.set(p.seq, { close: p.type === T_CLOSE, data: plain });
    while (this.pending.has(this.recvSeq + 1)) {
      const item = this.pending.get(++this.recvSeq)!;
      this.pending.delete(this.recvSeq);
      if (item.close) return this.onEnd(); // the other side hung up
      this.consume(item.data);
      if (this.closed) return;
    }
    // Something in between is missing: give the other relays a moment to deliver it.
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = this.pending.size ? setTimeout(() => this.onEnd(), REORDER_WAIT_MS) : null;
  }

  private consume(chunk: Uint8Array): void {
    this.inbuf = concatBytes(this.inbuf, chunk);
    for (;;) {
      if (this.inbuf.length < 4) return;
      const len = new DataView(this.inbuf.buffer, this.inbuf.byteOffset).getUint32(0);
      if (len > MAX_FRAME) return this.onEnd();
      if (this.inbuf.length < 4 + len) return;
      const frame = fromUtf8(this.inbuf.subarray(4, 4 + len));
      this.inbuf = this.inbuf.slice(4 + len);
      this.onFrame(frame);
      if (this.closed) return;
    }
  }

  /** Stops the stream; with `notify`, the other side is told (after anything still queued). */
  close(notify: boolean): void {
    if (this.closed) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (notify) {
      this.flush();
      this.sendChunk(T_CLOSE, new Uint8Array(0));
    }
    this.closed = true;
    if (this.gapTimer) clearTimeout(this.gapTimer);
  }
}

// ------------------------------------------------------------------ server side

export interface BeaconConnection {
  readonly id: string;
  send(frame: string): void;
  close(): void;
  onframe: ((frame: string) => void) | null;
  onclose: (() => void) | null;
}

export interface BeaconStatus {
  /** Relays connected / configured. */
  relays: number;
  total: number;
  /** Devices currently connected through the beacon. */
  clients: number;
}

export interface BeaconServerOptions {
  /** The server's static X25519 secret key (its public key is in the connection code). */
  secret: Uint8Array;
  /** The access key from the code. */
  psk: Uint8Array;
  relays: string[];
  info: () => BeaconInfo;
  onConnection: (c: BeaconConnection) => void;
  onStatus?: (s: BeaconStatus) => void;
  createSocket?: SocketFactory;
  maxConnections?: number;
}

class ServerConn implements BeaconConnection {
  readonly id: string;
  /** The client's one-time Nostr key: only its events count for this connection. */
  readonly peer: string;
  readonly nostr = nostrKeypair();
  readonly accept: string;
  stream!: Stream;
  onframe: ((frame: string) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly server: BeaconServer;

  constructor(server: BeaconServer, id: string, peer: string, accept: string) {
    this.server = server;
    this.id = id;
    this.peer = peer;
    this.accept = accept;
  }

  send(frame: string): void {
    this.stream.write(frame);
  }

  close(): void {
    this.server.drop(this, true);
  }
}

/** The home server's side: listens on today's topic and accepts tunnels from code holders. */
export class BeaconServer {
  private readonly opts: BeaconServerOptions;
  private readonly pub: Uint8Array;
  private pool: RelayPool | null = null;
  private readonly conns = new Map<string, ServerConn>();
  private readonly seenInits = new Map<string, number>();
  private topics: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private attempts = { tokens: 20, last: Date.now() };

  constructor(opts: BeaconServerOptions) {
    this.opts = opts;
    this.pub = beaconPublicKey(opts.secret);
  }

  status(): BeaconStatus {
    return { relays: this.pool?.connected ?? 0, total: this.pool?.total ?? this.opts.relays.length, clients: this.conns.size };
  }

  start(): void {
    if (this.pool) return;
    this.pool = new RelayPool(this.opts.relays, { createSocket: this.opts.createSocket, onChange: () => this.opts.onStatus?.(this.status()) });
    this.listen();
    this.timer = setInterval(() => this.tick(), 15_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private listen(): void {
    const d = day();
    const topics = [d - 1, d, d + 1].map((x) => beaconTopic(this.opts.psk, this.pub, x));
    if (topics.join() === this.topics.join()) return;
    this.topics = topics;
    this.pool!.subscribe('beacon', { kinds: [BEACON_KIND], '#p': topics, since: Math.floor(Date.now() / 1000) - 60 }, (e) => void this.onEvent(e));
  }

  private tick(): void {
    this.listen(); // a new day, a new topic
    const now = Date.now();
    for (const [k, t] of this.seenInits) if (now - t > 2 * HANDSHAKE_SKEW_S * 1000) this.seenInits.delete(k);
    for (const c of [...this.conns.values()]) if (now - c.stream.lastSeen > IDLE_MS) this.drop(c, true);
  }

  private async onEvent(ev: NostrEvent): Promise<void> {
    const p = parsePacket(ev.content);
    if (!p) return;
    const conn = this.conns.get(p.cidHex);
    if (p.type === T_INIT) {
      // A repeated INIT means our ACCEPT got lost: send it again.
      if (conn) return conn.peer === ev.pubkey ? this.publish(conn, conn.accept) : undefined;
      return this.onInit(p, ev.pubkey);
    }
    if (conn && conn.peer === ev.pubkey && (p.type === T_DATA || p.type === T_CLOSE)) await conn.stream.receive(p);
  }

  /** Unauthenticated work is rate limited: whoever learned a topic cannot make us spin. */
  private allowAttempt(): boolean {
    const now = Date.now();
    this.attempts.tokens = Math.min(20, this.attempts.tokens + ((now - this.attempts.last) / 1000) * 5);
    this.attempts.last = now;
    if (this.attempts.tokens < 1) return false;
    this.attempts.tokens--;
    return true;
  }

  private async onInit(p: Packet, peer: string): Promise<void> {
    if (p.body.length < 32 + 8 + 16 || !this.allowAttempt()) return;
    const e = p.body.slice(0, 32);
    const ts = p.body.slice(32, 40);
    const sent = Number(new DataView(ts.buffer).getBigUint64(0));
    if (Math.abs(Date.now() / 1000 - sent) > HANDSHAKE_SKEW_S) return;
    const eHex = bytesToHex(e);
    if (this.seenInits.has(eHex)) return; // replayed
    const es = dh(this.opts.secret, e);
    if (!es) return;
    const ok = await unseal(initKey(es, this.opts.psk, this.pub, e, ts), new Uint8Array(12), concatBytes(p.head, e, ts), p.body.subarray(40));
    // Checked again after the await: copies of one INIT (several relays, retries) arrive together.
    if (!ok || this.conns.has(p.cidHex) || this.seenInits.has(eHex)) return;
    this.seenInits.set(eHex, Date.now());
    if (this.conns.size >= (this.opts.maxConnections ?? 32)) return;

    const e2 = beaconKeypair();
    const ee = dh(e2.secret, e)!;
    const keys = sessionKeys(es, ee, this.opts.psk, this.pub, e, ts, e2.public);
    const head = header(T_ACCEPT, p.cid, 0);
    const info = utf8(JSON.stringify({ v: 1, ...this.opts.info() }));
    const ct = await seal(keys.k2, new Uint8Array(12), concatBytes(head, e2.public), info);
    const conn = new ServerConn(this, p.cidHex, peer, toBase64Url(concatBytes(head, e2.public, ct)));
    conn.stream = new Stream({
      cid: p.cid,
      sendKey: keys.toClient,
      recvKey: keys.toServer,
      dir: 1,
      emit: (content) => this.publish(conn, content),
      onFrame: (f) => conn.onframe?.(f),
      onEnd: () => this.drop(conn, false),
    });
    this.conns.set(conn.id, conn);
    this.publish(conn, conn.accept);
    this.opts.onConnection(conn);
    this.opts.onStatus?.(this.status());
  }

  /** A fresh event every time: relays and receivers drop exact repeats. */
  private publish(conn: ServerConn, content: string): void {
    this.pool?.publish(signEvent(conn.nostr.secret, BEACON_KIND, [['p', conn.peer]], content));
  }

  drop(conn: ServerConn, notify: boolean): void {
    if (this.conns.get(conn.id) !== conn) return;
    this.conns.delete(conn.id);
    conn.stream.close(notify);
    conn.onclose?.();
    this.opts.onStatus?.(this.status());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.conns.values()]) this.drop(c, true);
    // Give the goodbye events a moment to leave (they are encrypted asynchronously).
    const pool = this.pool;
    setTimeout(() => {
      pool?.close();
      if (this.pool === pool) this.pool = null;
    }, 300);
  }
}

// ------------------------------------------------------------------ client side

export interface BeaconTarget {
  /** Server's static X25519 public key (base64url). */
  key: string;
  /** Access key (base64url). */
  psk: string;
  relays: string[];
}

export interface BeaconSocketOptions {
  createSocket?: SocketFactory;
  /** The server told us where it can be reached directly right now. */
  onInfo?: (info: BeaconInfo) => void;
  /** Give direct addresses a head start before asking the relays (ms). */
  delayMs?: number;
  timeoutMs?: number;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * A WebSocket look-alike that tunnels through the beacon, for SignalingClient's createWebSocket.
 * Only what SignalingClient uses: readyState, send, close and the on* handlers.
 */
export class BeaconSocket {
  readyState = CONNECTING;
  readonly url: string;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  private readonly target: BeaconTarget;
  private readonly opts: BeaconSocketOptions;
  private pool: RelayPool | null = null;
  private stream: Stream | null = null;
  private readonly cid = randomBytes(8);
  private readonly nostr = nostrKeypair();
  private readonly e = beaconKeypair();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private idle: ReturnType<typeof setInterval> | null = null;
  private server: string | null = null;

  constructor(url: string, target: BeaconTarget, opts: BeaconSocketOptions = {}) {
    this.url = url;
    this.target = target;
    this.opts = opts;
    this.timers.push(setTimeout(() => void this.start(), opts.delayMs ?? 0));
    this.timers.push(setTimeout(() => this.finish(1006, 'the home server did not answer through the relays'), (opts.delayMs ?? 0) + (opts.timeoutMs ?? 25_000)));
  }

  private async start(): Promise<void> {
    if (this.readyState !== CONNECTING) return;
    let serverKey: Uint8Array;
    let psk: Uint8Array;
    try {
      serverKey = fromBase64Url(this.target.key);
      psk = fromBase64Url(this.target.psk);
    } catch {
      return this.finish(1006, 'invalid code');
    }
    const ts = new Uint8Array(8);
    new DataView(ts.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 1000)));
    const es = dh(this.e.secret, serverKey);
    if (!es) return this.finish(1006, 'invalid code');
    const head = header(T_INIT, this.cid, 0);
    const ct = await seal(initKey(es, psk, serverKey, this.e.public, ts), new Uint8Array(12), concatBytes(head, this.e.public, ts), utf8('{}'));
    const init = toBase64Url(concatBytes(head, this.e.public, ts, ct));
    const topic = beaconTopic(psk, serverKey);
    const cidHex = bytesToHex(this.cid);

    this.pool = new RelayPool(this.target.relays, { createSocket: this.opts.createSocket });
    this.pool.subscribe('beacon', { kinds: [BEACON_KIND], '#p': [this.nostr.pubkey], since: Math.floor(Date.now() / 1000) - 60 }, (ev) => {
      const p = parsePacket(ev.content);
      if (!p || p.cidHex !== cidHex) return;
      if (p.type === T_ACCEPT && !this.stream) void this.onAccept(p, ev.pubkey, es, psk, serverKey, ts, topic);
      else if (this.stream && ev.pubkey === this.server && (p.type === T_DATA || p.type === T_CLOSE)) void this.stream.receive(p);
    });
    // Relays may not have the subscription yet, and events can get lost: repeat until answered.
    const send = (n: number) => {
      if (this.stream || this.readyState !== CONNECTING || !this.pool) return;
      // A new event each time (same content): exact repeats would be dropped as duplicates.
      this.pool.publish(signEvent(this.nostr.secret, BEACON_KIND, [['p', topic]], init));
      if (n < 6) this.timers.push(setTimeout(() => send(n + 1), 800 * 2 ** Math.min(n, 2)));
    };
    send(0);
  }

  private async onAccept(p: Packet, from: string, es: Uint8Array, psk: Uint8Array, serverKey: Uint8Array, ts: Uint8Array, topic: string): Promise<void> {
    if (p.body.length < 32 + 16) return;
    const e2 = p.body.slice(0, 32);
    const ee = dh(this.e.secret, e2);
    if (!ee) return;
    const keys = sessionKeys(es, ee, psk, serverKey, this.e.public, ts, e2);
    const info = await unseal(keys.k2, new Uint8Array(12), concatBytes(p.head, e2), p.body.subarray(32));
    // Only the holder of the server's key can produce this: anything else is ignored.
    if (!info || this.stream || this.readyState !== CONNECTING) return;
    this.server = from;
    this.stream = new Stream({
      cid: this.cid,
      sendKey: keys.toServer,
      recvKey: keys.toClient,
      dir: 0,
      // To the topic the server listens on (its reply key only identifies its answers to us).
      emit: (content) => this.pool?.publish(signEvent(this.nostr.secret, BEACON_KIND, [['p', topic]], content)),
      onFrame: (f) => this.onmessage?.({ data: f }),
      onEnd: () => this.finish(1006, 'the home server closed the tunnel'),
    });
    this.readyState = OPEN;
    this.idle = setInterval(() => {
      if (this.stream && Date.now() - this.stream.lastSeen > IDLE_MS) this.finish(1006, 'the home server stopped answering');
    }, 10_000);
    this.onopen?.({});
    try {
      const parsed = JSON.parse(fromUtf8(info));
      if (parsed && Array.isArray(parsed.addresses)) this.opts.onInfo?.({ name: String(parsed.name ?? '').slice(0, 64), addresses: parsed.addresses.slice(0, 8) });
    } catch {
      /* informational only */
    }
  }

  send(data: string): void {
    if (this.readyState === OPEN) this.stream?.write(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= CLOSING) return;
    this.stream?.close(true);
    this.readyState = CLOSING;
    // Let the goodbye leave before the relay connections go.
    this.timers.push(setTimeout(() => this.finish(code, reason), 200));
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const t of this.timers) clearTimeout(t);
    if (this.idle) clearInterval(this.idle);
    this.stream?.close(false);
    this.pool?.close();
    this.pool = null;
    this.onerror?.({});
    this.onclose?.({ code, reason });
  }
}
