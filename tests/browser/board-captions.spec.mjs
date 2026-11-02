import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000051', name: 'Caption owner', email: 'caption-owner@example.test' };

// The caption route extracts the video's audio with ffmpeg, so the spec needs a real, tiny clip with a sound track.
function tinyVideo() {
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'captions-')), 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:d=1',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', file], { stdio: 'ignore' });
    return readFileSync(file);
  } catch {
    return null;
  }
}
const VIDEO = tinyVideo();

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

async function openBoard(page, timeout) {
  await page.goto('/', { timeout });
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click({ timeout });
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible({ timeout });
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible({ timeout });
  return canvas;
}

async function newProject(browser, baseURL) {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`]);
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board captions ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();
  return project;
}

// A cold Next dev server compiles the app and the board on first request, which can take minutes on a busy
// machine. Do that once under its own budget, so each test's timeout measures the board, not the compiler.
test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(420000);
  const project = await newProject(browser, baseURL);
  const { context, page } = await signIn(browser, baseURL, project.id);
  await openBoard(page, 400000);
  await context.close();
});

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

async function boardWithVideo(context, page) {
  await openBoard(page);
  const firstSave = page.waitForResponse(isSave);
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: VIDEO });
  const boardId = new URL((await firstSave).url()).pathname.split('/').pop();
  const board = await storedBoard(context, boardId, (b) => ofType(b, 'video').length === 1);
  const video = page.locator('[data-media="video"] video');
  await expect(video).toHaveCount(1);
  await video.click({ force: true });
  return { boardId, src: ofType(board, 'video')[0].src, video };
}

test('Board captions: generate with the cost step, toggle CC through a same-origin track', async ({ browser, baseURL }) => {
  test.skip(!VIDEO, 'ffmpeg is needed to build the fixture clip');
  test.setTimeout(240000);
  const project = await newProject(browser, baseURL);
  const { context, page } = await signIn(browser, baseURL, project.id);
  const domWarnings = [];
  page.on('console', (message) => { if (message.type() === 'error' && /Invalid DOM property/.test(message.text())) domWarnings.push(message.text()); });
  const { boardId, src, video } = await boardWithVideo(context, page);

  // Nothing starts by itself: the quote shows the model and the cost first, and a run needs a click.
  const generate = page.getByRole('button', { name: 'Generate captions' });
  await expect(generate).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-captions-toggle]')).toHaveCount(0);
  await generate.click();
  const confirm = page.locator('[data-captions-confirm]');
  await expect(confirm).toContainText('No price is metered');
  await confirm.getByRole('button', { name: 'Start' }).click();

  // The captions come back through the API as text, and the video carries a same-origin blob track, never crossOrigin.
  const toggle = page.getByRole('button', { name: 'CC', exact: true });
  await expect(toggle).toBeVisible({ timeout: 60000 });
  await expect(video.locator('track')).toHaveAttribute('src', /^blob:/, { timeout: 20000 });
  expect(await video.getAttribute('crossorigin')).toBeNull();
  const vtt = await context.request.get(`/api/canvas-boards/${boardId}/captions/vtt?src=${encodeURIComponent(src)}`);
  expect(vtt.headers()['content-type']).toContain('text/vtt');
  expect(await vtt.text()).toContain('Offline caption fixture.');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(video.locator('track')).toHaveCount(0);
  await toggle.click();
  await expect(video.locator('track')).toHaveCount(1);
  await expect(video.locator('track')).toHaveAttribute('srclang', 'en');
  expect(domWarnings).toEqual([]);

  // The board JSON stays free of caption text.
  expect(JSON.stringify((await (await context.request.get(`/api/canvas-boards/${boardId}`)).json()).data)).not.toContain('Offline caption fixture.');
  await context.close();
});

test('Board captions: a Start whose answer the transport drops settles without a stale error', async ({ browser, baseURL }) => {
  test.skip(!VIDEO, 'ffmpeg is needed to build the fixture clip');
  test.setTimeout(240000);
  const project = await newProject(browser, baseURL);
  const { context, page } = await signIn(browser, baseURL, project.id);
  const { video } = await boardWithVideo(context, page);
  // The run reaches Django and finishes there, but the proxy in front gives up and answers a bare 500.
  await page.route(/\/api\/canvas-boards\/[^/]+\/captions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' });
  });
  await page.getByRole('button', { name: 'Generate captions' }).click({ timeout: 20000 });
  await page.locator('[data-captions-confirm]').getByRole('button', { name: 'Start' }).click();

  const toggle = page.getByRole('button', { name: 'CC', exact: true });
  await expect(toggle).toBeVisible({ timeout: 60000 });
  await expect(page.locator('[data-captions-error]')).toHaveCount(0);
  await toggle.click();
  await expect(video.locator('track')).toHaveAttribute('src', /^blob:/, { timeout: 20000 });
  await context.close();
});
