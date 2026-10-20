import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import {
  ATTR,
  CLASS,
  METHOD,
  buildStun,
  createTurnServer,
  decodeXorAddress,
  encodeAddress,
  longTermKey,
  parseStun,
  restPassword,
  type TurnServer,
} from '../src/turn.ts';

const SECRET = 'turn-test-secret-0123456789';
const REALM = 'beamdesk';
let turn: TurnServer;
let port: number;

before(async () => {
  turn = createTurnServer({
    port: 0,
    secret: SECRET,
    relayAddress: '127.0.0.1',
    bindingRate: 1000,
  });
  port = await turn.listen();
});

after(() => turn.close());

/** A UDP socket that collects what it receives. */
async function udp() {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  const inbox: Buffer[] = [];
  const waiters: (() => void)[] = [];
  s.on('message', (m) => {
    inbox.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  return {
    socket: s,
    port: s.address().port,
    send: (b: Buffer, to = port) => s.send(b, to, '127.0.0.1'),
    async next(timeout = 2000): Promise<Buffer> {
      const deadline = Date.now() + timeout;
      while (!inbox.length) {
        if (Date.now() > deadline) throw new Error('timeout');
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
      return inbox.shift()!;
    },
    async nothing(ms = 300) {
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(inbox.length, 0, 'expected no packet');
    },
    close: () => s.close(),
  };
}

const tid = () => crypto.randomBytes(12);
const errorCode = (m: NonNullable<ReturnType<typeof parseStun>>) => {
  const v = m.attrs.find((a) => a.type === ATTR.ERROR_CODE)?.value;
  return v ? v[2] * 100 + v[3] : 0;
};
const attrOf = (m: NonNullable<ReturnType<typeof parseStun>>, t: number) => m.attrs.find((a) => a.type === t)?.value;
const transport = (): [number, Buffer] => [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])];
const lifetime = (s: number): [number, Buffer] => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(s);
  return [ATTR.LIFETIME, b];
};

function credentials(deviceId = '123456789', ttl = 600) {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${deviceId}`;
  return { username, key: longTermKey(username, REALM, restPassword(SECRET, username)) };
}

/** Allocates a relay the way a WebRTC client does: unauthenticated first, then with the nonce. */
async function allocate(c: Awaited<ReturnType<typeof udp>>, cred = credentials(), extra: [number, Buffer][] = []) {
  c.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [transport()]));
  const challenge = parseStun(await c.next())!;
  assert.equal(challenge.cls, CLASS.ERROR);
  assert.equal(errorCode(challenge), 401);
  const nonce = attrOf(challenge, ATTR.NONCE)!;
  assert.equal(attrOf(challenge, ATTR.REALM)!.toString(), REALM);
  const auth = (): [number, Buffer][] => [
    [ATTR.USERNAME, Buffer.from(cred.username)],
    [ATTR.REALM, Buffer.from(REALM)],
    [ATTR.NONCE, nonce],
  ];
  const t = tid();
  c.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, t, [transport(), ...extra, ...auth()], cred.key));
  const res = parseStun(await c.next())!;
  return { res, tid: t, auth, key: cred.key };
}

test('STUN binding returns the mapped address', async () => {
  const c = await udp();
  const t = tid();
  c.send(buildStun(METHOD.BINDING, CLASS.REQUEST, t, []));
  const res = parseStun(await c.next())!;
  assert.equal(res.cls, CLASS.SUCCESS);
  assert.deepEqual(decodeXorAddress(attrOf(res, ATTR.XOR_MAPPED_ADDRESS), t), { address: '127.0.0.1', port: c.port });
  c.close();
});

test('garbage and oversized packets are ignored', async () => {
  const c = await udp();
  c.send(crypto.randomBytes(100));
  c.send(Buffer.alloc(5000));
  c.send(Buffer.from([0x40, 0x00, 0xff, 0xff])); // ChannelData without an allocation
  await c.nothing();
  c.close();
});

test('allocation needs valid, unexpired REST credentials', async () => {
  const wrong = await udp();
  const bad = { username: credentials().username, key: longTermKey(credentials().username, REALM, 'not-the-password') };
  const r1 = await allocate(wrong, bad);
  assert.equal(r1.res.cls, CLASS.ERROR);
  assert.equal(errorCode(r1.res), 401);
  wrong.close();

  const expired = await udp();
  const r2 = await allocate(expired, credentials('123456789', -10));
  assert.equal(errorCode(r2.res), 401);
  expired.close();

  const forged = await udp();
  const username = `${Math.floor(Date.now() / 1000) + 600}:not-an-id`;
  const r3 = await allocate(forged, { username, key: longTermKey(username, REALM, restPassword(SECRET, username)) });
  assert.equal(errorCode(r3.res), 401);
  forged.close();

  // A nonce made for another address is not accepted.
  const a = await udp();
  a.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [transport()]));
  const nonce = attrOf(parseStun(await a.next())!, ATTR.NONCE)!;
  const tampered = Buffer.from(nonce.toString().replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')));
  const cred = credentials();
  a.send(
    buildStun(
      METHOD.ALLOCATE,
      CLASS.REQUEST,
      tid(),
      [transport(), [ATTR.USERNAME, Buffer.from(cred.username)], [ATTR.REALM, Buffer.from(REALM)], [ATTR.NONCE, tampered]],
      cred.key,
    ),
  );
  assert.equal(errorCode(parseStun(await a.next())!), 401);
  a.close();
  assert.equal(turn.stats().allocations, 0);
});

test('only UDP relays are offered', async () => {
  const c = await udp();
  c.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [[ATTR.REQUESTED_TRANSPORT, Buffer.from([6, 0, 0, 0])]]));
  const nonce = attrOf(parseStun(await c.next())!, ATTR.NONCE)!;
  const cred = credentials();
  c.send(
    buildStun(
      METHOD.ALLOCATE,
      CLASS.REQUEST,
      tid(),
      [[ATTR.REQUESTED_TRANSPORT, Buffer.from([6, 0, 0, 0])], [ATTR.USERNAME, Buffer.from(cred.username)], [ATTR.REALM, Buffer.from(REALM)], [ATTR.NONCE, nonce]],
      cred.key,
    ),
  );
  assert.equal(errorCode(parseStun(await c.next())!), 442);
  c.close();
});

/** Sends an authenticated request on an allocation and returns the parsed answer. */
async function request(c: Awaited<ReturnType<typeof udp>>, alloc: Awaited<ReturnType<typeof allocate>>, method: number, attrs: (t: Buffer) => [number, Buffer][]) {
  const t = tid();
  c.send(buildStun(method, CLASS.REQUEST, t, [...attrs(t), ...alloc.auth()], alloc.key));
  return parseStun(await c.next())!;
}

const sendIndication = (c: Awaited<ReturnType<typeof udp>>, to: { address: string; port: number }, data: string) => {
  const t = tid();
  c.send(buildStun(METHOD.SEND, CLASS.INDICATION, t, [[ATTR.XOR_PEER_ADDRESS, encodeAddress(to, t, true)], [ATTR.DATA, Buffer.from(data)]]));
};

test('relays between two allocations through Send/Data indications and channels', async () => {
  const a = await udp();
  const b = await udp();
  const allocA = await allocate(a, credentials('100000001'));
  const allocB = await allocate(b, credentials('100000002'));
  assert.equal(allocA.res.cls, CLASS.SUCCESS, `allocate failed with ${errorCode(allocA.res)}`);
  assert.equal(allocB.res.cls, CLASS.SUCCESS);
  const relayA = decodeXorAddress(attrOf(allocA.res, ATTR.XOR_RELAYED_ADDRESS), allocA.res.tid)!;
  const relayB = decodeXorAddress(attrOf(allocB.res, ATTR.XOR_RELAYED_ADDRESS), allocB.res.tid)!;
  assert.equal(relayA.address, '127.0.0.1');
  assert.equal(turn.stats().allocations, 2);

  // Without a permission nothing passes.
  sendIndication(a, relayB, 'early');
  await b.nothing();

  const peerAttr = (to: { address: string; port: number }) => (t: Buffer): [number, Buffer][] => [[ATTR.XOR_PEER_ADDRESS, encodeAddress(to, t, true)]];
  assert.equal((await request(a, allocA, METHOD.CREATE_PERMISSION, peerAttr(relayB))).cls, CLASS.SUCCESS);
  assert.equal((await request(b, allocB, METHOD.CREATE_PERMISSION, peerAttr(relayA))).cls, CLASS.SUCCESS);

  sendIndication(a, relayB, 'hello b');
  const data = parseStun(await b.next())!;
  assert.equal(data.method, METHOD.DATA);
  assert.equal(attrOf(data, ATTR.DATA)!.toString(), 'hello b');
  assert.deepEqual(decodeXorAddress(attrOf(data, ATTR.XOR_PEER_ADDRESS), data.tid), relayA);

  // Channels: a 4-byte header instead of a STUN message.
  const bound = await request(b, allocB, METHOD.CHANNEL_BIND, (t) => [[ATTR.CHANNEL_NUMBER, Buffer.from([0x40, 0x01, 0, 0])], ...peerAttr(relayA)(t)]);
  assert.equal(bound.cls, CLASS.SUCCESS);
  const payload = Buffer.from('over a channel');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt16BE(0x4001, 0);
  frame.writeUInt16BE(payload.length, 2);
  payload.copy(frame, 4);
  b.send(frame);
  const got = parseStun(await a.next())!;
  assert.equal(attrOf(got, ATTR.DATA)!.toString(), 'over a channel');
  sendIndication(a, relayB, 'back');
  const back = await b.next();
  assert.equal(back.readUInt16BE(0), 0x4001, 'data from a bound peer arrives as ChannelData');
  assert.equal(back.subarray(4).toString(), 'back');

  // Refresh with lifetime 0 frees the allocation.
  for (const [c, alloc] of [[a, allocA], [b, allocB]] as const) {
    assert.equal((await request(c, alloc, METHOD.REFRESH, () => [lifetime(0)])).cls, CLASS.SUCCESS);
  }
  assert.equal(turn.stats().allocations, 0);
  assert.ok(turn.stats().bytesRelayed > 0);
  a.close();
  b.close();
});

test('never relays to anything but its own allocations', async () => {
  const client = await udp();
  const outsider = await udp(); // some other program on this computer
  const alloc = await allocate(client, credentials('987654321'));
  assert.equal(alloc.res.cls, CLASS.SUCCESS);
  const relay = decodeXorAddress(attrOf(alloc.res, ATTR.XOR_RELAYED_ADDRESS), alloc.res.tid)!;
  const peerAttr = (to: { address: string; port: number }) => (t: Buffer): [number, Buffer][] => [[ATTR.XOR_PEER_ADDRESS, encodeAddress(to, t, true)]];

  // A device on the home network, or the internet: not even a permission.
  for (const address of ['10.0.0.7', '192.168.1.1', '8.8.8.8']) {
    assert.equal(errorCode(await request(client, alloc, METHOD.CREATE_PERMISSION, peerAttr({ address, port: 8080 }))), 403, address);
  }
  // This computer's other ports (a local service) cannot be bound to a channel...
  const local = { address: '127.0.0.1', port: outsider.port };
  const ch = (t: Buffer): [number, Buffer][] => [[ATTR.CHANNEL_NUMBER, Buffer.from([0x40, 0x02, 0, 0])], ...peerAttr(local)(t)];
  assert.equal(errorCode(await request(client, alloc, METHOD.CHANNEL_BIND, ch)), 403);
  // ...nor reached with a Send indication, even with a permission for the address.
  assert.equal((await request(client, alloc, METHOD.CREATE_PERMISSION, peerAttr(local))).cls, CLASS.SUCCESS);
  sendIndication(client, local, 'probe');
  sendIndication(client, { address: '127.0.0.1', port: 22 }, 'probe');
  await outsider.nothing();
  // And what such a program sends to the relay port is not passed on.
  outsider.send(Buffer.from('spoof'), relay.port);
  await client.nothing();

  assert.equal((await request(client, alloc, METHOD.REFRESH, () => [lifetime(0)])).cls, CLASS.SUCCESS);
  client.close();
  outsider.close();
});

test('a second allocation on the same 5-tuple is a mismatch, a retransmission is answered again', async () => {
  const client = await udp();
  const first = await allocate(client, credentials('111222333'));
  assert.equal(first.res.cls, CLASS.SUCCESS);
  // Same transaction ID: the answer was lost, send it again.
  client.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, first.tid, [transport(), ...first.auth()], first.key));
  const again = parseStun(await client.next())!;
  assert.equal(again.cls, CLASS.SUCCESS);
  assert.deepEqual(decodeXorAddress(attrOf(again, ATTR.XOR_RELAYED_ADDRESS), again.tid)?.port, decodeXorAddress(attrOf(first.res, ATTR.XOR_RELAYED_ADDRESS), first.res.tid)?.port);
  client.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [transport(), ...first.auth()], first.key));
  assert.equal(errorCode(parseStun(await client.next())!), 437);
  assert.equal(turn.stats().allocations, 1);
  const t = tid();
  client.send(buildStun(METHOD.REFRESH, CLASS.REQUEST, t, [lifetime(0), ...first.auth()], first.key));
  await client.next();
  client.close();
});

test('per-device allocation quota', async () => {
  const small = createTurnServer({ port: 0, secret: SECRET, relayAddress: '127.0.0.1', maxAllocationsPerUser: 2 });
  const smallPort = await small.listen();
  const clients = await Promise.all([udp(), udp(), udp()]);
  const results: number[] = [];
  for (const c of clients) {
    const send = c.send;
    c.send = (b: Buffer) => send(b, smallPort);
    const { res } = await allocate(c, credentials('555666777'));
    results.push(res.cls === CLASS.SUCCESS ? 200 : errorCode(res));
  }
  assert.deepEqual(results, [200, 200, 486]);
  assert.equal(small.stats().allocations, 2);
  await small.close();
  assert.equal(small.stats().allocations, 0);
  clients.forEach((c) => c.close());
});

test('unknown comprehension-required attributes are rejected', async () => {
  const c = await udp();
  c.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [transport(), [0x0031, Buffer.alloc(4)]]));
  const res = parseStun(await c.next())!;
  assert.equal(errorCode(res), 420);
  assert.equal(attrOf(res, ATTR.UNKNOWN_ATTRIBUTES)!.readUInt16BE(0), 0x0031);
  c.close();
});

test('cannot be used to bounce traffic: answers to strangers are rate limited', async () => {
  const strict = createTurnServer({ port: 0, secret: SECRET, relayAddress: '127.0.0.1', bindingRate: 5 });
  const strictPort = await strict.listen();
  const c = await udp();
  let answers = 0;
  c.socket.on('message', () => answers++);
  for (let i = 0; i < 100; i++) {
    c.send(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, tid(), [transport()]), strictPort);
    c.send(buildStun(METHOD.BINDING, CLASS.REQUEST, tid(), []), strictPort);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(answers <= 12, `answered ${answers} of 200`);
  assert.ok(answers >= 5);
  await strict.close();
  c.close();
});
