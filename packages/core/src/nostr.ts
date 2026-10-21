/**
 * Minimal Nostr client (NIP-01): signed events and a pool of relays with automatic reconnects.
 * BeamDesk uses public Nostr relays as untrusted mailboxes for its beacon (see beacon.ts); every
 * message is end-to-end encrypted before it gets here, so relays only see random-looking data.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { utf8 } from './util.ts';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
}

export type SocketFactory = (url: string) => WebSocket;

const HEX64 = /^[0-9a-f]{64}$/;

/** NIP-01 event id: sha256 of the canonical serialization. */
export function eventHash(e: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>): string {
  return bytesToHex(sha256(utf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

export function nostrKeypair(): { secret: Uint8Array; pubkey: string } {
  const secret = schnorr.utils.randomSecretKey();
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
}

export function signEvent(secret: Uint8Array, kind: number, tags: string[][], content: string, createdAt = Math.floor(Date.now() / 1000)): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const base = { pubkey, created_at: createdAt, kind, tags, content };
  const id = eventHash(base);
  return { ...base, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), secret)) };
}

/** Full check, as relays do it: shape, id and signature. */
export function verifyEvent(e: unknown): e is NostrEvent {
  const ev = e as NostrEvent;
  if (!ev || typeof ev !== 'object' || typeof ev.content !== 'string' || !Array.isArray(ev.tags) || !Number.isInteger(ev.kind) || !Number.isInteger(ev.created_at)) return false;
  if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || typeof ev.sig !== 'string' || !/^[0-9a-f]{128}$/.test(ev.sig)) return false;
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  if (eventHash(ev) !== ev.id) return false;
  try {
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

interface Subscription {
  filter: NostrFilter;
  onEvent: (e: NostrEvent) => void;
}

const MAX_QUEUE = 64;

class Relay {
  readonly url: string;
  ws: WebSocket | null = null;
  open = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  private closed = false;
  private readonly pool: RelayPool;

  constructor(url: string, pool: RelayPool) {
    this.url = url;
    this.pool = pool;
  }

  connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = this.pool.createSocket(this.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.attempt = 0;
      for (const [id, sub] of this.pool.subs) this.raw(['REQ', id, sub.filter]);
      for (const m of this.queue.splice(0)) ws.send(m);
      this.pool.changed();
    };
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.open) {
        this.open = false;
        this.pool.changed();
      }
      this.retry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private retry(): void {
    if (this.closed) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string' || data.length > 256 * 1024) return;
    let m: unknown;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT' && typeof m[1] === 'string') this.pool.dispatch(m[1], m[2]);
    else if (m[0] === 'CLOSED' && typeof m[1] === 'string') {
      // The relay dropped a subscription (limits, restarts): ask again a little later.
      const id = m[1];
      setTimeout(() => {
        const sub = this.pool.subs.get(id);
        if (sub && this.open) this.raw(['REQ', id, sub.filter]);
      }, 5000);
    }
  }

  raw(msg: unknown[]): void {
    const text = JSON.stringify(msg);
    if (this.open && this.ws?.readyState === 1) this.ws.send(text);
    else if (msg[0] === 'EVENT') {
      this.queue.push(text);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Publishes to every relay and merges what they deliver (each event once). */
export class RelayPool {
  readonly subs = new Map<string, Subscription>();
  readonly createSocket: SocketFactory;
  private readonly relays: Relay[];
  private readonly seen = new Set<string>();
  private readonly onChange: () => void;

  constructor(urls: string[], opts: { createSocket?: SocketFactory; onChange?: () => void } = {}) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
    this.onChange = opts.onChange ?? (() => undefined);
    this.relays = [...new Set(urls)].map((u) => new Relay(u, this));
    for (const r of this.relays) r.connect();
  }

  get connected(): number {
    return this.relays.filter((r) => r.open).length;
  }

  get total(): number {
    return this.relays.length;
  }

  changed(): void {
    this.onChange();
  }

  subscribe(id: string, filter: NostrFilter, onEvent: (e: NostrEvent) => void): void {
    this.subs.set(id, { filter, onEvent });
    for (const r of this.relays) r.raw(['REQ', id, filter]);
  }

  unsubscribe(id: string): void {
    if (!this.subs.delete(id)) return;
    for (const r of this.relays) r.raw(['CLOSE', id]);
  }

  publish(e: NostrEvent): void {
    for (const r of this.relays) r.raw(['EVENT', e]);
  }

  /**
   * An event from a relay. Only events whose id matches their content count, so a misbehaving
   * relay cannot use a real event's id to make the copies from honest relays look like repeats.
   */
  dispatch(subId: string, e: unknown): void {
    const sub = this.subs.get(subId);
    const ev = e as NostrEvent;
    if (!sub || !ev || typeof ev.id !== 'string' || this.seen.has(ev.id)) return;
    if (typeof ev.content !== 'string' || !Array.isArray(ev.tags) || eventHash(ev) !== ev.id) return;
    this.seen.add(ev.id);
    if (this.seen.size > 4000) this.seen.delete(this.seen.values().next().value!);
    sub.onEvent(ev);
  }

  close(): void {
    for (const r of this.relays) r.close();
    this.subs.clear();
  }
}
