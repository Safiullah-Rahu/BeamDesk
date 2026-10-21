import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJoinCode, encodeJoinCode, homeServerHosts, homeServerUrls, shortFingerprint, type HomeServer } from '../src/joincode.ts';
import { randomBytes, toBase64Url } from '../src/util.ts';

const server = (): HomeServer => ({
  name: 'Office PC',
  fingerprint: toBase64Url(randomBytes(32)),
  accessKey: toBase64Url(randomBytes(16)),
  addresses: [
    { kind: 'lan', host: '192.168.1.20', port: 41443 },
    { kind: 'tailscale', host: '100.101.102.103', port: 41443 },
    { kind: 'internet', host: '81.2.69.160', port: 41500 },
    { kind: 'name', host: 'my-home.duckdns.org', port: 41443 },
  ],
});

test('join codes round-trip', () => {
  const s = server();
  const code = encodeJoinCode(s);
  assert.match(code, /^BD1-[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 160, `short enough to paste: ${code.length}`);
  assert.deepEqual(decodeJoinCode(code), s);
  // Pasted with spaces or line breaks, as a link, or in lower case prefix.
  assert.deepEqual(decodeJoinCode(`  ${code.slice(0, 30)}\n${code.slice(30)} `), s);
  assert.deepEqual(decodeJoinCode(`beamdesk://join/${code}`), s);
  assert.deepEqual(decodeJoinCode(`bd1-${code.slice(4)}`), s);
});

test('a mistyped or tampered code is rejected', () => {
  const code = encodeJoinCode(server());
  for (let i = 4; i < code.length; i += 7) {
    const c = code[i] === 'A' ? 'B' : 'A';
    assert.equal(decodeJoinCode(code.slice(0, i) + c + code.slice(i + 1)), null, `changed character ${i}`);
  }
  assert.equal(decodeJoinCode(code.slice(0, -2)), null);
  for (const bad of ['', 'BD1-', 'BD2-AAAA', 'hello', 'BD1-!!!', `BD1-${'A'.repeat(700)}`]) assert.equal(decodeJoinCode(bad), null, bad);
});

test('invalid servers cannot be encoded', () => {
  const s = server();
  assert.throws(() => encodeJoinCode({ ...s, fingerprint: 'short' }));
  assert.throws(() => encodeJoinCode({ ...s, addresses: [{ kind: 'lan', host: '999.1.1.1', port: 1 }] }));
  assert.throws(() => encodeJoinCode({ ...s, addresses: [{ kind: 'name', host: 'evil.com/path', port: 443 }] }));
  assert.throws(() => encodeJoinCode({ ...s, addresses: [{ kind: 'lan', host: '10.0.0.1', port: 70000 }] }));
});

test('long names are shortened on a character boundary', () => {
  const s = { ...server(), name: 'Ünïcödé PC '.repeat(10) };
  const decoded = decodeJoinCode(encodeJoinCode(s))!;
  assert.ok(new TextEncoder().encode(decoded.name).length <= 48);
  assert.ok(s.name.startsWith(decoded.name));
});

test('addresses and pinned hosts', () => {
  const s = server();
  assert.deepEqual(homeServerUrls(s), ['wss://192.168.1.20:41443/ws', 'wss://100.101.102.103:41443/ws', 'wss://81.2.69.160:41500/ws', 'wss://my-home.duckdns.org:41443/ws']);
  assert.deepEqual(homeServerHosts(s), ['192.168.1.20', '100.101.102.103', '81.2.69.160', 'my-home.duckdns.org']);
  assert.match(shortFingerprint(s.fingerprint), /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
});

test('version 2 codes carry the beacon', () => {
  const s = { ...server(), beacon: { key: toBase64Url(randomBytes(32)), relays: [] as string[] } };
  const code = encodeJoinCode(s);
  assert.match(code, /^BD2-/);
  assert.deepEqual(decodeJoinCode(code), s);
  const custom = { ...s, beacon: { ...s.beacon, relays: ['wss://relay.example.org', 'wss://nostr.example.com:4443/r', 'ws://127.0.0.1:7777'] } };
  assert.deepEqual(decodeJoinCode(encodeJoinCode(custom)), custom);
  assert.throws(() => encodeJoinCode({ ...s, beacon: { ...s.beacon, relays: ['ws://relay.example.org'] } }), /relay/);
  assert.throws(() => encodeJoinCode({ ...s, beacon: { ...s.beacon, relays: ['https://x.org'] } }), /relay/);
  // A version 1 prefix on a version 2 body (or the other way round) is not accepted.
  assert.equal(decodeJoinCode(code.replace(/^BD2-/, 'BD1-')), null);
  // Without a beacon, still a version 1 code (readable by 1.1).
  assert.match(encodeJoinCode(server()), /^BD1-/);
});
