/**
 * Connection codes for home servers (host mode). One code carries everything another device needs
 * to use a BeamDesk server running on someone's computer, with no outside service involved:
 *
 *  - the addresses to try (home network, Tailscale, internet, a DNS name),
 *  - the SHA-256 fingerprint of the server's self-signed TLS certificate: the app accepts exactly
 *    that certificate, so nobody in between can pose as the server,
 *  - the access key: without it the server does not let a device in,
 *  - (version 2) the server's beacon key and relays: how to reach it through public relays when
 *    no address works, e.g. behind carrier-grade NAT (see beacon.ts).
 *
 * Text form: "BD1-"/"BD2-" + base64url(version | fingerprint | key | [beacon key] | addresses |
 * [relays] | name | checksum).
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
  /** Reachable through the beacon: the server's X25519 key (base64url) and relays ([] = the default ones). */
  beacon?: { key: string; relays: string[] };
}

/** Pseudo-address for the beacon in a list of server URLs. */
export const BEACON_URL = 'beacon:';
const MAX_RELAYS = 4;
/** wss:// relays; plain ws:// only on this computer (tests, a relay you run yourself). */
const RELAY_URL = /^(wss:\/\/[a-z0-9.-]+|ws:\/\/(127\.0\.0\.1|localhost))(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/i;

export const validRelayUrl = (u: string) => u.length <= 120 && RELAY_URL.test(u);
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
  const version = s.beacon ? 2 : 1;
  const parts: number[] = [version, ...fp, ...key];
  if (s.beacon) {
    const bk = fromBase64Url(s.beacon.key);
    if (bk.length !== 32) throw new Error('invalid beacon key');
    parts.push(...bk);
  }
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
  if (s.beacon) {
    const relays = s.beacon.relays.slice(0, MAX_RELAYS);
    parts.push(relays.length);
    for (const r of relays) {
      if (!validRelayUrl(r)) throw new Error('invalid relay address');
      const b = utf8(r);
      parts.push(b.length, ...b);
    }
  }
  const chars = Array.from(s.name.trim());
  let name = utf8(chars.join(''));
  while (name.length > MAX_NAME_BYTES) {
    chars.pop();
    name = utf8(chars.join(''));
  }
  parts.push(name.length, ...name);
  const body = Uint8Array.from(parts);
  return `BD${version}-` + toBase64Url(concatBytes(body, checksum(body)));
}

/** Decodes a code (also accepts it wrapped in a beamdesk://join/ link or with spaces). Null if invalid. */
export function decodeJoinCode(text: string): HomeServer | null {
  const cleaned = (text || '').trim().replace(/^beamdesk:\/\/join\//i, '').replace(/\s+/g, '');
  const prefix = /^BD([12])-/i.exec(cleaned);
  if (!prefix || cleaned.length > 1000) return null;
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(cleaned.slice(4));
  } catch {
    return null;
  }
  if (raw.length < 1 + 32 + 16 + 1 + 1 + 3) return null;
  const body = raw.subarray(0, raw.length - 3);
  const sum = checksum(body);
  if (sum.some((b, i) => b !== raw[raw.length - 3 + i])) return null;
  const version = body[0];
  if (String(version) !== prefix[1] || (version === 2 && body.length < 1 + 32 + 16 + 32 + 3)) return null;
  let o = 1;
  const fingerprint = toBase64Url(body.slice(o, (o += 32)));
  const accessKey = toBase64Url(body.slice(o, (o += 16)));
  const beaconKey = version === 2 ? toBase64Url(body.slice(o, (o += 32))) : null;
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
    const relays: string[] = [];
    if (beaconKey) {
      const n = body[o++];
      if (n === undefined || n > MAX_RELAYS) return null;
      for (let i = 0; i < n; i++) {
        const len = body[o++];
        const url = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(o, (o += len)));
        if (!validRelayUrl(url)) return null;
        relays.push(url);
      }
    }
    const nameLen = body[o++];
    if (nameLen === undefined || nameLen > MAX_NAME_BYTES || o + nameLen !== body.length) return null;
    const name = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(o, o + nameLen));
    const server: HomeServer = { name, fingerprint, accessKey, addresses };
    if (beaconKey) server.beacon = { key: beaconKey, relays };
    return server;
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
