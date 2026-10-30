import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';

async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

/** A real MP4 inside the asset library's limits (640 x 640, 24 fps) or, for `seconds` below 2, outside them. */
function clip(seconds, tag) {
  const directory = mkdtempSync(path.join(tmpdir(), 'portrait-video-'));
  const file = path.join(directory, 'clip.mp4');
  // The title tag makes each clip's bytes unique, so one run never deduplicates against another.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x640:rate=24:duration=${seconds}`, '-metadata', `title=${tag}`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', file], { stdio: 'ignore' });
  const bytes = readFileSync(file);
  rmSync(directory, { recursive: true, force: true });
  return bytes;
}

async function openGallery(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitem', { name: /^Seedance 2\.5(?:\s|$)/ }).click();
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  return page.getByRole('dialog', { name: 'Portrait Gallery', exact: true });
}

test('a video can be added to the Portrait Gallery, shows its first frame and plays in the full view', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  const name = `Clip ${randomUUID().slice(0, 8)}`;
  const gallery = await openGallery(page);
  const registered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/portraits' && response.request().method() === 'POST');
  await gallery.locator('input[type="file"]').setInputFiles({ name: `${name}.mp4`, mimeType: 'video/mp4', buffer: clip(3, name.slice(-4)) });
  const registration = await registered;
  expect(registration.ok()).toBeTruthy();
  const result = (await registration.json()).results[0];
  expect(result.ok).toBe(true);
  expect(result.portrait.kind).toBe('video');
  const card = gallery.getByRole('article', { name, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator('[data-portrait-video-badge], [data-portrait-chip]').first()).toBeVisible();
  await expect.poll(() => card.locator('img').evaluate(image => image.naturalWidth), { timeout: 30000 }).toBeGreaterThan(0);
  await card.dblclick();
  const preview = page.getByRole('complementary', { name: 'Portrait Full View' });
  await expect(preview).toBeVisible();
  const player = preview.locator('video');
  await expect(player).toHaveAttribute('src', /\/api\/media\/uploads\/portrait\//);
  await expect(player).toHaveAttribute('poster', /thumbs\/poster\//);
  await expect.poll(() => player.evaluate(video => video.readyState), { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  expect(await player.evaluate(video => video.controls)).toBe(true);
  expect(await player.evaluate(video => Math.round(video.duration))).toBe(3);
});

test('a clip that is too short is refused in the browser with a clear message and nothing is registered', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  const name = `Short ${randomUUID().slice(0, 8)}`;
  const gallery = await openGallery(page);
  let registered = false;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/portraits' && request.method() === 'POST') registered = true; });
  await gallery.locator('input[type="file"]').setInputFiles({ name: `${name}.mp4`, mimeType: 'video/mp4', buffer: clip(1, 'x') });
  await expect(gallery.getByText(/Too short \(1\.0 s\)\. Use a clip of 2 to 30 seconds\./)).toBeVisible();
  expect(registered).toBe(false);
});
