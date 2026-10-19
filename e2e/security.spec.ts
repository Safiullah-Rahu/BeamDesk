/**
 * Adversarial end-to-end tests. A tampering relay sits between the browsers and the real
 * server - the position of a malicious or compromised BeamDesk server - and tries to break
 * into, spy on or disrupt sessions. Every attack must fail safely.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { WebSocket, WebSocketServer } from 'ws';
import { Identity } from '../packages/core/src/identity.ts';
import { SignalingClient } from '../packages/core/src/signaling.ts';
import { device, deviceId, dial, expectVideo, startSharing } from './helpers.ts';

type Dir = 'up' | 'down';
interface Conn {
  id: string | null;
  /** Sends a message to the browser as if it came from the server. */
  inject(msg: unknown): void;
}
type Tamper = (dir: Dir, msg: any, conn: Conn) => any;

interface Relay {
  url: string;
  conns: Conn[];
  tamper: Tamper | null;
  close(): Promise<void>;
}

async function startRelay(upstream: string): Promise<Relay> {
  const relay: Relay = { url: '', conns: [], tamper: null, close: async () => undefined };
  const target = new URL(upstream);
  const server = http.createServer((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (client) => {
    const up = new WebSocket(`ws://${target.host}/ws`);
    const early: string[] = [];
    const conn: Conn = { id: null, inject: (msg) => client.send(JSON.stringify(msg)) };
    relay.conns.push(conn);
    const pass = (dir: Dir, raw: string) => {
      let msg = JSON.parse(raw);
      if (dir === 'down' && msg.t === 'registered') conn.id = msg.id;
      if (relay.tamper) msg = relay.tamper(dir, msg, conn);
      return msg === null ? null : JSON.stringify(msg);
    };
    client.on('message', (d) => {
      const out = pass('up', String(d));
      if (out === null) return;
      if (up.readyState === WebSocket.OPEN) up.send(out);
      else early.push(out);
    });
    up.on('open', () => early.splice(0).forEach((m) => up.send(m)));
    up.on('message', (d) => {
      const out = pass('down', String(d));
      if (out !== null && client.readyState === WebSocket.OPEN) client.send(out);
    });
    client.on('close', () => up.close());
    up.on('close', () => client.close());
    up.on('error', () => client.close());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  relay.url = `http://localhost:${(server.address() as AddressInfo).port}`;
  relay.close = () =>
    new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => r());
      server.closeAllConnections();
    });
  return relay;
}

let relay: Relay;
test.beforeEach(async ({ baseURL }) => {
  relay = await startRelay(baseURL!);
});
test.afterEach(async () => {
  await relay.close();
});

const IDENTITY_ERROR = 'The identity of the other device could not be verified.';

test('a relay that swaps the host certificate is caught before anything is shared', async ({ browser }) => {
  const host = await device(browser, relay.url);
  const viewer = await device(browser, relay.url);
  const { id } = await startSharing(host);
  relay.tamper = (dir, m) => {
    if (dir === 'down' && m.t === 'signal' && m.kind === 'answer' && m.data?.hello) {
      // Replace the DTLS fingerprint, as a man in the middle terminating DTLS would have to.
      m.data.sdp = m.data.sdp.replace(/(a=fingerprint:sha-256 )([0-9A-F]{2})/, (_: string, p: string, h: string) => p + (h === '00' ? '11' : '00'));
    }
    return m;
  };
  await dial(viewer, id);
  await expect(viewer.getByText(IDENTITY_ERROR)).toBeVisible();
  await expect(host.getByTestId('accept')).toHaveCount(0);
});

test('a forged acceptance does not start a session', async ({ browser }) => {
  const host = await device(browser, relay.url);
  const viewer = await device(browser, relay.url);
  const { id } = await startSharing(host);
  relay.tamper = (dir, m, conn) => {
    if (dir === 'down' && m.t === 'signal' && m.kind === 'pending') {
      // The prompt is showing on the host; pretend the host clicked Accept with full control.
      conn.inject({ t: 'signal', from: m.from, sid: m.sid, kind: 'auth-result', data: { ok: true, slot: null, perms: { control: true, clipboard: true, files: true, audio: true }, sig: 'A'.repeat(86) } });
      return null;
    }
    return m;
  };
  await dial(viewer, id);
  await expect(viewer.getByText(IDENTITY_ERROR)).toBeVisible();
  await expect(viewer.getByTestId('viewer')).not.toHaveAttribute('data-state', 'connected');
});

test('a relay cannot strip the password offer to downgrade authentication', async ({ browser }) => {
  const host = await device(browser, relay.url);
  const viewer = await device(browser, relay.url);
  const { id, otp } = await startSharing(host);
  relay.tamper = (dir, m) => {
    if (dir === 'down' && m.t === 'signal' && m.kind === 'answer' && m.data?.hello) m.data.hello.shares = {};
    return m;
  };
  await dial(viewer, id, otp);
  await expect(viewer.getByText(IDENTITY_ERROR)).toBeVisible();
  await expect(host.getByTestId('accept')).toHaveCount(0);
});

test('a relay cannot hang up a live session', async ({ browser }) => {
  const host = await device(browser, relay.url);
  const viewer = await device(browser, relay.url);
  const { id, otp } = await startSharing(host);
  let sid = '';
  relay.tamper = (dir, m) => {
    if (dir === 'up' && m.t === 'signal' && m.kind === 'offer' && !m.data?.restart) sid = m.sid;
    return m;
  };
  await dial(viewer, id, otp);
  await expectVideo(viewer);
  const viewerId = await deviceId(viewer);
  const [hostConn, viewerConn] = [relay.conns.find((c) => c.id === id)!, relay.conns.find((c) => c.id === viewerId)!];
  viewerConn.inject({ t: 'signal', from: id, sid, kind: 'bye', data: { reason: 'remote-closed' } });
  hostConn.inject({ t: 'signal', from: viewerId, sid, kind: 'bye', data: { reason: 'local' } });
  viewerConn.inject({ t: 'signal', from: id, sid, kind: 'pending', data: {} });
  await viewer.waitForTimeout(2500);
  await expect(viewer.getByTestId('viewer')).toHaveAttribute('data-state', 'connected');
  await expect(host.getByText('Someone is connected to this device')).toBeVisible();
});

test('only invites answering our own help link are shown', async ({ browser, baseURL }) => {
  const helper = await device(browser);
  const helperId = await deviceId(helper);
  const scammer = new SignalingClient({ url: baseURL!.replace('http', 'ws') + '/ws', identity: Identity.generate(), name: 'x', platform: 'web' });
  scammer.start();
  await scammer.waitOnline();
  // Anyone can address an ID: an unsolicited "support" invite must not appear.
  scammer.send(helperId, 'unsolicited-1', 'invite', { name: 'Microsoft Support', platform: 'windows' });
  scammer.send(helperId, 'unsolicited-2', 'invite', { name: 'Microsoft Support', platform: 'windows', token: 'guessed-token-123' });
  await helper.waitForTimeout(1500);
  await expect(helper.getByText('is sharing their screen with you')).toHaveCount(0);

  // With the token from a help link the helper actually sent, the invite shows up.
  await helper.getByRole('button', { name: 'Copy help link' }).click();
  const link = new URL(await helper.evaluate(() => navigator.clipboard.readText()));
  const token = new URLSearchParams(link.hash.slice(1)).get('t');
  expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
  scammer.send(helperId, 'solicited-1', 'invite', { name: 'Grandma', platform: 'windows', token });
  await expect(helper.getByText('is sharing their screen with you')).toBeVisible();
  scammer.stop();
});

test('files from the other device are only saved with consent', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  const { id, otp } = await startSharing(host);
  await dial(viewer, id, otp);
  await expectVideo(viewer);
  let downloads = 0;
  viewer.on('download', () => downloads++);
  await host.locator('.hosted-row input[type=file]').setInputFiles({ name: 'invoice.pdf          .exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10_000, 1) });
  await expect(viewer.getByText('wants to send you a file')).toBeVisible();
  // The padded name is collapsed so the real extension is visible, and it is flagged.
  await expect(viewer.getByRole('dialog').locator('code')).toHaveText('invoice.pdf .exe');
  await expect(viewer.getByText('can run programs on your computer')).toBeVisible();
  await viewer.getByTestId('file-decline').click();
  await expect(host.getByText('Declined by the other side')).toBeVisible();
  await viewer.waitForTimeout(500);
  expect(downloads).toBe(0);
});

test('a password is only used with a device that can prove it knows it', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  const { id } = await startSharing(host);
  // The host turns its one-time password off: it can no longer take part in a password login.
  await host.getByTestId('open-settings').click();
  await host.getByRole('button', { name: 'Security' }).click();
  await host.getByRole('switch', { name: /Use a one-time password/ }).uncheck();
  await host.keyboard.press('Escape');
  await dial(viewer, id, 'abc123');
  await expect(viewer.getByText(/does not accept passwords right now/)).toBeVisible();
  // Falling back to asking the person works, with the accept prompt as usual.
  await viewer.getByRole('button', { name: 'Ask to connect without a password' }).click();
  await expect(host.getByTestId('accept')).toBeVisible();
});
