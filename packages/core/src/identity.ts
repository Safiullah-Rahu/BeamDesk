/**
 * Device identity.
 *
 * Every BeamDesk device owns an Ed25519 key pair that never leaves the device.
 * Its public 9-digit ID is derived from the public key, so:
 *  - the signaling server can verify that a device really owns the ID it registers, and
 *  - peers can verify, end to end, that they talk to the device behind the ID they typed
 *    (the signaling server cannot impersonate a device without its private key).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from './util.ts';

export interface StoredIdentity {
  /** base64url Ed25519 secret key (32 bytes). */
  sk: string;
  /** base64url Ed25519 public key (32 bytes). */
  pk: string;
}

const ID_DOMAIN = utf8('BeamDesk-ID-v1');

/** Derives the public, human friendly 9 digit device ID (100000000-999999999). */
export function deviceIdFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('bad public key length');
  const h = sha256(concatBytes(ID_DOMAIN, publicKey));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
  return String((n % 900_000_000n) + 100_000_000n);
}

export class Identity {
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly publicKeyB64: string;
  private readonly secretKey: Uint8Array;

  private constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
    this.publicKey = ed25519.getPublicKey(secretKey);
    this.publicKeyB64 = toBase64Url(this.publicKey);
    this.id = deviceIdFromPublicKey(this.publicKey);
  }

  static generate(): Identity {
    return new Identity(ed25519.utils.randomSecretKey());
  }

  static restore(stored: StoredIdentity | null | undefined): Identity | null {
    try {
      if (!stored?.sk) return null;
      const sk = fromBase64Url(stored.sk);
      if (sk.length !== 32) return null;
      return new Identity(sk);
    } catch {
      return null;
    }
  }

  /** Loads the stored identity or creates (and returns for persisting) a fresh one. */
  static loadOrCreate(stored: StoredIdentity | null | undefined): { identity: Identity; created: boolean } {
    const restored = Identity.restore(stored);
    if (restored) return { identity: restored, created: false };
    return { identity: Identity.generate(), created: true };
  }

  toStored(): StoredIdentity {
    return { sk: toBase64Url(this.secretKey), pk: this.publicKeyB64 };
  }

  sign(message: Uint8Array): string {
    return toBase64Url(ed25519.sign(message, this.secretKey));
  }
}

export function verifySignature(publicKeyB64: string, message: Uint8Array, signatureB64: string): boolean {
  try {
    const pk = fromBase64Url(publicKeyB64);
    const sig = fromBase64Url(signatureB64);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, message, pk);
  } catch {
    return false;
  }
}

/** Verifies that `publicKeyB64` is the key behind `deviceId`. */
export function publicKeyMatchesId(publicKeyB64: string, deviceId: string): boolean {
  try {
    return deviceIdFromPublicKey(fromBase64Url(publicKeyB64)) === deviceId;
  } catch {
    return false;
  }
}

/** Message a device signs to register with the signaling server. */
export function registrationMessage(challenge: string): Uint8Array {
  return concatBytes(utf8('BeamDesk-register-v1:'), utf8(challenge));
}

/**
 * Short fingerprint of a public key for humans (e.g. when an identity changes):
 * "3F9A-1C22-7B0E".
 */
export function keyFingerprint(publicKeyB64: string): string {
  const h = sha256(utf8(publicKeyB64));
  const hex = Array.from(h.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
