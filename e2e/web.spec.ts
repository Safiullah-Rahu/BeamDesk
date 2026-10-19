/**
 * End-to-end tests through the real signaling server, with two isolated browser
 * "devices" talking WebRTC to each other.
 */
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { device, dial, expectVideo, startSharing } from './helpers.ts';

test('approve a request, chat and receive a file', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  const { id } = await startSharing(host);

  await dial(viewer, id);
  await expect(viewer.getByText(/Waiting for .* to accept/)).toBeVisible();
  // Both sides show the same security code.
  const promptCode = (await host.locator('.security-code code').textContent())!.trim();
  await expect(viewer.locator('.security-code code')).toHaveText(promptCode);
  await host.getByTestId('accept').click();
  await expectVideo(viewer);
  await expect(host.getByText('Someone is connected to this device')).toBeVisible();

  // Chat both ways.
  await viewer.getByRole('button', { name: 'Chat' }).click();
  await viewer.getByLabel('Message').fill('Can you see my cursor?');
  await viewer.getByLabel('Message').press('Enter');
  await expect(host.getByRole('button', { name: 'Chat (1)' })).toBeVisible();
  await host.getByRole('button', { name: 'Chat (1)' }).click();
  await host.getByLabel('Message').fill('Yes!');
  await host.getByLabel('Message').press('Enter');
  await expect(viewer.locator('.bubble.them')).toHaveText(/Yes!/);

  // Host sends a file; the viewer's browser downloads it.
  const download = viewer.waitForEvent('download');
  await host.locator('.hosted-row input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello '.repeat(50_000)) });
  const d = await download;
  expect(d.suggestedFilename()).toBe('notes.txt');
  expect(fs.statSync(await d.path()).size).toBe(300_000);

  // The host ends the session.
  await host.getByTestId('end-hosted').click();
  await expect(viewer.getByText('Session ended')).toBeVisible();
});

test('declined requests are reported to the viewer', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  const { id } = await startSharing(host);
  await dial(viewer, id);
  await host.getByTestId('decline').click();
  await expect(viewer.getByText('The other person declined the connection.')).toBeVisible();
});

test('the one-time password connects without a prompt', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  const { id, otp } = await startSharing(host);
  await dial(viewer, id, otp.toUpperCase());
  // Browser hosts still have to pick a screen, which the test flags auto-select.
  await expectVideo(viewer);
  await expect(host.getByTestId('accept')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Connection details' }).click();
  await expect(viewer.locator('.stats-panel')).toContainText('One-time password');
});

test('a wrong password is rejected', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  const { id } = await startSharing(host);
  await dial(viewer, id, 'zzzzzz');
  await expect(viewer.getByText('Wrong password. Check the password and try again.')).toBeVisible();
  await expect(host.getByTestId('accept')).toHaveCount(0);
});

test('help link: the person shares, the helper joins', async ({ browser }) => {
  const helper = await device(browser);
  const person = await device(browser);
  await helper.getByRole('button', { name: 'Copy help link' }).click();
  const link = new URL(await helper.evaluate(() => navigator.clipboard.readText()));
  link.hash = link.hash.replace(/n=[^&]*/, 'n=Support%20Desk');
  expect(link.hash).toMatch(/k=[A-Za-z0-9_-]{22}/);

  await person.goto(`/${link.hash}`);
  await expect(person.getByText('Support Desk would like to help you')).toBeVisible();
  await person.getByTestId('share-for-help').click();
  await expect(person.getByText(/Waiting for Support Desk to join/)).toBeVisible();

  await helper.getByTestId('join-invite').click();
  await expectVideo(helper);
  await expect(person.getByText(/You are sharing your screen with/)).toBeVisible();
  await person.getByRole('dialog').getByRole('button', { name: 'Stop sharing' }).click();
  await expect(helper.getByText('Session ended')).toBeVisible();
});

test('invite links ask for confirmation, then connect to exactly that device', async ({ browser }) => {
  const host = await device(browser);
  const viewer = await device(browser);
  await startSharing(host);
  await host.getByRole('button', { name: 'Copy invite link' }).click();
  const link = new URL(await host.evaluate(() => navigator.clipboard.readText()));
  expect(link.hash).toMatch(/^#c=\d{9}&p=\w+&k=[A-Za-z0-9_-]{22}$/);

  await viewer.goto(`/${link.hash}`);
  await expect(viewer.getByText('Connect to this device?')).toBeVisible();
  await viewer.getByTestId('confirm-link').click();
  await expectVideo(viewer); // the link's one-time password skips the accept prompt

  // A link whose key hash does not match the device is refused.
  const other = await device(browser);
  await other.goto(`/${link.hash.replace(/k=[^&]+/, 'k=AAAAAAAAAAAAAAAAAAAAAA')}`);
  await other.getByTestId('confirm-link').click();
  await expect(other.getByText('The identity of the other device could not be verified.')).toBeVisible();
});

test('offline IDs give a clear message', async ({ browser }) => {
  const viewer = await device(browser);
  await dial(viewer, '123456789');
  await expect(viewer.getByText(/That device is offline or the ID is wrong/)).toBeVisible();
});
