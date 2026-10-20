/**
 * Built-in STUN (RFC 5389) and TURN (RFC 5766) server for host mode, so a home computer can
 * be the whole infrastructure: devices learn their public address from it (STUN) and, when no
 * direct path exists, relay through it (TURN), without any outside service.
 *
 * UDP only. Credentials are the short-lived HMAC "REST" credentials the signaling server hands
 * to registered devices (username "<expiry>:<deviceId>"). The relay only connects its own
 * allocations with each other (both devices relay through this computer and meet here), so it can
 * never be used to reach anything else, on the home network or beyond. Every allocation is
 * bandwidth-limited.
 */
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

const MAGIC = 0x2112a442;

export const METHOD = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 } as const;
export const CLASS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 } as const;

export const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
} as const;

/** Comprehension-required attributes we understand; any other one below 0x8000 gets a 420. */
const KNOWN = new Set<number>([
  ATTR.USERNAME,
  ATTR.MESSAGE_INTEGRITY,
  ATTR.CHANNEL_NUMBER,
  ATTR.LIFETIME,
  ATTR.XOR_PEER_ADDRESS,
  ATTR.DATA,
  ATTR.REALM,
  ATTR.NONCE,
  ATTR.REQUESTED_ADDRESS_FAMILY,
  ATTR.REQUESTED_TRANSPORT,
  ATTR.DONT_FRAGMENT,
]);

const DEFAULT_LIFETIME = 600;
const MAX_LIFETIME = 3600;
const PERMISSION_LIFETIME = 300;
const CHANNEL_LIFETIME = 600;
const NONCE_LIFETIME_MS = 10 * 60_000;
const MAX_STUN_BYTES = 4096;

export interface TurnOptions {
  port: number;
  /** Shared secret of the REST credentials (same as the signaling server's TURN secret). */
  secret: string;
  realm?: string;
  /** Address the relay sockets bind to and put into XOR-RELAYED-ADDRESS: this computer's LAN address. */
  relayAddress: string;
  maxAllocations?: number;
  maxAllocationsPerUser?: number;
  /** Bytes per second each allocation may relay (each direction counted together). */
  bandwidthPerAllocation?: number;
  /**
   * Answers per second to a source address without an allocation (Binding, challenges, errors):
   * the relay must not be usable to bounce traffic at someone else.
   */
  bindingRate?: number;
}

interface Endpoint {
  address: string;
  port: number;
}

interface Allocation {
  id: string;
  client: Endpoint;
  username: string;
  key: Buffer;
  socket: dgram.Socket;
  relayPort: number;
  expires: number;
  allocateTid: string;
  permissions: Map<string, number>;
  channels: Map<number, { peer: Endpoint; expires: number }>;
  channelByPeer: Map<string, number>;
  tokens: number;
  last: number;
}

interface Message {
  method: number;
  cls: number;
  tid: Buffer;
  attrs: { type: number; value: Buffer; offset: number }[];
  raw: Buffer;
}

// ------------------------------------------------------------------ wire format

function messageType(method: number, cls: number): number {
  return (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
}

export function parseStun(buf: Buffer): Message | null {
  if (buf.length < 20 || buf.length > MAX_STUN_BYTES || (buf[0] & 0xc0) !== 0) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  if (buf.readUInt32BE(4) !== MAGIC || length + 20 !== buf.length || length % 4 !== 0) return null;
  const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
  const cls = ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7);
  const attrs: Message['attrs'] = [];
  let offset = 20;
  while (offset < buf.length) {
    if (offset + 4 > buf.length || attrs.length >= 32) return null;
    const t = buf.readUInt16BE(offset);
    const l = buf.readUInt16BE(offset + 2);
    if (offset + 4 + l > buf.length) return null;
    attrs.push({ type: t, value: buf.subarray(offset + 4, offset + 4 + l), offset });
    offset += 4 + ((l + 3) & ~3);
  }
  return { method, cls, tid: buf.subarray(8, 20), attrs, raw: buf };
}

const attr = (m: Message, type: number) => m.attrs.find((a) => a.type === type)?.value;

export function encodeAddress(ep: Endpoint, tid: Buffer, xor: boolean): Buffer {
  const v6 = net.isIPv6(ep.address);
  const out = Buffer.alloc(v6 ? 20 : 8);
  out[1] = v6 ? 2 : 1;
  out.writeUInt16BE(xor ? ep.port ^ (MAGIC >>> 16) : ep.port, 2);
  const ip = ipToBytes(ep.address);
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), tid]);
  for (let i = 0; i < ip.length; i++) out[4 + i] = xor ? ip[i] ^ mask[i] : ip[i];
  return out;
}

export function decodeXorAddress(value: Buffer | undefined, tid: Buffer): Endpoint | null {
  if (!value || value.length < 8) return null;
  const family = value[1];
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  const mask = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), tid]);
  if (family === 1 && value.length === 8) {
    return { address: [0, 1, 2, 3].map((i) => value[4 + i] ^ mask[i]).join('.'), port };
  }
  if (family === 2 && value.length === 20) {
    const b = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) b[i] = value[4 + i] ^ mask[i];
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
    return { address: groups.join(':'), port };
  }
  return null;
}

function ipToBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Encodes a STUN message, adding MESSAGE-INTEGRITY (when a key is given) and FINGERPRINT. */
export function buildStun(method: number, cls: number, tid: Buffer, attrs: [number, Buffer][], key?: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const [type, value] of attrs) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(value.length, 2);
    parts.push(head, value, Buffer.alloc((4 - (value.length % 4)) % 4));
  }
  let body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(messageType(method, cls), 0);
  header.writeUInt32BE(MAGIC, 4);
  tid.copy(header, 8);
  if (key) {
    header.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    const mi = Buffer.alloc(4);
    mi.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, 0);
    mi.writeUInt16BE(20, 2);
    body = Buffer.concat([body, mi, mac]);
  }
  header.writeUInt16BE(body.length + 8, 2);
  const fp = Buffer.alloc(8);
  fp.writeUInt16BE(ATTR.FINGERPRINT, 0);
  fp.writeUInt16BE(4, 2);
  fp.writeUInt32BE((crc32(Buffer.concat([header, body])) ^ 0x5354554e) >>> 0, 4);
  return Buffer.concat([header, body, fp]);
}

/** Checks MESSAGE-INTEGRITY with the long-term key. */
function integrityOk(m: Message, key: Buffer): boolean {
  const mi = m.attrs.find((a) => a.type === ATTR.MESSAGE_INTEGRITY);
  if (!mi || mi.value.length !== 20) return false;
  const signed = Buffer.from(m.raw.subarray(0, mi.offset));
  signed.writeUInt16BE(mi.offset - 20 + 24, 2);
  const expected = crypto.createHmac('sha1', key).update(signed).digest();
  return crypto.timingSafeEqual(expected, mi.value);
}

/** The REST password for a TURN username (what the signaling server hands out as credential). */
export function restPassword(secret: string, username: string): string {
  return crypto.createHmac('sha1', secret).update(username).digest('base64');
}

export const longTermKey = (username: string, realm: string, password: string) =>
  crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();

function errorAttr(code: number, reason: string): [number, Buffer] {
  const r = Buffer.from(reason, 'utf8');
  const v = Buffer.alloc(4 + r.length);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  r.copy(v, 4);
  return [ATTR.ERROR_CODE, v];
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

// ------------------------------------------------------------------ server

export interface TurnServer {
  readonly port: number;
  listen(): Promise<number>;
  close(): Promise<void>;
  stats(): { allocations: number; bytesRelayed: number };
}

export function createTurnServer(opts: TurnOptions): TurnServer {
  const realm = opts.realm ?? 'beamdesk';
  const maxAllocations = opts.maxAllocations ?? 64;
  const maxPerUser = opts.maxAllocationsPerUser ?? 8;
  const bandwidth = opts.bandwidthPerAllocation ?? 4 * 1024 * 1024;
  const bindingRate = opts.bindingRate ?? 20;
  const nonceKey = crypto.randomBytes(32);
  const allocations = new Map<string, Allocation>();
  /** 5-tuples whose Allocate is waiting for its relay socket (a retransmission must not create a second one). */
  const pending = new Set<string>();
  const bindingBuckets = new Map<string, { tokens: number; last: number }>();
  let bytesRelayed = 0;
  let socket: dgram.Socket | null = null;
  let boundPort = opts.port;
  let sweeper: ReturnType<typeof setInterval> | null = null;

  const tupleKey = (ep: Endpoint) => `${ep.address}|${ep.port}`;
  const peerKey = (ep: Endpoint) => `${ep.address}|${ep.port}`;

  const makeNonce = (ip: string) => {
    const ts = Date.now().toString(36);
    const mac = crypto.createHmac('sha256', nonceKey).update(`${ts}|${ip}`).digest('base64url').slice(0, 22);
    return `${ts}.${mac}`;
  };
  const nonceValid = (nonce: string, ip: string): 'ok' | 'stale' | 'bad' => {
    const [ts, mac] = nonce.split('.');
    if (!ts || !mac) return 'bad';
    const expected = crypto.createHmac('sha256', nonceKey).update(`${ts}|${ip}`).digest('base64url').slice(0, 22);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return 'bad';
    return Date.now() - parseInt(ts, 36) < NONCE_LIFETIME_MS ? 'ok' : 'stale';
  };

  function send(buf: Buffer, to: Endpoint): void {
    socket?.send(buf, to.port, to.address);
  }

  function reply(m: Message, to: Endpoint, cls: number, attrs: [number, Buffer][], key?: Buffer): void {
    send(buildStun(m.method, cls, m.tid, [...attrs, [ATTR.SOFTWARE, Buffer.from('BeamDesk')]], key), to);
  }

  function fail(m: Message, to: Endpoint, code: number, reason: string, key?: Buffer, extra: [number, Buffer][] = []): void {
    reply(m, to, CLASS.ERROR, [errorAttr(code, reason), ...extra], key);
  }

  /** Long-term credential check. Returns the key, or null after answering with an error. */
  function authenticate(m: Message, from: Endpoint): { key: Buffer; username: string } | null {
    const challenge = (code: number, reason: string) =>
      fail(m, from, code, reason, undefined, [
        [ATTR.REALM, Buffer.from(realm)],
        [ATTR.NONCE, Buffer.from(makeNonce(from.address))],
      ]);
    const username = attr(m, ATTR.USERNAME)?.toString('utf8');
    const nonce = attr(m, ATTR.NONCE)?.toString('utf8');
    if (!username || !nonce || !attr(m, ATTR.MESSAGE_INTEGRITY)) {
      challenge(401, 'Unauthorized');
      return null;
    }
    const nv = nonceValid(nonce, from.address);
    if (nv !== 'ok') {
      challenge(nv === 'stale' ? 438 : 401, nv === 'stale' ? 'Stale Nonce' : 'Unauthorized');
      return null;
    }
    const expiry = Number(username.split(':')[0]);
    if (!/^\d{1,12}:\d{9}$/.test(username) || !(expiry * 1000 > Date.now())) {
      challenge(401, 'Unauthorized');
      return null;
    }
    const key = longTermKey(username, realm, restPassword(opts.secret, username));
    if (!integrityOk(m, key)) {
      challenge(401, 'Unauthorized');
      return null;
    }
    return { key, username };
  }

  /** Relay ports of live allocations: the only peers anyone may relay to. */
  const relayPorts = new Set<number>();
  const allowedAddress = (ip: string) => ip === opts.relayAddress;
  const allowedPeer = (ep: Endpoint) => ep.address === opts.relayAddress && relayPorts.has(ep.port);

  function hasPermission(a: Allocation, ip: string): boolean {
    return (a.permissions.get(ip) ?? 0) > Date.now();
  }

  /** Token bucket per allocation; false = drop the packet. */
  function spend(a: Allocation, bytes: number): boolean {
    const now = Date.now();
    a.tokens = Math.min(bandwidth * 2, a.tokens + ((now - a.last) / 1000) * bandwidth);
    a.last = now;
    if (a.tokens < bytes) return false;
    a.tokens -= bytes;
    bytesRelayed += bytes;
    return true;
  }

  function freeAllocation(a: Allocation): void {
    if (allocations.get(a.id) === a) {
      allocations.delete(a.id);
      relayPorts.delete(a.relayPort);
    }
    try {
      a.socket.close();
    } catch {
      /* already closed */
    }
  }

  async function onAllocate(m: Message, from: Endpoint): Promise<void> {
    const existing = allocations.get(tupleKey(from));
    if (pending.has(tupleKey(from))) return; // still answering the first copy of this request
    const auth = authenticate(m, from);
    if (!auth) return;
    if (existing) {
      if (existing.allocateTid === m.tid.toString('hex')) {
        // Retransmission of a request we already answered.
        return reply(m, from, CLASS.SUCCESS, allocationAttrs(existing, m), existing.key);
      }
      return fail(m, from, 437, 'Allocation Mismatch', auth.key);
    }
    const transport = attr(m, ATTR.REQUESTED_TRANSPORT);
    if (!transport || transport[0] !== 17) return fail(m, from, 442, 'Unsupported Transport Protocol', auth.key);
    const family = attr(m, ATTR.REQUESTED_ADDRESS_FAMILY);
    if (family && family[0] !== 1) return fail(m, from, 440, 'Address Family not Supported', auth.key);
    if (allocations.size + pending.size >= maxAllocations) return fail(m, from, 486, 'Allocation Quota Reached', auth.key);
    let mine = 0;
    for (const a of allocations.values()) if (a.username.split(':')[1] === auth.username.split(':')[1]) mine++;
    if (mine >= maxPerUser) return fail(m, from, 486, 'Allocation Quota Reached', auth.key);

    const relay = dgram.createSocket('udp4');
    pending.add(tupleKey(from));
    try {
      await new Promise<void>((resolve, reject) => {
        relay.once('error', reject);
        relay.bind(0, opts.relayAddress, () => resolve());
      });
    } catch {
      return fail(m, from, 508, 'Insufficient Capacity', auth.key);
    } finally {
      pending.delete(tupleKey(from));
    }
    if (!socket) {
      relay.close(); // the server was closed meanwhile
      return;
    }
    const requested = attr(m, ATTR.LIFETIME)?.readUInt32BE(0) ?? DEFAULT_LIFETIME;
    const a: Allocation = {
      id: tupleKey(from),
      client: from,
      username: auth.username,
      key: auth.key,
      socket: relay,
      relayPort: relay.address().port,
      expires: Date.now() + Math.min(Math.max(requested, 60), MAX_LIFETIME) * 1000,
      allocateTid: m.tid.toString('hex'),
      permissions: new Map(),
      channels: new Map(),
      channelByPeer: new Map(),
      tokens: bandwidth,
      last: Date.now(),
    };
    relay.on('message', (data, rinfo) => onPeerData(a, data, { address: rinfo.address, port: rinfo.port }));
    relay.on('error', () => freeAllocation(a));
    allocations.set(a.id, a);
    relayPorts.add(a.relayPort);
    reply(m, from, CLASS.SUCCESS, allocationAttrs(a, m), a.key);
  }

  function allocationAttrs(a: Allocation, m: Message): [number, Buffer][] {
    return [
      [ATTR.XOR_RELAYED_ADDRESS, encodeAddress({ address: opts.relayAddress, port: a.relayPort }, m.tid, true)],
      [ATTR.LIFETIME, u32(Math.max(0, Math.round((a.expires - Date.now()) / 1000)))],
      [ATTR.XOR_MAPPED_ADDRESS, encodeAddress(a.client, m.tid, true)],
    ];
  }

  function withAllocation(m: Message, from: Endpoint, fn: (a: Allocation, key: Buffer) => void): void {
    const auth = authenticate(m, from);
    if (!auth) return;
    const a = allocations.get(tupleKey(from));
    if (!a || a.username !== auth.username) return fail(m, from, 437, 'Allocation Mismatch', auth.key);
    fn(a, auth.key);
  }

  function onRefresh(m: Message, from: Endpoint): void {
    withAllocation(m, from, (a, key) => {
      const requested = attr(m, ATTR.LIFETIME)?.readUInt32BE(0) ?? DEFAULT_LIFETIME;
      if (requested === 0) {
        freeAllocation(a);
        return reply(m, from, CLASS.SUCCESS, [[ATTR.LIFETIME, u32(0)]], key);
      }
      const lifetime = Math.min(Math.max(requested, 60), MAX_LIFETIME);
      a.expires = Date.now() + lifetime * 1000;
      reply(m, from, CLASS.SUCCESS, [[ATTR.LIFETIME, u32(lifetime)]], key);
    });
  }

  function onCreatePermission(m: Message, from: Endpoint): void {
    withAllocation(m, from, (a, key) => {
      const peers = m.attrs.filter((x) => x.type === ATTR.XOR_PEER_ADDRESS).map((x) => decodeXorAddress(x.value, m.tid));
      if (!peers.length || peers.some((p) => !p)) return fail(m, from, 400, 'Bad Request', key);
      // The permission is for the address; ports are checked again on every packet.
      if (peers.some((p) => !allowedAddress(p!.address))) return fail(m, from, 403, 'Forbidden', key);
      if (a.permissions.size + peers.length > 64) return fail(m, from, 508, 'Insufficient Capacity', key);
      for (const p of peers) a.permissions.set(p!.address, Date.now() + PERMISSION_LIFETIME * 1000);
      reply(m, from, CLASS.SUCCESS, [], key);
    });
  }

  function onChannelBind(m: Message, from: Endpoint): void {
    withAllocation(m, from, (a, key) => {
      const ch = attr(m, ATTR.CHANNEL_NUMBER)?.readUInt16BE(0);
      const peer = decodeXorAddress(attr(m, ATTR.XOR_PEER_ADDRESS), m.tid);
      if (ch === undefined || ch < 0x4000 || ch > 0x7fff || !peer) return fail(m, from, 400, 'Bad Request', key);
      if (!allowedPeer(peer)) return fail(m, from, 403, 'Forbidden', key);
      const boundPeer = a.channels.get(ch);
      const boundCh = a.channelByPeer.get(peerKey(peer));
      if ((boundPeer && peerKey(boundPeer.peer) !== peerKey(peer)) || (boundCh !== undefined && boundCh !== ch)) {
        return fail(m, from, 400, 'Bad Request', key);
      }
      if (!boundPeer && a.channels.size >= 64) return fail(m, from, 508, 'Insufficient Capacity', key);
      a.channels.set(ch, { peer, expires: Date.now() + CHANNEL_LIFETIME * 1000 });
      a.channelByPeer.set(peerKey(peer), ch);
      a.permissions.set(peer.address, Date.now() + PERMISSION_LIFETIME * 1000);
      reply(m, from, CLASS.SUCCESS, [], key);
    });
  }

  function onSendIndication(m: Message, from: Endpoint): void {
    const a = allocations.get(tupleKey(from));
    const peer = decodeXorAddress(attr(m, ATTR.XOR_PEER_ADDRESS), m.tid);
    const data = attr(m, ATTR.DATA);
    if (!a || !peer || !data || !allowedPeer(peer) || !hasPermission(a, peer.address) || !spend(a, data.length)) return;
    a.socket.send(data, peer.port, peer.address);
  }

  function onChannelData(buf: Buffer, from: Endpoint): void {
    if (buf.length < 4) return;
    const ch = buf.readUInt16BE(0);
    const length = buf.readUInt16BE(2);
    if (4 + length > buf.length) return;
    const a = allocations.get(tupleKey(from));
    const binding = a?.channels.get(ch);
    if (!a || !binding || binding.expires < Date.now()) return;
    if (!allowedPeer(binding.peer) || !hasPermission(a, binding.peer.address) || !spend(a, length)) return;
    a.socket.send(buf.subarray(4, 4 + length), binding.peer.port, binding.peer.address);
  }

  function onPeerData(a: Allocation, data: Buffer, peer: Endpoint): void {
    if (allocations.get(a.id) !== a || !allowedPeer(peer) || !hasPermission(a, peer.address) || !spend(a, data.length)) return;
    const ch = a.channelByPeer.get(peerKey(peer));
    if (ch !== undefined && (a.channels.get(ch)?.expires ?? 0) > Date.now()) {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(ch, 0);
      head.writeUInt16BE(data.length, 2);
      send(Buffer.concat([head, data]), a.client);
      return;
    }
    const tid = crypto.randomBytes(12);
    send(buildStun(METHOD.DATA, CLASS.INDICATION, tid, [[ATTR.XOR_PEER_ADDRESS, encodeAddress(peer, tid, true)], [ATTR.DATA, data]]), a.client);
  }

  /** Token bucket per source address for everything answered before an allocation exists. */
  function unauthenticatedOk(from: Endpoint): boolean {
    const now = Date.now();
    let b = bindingBuckets.get(from.address);
    if (!b) {
      if (bindingBuckets.size > 10_000) bindingBuckets.clear();
      b = { tokens: bindingRate * 2, last: now };
      bindingBuckets.set(from.address, b);
    }
    b.tokens = Math.min(bindingRate * 2, b.tokens + ((now - b.last) / 1000) * bindingRate);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  function onBinding(m: Message, from: Endpoint): void {
    reply(m, from, CLASS.SUCCESS, [[ATTR.XOR_MAPPED_ADDRESS, encodeAddress(from, m.tid, true)]]);
  }

  function onPacket(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    const from = { address: rinfo.address, port: rinfo.port };
    if (buf.length >= 4 && (buf[0] & 0xc0) === 0x40) return onChannelData(buf, from);
    const m = parseStun(buf);
    if (!m) return;
    if (m.cls === CLASS.REQUEST) {
      if (!allocations.has(tupleKey(from)) && !unauthenticatedOk(from)) return;
      const unknown = m.attrs.filter((a) => a.type < 0x8000 && !KNOWN.has(a.type) && a.type !== ATTR.FINGERPRINT).map((a) => a.type);
      if (unknown.length && m.method !== METHOD.BINDING) {
        const list = Buffer.alloc(unknown.length * 2);
        unknown.forEach((t, i) => list.writeUInt16BE(t, i * 2));
        return fail(m, from, 420, 'Unknown Attribute', undefined, [[ATTR.UNKNOWN_ATTRIBUTES, list]]);
      }
      switch (m.method) {
        case METHOD.BINDING:
          return onBinding(m, from);
        case METHOD.ALLOCATE:
          void onAllocate(m, from);
          return;
        case METHOD.REFRESH:
          return onRefresh(m, from);
        case METHOD.CREATE_PERMISSION:
          return onCreatePermission(m, from);
        case METHOD.CHANNEL_BIND:
          return onChannelBind(m, from);
        default:
          return fail(m, from, 400, 'Bad Request');
      }
    }
    if (m.cls === CLASS.INDICATION && m.method === METHOD.SEND) onSendIndication(m, from);
  }

  function sweep(): void {
    const now = Date.now();
    for (const a of [...allocations.values()]) {
      if (a.expires < now) {
        freeAllocation(a);
        continue;
      }
      for (const [ip, exp] of a.permissions) if (exp < now) a.permissions.delete(ip);
      for (const [ch, c] of a.channels) {
        if (c.expires < now) {
          a.channels.delete(ch);
          a.channelByPeer.delete(peerKey(c.peer));
        }
      }
    }
    for (const [ip, b] of bindingBuckets) if (now - b.last > 60_000) bindingBuckets.delete(ip);
  }

  return {
    get port() {
      return boundPort;
    },
    listen: () =>
      new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.once('error', reject);
        s.bind(opts.port, '0.0.0.0', () => {
          s.removeListener('error', reject);
          s.on('error', (err) => console.warn('[turn]', err.message));
          s.on('message', (buf, rinfo) => {
            try {
              onPacket(buf, rinfo);
            } catch (err) {
              console.warn('[turn] bad packet', (err as Error).message);
            }
          });
          socket = s;
          boundPort = s.address().port;
          sweeper = setInterval(sweep, 15_000);
          sweeper.unref();
          resolve(boundPort);
        });
      }),
    close: async () => {
      if (sweeper) clearInterval(sweeper);
      for (const a of [...allocations.values()]) freeAllocation(a);
      await new Promise<void>((resolve) => (socket ? socket.close(() => resolve()) : resolve()));
      socket = null;
    },
    stats: () => ({ allocations: allocations.size, bytesRelayed }),
  };
}
