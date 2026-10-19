import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmationTag,
  cpaceFinish,
  cpaceStart,
  derivePasswordSecret,
  generateOneTimePassword,
  normalizeOneTimePassword,
  securityCode,
  verifyConfirmation,
} from '../src/cpace.ts';
import { deviceIdFromPublicKey, Identity, keyFingerprint, publicKeyMatchesId, registrationMessage, verifySignature } from '../src/identity.ts';
import { fromBase64Url, toBase64Url, utf8 } from '../src/util.ts';

test('identity: stable 9 digit ID derived from the public key', () => {
  const a = Identity.generate();
  assert.match(a.id, /^[1-9]\d{8}$/);
  const restored = Identity.restore(a.toStored())!;
  assert.equal(restored.id, a.id);
  assert.equal(restored.publicKeyB64, a.publicKeyB64);
  assert.equal(deviceIdFromPublicKey(a.publicKey), a.id);
  assert.ok(publicKeyMatchesId(a.publicKeyB64, a.id));
  assert.ok(!publicKeyMatchesId(Identity.generate().publicKeyB64, a.id));
  assert.match(keyFingerprint(a.publicKeyB64), /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
});

test('identity: signatures verify and reject tampering', () => {
  const a = Identity.generate();
  const msg = registrationMessage('challenge-123');
  const sig = a.sign(msg);
  assert.ok(verifySignature(a.publicKeyB64, msg, sig));
  assert.ok(!verifySignature(a.publicKeyB64, registrationMessage('challenge-124'), sig));
  assert.ok(!verifySignature(Identity.generate().publicKeyB64, msg, sig));
  assert.ok(!verifySignature('not-base64!', msg, sig));
  assert.equal(Identity.restore({ sk: 'garbage', pk: '' }), null);
});

async function run(viewerPw: string, hostPw: string, slot: 'otp' | 'perm', ciV = 'ci', ciH = 'ci') {
  const hostId = '123456789';
  const sid = 'session-1';
  const prsH = await derivePasswordSecret(slot, hostPw, hostId);
  const prsV = await derivePasswordSecret(slot, viewerPw, hostId);
  const h = cpaceStart(prsH, ciH, sid, slot);
  const v = cpaceStart(prsV, ciV, sid, slot);
  const iskV = cpaceFinish(v, h.Y, 'viewer');
  const iskH = cpaceFinish(h, v.Y, 'host');
  const tagV = confirmationTag(iskV, 'viewer', sid, ciV);
  return { hostAccepts: verifyConfirmation(iskH, 'viewer', sid, ciH, tagV), same: toBase64Url(iskV) === toBase64Url(iskH) };
}

test('cpace: matching passwords agree on a key', async () => {
  const r = await run('k7m p2x', 'K7M-P2X', 'otp');
  assert.ok(r.same);
  assert.ok(r.hostAccepts);
  const p = await run('Correct Horse 1', 'Correct Horse 1', 'perm');
  assert.ok(p.same && p.hostAccepts);
});

test('cpace: wrong password fails', async () => {
  const r = await run('k7mp2y', 'k7mp2x', 'otp');
  assert.ok(!r.same);
  assert.ok(!r.hostAccepts);
  const p = await run('correct horse 1', 'Correct Horse 1', 'perm');
  assert.ok(!p.hostAccepts, 'permanent passwords are case sensitive');
});

test('cpace: channel binding defeats a DTLS man-in-the-middle', async () => {
  // Same password, but each side sees a different pair of DTLS fingerprints.
  const r = await run('k7mp2x', 'k7mp2x', 'otp', 'fpViewer|fpMitm1', 'fpHost|fpMitm2');
  assert.ok(!r.hostAccepts);
});

test('cpace: rejects invalid and identity shares', async () => {
  const prs = await derivePasswordSecret('otp', 'abc', '123456789');
  const st = cpaceStart(prs, 'ci', 'sid', 'otp');
  assert.throws(() => cpaceFinish(st, new Uint8Array(32), 'host'));
  assert.throws(() => cpaceFinish(st, new Uint8Array(31), 'host'));
  assert.throws(() => cpaceFinish(st, fromBase64Url(toBase64Url(new Uint8Array(32).fill(255))), 'host'));
});

test('one-time passwords: readable alphabet and normalisation', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generateOneTimePassword(6);
    assert.match(pw, /^[2-9a-hjkmnp-z]{6}$/);
  }
  assert.equal(normalizeOneTimePassword(' K7M-p2x '), 'k7mp2x');
});

test('security code is deterministic and formatted', () => {
  assert.equal(securityCode('a|b'), securityCode('a|b'));
  assert.notEqual(securityCode('a|b'), securityCode('a|c'));
  assert.match(securityCode('x'), /^\d{4} \d{4}$/);
  assert.ok(utf8('x').length === 1);
});

test('key hashes are 128-bit, stable and distinct', async () => {
  const { keyHash, isKeyHash } = await import('../src/identity.ts');
  const a = Identity.generate();
  assert.ok(isKeyHash(keyHash(a.publicKeyB64)));
  assert.equal(keyHash(a.publicKeyB64), keyHash(a.publicKeyB64));
  assert.notEqual(keyHash(a.publicKeyB64), keyHash(Identity.generate().publicKeyB64));
  assert.ok(!isKeyHash('short'));
});

test('acceptance signatures bind session, channel, viewer, slot and permissions', async () => {
  const { acceptTranscript } = await import('../src/protocol.ts');
  const host = Identity.generate();
  const perms = { control: true, clipboard: false, files: true, audio: false };
  const msg = acceptTranscript('sid', 'ci', '123456789', 'otp', perms);
  const sig = host.sign(utf8(msg));
  assert.ok(verifySignature(host.publicKeyB64, utf8(msg), sig));
  for (const tampered of [
    acceptTranscript('sid', 'ci', '123456789', 'otp', { ...perms, clipboard: true }),
    acceptTranscript('sid', 'ci2', '123456789', 'otp', perms),
    acceptTranscript('sid', 'ci', '987654321', 'otp', perms),
    acceptTranscript('sid', 'ci', '123456789', null, perms),
  ]) {
    assert.ok(!verifySignature(host.publicKeyB64, utf8(tampered), sig));
  }
});

test('permanent password secrets are identical with and without WebCrypto', async () => {
  const withSubtle = await derivePasswordSecret('perm', 'correct horse battery', '123456789');
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: original.getRandomValues.bind(original) }, configurable: true });
  try {
    const pure = await derivePasswordSecret('perm', 'correct horse battery', '123456789');
    assert.deepEqual(pure, withSubtle);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  }
});
