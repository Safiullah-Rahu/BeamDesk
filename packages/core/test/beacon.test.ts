import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { BeaconServer, BeaconSocket, beaconKeypair, beaconTopic, BEACON_KIND, type BeaconConnection } from '../src/beacon.ts';
import { signEvent, nostrKeypair, verifyEvent, eventHash } from '../src/nostr.ts';
import { randomBytes, toBase64Url } from '../src/util.ts';
import { startRelay, type TestRelay } from './nostr-relay.ts';

const relays: TestRelay[] = [];
after(() => Promise.all(relays.map((r) => r.close())));

async function relay(): Promise<TestRelay> {
  const r = await startRelay();
  relays.push(r);
  return r;
}

/** A home server that echoes every frame back, upper-cased. */
function echoServer(urls: string[], key = beaconKeypair(), psk = randomBytes(16)) {
  const conns: BeaconConnection[] = [];
  const server = new BeaconServer({
    secret: key.secret,
    psk,
    relays: urls,
    info: () => ({ name: 'Home PC', addresses: [{ kind: 'lan', host: '192.168.1.20', port: 41443 }] }),
    onConnection: (c) => {
      conns.push(c);
      c.onframe = (f) => c.send(f.toUpperCase());
    },
  });
  server.start();
  return { server, conns, target: { key: toBase64Url(key.public), psk: toBase64Url(psk), relays: urls } };
}

function open(s: BeaconSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    s.onopen = () => resolve();
    s.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`));
  });
}

function nextMessage(s: BeaconSocket): Promise<string> {
  return new Promise((resolve) => (s.onmessage = (e) => resolve(e.data)));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('events are signed and verifiable like any Nostr event', () => {
  const k = nostrKeypair();
  const e = signEvent(k.secret, BEACON_KIND, [['p', 'ab'.repeat(32)]], 'hello');
  assert.ok(verifyEvent(e));
  assert.equal(e.id, eventHash(e));
  assert.ok(!verifyEvent({ ...e, content: 'tampered' }));
  assert.ok(!verifyEvent({ ...e, sig: '00'.repeat(64) }));
});

test('topics change daily and depend on the code', () => {
  const k = beaconKeypair();
  const psk = randomBytes(16);
  assert.match(beaconTopic(psk, k.public, 20000), /^[0-9a-f]{64}$/);
  assert.notEqual(beaconTopic(psk, k.public, 20000), beaconTopic(psk, k.public, 20001));
  assert.notEqual(beaconTopic(psk, k.public, 20000), beaconTopic(randomBytes(16), k.public, 20000));
});

test('a device with the code reaches the server through the relays', async () => {
  const a = await relay();
  const b = await relay();
  const { server, conns, target } = echoServer([a.url, b.url]);
  await wait(200);
  let info: unknown = null;
  const s = new BeaconSocket('beacon:', target, { onInfo: (i) => (info = i) });
  await open(s);
  assert.deepEqual(info, { name: 'Home PC', addresses: [{ kind: 'lan', host: '192.168.1.20', port: 41443 }] });
  const reply = nextMessage(s);
  s.send('hello through the relays');
  assert.equal(await reply, 'HELLO THROUGH THE RELAYS');
  assert.equal(conns.length, 1, 'two relays, one connection');
  assert.equal(server.status().clients, 1);
  assert.equal(server.status().relays, 2);

  // Relays only ever see ciphertext.
  const all = [...a.accepted, ...b.accepted];
  assert.ok(all.length > 0);
  assert.ok(all.every((e) => !e.content.includes('hello') && !Buffer.from(e.content, 'base64url').toString('latin1').includes('hello')));

  // Big frames are cut into chunks and put back together, in order.
  const big = 'x'.repeat(100_000) + 'end';
  const got: string[] = [];
  s.onmessage = (e) => got.push(e.data);
  for (let i = 0; i < 5; i++) s.send(`${i}:${big}`);
  for (let i = 0; i < 100 && got.length < 5; i++) await wait(50);
  assert.deepEqual(got, [0, 1, 2, 3, 4].map((i) => `${i}:${big}`.toUpperCase()));

  // Closing tells the other side.
  const closed = new Promise<void>((r) => (conns[0].onclose = () => r()));
  s.close();
  await closed;
  assert.equal(server.status().clients, 0);
  server.stop();
});

test('without the access key, or to another server, nothing happens', async () => {
  const r = await relay();
  const { server, conns, target } = echoServer([r.url]);
  await wait(150);
  const wrongKey = new BeaconSocket('beacon:', { ...target, psk: toBase64Url(randomBytes(16)) }, { timeoutMs: 2500 });
  await assert.rejects(open(wrongKey), /closed 1006/);
  const wrongServer = new BeaconSocket('beacon:', { ...target, key: toBase64Url(beaconKeypair().public) }, { timeoutMs: 2500 });
  await assert.rejects(open(wrongServer), /closed 1006/);
  assert.equal(conns.length, 0);
  server.stop();
});

test('lost events are made up for by the other relays; duplicates and reordering are handled', async () => {
  const a = await relay();
  const b = await relay();
  const c = await relay();
  // Each relay loses about a third of everything; one also delivers late.
  let n = 0;
  a.drop = () => n++ % 3 === 0;
  b.drop = () => n++ % 3 === 1;
  c.delay = () => (n % 2 ? 120 : 0);
  const { server, target } = echoServer([a.url, b.url, c.url]);
  await wait(200);
  const s = new BeaconSocket('beacon:', target);
  await open(s);
  const got: string[] = [];
  s.onmessage = (e) => got.push(e.data);
  for (let i = 0; i < 30; i++) {
    s.send(`msg ${i}`);
    await wait(5);
  }
  for (let i = 0; i < 100 && got.length < 30; i++) await wait(50);
  assert.deepEqual(got, Array.from({ length: 30 }, (_, i) => `MSG ${i}`));
  s.close();
  server.stop();
});

test('a misbehaving relay cannot block, forge or replay messages', async () => {
  const honest = await relay();
  const evil = await relay();
  const { server, conns, target } = echoServer([honest.url, evil.url]);
  await wait(200);
  const s = new BeaconSocket('beacon:', target);
  await open(s);
  // The evil relay copies real events' ids onto garbage, and replays old events.
  const seen = [...honest.accepted];
  evil.inject((sub) => ['EVENT', sub, { ...seen[0], content: 'AAAA' }]);
  for (const e of seen) evil.inject((sub) => ['EVENT', sub, e]);
  const reply = nextMessage(s);
  s.send('still fine');
  assert.equal(await reply, 'STILL FINE');
  // A replayed handshake from a recorded session does not open a second connection.
  for (const e of [...honest.accepted]) evil.inject((sub) => ['EVENT', sub, e]);
  await wait(300);
  assert.equal(conns.length, 1);
  s.close();
  server.stop();
});

test('works while some relays are down, and a server that went away is noticed', async () => {
  const up = await relay();
  const { server, target } = echoServer(['ws://127.0.0.1:1', up.url]);
  await wait(200);
  const s = new BeaconSocket('beacon:', { ...target, relays: ['ws://127.0.0.1:1', up.url] });
  await open(s);
  const reply = nextMessage(s);
  s.send('one relay is enough');
  assert.equal(await reply, 'ONE RELAY IS ENOUGH');
  const closed = new Promise<number>((r) => (s.onclose = (e) => r(e.code)));
  server.stop();
  assert.equal(await closed, 1006, 'the client learns that the server hung up');
});

test('a slow answer makes the device ask again, but still opens exactly one connection', async () => {
  const r = await relay();
  const { server, conns, target } = echoServer([r.url]);
  await wait(150);
  const topics = new Set<string>();
  // Hold back everything the server sends for 2.5 s: the device repeats its request meanwhile.
  r.delay = (e) => (topics.has(e.tags[0][1]) ? 0 : 2500);
  const s = new BeaconSocket('beacon:', target);
  await wait(50);
  for (const e of r.accepted) topics.add(e.tags[0][1]);
  await open(s);
  const inits = r.accepted.filter((e) => topics.has(e.tags[0][1])).length;
  assert.ok(inits >= 2, `asked ${inits} times`);
  assert.equal(conns.length, 1);
  r.delay = null;
  const reply = nextMessage(s);
  s.send('once');
  assert.equal(await reply, 'ONCE');
  s.close();
  server.stop();
});
