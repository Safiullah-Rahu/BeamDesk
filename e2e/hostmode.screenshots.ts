/**
 * Screenshots of host mode for docs/images (light and dark). Needs a home network with a router,
 * so it runs in a network namespace with a dummy network card and a fake UPnP router in this
 * process; see e2e/netns-screenshots.sh, which sets that up and runs it:
 *
 *   npm run build && e2e/netns-screenshots.sh
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../packages/core/test/nostr-relay.ts';

type Theme = 'light' | 'dark';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_APP = path.resolve(HERE, '../apps/desktop');
const OUT = path.resolve(HERE, '../docs/images');
const SIZE = { width: 1280, height: 820 };
const ROUTER = '192.168.1.1';
// The router's own "internet" address is shared carrier-grade NAT space: nothing can come in.
const PUBLIC_IP = '100.72.14.9';

test.skip(!process.env.BEAMDESK_SHOTS_NETNS, 'run through e2e/netns-screenshots.sh');

/** A home router that answers SSDP and forwards ports over UPnP IGD. */
async function fakeRouter(): Promise<() => void> {
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      if (req.url === '/desc.xml') {
        return res.end(
          '<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>',
        );
      }
      res.end(/GetExternalIPAddress/.test(String(req.headers.soapaction)) ? `<r><NewExternalIPAddress>${PUBLIC_IP}</NewExternalIPAddress></r>` : '<ok/>');
    });
  });
  await new Promise<void>((r) => web.listen(5000, ROUTER, () => r()));
  const search = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const reply = dgram.createSocket('udp4');
  await new Promise<void>((r) => reply.bind(0, ROUTER, () => r()));
  await new Promise<void>((r) => search.bind(1900, '0.0.0.0', () => r()));
  search.addMembership('239.255.255.250', '192.168.1.20'); // searches loop back on the home network card
  search.on('message', (msg, rinfo) => {
    if (!msg.toString().startsWith('M-SEARCH')) return;
    reply.send(`HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\nLOCATION: http://${ROUTER}:5000/desc.xml\r\n\r\n`, rinfo.port, rinfo.address);
  });
  return () => {
    web.close();
    search.close();
    reply.close();
  };
}

async function launch(home: string, baseURL: string): Promise<{ app: ElectronApplication; win: Page }> {
  const env = { ...process.env, HOME: home, BEAMDESK_SERVER_URL: baseURL, XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } as Record<string, string>;
  delete env.WAYLAND_DISPLAY;
  const app = await electron.launch({
    executablePath: require('electron') as unknown as string,
    args: [DESKTOP_APP, '--no-sandbox', '--disable-gpu', '--no-proxy-server', `--user-data-dir=${path.join(home, 'profile')}`],
    env,
  });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows().find((x) => !x.isAlwaysOnTop())!.setBounds({ x: 0, y: 0, ...size });
  }, SIZE);
  await expect(win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
  return { app, win };
}

async function configure(win: Page, theme: Theme, name: string): Promise<void> {
  await win.evaluate(
    ({ theme, name }) => {
      const bridge = (window as unknown as { beamdesk: { store: { load(): { data: Record<string, any> }; set(k: string, v: unknown): void } } }).beamdesk;
      const settings = bridge.store.load().data.settings ?? {};
      bridge.store.set('settings', { ...settings, theme, deviceName: name, sounds: false, notifications: false });
    },
    { theme, name },
  );
  await win.reload();
  await expect(win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
}

async function openNetwork(win: Page, view: string): Promise<void> {
  await win.getByTestId('open-settings').click();
  await win.getByRole('button', { name: 'Network' }).click();
  await win.getByRole('radio', { name: view }).click();
}

test('host mode screenshots', async ({ baseURL }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });
  const stopRouter = await fakeRouter();
  const relay = await startRelay(); // stands in for the public relays
  const homes = [fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-shotA-')), fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-shotB-'))];
  const apps: ElectronApplication[] = [];
  try {
    const a = await launch(homes[0], baseURL!);
    apps.push(a.app);
    const b = await launch(homes[1], baseURL!);
    apps.push(b.app);
    let code = '';
    for (const theme of ['light', 'dark'] as const) {
      await configure(a.win, theme, 'Home PC');
      await configure(b.win, theme, 'Laptop');

      // The computer that stays on: host mode with the router's port opened.
      await openNetwork(a.win, 'This computer is the server');
      if (!code) {
        await a.win.evaluate((relay) => (window as any).beamdesk.hostMode.set({ relays: [relay] }), relay.url);
        await a.win.getByRole('switch', { name: /^Host mode/ }).check();
      }
      await expect(a.win.getByText(/carrier-grade NAT\). The beacon below takes over/)).toBeVisible({ timeout: 30_000 });
      await expect(a.win.getByText(/through the beacon: ready/)).toBeVisible({ timeout: 20_000 });
      // Show the code and the checks.
      await a.win.locator('.settings-body').evaluate((el) => {
        const field = el.querySelector('[data-testid=host-code]')!.closest('.field')!;
        el.scrollTop += field.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
      });
      code = (await a.win.getByTestId('host-code').textContent())!;
      await a.win.waitForTimeout(400);
      await a.win.screenshot({ path: path.join(OUT, `settings-hostmode-${theme}.png`), animations: 'disabled' });
      await a.win.keyboard.press('Escape');

      // Another computer joins with the code.
      await openNetwork(b.win, 'Connection code');
      if (theme === 'light') {
        await b.win.getByTestId('join-code').fill(code);
        await b.win.getByTestId('join').click();
      }
      await expect(b.win.getByText('connected via home network')).toBeVisible({ timeout: 20_000 });
      await b.win.waitForTimeout(5000); // the "Joined" toast fades
      await b.win.screenshot({ path: path.join(OUT, `settings-joincode-${theme}.png`), animations: 'disabled' });
      await b.win.keyboard.press('Escape');
    }
  } finally {
    await Promise.allSettled(apps.map((x) => x.close()));
    stopRouter();
    await relay.close();
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  }
});
