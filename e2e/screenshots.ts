/**
 * Regenerates the screenshots in docs/images, in the light and the dark theme, from the real
 * desktop app (Electron) and browser version. Not part of the test suite. Linux only:
 *
 *   npm run build
 *   dbus-run-session -- sh -c 'echo | gnome-keyring-daemon --unlock --components=secrets >/dev/null &&
 *     xvfb-run -a -s "-screen 0 1280x820x24" npx playwright test -c e2e/screenshots.config.ts'
 *
 * The keyring lets the desktop app store its secrets the way it does on a normal Linux desktop
 * (otherwise it shows a "no keyring" notice); the virtual screen is exactly one app window, so
 * the remote-session shot shows the host's desktop.
 */
import { _electron as electron, expect, test, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dial, expectVideo } from './helpers.ts';

type Theme = 'light' | 'dark';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_APP = path.resolve(HERE, '../apps/desktop');
const OUT = path.resolve(HERE, '../docs/images');
const SIZE = { width: 1280, height: 820 };

test.skip(process.platform !== 'linux' || !process.env.DISPLAY, 'run under xvfb-run on Linux (see the comment at the top)');

const contacts = () => {
  const now = Date.now();
  return [
    { id: '482913077', name: 'Office PC', platform: 'windows', favorite: true, lastConnected: now - 3600_000 },
    { id: '731204588', name: "Mum's laptop", platform: 'macos', favorite: true, lastConnected: now - 2 * 86_400_000 },
    { id: '615338920', name: 'Home server', platform: 'linux', favorite: false, lastConnected: now - 6 * 86_400_000 },
  ];
};

const shot = (page: Page, name: string, theme: Theme) =>
  page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`), animations: 'disabled' });

/** A browser "device" with its own identity, a name and the given theme. */
async function browserDevice(
  browser: Browser,
  theme: Theme,
  name: string,
  opts: { mobile?: boolean; contacts?: boolean } = {},
): Promise<Page> {
  const ctx = await browser.newContext({
    colorScheme: theme,
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(opts.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: SIZE }),
  });
  await ctx.addInitScript(
    ({ theme, name, contacts }) => {
      if (localStorage.getItem('beamdesk:data')) return;
      localStorage.setItem('beamdesk:data', JSON.stringify({ settings: { theme, deviceName: name, sounds: false, notifications: false }, contacts }));
    },
    { theme, name, contacts: opts.contacts ? contacts() : [] },
  );
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('.pill.ok')).toBeVisible({ timeout: 15_000 });
  return page;
}

/** Switches the desktop app to a theme (and a name and address book), then reloads it. */
async function configureDesktop(win: Page, theme: Theme): Promise<void> {
  await win.evaluate(
    ({ theme, contacts }) => {
      const bridge = (window as unknown as { beamdesk: { store: { load(): { data: Record<string, any> }; set(k: string, v: unknown): void } } }).beamdesk;
      const settings = bridge.store.load().data.settings ?? {};
      bridge.store.set('settings', { ...settings, theme, deviceName: 'Linux PC', sounds: false, notifications: false });
      bridge.store.set('contacts', contacts);
    },
    { theme, contacts: contacts() },
  );
  await win.reload();
  await expect(win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
}

/** The transparent session bar renders as a black box on a virtual display (no compositor). */
async function hideSessionBar(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.isAlwaysOnTop()) w.hide();
  });
}

test('screenshots', async ({ browser, baseURL }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-shots-'));
  // Like a GNOME session: Chromium picks the system keyring from the desktop environment.
  const env = { ...process.env, HOME: home, BEAMDESK_SERVER_URL: baseURL!, XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } as Record<string, string>;
  delete env.WAYLAND_DISPLAY;
  const app = await electron.launch({
    executablePath: require('electron') as unknown as string,
    args: [DESKTOP_APP, '--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(home, 'profile')}`],
    env,
  });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isAlwaysOnTop())!;
      w.setBounds({ x: 0, y: 0, ...size });
    }, SIZE);
    await expect(win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });

    for (const theme of ['light', 'dark'] as const) {
      await configureDesktop(win, theme);
      const id = ((await win.getByTestId('my-id').locator('span').first().textContent()) ?? '').replace(/\s/g, '');

      // Home screen of the desktop app.
      await win.waitForTimeout(500);
      await shot(win, 'home', theme);

      // Settings -> Security.
      await win.getByTestId('open-settings').click();
      await win.getByRole('button', { name: 'Security' }).click();
      await win.waitForTimeout(300);
      await shot(win, 'settings-security', theme);
      await win.keyboard.press('Escape');

      // A browser asks to connect: the accept prompt on the desktop app.
      const viewer = await browserDevice(browser, theme, 'My laptop', { contacts: true });
      await dial(viewer, id);
      await expect(win.getByTestId('accept')).toBeVisible();
      await win.waitForTimeout(400);
      await shot(win, 'incoming-request', theme);
      await win.getByTestId('accept').click();

      // The remote session, with the connection details open.
      await expectVideo(viewer);
      await viewer.getByRole('button', { name: 'Connection details' }).click();
      await hideSessionBar(app);
      await viewer.waitForTimeout(5000); // toasts fade, stats settle
      await shot(viewer, 'remote-session', theme);
      await viewer.getByRole('button', { name: 'Connection details' }).click();

      // The desktop app sends a file: the viewer is asked before anything is saved.
      await win.locator('.hosted-row input[type=file]').setInputFiles({ name: 'Quarterly report.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2_400_000, 1) });
      await expect(viewer.getByText('wants to send you a file')).toBeVisible();
      await viewer.waitForTimeout(300);
      await shot(viewer, 'file-consent', theme);
      await viewer.getByTestId('file-decline').click();
      await viewer.getByTestId('disconnect').click();
      await expect(win.getByText('Someone is connected to this device')).toHaveCount(0);
      await viewer.context().close();

      // Someone without BeamDesk opens a help link.
      const helper = await browserDevice(browser, theme, 'Support Desk');
      await helper.getByRole('button', { name: 'Copy help link' }).click();
      const link = new URL(await helper.evaluate(() => navigator.clipboard.readText()));
      const person = await browserDevice(browser, theme, 'Grandma');
      await person.goto(`/${link.hash}`);
      await expect(person.getByText('would like to help you')).toBeVisible();
      await person.waitForTimeout(300);
      await shot(person, 'help-link', theme);
      await helper.context().close();
      await person.context().close();

      // The browser version on a phone.
      const phone = await browserDevice(browser, theme, 'My phone', { mobile: true });
      await phone.waitForTimeout(300);
      await shot(phone, 'mobile', theme);
      await phone.context().close();
    }
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
