import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import WebSocket from 'ws';
import { createHostSecrets, hostSecretsValid, probeServer, startHostMode, type HostMode, type HostSecrets } from '../src/hostmode.ts';
import { fingerprintOf } from '../src/cert.ts';
import { requestHost } from '../src/server.ts';
import { ATTR, CLASS, METHOD, buildStun, longTermKey, parseStun } from '../src/turn.ts';
import { decodeJoinCode } from '../../packages/core/src/joincode.ts';
import { Identity } from '../../packages/core/src/identity.ts';
import { SignalingClient } from '../../packages/core/src/signaling.ts';

let secrets: HostSecrets;
let host: HostMode;
let port: number;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-host-'));

/** A port free for both TCP and UDP. */
async function freePort(): Promise<number> {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 30000);
    const tcpFree = await new Promise<boolean>((r) => {
      const s = net.createServer().once('error', () => r(false));
      s.listen(p, '0.0.0.0', () => s.close(() => r(true)));
    });
    const udpFree = await new Promise<boolean>((r) => {
      const s = dgram.createSocket('udp4').once('error', () => r(false));
      s.bind(p, '0.0.0.0', () => s.close(() => r(true)));
    });
    if (tcpFree && udpFree) return p;
  }
}

/** A WebSocket that accepts exactly the pinned certificate, like the desktop app. */
const pinned = (fingerprint: string) => (url: string) => {
  // No CA vouches for a home server: the fingerprint check below is the whole verification.
  const ws = new WebSocket(url, { rejectUnauthorized: false });
  ws.on('upgrade', (res) => {
    const cert = (res.socket as tls.TLSSocket).getPeerCertificate();
    if (!cert?.raw || fingerprintOf(cert.raw) !== fingerprint) ws.terminate();
  });
  return ws as unknown as globalThis.WebSocket;
};

before(async () => {
  secrets = createHostSecrets();
  port = await freePort();
  host = await startHostMode({ port, dataDir, webRoot: null, name: 'Test home', secrets, portMapping: false });
});

after(async () => {
  await host.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('secrets are generated complete and checked', () => {
  assert.ok(hostSecretsValid(secrets));
  assert.ok(!hostSecretsValid({ ...secrets, accessKey: 'short' }));
  assert.ok(!hostSecretsValid({ ...secrets, key: createHostSecrets().key }), 'key from another certificate');
  assert.ok(!hostSecretsValid({ ...secrets, turnSecret: 'x' }));
  assert.ok(!hostSecretsValid(null));
});

test('the connection code carries the pinned certificate and the access key', () => {
  const s = host.status();
  assert.equal(s.state, 'running');
  assert.equal(s.port, port);
  const code = decodeJoinCode(s.code)!;
  assert.ok(code, 'valid code');
  assert.equal(code.name, 'Test home');
  assert.equal(code.fingerprint, fingerprintOf(secrets.cert));
  assert.equal(code.accessKey, secrets.accessKey);
  assert.ok(code.addresses.length >= 1);
  assert.ok(code.addresses.every((a) => a.port === port));
  assert.equal(s.internet.mapping, 'off');
});

test('only TLS 1.3 with the host certificate is spoken', async () => {
  assert.ok(await probeServer('127.0.0.1', port, fingerprintOf(secrets.cert)));
  assert.ok(!(await probeServer('127.0.0.1', port, fingerprintOf(createHostSecrets().cert))), 'another certificate does not match');
  const old = await new Promise<string>((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, maxVersion: 'TLSv1.2', rejectUnauthorized: false });
    s.once('secureConnect', () => resolve('connected'));
    s.once('error', (e) => resolve(e.message));
  });
  assert.notEqual(old, 'connected', 'TLS 1.2 is refused');
  // Plain HTTP on the TLS port gets nowhere.
  const plain = await fetch(`http://127.0.0.1:${port}/api/info`).then(
    (r) => r.status,
    () => 'failed',
  );
  assert.equal(plain, 'failed');
});

test('devices with the code register and get the built-in relay; others are refused', async (t) => {
  const fp = fingerprintOf(secrets.cert);
  const make = (accessKey: string, url: string | string[] = `wss://127.0.0.1:${port}/ws`) =>
    new SignalingClient({ url, identity: Identity.generate(), name: 'T', platform: 'linux', accessKey, createWebSocket: pinned(fp) });

  // Several addresses for one server: unreachable ones do not stop the working one.
  const a = make(secrets.accessKey, [`wss://127.0.0.1:1/ws`, `wss://127.0.0.1:${port}/ws`]);
  t.after(() => a.stop());
  a.start();
  await a.waitOnline(8000);
  assert.equal(a.url, `wss://127.0.0.1:${port}/ws`);
  const stun = a.ice.find((s) => String(s.urls).startsWith('stun:'))!;
  const turn = a.ice.find((s) => String(s.urls).startsWith('turn:'))!;
  assert.ok(stun && turn, 'own STUN and TURN, nothing else');
  assert.equal(a.ice.length, 2);
  assert.match(String(turn.urls), new RegExp(`:${port}\\?transport=udp$`));
  const lan = host.status().lan;
  if (lan) assert.ok(String(turn.urls).includes(lan), 'loopback clients are given the network address');

  // The credential opens the relay.
  const relayHost = /^turn:([\d.]+):/.exec(String(turn.urls))![1];
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, () => r()));
  const ask = (msg: Buffer) =>
    new Promise<ReturnType<typeof parseStun>>((resolve) => {
      sock.once('message', (m) => resolve(parseStun(m)));
      sock.send(msg, port, relayHost);
    });
  const transport: [number, Buffer] = [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])];
  const challenge = (await ask(buildStun(METHOD.ALLOCATE, CLASS.REQUEST, crypto.randomBytes(12), [transport])))!;
  const nonce = challenge.attrs.find((x) => x.type === ATTR.NONCE)!.value;
  const key = longTermKey(turn.username!, 'beamdesk', String(turn.credential));
  const res = (await ask(
    buildStun(METHOD.ALLOCATE, CLASS.REQUEST, crypto.randomBytes(12), [transport, [ATTR.USERNAME, Buffer.from(turn.username!)], [ATTR.REALM, Buffer.from('beamdesk')], [ATTR.NONCE, nonce]], key),
  ))!;
  assert.equal(res.cls, CLASS.SUCCESS, 'relay allocation with the issued credential');
  sock.close();

  // Wrong access key.
  const b = make(crypto.randomBytes(16).toString('base64url'));
  t.after(() => b.stop());
  b.start();
  await assert.rejects(b.waitOnline(8000), /access key/);
  assert.equal(b.lastError?.code, 'access-key');
  b.stop();

  // A server with another certificate (someone posing as this one) is never talked to.
  const c = new SignalingClient({ url: `wss://127.0.0.1:${port}/ws`, identity: Identity.generate(), name: 'T', platform: 'linux', accessKey: secrets.accessKey, createWebSocket: pinned(fingerprintOf(createHostSecrets().cert)) });
  t.after(() => c.stop());
  c.start();
  await assert.rejects(c.waitOnline(1500));
  c.stop();

  await new Promise((r) => setTimeout(r, 5500)); // the device counter updates every 5 s
  assert.equal(host.status().devices, 1);
  a.stop();
});

test('one address cannot hold many connections open', async () => {
  const sockets = Array.from({ length: 48 }, () => net.connect(port, '127.0.0.1'));
  await new Promise((r) => setTimeout(r, 500));
  const dropped = sockets.filter((s) => s.destroyed || s.readableEnded).length;
  sockets.forEach((s) => s.destroy());
  assert.ok(dropped >= 16, `dropped ${dropped} of 48`);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(await probeServer('127.0.0.1', port, fingerprintOf(secrets.cert)), 'still serving once they are gone');
});

test('the public info does not reveal the owner or the number of devices', async () => {
  const info = await new Promise<string>((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => s.end('GET /api/info HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
  assert.match(info, /"name":"BeamDesk"/);
  assert.doesNotMatch(info, /Test home/);
  assert.match(info, /"requiresKey":true/);
});

test('Host headers are only used when they are plain addresses or names', () => {
  assert.equal(requestHost('81.2.69.160:41443'), '81.2.69.160');
  assert.equal(requestHost('[2001:db8::1]:41443'), '2001:db8::1');
  assert.equal(requestHost('My-Home.duckdns.org'), 'my-home.duckdns.org');
  assert.equal(requestHost('evil.com/?x'), null);
  assert.equal(requestHost('a b'), null);
  assert.equal(requestHost(undefined), null);
  assert.equal(requestHost('x'.repeat(400)), null);
});

test('a port that is taken gives a clear error', async () => {
  await assert.rejects(startHostMode({ port, dataDir, webRoot: null, name: 'Second', secrets, portMapping: false }), /already used by another program/);
});
