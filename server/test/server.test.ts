import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { configErrors, configWarnings, loadConfig } from '../src/config.ts';
import { createBeamServer, jsonDepthOk, rateLimitKey, type BeamServer } from '../src/server.ts';
import { Identity, registrationMessage } from '../../packages/core/src/identity.ts';
import { SignalingClient, type IncomingSignal } from '../../packages/core/src/signaling.ts';

let server: BeamServer;
let url: string;
let base: string;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-test-'));

before(async () => {
  server = createBeamServer(
    loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, WEB_ROOT: '', TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: 'test-secret-0123456789' }),
  );
  const port = await server.listen();
  url = `ws://127.0.0.1:${port}/ws`;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const client = (identity = Identity.generate(), extra: Partial<ConstructorParameters<typeof SignalingClient>[0]> = {}) =>
  new SignalingClient({ url, identity, name: 'Test', platform: 'linux', ...extra });

const next = <T>(c: SignalingClient, event: 'signal' | 'undeliverable' | 'state'): Promise<T> =>
  new Promise((resolve) => {
    const off = c.on(event as 'signal', (v) => {
      off();
      resolve(v as T);
    });
  });

test('devices register and receive TURN credentials', async () => {
  const a = client();
  a.start();
  await a.waitOnline();
  const turn = a.ice.find((s) => String(s.urls).includes('turn:'));
  assert.ok(turn?.username?.endsWith(`:${a.id}`), 'ephemeral username is bound to the device ID');
  assert.ok(turn?.credential);
  const fresh = await a.refreshIce();
  assert.ok(fresh.length >= 2);
  a.stop();
});

test('signals are relayed between online devices with a verified sender ID', async () => {
  const a = client();
  const b = client();
  a.start();
  b.start();
  await Promise.all([a.waitOnline(), b.waitOnline()]);
  const got = next<IncomingSignal>(b, 'signal');
  assert.ok(a.send(b.id, 'sid-1', 'offer', { sdp: 'x' }));
  const s = await got;
  assert.equal(s.from, a.id);
  assert.equal(s.sid, 'sid-1');
  assert.equal(s.kind, 'offer');
  assert.deepEqual(s.data, { sdp: 'x' });

  const presence = await a.presence([b.id, '999999999']);
  assert.deepEqual(presence, { [b.id]: true, '999999999': false });

  const miss = next<{ reason: string }>(a, 'undeliverable');
  a.send('999999999', 'sid-2', 'offer', {});
  assert.equal((await miss).reason, 'offline');
  a.stop();
  b.stop();
});

test('a second connection with the same identity replaces the first', async () => {
  const id = Identity.generate();
  const first = client(id);
  first.start();
  await first.waitOnline();
  const replaced = next<string>(first, 'state');
  const second = client(id);
  second.start();
  await second.waitOnline();
  assert.equal(await replaced, 'replaced');
  second.stop();
  first.stop();
});

async function rawRegister(pk: string, sign: (challenge: string) => string) {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  await new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      messages.push(m);
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'register', pk, sig: sign(m.challenge), name: 'x', platform: 'web', version: '1' }));
      else resolve();
    };
  });
  ws.close();
  return messages[1];
}

test('registration with a bad signature is rejected', async () => {
  const id = Identity.generate();
  const other = Identity.generate();
  const res = await rawRegister(id.publicKeyB64, (c) => other.sign(registrationMessage(c)));
  assert.equal(res.t, 'error');
  assert.equal(res.code, 'bad-signature');
});

test('replayed signatures from another challenge are rejected', async () => {
  const id = Identity.generate();
  const res = await rawRegister(id.publicKeyB64, () => id.sign(registrationMessage('old-challenge')));
  assert.equal(res.code, 'bad-signature');
});

test('connection requests are rate limited per device', async () => {
  const a = client();
  const b = client();
  a.start();
  b.start();
  await Promise.all([a.waitOnline(), b.waitOnline()]);
  let limited = false;
  const off = a.on('undeliverable', (u) => {
    if (u.reason === 'rate-limited') limited = true;
  });
  for (let i = 0; i < 25; i++) a.send(b.id, `s${i}`, 'offer', {});
  await new Promise((r) => setTimeout(r, 300));
  off();
  assert.ok(limited);
  a.stop();
  b.stop();
});

test('http endpoints', async () => {
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
  const info = await fetch(`${base}/api/info`).then((r) => r.json());
  assert.equal(info.turn, true);
  assert.equal(info.requiresKey, false);
  const res = await fetch(`${base}/api/info`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('access key protects private servers', async () => {
  const priv = createBeamServer(loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, WEB_ROOT: '', ACCESS_KEY: 'team-key' }));
  const port = await priv.listen();
  const purl = `ws://127.0.0.1:${port}/ws`;
  const bad = new SignalingClient({ url: purl, identity: Identity.generate(), name: 'x', platform: 'web', accessKey: 'nope' });
  bad.start();
  await assert.rejects(bad.waitOnline(3000));
  assert.equal(bad.lastError?.code, 'access-key');
  bad.stop();
  const good = new SignalingClient({ url: purl, identity: Identity.generate(), name: 'x', platform: 'web', accessKey: 'team-key' });
  good.start();
  await good.waitOnline(3000);
  good.stop();
  await priv.close();
});

/** Opens a raw socket and returns it with the messages it receives. */
async function raw(): Promise<{ ws: WebSocket; messages: any[]; closed: Promise<number> }> {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ws, messages, closed };
}

test('deeply nested JSON is refused without crashing the server', async () => {
  const { ws, messages, closed } = await raw();
  // 20k levels used to overflow the stack in Number(m.rid) and kill the process.
  ws.send(`{"t":"ping","rid":${'['.repeat(20_000)}${']'.repeat(20_000)}}`);
  assert.equal(await closed, 4003);
  assert.ok(messages.some((m) => m.t === 'error' && m.code === 'bad-request'));
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
});

test('binary frames and non-object messages are rejected', async () => {
  const { ws, messages } = await raw();
  ws.send(new Uint8Array(16));
  ws.send('[]');
  ws.send('{"t":1}');
  ws.send('{"t":"presence","ids":["123456789"]}');
  await new Promise((r) => setTimeout(r, 200));
  const codes = messages.filter((m) => m.t === 'error').map((m) => m.code);
  assert.deepEqual(codes, ['bad-request', 'bad-request', 'bad-request', 'not-registered']);
  ws.close();
});

test('a connection may attempt registration only once', async () => {
  const { ws, messages, closed } = await raw();
  const id = Identity.generate();
  await new Promise((r) => setTimeout(r, 50));
  const challenge = messages[0].challenge;
  ws.send(JSON.stringify({ t: 'register', pk: id.publicKeyB64, sig: Identity.generate().sign(registrationMessage(challenge)) }));
  ws.send(JSON.stringify({ t: 'register', pk: id.publicKeyB64, sig: id.sign(registrationMessage(challenge)) }));
  assert.equal(await closed, 4003);
  assert.ok(!messages.some((m) => m.t === 'registered'));
});

test('oversized signals and malformed session IDs are refused', async () => {
  const a = client();
  const b = client();
  a.start();
  b.start();
  await Promise.all([a.waitOnline(), b.waitOnline()]);
  const errors: string[] = [];
  let received = 0;
  const off = b.on('signal', () => received++);
  // Bypass the client-side checks and talk to the socket directly.
  const sock = (a as unknown as { ws: WebSocket }).ws;
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(e.data as string);
    if (m.t === 'error') errors.push(m.code);
  });
  sock.send(JSON.stringify({ t: 'signal', to: b.id, sid: 'x'.repeat(65), kind: 'ice', data: {} }));
  sock.send(JSON.stringify({ t: 'signal', to: b.id, sid: 'bad sid!', kind: 'ice', data: {} }));
  sock.send(JSON.stringify({ t: 'signal', to: b.id, sid: 'okay', kind: 'ice', data: { pad: 'x'.repeat(55_000) } }));
  await new Promise((r) => setTimeout(r, 300));
  off();
  assert.equal(received, 0);
  assert.deepEqual(errors, ['bad-request', 'bad-request', 'too-large']);
  a.stop();
  b.stop();
});

test('rate limit keys group IPv6 networks and unwrap mapped IPv4', () => {
  assert.equal(rateLimitKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(rateLimitKey('198.51.100.7'), '198.51.100.7');
  assert.equal(rateLimitKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKey('::1'), '0:0:0:0::/64');
});

test('jsonDepthOk ignores brackets inside strings', () => {
  assert.equal(jsonDepthOk('{"a":"[[[[[[[[[[[[[[[[[[[[[[[["}'), true);
  assert.equal(jsonDepthOk('{"a":"\\"[[[[[[[[[[[[[[[[[[[[["}'), true);
  assert.equal(jsonDepthOk('[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]'), false);
});

test('unsafe TURN and access-key settings are refused at startup', () => {
  assert.deepEqual(configErrors(loadConfig({})), []);
  assert.equal(configErrors(loadConfig({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 'change-me-to-a-long-random-string' })).length, 1);
  assert.equal(configErrors(loadConfig({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 'short' })).length, 1);
  assert.equal(configErrors(loadConfig({ TURN_URLS: 'turn:x:3478' })).length, 1);
  assert.equal(configErrors(loadConfig({ ACCESS_KEY: 'abc' })).length, 1);
  assert.deepEqual(configErrors(loadConfig({ TURN_URLS: 'turn:x:3478', TURN_SECRET: 'a'.repeat(32), ACCESS_KEY: 'long-enough' })), []);
  assert.ok(configWarnings(loadConfig({ TURN_URLS: 'turn:x:3478', TURN_USERNAME: 'u', TURN_PASSWORD: 'p' })).length >= 1);
  assert.equal(loadConfig({}).turnTtl, 3600);
});
