/**
 * Desktop host test: the real Electron app shares an X11 screen and is remote-controlled
 * from a browser. Linux only; run under a virtual display:
 *   BEAMDESK_E2E_DESKTOP=1 xvfb-run -a -s "-screen 0 1280x800x24" npm run test:e2e -- desktop.spec.ts
 */
import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { device, dial, expectVideo } from './helpers.ts';

const require = createRequire(import.meta.url);
const DESKTOP_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const enabled = process.env.BEAMDESK_E2E_DESKTOP === '1' && process.platform === 'linux' && !!process.env.DISPLAY;

test.skip(!enabled, 'set BEAMDESK_E2E_DESKTOP=1 and run under xvfb-run');

test('desktop host: password login, remote mouse, clipboard and files', async ({ browser, baseURL }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beamdesk-desktop-'));
  const env = { ...process.env, HOME: home, BEAMDESK_SERVER_URL: baseURL!, XDG_SESSION_TYPE: 'x11', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } as Record<string, string>;
  delete env.WAYLAND_DISPLAY;
  const app = await electron.launch({
    executablePath: require('electron') as unknown as string,
    args: [DESKTOP_APP, '--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(home, 'profile')}`],
    env,
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.pill.ok')).toBeVisible({ timeout: 20_000 });
    const id = ((await win.getByTestId('my-id').locator('span').first().textContent()) ?? '').replace(/\s/g, '');
    const otp = ((await win.getByTestId('otp').textContent()) ?? '').replace(/\s/g, '');

    const viewer = await device(browser);
    await dial(viewer, id, otp);
    await expectVideo(viewer);

    // Remote mouse control lands where we point (25% / 75% of the remote screen).
    const box = (await viewer.getByTestId('remote-video').boundingBox())!;
    await viewer.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.75);
    await viewer.mouse.move(box.x + box.width * 0.25 + 1, box.y + box.height * 0.75);
    await viewer.waitForTimeout(500);
    const screen = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().size);
    const pos = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('@jitsi/robotjs').getMousePos()))"]).toString());
    expect(Math.abs(pos.x - screen.width * 0.25)).toBeLessThan(6);
    expect(Math.abs(pos.y - screen.height * 0.75)).toBeLessThan(6);

    // Clipboard follows a paste.
    await viewer.evaluate(() => navigator.clipboard.writeText('hello from the viewer'));
    await viewer.getByTestId('viewer').focus();
    await viewer.keyboard.press('Control+V');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('hello from the viewer');

    // Files land in the host's download folder.
    await viewer.locator('.viewer input[type=file]').setInputFiles({ name: 'report.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(250_000, 7) });
    await expect(viewer.getByText('Delivered')).toBeVisible();
    const saved = [path.join(home, 'Downloads', 'BeamDesk', 'report.bin'), path.join(home, 'BeamDesk', 'report.bin')].find((p) => fs.existsSync(p));
    expect(saved && fs.statSync(saved).size).toBe(250_000);

    // Ending the session rotates the one-time password.
    await viewer.getByTestId('disconnect').click();
    await expect(win.getByText('Someone is connected to this device')).toHaveCount(0);
    await expect(win.getByTestId('otp')).not.toHaveText(new RegExp(otp.split('').join('\\s?')));
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
