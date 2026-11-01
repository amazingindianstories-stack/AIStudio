import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000041', name: 'Media owner', email: 'media-owner@example.test' };
// The generation worker converts SVG, PSD and PDF through pyvips. Ask the harness's Python, which runs with the
// worker's environment, whether libvips loads; a laptop without it skips those cases, and CI installs it.
const HAS_VIPS = (() => {
  try {
    execFileSync(process.env.E2E_PYTHON, ['-c', 'import pyvips'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// A 1x1 PNG, and a tiny MP4 header the server stores byte for byte (no transcoding).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
// A flattened 1x1 RGB Photoshop file: header, empty colour/resource/layer sections, raw pixel channels.
const PSD = Buffer.concat([Buffer.from('8BPS', 'latin1'), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 8, 0, 3]),
  Buffer.alloc(12), Buffer.from([0, 0, 0xcc, 0x33, 0x33])]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c33"/></svg>';
// The worker refuses SVG with active content rather than rendering part of it.
const SCRIPTED_SVG = SVG.replace('</svg>', '<script>alert(1)</script></svg>');
// A silent 44-byte WAV: RIFF header, PCM format chunk and an empty data chunk.
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]), Buffer.from('data'), Buffer.alloc(4)]);

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
    data: { op: 'createProject', name: `Board media ${randomUUID()}` }, headers: { Origin: baseURL } });
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

test('Board media: embed code, code block, emoji, interactive sticker, icon, uploads, saved files, replace image and object links', async ({ browser, baseURL }, info) => {
  test.setTimeout(240000);
  const project = await newProject(browser, baseURL);
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

  // Plain-HTTP and private-address links are refused by the server, and the dialog says why.
  for (const [url, message] of [['http://example.com/clip.mp4', 'Use a public HTTPS link'], ['https://127.0.0.1/clip.mp4', 'Could not import this public HTTPS link']]) {
    await media('Link or embed');
    dialog = page.getByRole('dialog', { name: 'Link or embed' });
    await dialog.getByLabel('Link or iframe code').fill(url);
    const refused = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/canvas-boards/${boardId}/import-url`);
    await dialog.getByRole('button', { name: /^Add/ }).click();
    expect((await refused).status()).toBe(400);
    await expect(dialog.getByRole('alert')).toContainText(message);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }

  // Malformed library cursors and file ids are client errors, not server errors.
  for (const [path, error] of [[`media?before=not-a-uuid`, 'Invalid library cursor.'], [`media/not-a-uuid`, 'Invalid file id.']]) {
    const response = await context.request.get(`/api/canvas-boards/${boardId}/${path}`);
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe(error);
  }

  // Uploads through the file picker: image, SVG and PSD (converted to PNG) and video.
  const picker = page.locator('input[type="file"][multiple]');
  const files = [{ name: 'dot.png', mimeType: 'image/png', buffer: PNG }];
  if (HAS_VIPS) files.push({ name: 'shape.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) },
    { name: 'layers.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: PSD });
  await picker.setInputFiles(files);
  board = await storedBoard(context, boardId, (b) => ofType(b, 'image').length === files.length);
  expect(ofType(board, 'image').map((image) => image.alt).sort()).toEqual(files.map((file) => file.name).sort());
  // Every image, including the SVG and the PSD, is served as PNG pixels.
  for (const image of ofType(board, 'image')) {
    expect(image.src).toMatch(/^\/api\/media\/.+\.png$/);
    const served = await context.request.get(image.src);
    expect(served.headers()['content-type']).toBe('image/png');
    expect((await served.body()).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  }
  if (HAS_VIPS) {
    await picker.setInputFiles({ name: 'scripted.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SCRIPTED_SVG) });
    await expect(page.getByRole('status').filter({ hasText: '0 files added; 1 failed. Could not render file.' })).toBeVisible({ timeout: 20000 });
    board = await storedBoard(context, boardId, (b) => ofType(b, 'image').length === files.length);
  }
  await picker.setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('00000018667479706d703432', 'hex') });
  board = await storedBoard(context, boardId, (b) => ofType(b, 'video').length === 1);
  expect(ofType(board, 'video')[0].src).toMatch(/^\/api\/media\//);
  await expect(page.locator('[data-media="video"]')).toHaveCount(1);
  await picker.setInputFiles({ name: 'memo.wav', mimeType: 'audio/wav', buffer: WAV });
  board = await storedBoard(context, boardId, (b) => ofType(b, 'audio')[0]?.title === 'memo.wav');
  expect(ofType(board, 'audio')[0].src).toMatch(/^\/api\/media\/.+\.wav$/);
  await expect(page.locator('[data-media="audio"]')).toHaveCount(1);

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

  // History names the audio clip by its title.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('region', { name: 'Board history' });
  await expect(history.getByRole('button', { name: /Added audio/ })).toContainText('“memo.wav”');
  await info.attach('history', { body: await page.screenshot(), contentType: 'image/png' });

  expect(errors).toEqual([]);
  await context.close();
});

test('Board media: a placed PDF survives reload and keeps the page it was turned to', async ({ browser, baseURL }, info) => {
  test.skip(!HAS_VIPS, 'PDF pages are rendered with libvips');
  test.setTimeout(120000);
  const project = await newProject(browser, baseURL);
  const { context, page } = await signIn(browser, baseURL, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  // Two pages, white then red, written by the harness's Pillow.
  const pdf = execFileSync(process.env.E2E_PYTHON, ['-c', `import io, sys
from PIL import Image
output = io.BytesIO()
Image.new('RGB', (200, 260), 'white').save(output, format='PDF', save_all=True, append_images=[Image.new('RGB', (200, 260), (200, 40, 40))])
sys.stdout.buffer.write(output.getvalue())`]);
  const firstSave = page.waitForResponse(isSave);
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'deck.pdf', mimeType: 'application/pdf', buffer: pdf });
  const boardId = new URL((await firstSave).url()).pathname.split('/').pop();
  let board = await storedBoard(context, boardId, (b) => ofType(b, 'pdf').length === 1);
  expect(ofType(board, 'pdf')[0]).toMatchObject({ name: 'deck.pdf', pages: 2, page: 1 });

  const pdfNode = page.locator('[data-media="pdf"]');
  await expect(pdfNode).toContainText('Page 1 of 2');
  await pdfNode.click();
  await pdfNode.getByRole('button', { name: 'Next page' }).click();
  await expect(pdfNode).toContainText('Page 2 of 2');
  board = await storedBoard(context, boardId, (b) => ofType(b, 'pdf')[0]?.page === 2);
  expect(ofType(board, 'pdf')[0].pages).toBe(2);

  // After a reload the PDF is still there, on page 2, with that page's image rendered.
  await page.reload();
  await openBoard(page);
  await expect(pdfNode).toContainText('Page 2 of 2');
  const image = pdfNode.getByRole('img', { name: 'deck.pdf, page 2 of 2' });
  await expect(image).toHaveAttribute('src', /\.pdf\.pages\/2\.png$/);
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
  await info.attach('pdf-page-2', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
  await context.close();
});
