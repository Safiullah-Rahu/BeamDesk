/**
 * Connection codes for home servers (host mode). One code carries everything another device needs
 * to use a BeamDesk server running on someone's computer, with no outside service involved:
 *
 *  - the addresses to try (home network, Tailscale, internet, a DNS name),
 *  - the SHA-256 fingerprint of the server's self-signed TLS certificate: the app accepts exactly
 *    that certificate, so nobody in between can pose as the server,
 *  - the access key: without it the server does not let a device in.
 *
 * Text form: "BD1-" + base64url(version | fingerprint | key | addresses | name | checksum).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from './util.ts';

export type HomeAddressKind = 'lan' | 'tailscale' | 'internet' | 'name';

export interface HomeAddress {
  kind: HomeAddressKind;
  /** IPv4 address, or a DNS name for kind "name". */
  host: string;
  port: number;
}

export interface HomeServer {
  name: string;
  /** base64url SHA-256 of the server certificate (DER). */
  fingerprint: string;
  /** base64url, 16 random bytes. */
  accessKey: string;
  addresses: HomeAddress[];
}

const PREFIX = 'BD1-';
const VERSION = 1;
const KINDS: HomeAddressKind[] = ['lan', 'tailscale', 'internet', 'name'];
const MAX_ADDRESSES = 8;
const MAX_NAME_BYTES = 48;
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function ipv4Bytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

const checksum = (body: Uint8Array) => sha256(concatBytes(utf8('BeamDesk-joincode'), body)).slice(0, 3);

export function encodeJoinCode(s: HomeServer): string {
  const fp = fromBase64Url(s.fingerprint);
  const key = fromBase64Url(s.accessKey);
  if (fp.length !== 32 || key.length !== 16) throw new Error('invalid fingerprint or access key');
  const parts: number[] = [VERSION, ...fp, ...key];
  const addresses = s.addresses.slice(0, MAX_ADDRESSES);
  parts.push(addresses.length);
  for (const a of addresses) {
    if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new Error('invalid port');
    parts.push(KINDS.indexOf(a.kind));
    if (a.kind === 'name') {
      if (!DNS_NAME.test(a.host)) throw new Error('invalid host name');
      const b = utf8(a.host.toLowerCase());
      parts.push(b.length, ...b);
    } else {
      const b = ipv4Bytes(a.host);
      if (!b) throw new Error('invalid address');
      parts.push(...b);
    }
    parts.push(a.port >> 8, a.port & 0xff);
  }
  const chars = Array.from(s.name.trim());
  let name = utf8(chars.join(''));
  while (name.length > MAX_NAME_BYTES) {
    chars.pop();
    name = utf8(chars.join(''));
  }
  parts.push(name.length, ...name);
  const body = Uint8Array.from(parts);
  return PREFIX + toBase64Url(concatBytes(body, checksum(body)));
}

/** Decodes a code (also accepts it wrapped in a beamdesk://join/ link or with spaces). Null if invalid. */
export function decodeJoinCode(text: string): HomeServer | null {
  const cleaned = (text || '').trim().replace(/^beamdesk:\/\/join\//i, '').replace(/\s+/g, '');
  if (!cleaned.toUpperCase().startsWith(PREFIX) || cleaned.length > 600) return null;
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(cleaned.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (raw.length < 1 + 32 + 16 + 1 + 1 + 3) return null;
  const body = raw.subarray(0, raw.length - 3);
  const sum = checksum(body);
  if (sum.some((b, i) => b !== raw[raw.length - 3 + i])) return null;
  if (body[0] !== VERSION) return null;
  let o = 1;
  const fingerprint = toBase64Url(body.slice(o, (o += 32)));
  const accessKey = toBase64Url(body.slice(o, (o += 16)));
  const count = body[o++];
  if (count > MAX_ADDRESSES) return null;
  const addresses: HomeAddress[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const kind = KINDS[body[o++]];
      if (!kind) return null;
      let host: string;
      if (kind === 'name') {
        const len = body[o++];
        host = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(o, (o += len)));
        if (!DNS_NAME.test(host)) return null;
      } else {
        if (o + 4 > body.length) return null;
        host = Array.from(body.subarray(o, (o += 4))).join('.');
      }
      if (o + 2 > body.length) return null;
      const port = (body[o] << 8) | body[o + 1];
      o += 2;
      if (!port) return null;
      addresses.push({ kind, host, port });
    }
    const nameLen = body[o++];
    if (nameLen === undefined || nameLen > MAX_NAME_BYTES || o + nameLen !== body.length) return null;
    const name = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(o, o + nameLen));
    return { name, fingerprint, accessKey, addresses };
  } catch {
    return null;
  }
}

/** WebSocket URLs to try for a home server, in the order given by the code. */
export function homeServerUrls(s: HomeServer): string[] {
  return s.addresses.map((a) => `wss://${a.host}:${a.port}/ws`);
}

/** Host names the app must accept only with the pinned certificate. */
export function homeServerHosts(s: HomeServer): string[] {
  return [...new Set(s.addresses.map((a) => a.host.toLowerCase()))];
}

/** Short, readable form of the fingerprint ("AB12 CD34 EF56 7890") to compare by eye. */
export function shortFingerprint(fingerprint: string): string {
  try {
    const hex = Array.from(fromBase64Url(fingerprint).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex.replace(/(.{4})(?=.)/g, '$1 ');
  } catch {
    return '';
  }
}
