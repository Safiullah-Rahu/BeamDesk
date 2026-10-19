/** Small, dependency-free helpers shared by every BeamDesk component. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Length-prefixed concatenation, so that ("ab","c") and ("a","bc") never collide. */
export function lvConcat(...parts: (Uint8Array | string)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const b = typeof p === 'string' ? utf8(p) : p;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length);
    chunks.push(len, b);
  }
  return concatBytes(...chunks);
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export const randomId = (bytes = 16): string => toBase64Url(randomBytes(bytes));

/** Constant-time comparison for MACs and tags. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Listener<T> = (payload: T) => void;

/**
 * Minimal typed event emitter (works in browsers, Electron and Node without polyfills).
 * `on` returns an unsubscribe function, which keeps UI effects tidy.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[beamdesk] listener for "${String(event)}" failed`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

/** Formats a 9 digit device ID as "123 456 789". */
export function formatId(id: string): string {
  const digits = id.replace(/\D/g, '');
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

/** Accepts "123 456 789", "123-456-789", "123456789" and returns the canonical digits, or null. */
export function parseId(input: string): string | null {
  const digits = (input || '').replace(/[\s\-_.]/g, '');
  return /^[1-9]\d{8}$/.test(digits) ? digits : null;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 kbps';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

/** Normalises user supplied server addresses into ws(s) and http(s) base URLs. */
export function normalizeServerUrl(input: string): { http: string; ws: string } | null {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|\[?::1\]?)/.test(s);
    s = `${local ? 'http' : 'https'}://${s}`;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/(ws)?\/?$/, '');
  const http = `${url.protocol}//${url.host}${path}`;
  const ws = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}${path}/ws`;
  return { http, ws };
}
