import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000041', name: 'Media owner', email: 'media-owner@example.test' };
// SVG, PSD and PDF are converted with libvips, which a laptop without it cannot do; CI installs it.
const HAS_VIPS = ['/opt/homebrew/lib/libvips.42.dylib', '/usr/local/lib/libvips.42.dylib', '/usr/lib/x86_64-linux-gnu/libvips.so.42', '/usr/lib/aarch64-linux-gnu/libvips.so.42'].some((path) => existsSync(path));
// A 1x1 PNG, and a tiny MP4 header the server stores byte for byte (no transcoding).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c33"/><script>alert(1)</script></svg>';

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(OWNER.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  return { context, page: await context.newPage() };
}

async function openBoard(page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());

async function storedBoard(context, boardId, ready) {
  let board;
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return ready(board);
  }, { timeout: 20000 }).toBe(true);
  return board;
}

const ofType = (board, type) => board.data.nodes.filter((node) => node.type === type);

test('Board media: embed code, code block, emoji, interactive sticker, icon, uploads, saved files, replace image and object links', async ({ browser, baseURL }, info) => {
  test.setTimeout(240000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`]);
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board media ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const media = async (name) => {
    await page.getByRole('button', { name: 'Add media' }).click();
    await page.getByRole('menuitem', { name }).click();
  };

  // Embed by iframe code: only allowlisted providers become embeds, and the frame is sandboxed.
  await media('Link or embed');
  let dialog = page.getByRole('dialog', { name: 'Link or embed' });
  await dialog.getByLabel('Link or iframe code').fill('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560"></iframe>');
  const firstSave = page.waitForResponse(isSave);
  await dialog.getByRole('button', { name: /^Add/ }).click();
  await expect(dialog).toHaveCount(0);
  const boardId = new URL((await firstSave).url()).pathname.split('/').pop();
  const frame = page.locator('[data-media="embed"] iframe');
  await expect(frame).toHaveAttribute('src', /^https:\/\/www\.youtube(-nocookie)?\.com\/embed\/dQw4w9WgXcQ/);
  await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');

  // Code block with highlighting.
  await media('Code block');
  dialog = page.getByRole('dialog', { name: 'Code block' });
  await dialog.getByLabel('Code').fill('const answer = 42;');
  await dialog.getByRole('button', { name: 'Add code block' }).click();
  await expect(page.locator('[data-media="code"]')).toContainText('const answer = 42;');

  // Object link on the selected code block, (a new object stays selected, so its actions show).
  await page.getByRole('button', { name: 'Add link' }).click();
  await page.getByLabel('Link address').fill('https://example.com/docs');
  await page.getByRole('button', { name: 'Save link' }).click();
  await storedBoard(context, boardId, (b) => ofType(b, 'code')[0]?.link?.url === 'https://example.com/docs');
  await expect(page.getByRole('link', { name: /Open link https:\/\/example\.com\/docs/ })).toBeVisible();


  // Emoji sticker, made interactive.
  await media('Emoji and stickers');
  dialog = page.getByRole('dialog', { name: 'Emoji and stickers' });
  await dialog.getByLabel('Search emoji').fill('thumbs');
  await dialog.getByRole('button', { name: /thumbs up/i }).first().click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-media="emoji"]')).toHaveCount(1);
  await page.locator('[data-media="emoji"]').click();
  await page.getByLabel('Click to agree').check();
  await page.locator('[data-media="emoji"]').click();
  await expect(page.locator('[data-media="emoji"]')).toContainText('1');

  // Icon.
  await media('Icons');
  dialog = page.getByRole('dialog', { name: 'Icons' });
  await dialog.getByLabel('Search icons').fill('star');
  await dialog.getByRole('button', { name: 'star', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-media="icon"]')).toHaveCount(1);

  let board = await storedBoard(context, boardId, (b) => ['embed', 'code', 'emoji', 'icon'].every((t) => ofType(b, t).length === 1));
  expect(ofType(board, 'embed')[0].provider).toBe('youtube');
  expect(JSON.stringify(board.data)).not.toContain('data:');
  await info.attach('media-objects', { body: await page.screenshot(), contentType: 'image/png' });

  // A non-allowlisted iframe is refused with a message and adds nothing.
  await media('Link or embed');
  dialog = page.getByRole('dialog', { name: 'Link or embed' });
  await dialog.getByLabel('Link or iframe code').fill('<iframe src="http://localhost:9/evil"></iframe>');
  await dialog.getByRole('button', { name: /^Add/ }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Uploads through the file picker: image, SVG (sanitized to PNG) and video.
  const picker = page.locator('input[type="file"][multiple]');
  const files = [{ name: 'dot.png', mimeType: 'image/png', buffer: PNG }];
  if (HAS_VIPS) files.push({ name: 'shape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) });
  await picker.setInputFiles(files);
  board = await storedBoard(context, boardId, (b) => ofType(b, 'image').length === files.length);
  for (const image of ofType(board, 'image')) expect(image.src).toMatch(/^\/api\/media\//);
  await picker.setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('00000018667479706d703432', 'hex') });
  board = await storedBoard(context, boardId, (b) => ofType(b, 'video').length === 1);
  expect(ofType(board, 'video')[0].src).toMatch(/^\/api\/media\//);
  await expect(page.locator('[data-media="video"]')).toHaveCount(1);

  // Saved files library lists what was uploaded and places a copy on the board.
  await media('Saved files');
  dialog = page.getByRole('dialog', { name: 'Saved files' });
  await expect(dialog.getByRole('button', { name: /Place dot\.png/ }).first()).toBeVisible();
  await dialog.getByRole('button', { name: /Place dot\.png/ }).first().click();
  board = await storedBoard(context, boardId, (b) => ofType(b, 'image').length === files.length + 1);
  await page.keyboard.press('Escape');

  // The image placed from Saved files is selected: replace it.
  const before = ofType(board, 'image').at(-1);
  await page.getByLabel('Replacement image').setInputFiles({ name: 'other.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.from('x')]) });
  board = await storedBoard(context, boardId, (b) => ofType(b, 'image').find((n) => n.id === before.id)?.src !== before.src);

  expect(errors).toEqual([]);
  await context.close();
});
