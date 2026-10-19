import { expect, type Browser, type Page } from '@playwright/test';

/** Each device gets its own browser context, i.e. its own identity and storage. */
export async function device(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto('/');
  await expect(page.locator('.pill.ok')).toBeVisible({ timeout: 15_000 });
  return page;
}

export async function deviceId(page: Page): Promise<string> {
  await expect(page.getByTestId('my-id')).toHaveText(/\d{3} \d{3} \d{3}/);
  return ((await page.getByTestId('my-id').locator('span').first().textContent()) ?? '').replace(/\s/g, '');
}

/** Browser hosts must opt in to being viewed. */
export async function startSharing(page: Page): Promise<{ id: string; otp: string }> {
  await page.getByRole('button', { name: 'Let someone view this screen' }).click();
  const id = await deviceId(page);
  const otp = ((await page.getByTestId('otp').textContent()) ?? '').replace(/\s/g, '');
  return { id, otp };
}

export async function dial(page: Page, id: string, password?: string): Promise<void> {
  await page.getByTestId('partner-id').fill(id);
  if (password !== undefined) {
    await page.getByText('I have a password').click();
    await page.getByTestId('partner-password').fill(password);
  }
  await page.getByTestId('connect').click();
}

export async function expectVideo(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid=remote-video]');
      return !!v && v.videoWidth > 0 && (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 1) > 0;
    },
    null,
    // Interval polling: background pages get no animation frames.
    { timeout: 25_000, polling: 250 },
  );
  await expect(page.getByTestId('viewer')).toHaveAttribute('data-state', 'connected');
}
