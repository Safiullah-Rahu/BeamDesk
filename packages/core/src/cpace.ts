/**
 * Password authentication with CPace (a balanced PAKE selected by the IRTF CFRG),
 * instantiated over ristretto255 and bound to the WebRTC DTLS fingerprints.
 *
 * Why a PAKE instead of "send the password":
 *  - The password never leaves the device, not even hashed.
 *  - Neither the signaling server nor a network attacker can test password guesses offline;
 *    every guess requires a live connection attempt, which the host rate limits.
 *  - The shared key is bound to the DTLS fingerprints of *this* WebRTC connection
 *    ("channel binding"), so a man-in-the-middle that terminates DTLS on both sides
 *    ends up with two different channel identifiers and authentication fails.
 *
 * Construction (per password slot):
 *   G   = hash_to_ristretto255(lv(DSI, PRS, CI, sid, slot))
 *   Y_i = y_i * G                                (each side, fresh random scalar)
 *   K   = y_a * Y_b = y_b * Y_a                  (reject identity elements)
 *   ISK = SHA-512(lv(DSI_ISK, sid, slot, K, Y_viewer, Y_host))
 *   tag_role = HMAC-SHA256(ISK, lv("BeamDesk-confirm", role, sid, CI))
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { equalBytes, lvConcat, randomBytes, utf8 } from './util.ts';

export type PasswordSlot = 'otp' | 'perm';
export const PASSWORD_SLOTS: readonly PasswordSlot[] = ['otp', 'perm'];

const Point = ristretto255.Point;
const ORDER = Point.Fn.ORDER;
const DSI = 'CPaceRistretto255-BeamDesk-v1';
const DST = 'BeamDesk-CPace-v1_XMD:SHA-512_R255MAP_RO_';

/** One-time passwords are case-insensitive and may be typed with spaces or dashes. */
export function normalizeOneTimePassword(pw: string): string {
  return (pw || '').normalize('NFKC').toLowerCase().replace(/[\s\-_.]/g, '');
}

export function normalizePermanentPassword(pw: string): string {
  return (pw || '').normalize('NFKC');
}

/**
 * Password-related string (PRS). The host stores only this value, never the plain password.
 * Permanent passwords are stretched with PBKDF2 so a stolen settings file is costly to crack.
 */
const PBKDF2_ITERATIONS = 210_000;

export async function derivePasswordSecret(slot: PasswordSlot, password: string, hostId: string): Promise<Uint8Array> {
  if (slot === 'otp') {
    return sha256(lvConcat('BeamDesk-PRS-otp-v1', hostId, normalizeOneTimePassword(password)));
  }
  const pw = utf8(normalizePermanentPassword(password));
  const salt = utf8(`BeamDesk-PRS-perm-v1|${hostId}`);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Pages served over plain HTTP (e.g. testing on a local network) have no WebCrypto.
    return pbkdf2Async(sha256, pw, salt, { c: PBKDF2_ITERATIONS, dkLen: 32, asyncTick: 25 });
  }
  const key = await subtle.importKey('raw', pw as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

function randomScalar(): bigint {
  // 64 random bytes reduced mod the group order gives a negligible bias.
  const b = randomBytes(64);
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  const s = n % ORDER;
  return s === 0n ? 1n : s;
}

function generator(prs: Uint8Array, ci: string, sid: string, slot: PasswordSlot) {
  return ristretto255_hasher.hashToCurve(lvConcat(DSI, prs, ci, sid, slot), { DST });
}

export interface CpaceState {
  readonly slot: PasswordSlot;
  readonly sid: string;
  readonly ci: string;
  readonly y: bigint;
  /** Our public share (32 bytes). */
  readonly Y: Uint8Array;
}

export function cpaceStart(prs: Uint8Array, ci: string, sid: string, slot: PasswordSlot): CpaceState {
  const G = generator(prs, ci, sid, slot);
  const y = randomScalar();
  return { slot, sid, ci, y, Y: G.multiply(y).toBytes() };
}

/**
 * Completes the exchange and returns the intermediate session key (ISK).
 * Throws on malformed or degenerate peer shares.
 */
export function cpaceFinish(state: CpaceState, peerY: Uint8Array, role: 'viewer' | 'host'): Uint8Array {
  if (!(peerY instanceof Uint8Array) || peerY.length !== 32) throw new Error('bad CPace share');
  const P = Point.fromBytes(peerY);
  if (P.is0()) throw new Error('degenerate CPace share');
  const K = P.multiply(state.y);
  if (K.is0()) throw new Error('degenerate CPace key');
  const yViewer = role === 'viewer' ? state.Y : peerY;
  const yHost = role === 'viewer' ? peerY : state.Y;
  return sha512(lvConcat(`${DSI}_ISK`, state.sid, state.slot, K.toBytes(), yViewer, yHost));
}

export function confirmationTag(isk: Uint8Array, role: 'viewer' | 'host', sid: string, ci: string): Uint8Array {
  return hmac(sha256, isk, lvConcat('BeamDesk-confirm-v1', role, sid, ci));
}

export function verifyConfirmation(isk: Uint8Array, role: 'viewer' | 'host', sid: string, ci: string, tag: Uint8Array): boolean {
  return equalBytes(confirmationTag(isk, role, sid, ci), tag);
}

/**
 * A short code both people can compare (e.g. over the phone) to rule out an interception,
 * derived from the DTLS fingerprints of the connection: "4821 0937".
 */
export function securityCode(ci: string): string {
  const h = sha256(lvConcat('BeamDesk-SAS-v1', ci));
  let n = 0;
  for (let i = 0; i < 4; i++) n = n * 256 + h[i];
  const digits = String(n % 100_000_000).padStart(8, '0');
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

/** Human friendly one-time password alphabet (no 0/o, 1/l/i). */
const OTP_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function generateOneTimePassword(length = 6): string {
  const out: string[] = [];
  // Rejection sampling for an unbiased pick.
  const limit = 256 - (256 % OTP_ALPHABET.length);
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit && out.length < length) out.push(OTP_ALPHABET[b % OTP_ALPHABET.length]);
    }
  }
  return out.join('');
}

/** "k7mp2x" -> "k7m p2x" for display. */
export function formatOneTimePassword(pw: string): string {
  return pw.length >= 6 ? `${pw.slice(0, Math.ceil(pw.length / 2))} ${pw.slice(Math.ceil(pw.length / 2))}` : pw;
}
