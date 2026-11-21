import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { fixtureDatabase } from './fixture-db.mjs';

// A board of many full-resolution images: what the board actually downloads when it opens.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000071', name: 'LOD owner', email: 'lod-owner@example.test' };
const IMAGE_W = 1600;
const IMAGE_H = 1200;

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** A real 1600x1200 RGB PNG whose gradient differs per index (so tiers are genuinely re-encoded). */
function gradientPng(index) {
  const raw = Buffer.alloc((IMAGE_W * 3 + 1) * IMAGE_H);
  let at = 0;
  for (let y = 0; y < IMAGE_H; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < IMAGE_W; x += 1) {
      raw[at] = (x + index * 11) % 256;
      raw[at + 1] = (y + index * 7) % 256;
      raw[at + 2] = ((x ^ y) + index * 23) % 256;
      at += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_W, 0);
  header.writeUInt32BE(IMAGE_H, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(OWNER.id), url: baseURL }]);
  if (projectId) {
    await context.addInitScript((id) => {
      localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
    }, projectId);
  }
  return { context, page: await context.newPage() };
}

async function openBoard(page, timeout = 60000) {
  await page.goto('/', { timeout });
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click({ timeout });
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible({ timeout });
  return canvas;
}

async function newProject(browser, baseURL) {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board LOD ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();
  return project;
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname)
  && ['PUT', 'PATCH'].includes(response.request().method());

/** Upload `count` full-resolution PNGs through the board's own file picker. */
async function seedBoardImages(page, context, count) {
  const canvas = await openBoard(page, 400000);
  const placed = page.waitForResponse(isSave, { timeout: 400000 });
  await page.locator('input[type="file"][multiple]').setInputFiles(
    Array.from({ length: count }, (unused, index) => (
      { name: `plate-${index}.png`, mimeType: 'image/png', buffer: gradientPng(index) })));
  const boardId = new URL((await placed).url()).pathname.split('/').pop();
  let board;
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return board.data.nodes.filter((node) => node.type === 'image' && node.src).length;
  }, { timeout: 180000 }).toBe(count);
  return { boardId, board, canvas };
}

async function layOut(context, baseURL, boardId, board, nodes) {
  const current = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
  const saved = await context.request.put(`/api/canvas-boards/${boardId}`, {
    data: { data: { ...current.data, nodes, connectors: [], viewport: { x: 0, y: 0, zoom: 1 } },
      baseVersion: current.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(saved.status()).toBe(200);
}

const mediaKey = (src) => new URL(src, 'http://x').pathname;
const widthOf = (url) => new URL(url).searchParams.get('w');

function watchMedia(page) {
  const seen = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/media/')) return;
    seen.push({ key: url.pathname, w: url.searchParams.get('w'), status: response.status(),
      type: response.headers()['content-type'], length: Number(response.headers()['content-length'] || 0) });
  });
  return seen;
}

test('Opening a board of full-resolution images downloads small WebP tiers, skips off-screen images, and restores the master on zoom-in', async ({ browser, baseURL }, info) => {
  test.setTimeout(600000);
  const project = await newProject(browser, baseURL);
  const { context, page } = await signIn(browser, baseURL, project.id);
  const { boardId, board, canvas } = await seedBoardImages(page, context, 18);
  const images = board.data.nodes.filter((node) => node.type === 'image');
  const box = await canvas.boundingBox();

  // 12 images tiled inside the visible canvas, 6 parked just past its right edge:
  // far enough out that the image load margin excludes them, near enough that the board still mounts them.
  const near = images.slice(0, 12).map((node, index) => ({ ...node, w: 240, h: 180,
    x: 360 + (index % 3) * 260, y: 40 + Math.floor(index / 3) * 200, rotation: 0, crop: undefined }));
  const far = images.slice(12).map((node, index) => ({ ...node, w: 300, h: 225,
    x: box.width + 420 + (index % 2) * 330, y: 40 + Math.floor(index / 2) * 250, rotation: 0, crop: undefined }));
  await layOut(context, baseURL, boardId, board, [...near, ...far]);

  // Masters: what the board used to download for every one of these images.
  const masterBytes = Number((await context.request.get(near[0].src)).headers()['content-length']);
  expect(masterBytes).toBeGreaterThan(200000);

  const visitor = await signIn(browser, baseURL, project.id);
  const seen = watchMedia(visitor.page);
  await visitor.page.goto(`/?project=${project.id}&board=${boardId}`);
  await expect(visitor.page.getByRole('application', { name: 'Board canvas' })).toBeVisible({ timeout: 120000 });
  for (const node of near) {
    await expect(visitor.page.locator(`[data-node-id="${node.id}"] img`)).toBeVisible({ timeout: 60000 });
  }
  await expect.poll(() => seen.filter((entry) => entry.w).length, { timeout: 30000 }).toBeGreaterThanOrEqual(12);
  await visitor.page.waitForTimeout(2000);
  await info.attach('board-open-tiers', { body: await visitor.page.screenshot(), contentType: 'image/png' });

  // Every visible image came down as a small WebP tier sized to its rendered pixels, not as the master.
  const nearKeys = new Set(near.map((node) => mediaKey(node.src)));
  const loaded = seen.filter((entry) => nearKeys.has(entry.key));
  expect(loaded.every((entry) => ['256', '512'].includes(entry.w))).toBe(true);
  expect(loaded.every((entry) => entry.status === 200 && entry.type === 'image/webp')).toBe(true);
  expect(Math.max(...loaded.map((entry) => entry.length))).toBeLessThan(masterBytes / 5);
  expect(new Set(loaded.map((entry) => entry.key)).size).toBe(12);

  // The off-screen images are mounted by the board but never fetched.
  for (const node of far) {
    await expect(visitor.page.locator(`[data-node-id="${node.id}"]`)).toHaveCount(1);
    expect(seen.some((entry) => entry.key === mediaKey(node.src))).toBe(false);
  }

  const tierBytes = loaded.reduce((total, entry) => total + entry.length, 0);
  info.annotations.push({ type: 'bytes', description:
    `12 visible images: ${tierBytes} B of WebP tiers vs ${masterBytes * 12} B of masters` });

  // Zooming in on one image swaps it to the untouched full-resolution master.
  // Zoom keeps the viewport centre, so drive the image sitting closest to it.
  const centre = { x: box.width / 2, y: box.height / 2 };
  const target = near.reduce((best, node) => (
    Math.hypot(node.x + node.w / 2 - centre.x, node.y + node.h / 2 - centre.y)
      < Math.hypot(best.x + best.w / 2 - centre.x, best.y + best.h / 2 - centre.y) ? node : best));
  // Focus the canvas on empty space (clear of the asset panel and the toolbars) before zooming.
  await visitor.page.getByRole('application', { name: 'Board canvas' })
    .click({ position: { x: box.width - 90, y: box.height - 240 } });
  for (let step = 0; step < 14; step += 1) {
    await visitor.page.keyboard.press('ControlOrMeta+Equal');
    await visitor.page.waitForTimeout(120);
  }
  await expect.poll(() => seen.some((entry) => entry.key === mediaKey(target.src) && !entry.w),
    { timeout: 60000 }).toBe(true);
  const master = seen.find((entry) => entry.key === mediaKey(target.src) && !entry.w);
  expect(master.status).toBe(200);
  expect(master.type).toBe('image/png');
  await expect(visitor.page.locator(`[data-node-id="${target.id}"] img`)).toBeVisible();
  await info.attach('zoomed-master', { body: await visitor.page.screenshot(), contentType: 'image/png' });

  await visitor.context.close();
  await context.close();
});

test('A board of many images never floods the network: thumbnails stay within their pool and masters within theirs', async ({ browser, baseURL }, info) => {
  test.setTimeout(600000);
  const project = await newProject(browser, baseURL);
  const { context, page } = await signIn(browser, baseURL, project.id);
  const { boardId, board } = await seedBoardImages(page, context, 24);
  const images = board.data.nodes.filter((node) => node.type === 'image');
  const nodes = images.map((node, index) => ({ ...node, w: 150, h: 112,
    x: 20 + (index % 8) * 165, y: 20 + Math.floor(index / 8) * 130, rotation: 0, crop: undefined }));
  await layOut(context, baseURL, boardId, board, nodes);

  const visitor = await signIn(browser, baseURL, project.id);
  let thumbActive = 0;
  let masterActive = 0;
  let peakThumb = 0;
  let peakMaster = 0;
  const requested = new Set();
  // Hold every media response briefly so the board's own queue, not the LAN, decides parallelism.
  await visitor.page.route('**/api/media/**', async (route) => {
    const url = new URL(route.request().url());
    const isThumb = Boolean(url.searchParams.get('w'));
    requested.add(url.pathname + (isThumb ? `?w=${url.searchParams.get('w')}` : ''));
    if (isThumb) {
      thumbActive += 1;
      peakThumb = Math.max(peakThumb, thumbActive);
    } else {
      masterActive += 1;
      peakMaster = Math.max(peakMaster, masterActive);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (isThumb) thumbActive -= 1;
    else masterActive -= 1;
    await route.continue();
  });
  await visitor.page.goto(`/?project=${project.id}&board=${boardId}`);
  await expect(visitor.page.getByRole('application', { name: 'Board canvas' })).toBeVisible({ timeout: 120000 });
  for (const node of nodes) {
    await expect(visitor.page.locator(`[data-node-id="${node.id}"] img`)).toBeVisible({ timeout: 60000 });
  }
  await info.attach('board-24-images', { body: await visitor.page.screenshot(), contentType: 'image/png' });

  expect(requested.size).toBeGreaterThanOrEqual(24);
  expect(peakThumb).toBeGreaterThan(4);
  expect(peakThumb).toBeLessThanOrEqual(16);
  expect(peakMaster).toBeLessThanOrEqual(2);
  info.annotations.push({ type: 'concurrency', description: `peak in-flight media requests: ${peakThumb}` });

  await visitor.context.close();
  await context.close();
});
