/**
 * Host mode: the desktop app is the BeamDesk server. A second desktop app joins with the
 * connection code (and refuses a server with another certificate), a session forced through the
 * relay uses the built-in TURN server, a browser joins with the browser link, and host mode comes
 * back on by itself when the app starts again. Linux only; run under a virtual display:
 *   BEAMDESK_E2E_DESKTOP=1 xvfb-run -a -s "-screen 0 1280x800x24" npm run test:e2e -- hostmode.spec.ts
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeJoinCode, encodeJoinCode } from '../packages/core/src/joincode.ts';
import { startRelay } from '../packages/core/test/nostr-relay.ts';
import { dial, expectVideo } from './helpers.ts';

const require = createRequire(import.meta.url);
const DESKTOP_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const enabled = process.env.BEAMDESK_E2E_DESKTOP === '1' && process.platform === 'linux' && !!process.env.DISPLAY;

test.skip(!enabled, 'set BEAMDESK_E2E_DESKTOP=1 and run under xvfb-run');
test.setTimeout(240_000);

async function freePort(): Promise<number> {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 30000);
    const tcp = await new Promise<boolean>((r) => {
      const s = net.createServer().once('error', () => r(false));
      s.listen(p, '0.0.0.0', () => s.close(() => r(true)));
    });
    const udp = await new Promise<boolean>((r) => {
      const s = dgram.createSocket('udp4').once('error', () => r(false));
      s.bind(p, '0.0.0.0', () => s.close(() => r(true)));
    });
    if (tcp && udp) return p;
  }
}

async function launch(home: string, baseURL: string): Promise<{ app: ElectronApplication; win: Page }> {
  const env = { ...process.env, HOME: home, BEAMDESK_SERVER_URL: baseURL, XDG_SESSION_TYPE: 'x11', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } as Record<string, string>;
  delete env.WAYLAND_DISPLAY;
  const app = await electron.launch({
    executablePath: require('electron') as unknown as string,
    // The test machine's web proxy would sit between the apps (and break the pinned certificate).
    args: [DESKTOP_APP, '--no-sandbox', '--disable-gpu', '--no-proxy-server', `--user-data-dir=${path.join(home, 'profile')}`],
    env,
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await expect(win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
  return { app, win };
}

const idOf = async (p: Page) => ((await p.getByTestId('my-id').locator('span').first().textContent()) ?? '').replace(/\s/g, '');
const otpOf = async (p: Page) => ((await p.getByTestId('otp').textContent()) ?? '').replace(/\s/g, '');

async function openNetwork(win: Page, view: 'Server address' | 'Connection code' | 'This computer is the server'): Promise<void> {
  if (!(await win.locator('.settings').isVisible())) await win.getByTestId('open-settings').click();
  await win.getByRole('button', { name: 'Network' }).click();
  await win.getByRole('radio', { name: view }).click();
}

async function join(win: Page, code: string): Promise<void> {
  await openNetwork(win, 'Connection code');
  await win.getByTestId('join-code').fill(code);
  await win.getByTestId('join').click();
  await win.keyboard.press('Escape');
}

test('host mode: join with the code, relay through the built-in TURN, browser link, back after a restart', async ({ baseURL, browser }) => {
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-hostA-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-hostB-'));
  const port = await freePort();
  const apps: ElectronApplication[] = [];
  try {
    let a = await launch(homeA, baseURL!);
    apps.push(a.app);
    const b = await launch(homeB, baseURL!);
    apps.push(b.app);
    // A: turn host mode on (no router in the test network: port mapping off; no public relays).
    await a.win.evaluate((port) => (window as any).beamdesk.hostMode.set({ port, portMapping: false, beacon: false }), port);
    await openNetwork(a.win, 'This computer is the server');
    await a.win.getByRole('switch', { name: /^Host mode/ }).check();
    const codeText = (await a.win.getByTestId('host-code').textContent({ timeout: 20_000 }))!;
    const code = decodeJoinCode(codeText)!;
    expect(code.addresses.every((x) => x.port === port)).toBe(true);
    const link = (await a.win.getByTestId('browser-link').textContent())!;
    // BeamDesk starts with the computer, so the server comes back after a restart.
    await expect(a.win.getByRole('switch', { name: /^Start with this computer/ })).toBeChecked();
    await a.win.keyboard.press('Escape');
    await expect(a.win.getByTestId('hosting-pill')).toBeVisible({ timeout: 20_000 });
    const idA = await idOf(a.win);

    // B: a code with the right addresses but another certificate never gets connected.
    const forged = encodeJoinCode({ ...code, fingerprint: Buffer.alloc(32, 7).toString('base64url') });
    await join(b.win, forged);
    await expect(b.win.locator('.pill.ok')).toHaveCount(0);
    await b.win.waitForTimeout(4000);
    await expect(b.win.locator('.pill.ok')).toHaveCount(0);

    // B: the real code.
    await join(b.win, codeText);
    await expect(b.win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
    await expect(a.win.getByTestId('hosting-pill')).toContainText('2 devices', { timeout: 15_000 });

    // B controls A through the built-in relay.
    await openNetwork(b.win, 'Connection code');
    await b.win.getByRole('switch', { name: /Always relay connections/ }).check();
    await b.win.keyboard.press('Escape');
    await dial(b.win, idA, await otpOf(a.win));
    await expectVideo(b.win);
    await expect(b.win.locator('.route.relay')).toBeVisible({ timeout: 15_000 });
    await b.win.getByTestId('disconnect').click();
    await expect(a.win.getByText('Someone is connected to this device')).toHaveCount(0);

    // A browser opens the browser link (it carries the access key) and connects too.
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 820 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
    const u = new URL(link);
    u.hostname = '127.0.0.1'; // the test machine's proxy must not see it
    await page.goto(u.toString());
    await expect(page.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
    await dial(page, idA, await otpOf(a.win));
    await expectVideo(page);
    await page.getByTestId('disconnect').click();
    await ctx.close();

    // A restarts (like a reboot): host mode comes back on its own, with the same code, and B
    // reconnects by itself.
    await a.app.close();
    await expect(b.win.locator('.pill.ok')).toHaveCount(0, { timeout: 70_000 });
    a = await launch(homeA, baseURL!);
    apps.push(a.app);
    await expect(a.win.getByTestId('hosting-pill')).toBeVisible({ timeout: 20_000 });
    await openNetwork(a.win, 'This computer is the server');
    expect(await a.win.getByTestId('host-code').textContent()).toBe(codeText);
    await a.win.keyboard.press('Escape');
    await expect(b.win.locator('.pill.ok')).toBeVisible({ timeout: 40_000 });

    // Switched off: A goes back to its normal server, B loses the home server.
    await openNetwork(a.win, 'This computer is the server');
    await a.win.getByRole('switch', { name: /^Host mode/ }).uncheck();
    await a.win.keyboard.press('Escape');
    await expect(a.win.getByTestId('hosting-pill')).toHaveCount(0);
    await expect(a.win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
    await expect(b.win.locator('.pill.ok')).toHaveCount(0, { timeout: 70_000 });
  } finally {
    await Promise.allSettled(apps.map((x) => x.close()));
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }
});

test('behind carrier-grade NAT: desktop and browser reach the host through the beacon only', async ({ baseURL, browser }) => {
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-cgnatA-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-cgnatB-'));
  const port = await freePort();
  // A public relay as the outside world would see it (strict: checks every signature).
  const relay = await startRelay();
  const apps: ElectronApplication[] = [];
  try {
    const a = await launch(homeA, baseURL!);
    apps.push(a.app);
    const b = await launch(homeB, baseURL!);
    apps.push(b.app);
    await a.win.evaluate(({ port, relay }) => (window as any).beamdesk.hostMode.set({ port, portMapping: false, relays: [relay] }), { port, relay: relay.url });
    await openNetwork(a.win, 'This computer is the server');
    await a.win.getByRole('switch', { name: /^Host mode/ }).check();
    await expect(a.win.getByText(/through the beacon: ready/)).toBeVisible({ timeout: 20_000 });
    const real = decodeJoinCode((await a.win.getByTestId('host-code').textContent())!)!;
    expect(real.beacon?.relays).toEqual([relay.url]);
    expect(await a.win.getByTestId('universal-link').textContent()).toContain('#join=BD2-');
    await a.win.keyboard.press('Escape');
    const idA = await idOf(a.win);

    // Behind carrier-grade NAT none of the addresses answers: the code holds only an
    // unreachable internet address (a documentation range nobody routes).
    const cgnat = encodeJoinCode({ ...real, addresses: [{ kind: 'internet', host: '203.0.113.77', port }] });

    // A desktop app joins and controls A through the beacon.
    await join(b.win, cgnat);
    await expect(b.win.locator('.pill.ok')).toBeVisible({ timeout: 30_000 });
    await openNetwork(b.win, 'Connection code');
    await expect(b.win.getByText('connected via the beacon (public relays)')).toBeVisible();
    await b.win.keyboard.press('Escape');
    await dial(b.win, idA, await otpOf(a.win));
    await expectVideo(b.win);
    await b.win.getByTestId('disconnect').click();
    await expect(a.win.getByText('Someone is connected to this device')).toHaveCount(0);

    // A browser (a phone) opens the link for phones: the code in the #fragment, Join, connect.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
    await page.goto(`/#join=${cgnat}`);
    await expect(page.getByTestId('join-code')).toHaveValue(cgnat);
    await page.getByTestId('join').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pill.ok')).toBeVisible({ timeout: 30_000 });
    await dial(page, idA, await otpOf(a.win));
    await expectVideo(page);
    await page.getByTestId('disconnect').click();
    await ctx.close();

    // The relays only ever carried ciphertext between one-time keys.
    expect(relay.accepted.length).toBeGreaterThan(5);
    expect(relay.accepted.some((e) => e.content.includes('register') || e.content.includes('offer'))).toBe(false);
  } finally {
    await Promise.allSettled(apps.map((x) => x.close()));
    await relay.close();
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }
});
