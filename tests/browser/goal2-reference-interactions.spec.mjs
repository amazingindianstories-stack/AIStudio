import { test, expect } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const userId = 'e33e1832-9e29-427f-af61-796b842a4b37';
const diagnostics = new WeakMap();
test.beforeEach(async ({ page }) => {
  const entries = []; diagnostics.set(page, entries);
  page.on('pageerror', error => entries.push({ type: 'pageerror', text: error.message }));
  page.on('console', message => {
    if (['warning', 'error'].includes(message.type())) entries.push({ type: message.type(), text: message.text().replace(/https?:\/\/\S+/g, '[URL]') });
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const entries = diagnostics.get(page) || [];
  await testInfo.attach('browser-diagnostics', { body: JSON.stringify(entries, null, 2), contentType: 'application/json' });
  expect(entries.filter(entry => entry.type === 'pageerror' || /hydration|hydrated|cannot be a descendant/i.test(entry.text))).toEqual([]);
});
async function ready(page, context, baseURL) {
  if (process.env.MIGRATION_TEST_ISOLATED !== '1' || !process.env.AUTH_SECRET || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Goal2 requires isolated local Django.');
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByText('Desktop fixture').first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Image', exact: true }).click();
}
async function stage(page, context, count) {
  const image = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  expect(image.ok()).toBeTruthy();
  const buffer = await image.body();
  await page.locator('input[type=file][multiple][accept="image/*,video/*,audio/*"]').setInputFiles(Array.from({ length: count }, () => ({ name: 'same-name.png', mimeType: 'image/png', buffer })));
  await expect(page.locator('[data-reference-id]')).toHaveCount(count, { timeout: 90000 });
  const ids = await page.locator('[data-reference-id]').evaluateAll(cards => cards.map(card => card.dataset.referenceId));
  expect(new Set(ids).size).toBe(count);
  return ids;
}
async function order(page) { return page.locator('[data-reference-id]').evaluateAll(cards => cards.map(card => card.dataset.referenceId)); }

test('Goal2 actual pointer traverses 50 references with edge autoscroll and preserves indexed mentions', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(150000);
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 50);
  await page.locator('textarea').first().fill('@img1 @img10 @img50 literal @img100 @named');
  const strip = page.getByTestId('reference-strip');
  const handle = page.locator('[data-reference-grip]').first();
  const h = await handle.boundingBox();
  const bounds = await strip.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 2, h.y + h.height / 2, { steps: 20 });
  await expect.poll(async () => strip.evaluate(el => el.scrollLeft + el.clientWidth >= el.scrollWidth - 5), { timeout: 20000 }).toBeTruthy();
  await page.mouse.move(bounds.x + bounds.width - 1, h.y + h.height / 2);
  await expect.poll(async () => (await order(page)).at(-1)).toBe(ids[0]);
  await page.mouse.up();
  expect((await order(page)).at(-1)).toBe(ids[0]);
  await expect(page.locator('textarea').first()).toHaveValue('@img50 @img9 @img49 literal @img100 @named');
  await page.screenshot({ path: testInfo.outputPath('50-reference-pointer.png') });
  await page.getByRole('button', { name: 'Undo reorder', exact: true }).click();
  expect(await order(page)).toEqual(ids);
  await expect(page.locator('textarea').first()).toHaveValue('@img1 @img10 @img50 literal @img100 @named');
});

test('Goal2 explicit buttons position keyboard focus and reload preserve attachment occurrence identity', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 10);
  const sources = await page.locator('[data-reference-id] img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  await page.locator('textarea').first().fill('@img1 @img10 @img100 @named');
  const grip = await page.locator('[data-reference-grip]').first().boundingBox();
  const stripBounds = await page.getByTestId('reference-strip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(stripBounds.x + stripBounds.width - 1, grip.y + grip.height / 2, { steps: 15 });
  await expect.poll(async () => (await order(page)).at(-1)).toBe(ids[0]);
  await page.mouse.up();
  await expect(page.locator('textarea').first()).toHaveValue('@img10 @img9 @img100 @named');
  await page.getByRole('button', { name: 'Undo reorder', exact: true }).click();
  await page.getByRole('button', { name: 'Move reference 1 right', exact: true }).click();
  expect((await order(page))[1]).toBe(ids[0]);
  const moved = page.locator(`[data-reference-id="${ids[0]}"] [data-reference-grip]`);
  await expect(moved).toBeFocused();
  await moved.press('Alt+ArrowRight');
  expect((await order(page))[2]).toBe(ids[0]);
  await expect(moved).toBeFocused();
  await page.locator(`[data-reference-id="${ids[0]}"]`).getByRole('button', { name: /to position$/ }).click();
  await page.getByRole('spinbutton', { name: 'Move to position' }).fill('10');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  expect((await order(page)).at(-1)).toBe(ids[0]);
  await expect(page.locator('textarea').first()).toHaveValue('@img10 @img9 @img100 @named');
  await page.reload();
  await expect(page.locator('[data-reference-id]')).toHaveCount(10);
  expect((await order(page)).at(-1)).toBe(ids[0]);
  await page.screenshot({ path: testInfo.outputPath('reference-reload.png') });
  await page.locator('textarea').first().fill('Compare @img10 with @img9');
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/generate/image') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const submitted = response.request().postDataJSON();
  const expectedSources = [...sources.slice(1), sources[0]];
  expect(submitted.referenceImages).toEqual(expectedSources);
  expect(submitted.prompt).toBe('Compare @img10 with @img9');
  const result = await response.json();
  const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const rows = await sql`SELECT prompt, reference_images, submission_input FROM generations WHERE id=${result.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].prompt).toBe(submitted.prompt);
  expect(rows[0].reference_images).toEqual(expectedSources);
  await expect(page.locator('textarea').first()).toHaveValue(submitted.prompt);
  expect(await order(page)).toEqual([...ids.slice(1), ids[0]]);
  await page.screenshot({ path: testInfo.outputPath('post-submit-retained-reference-state.png') });
  const card = page.locator(`[data-generation-id="${result.id}"]`).first();
  await expect(card.locator('time')).toBeVisible({ timeout: 30000 });
  await card.hover();
  await expect(card.getByRole('button', { name: /^▱ / })).toContainText('Unsorted');
  await expect(card.locator('time')).toHaveAttribute('datetime', /T.*Z$/);
  await card.locator('time').hover();
  await page.screenshot({ path: testInfo.outputPath('chat-folder-cue-timestamp.png') });
  await page.locator('textarea').first().fill('A later editable draft @img1');
  await page.getByRole('button', { name: 'Move reference 1 right', exact: true }).click();
  const committed = await sql`SELECT prompt, reference_images FROM generations WHERE id=${result.id}`;
  expect(committed[0].prompt).toBe(submitted.prompt);
  expect(committed[0].reference_images).toEqual(expectedSources);
});

test('Goal2 33MiB attachment uses bounded binary chunks and small init finalize metadata', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120000);
  await ready(page, context, baseURL);
  const fixture = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const buffer = Buffer.alloc(33 * 1024 * 1024);
  (await fixture.body()).copy(buffer);
  const requests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/uploads/')) requests.push(request);
  });
  await page.locator('input[type=file][multiple][accept="image/*,video/*,audio/*"]').setInputFiles({ name: 'large-fixture.png', mimeType: 'image/png', buffer });
  await expect(page.locator('[data-reference-id]')).toHaveCount(1, { timeout: 90000 });
  const boundaries = await Promise.all(requests.map(async request => {
    const headers = await request.allHeaders();
    return { path: new URL(request.url()).pathname, method: request.method(),
      bytes: Number(headers['content-length'] || (await request.sizes()).requestBodySize),
      contentType: headers['content-type'], range: headers['content-range'] };
  }));
  const metadata = boundaries.filter(request => request.method === 'POST');
  expect(metadata.some(request => request.path.endsWith('/init'))).toBeTruthy();
  expect(metadata.some(request => request.path.endsWith('/finalize'))).toBeTruthy();
  expect(metadata.every(request => request.bytes < 8192)).toBeTruthy();
  const chunks = boundaries.filter(request => request.method === 'PUT' && request.bytes);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.reduce((sum, request) => sum + request.bytes, 0)).toBe(buffer.length);
  expect(chunks.every(request => request.bytes <= 8 * 1024 * 1024 && request.range?.startsWith('bytes '))).toBeTruthy();
  const stored = await context.request.get(await page.locator('[data-reference-id] img').getAttribute('src'));
  expect(stored.ok()).toBeTruthy();
  expect(createHash('sha256').update(await stored.body()).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
  await testInfo.attach('sanitized-upload-boundaries', { body: JSON.stringify(boundaries, null, 2), contentType: 'application/json' });
});

test('Goal2 portrait six-selection bulk attach and repeated same portrait retain separate occurrence IDs', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120000);
  await ready(page, context, baseURL);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const buffer = await fixture.body();
  const prefix = `QA-${Date.now()}`;
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Portrait Gallery', exact: true });
  await gallery.locator('input[type=file]').setInputFiles(Array.from({ length: 6 }, (_, i) => ({ name: `${prefix}-${i}.png`, mimeType: 'image/png', buffer })));
  await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(6, { timeout: 90000 });
  const tiles = gallery.locator('article').filter({ hasText: prefix });
  await tiles.first().click();
  await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await expect(gallery.getByRole('button', { name: 'Add 2 to prompt', exact: true })).toBeVisible();
  await gallery.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await tiles.first().click();
  await tiles.nth(5).click({ modifiers: ['Shift'] });
  await expect(gallery.getByRole('button', { name: 'Add 6 to prompt', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('portrait-six-selected-reduced-motion.png') });
  await gallery.getByRole('button', { name: 'Add 6 to prompt', exact: true }).click();
  if (await gallery.isVisible()) await gallery.getByRole('button', { name: 'Close Portrait Gallery', exact: true }).click();
  await expect(page.locator('[data-reference-id]')).toHaveCount(6);
  const initialIds = await order(page);
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  await gallery.locator('article').filter({ hasText: `${prefix}-0` }).click();
  await gallery.getByRole('button', { name: 'Add 1 to prompt', exact: true }).click();
  if (await gallery.isVisible()) await gallery.getByRole('button', { name: 'Close Portrait Gallery', exact: true }).click();
  await expect(page.locator('[data-reference-id]')).toHaveCount(7);
  const ids = await order(page);
  expect(new Set(ids).size).toBe(7);
  expect(ids.slice(0, 6)).toEqual(initialIds);
  const sources = await page.locator('[data-reference-id] img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  expect(sources.filter(source => source === sources.at(-1))).toHaveLength(2);
});

test('Goal2 actor switch cannot restore another actors prompt or attachment IDs', async ({ page, context, baseURL }) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 2);
  await page.locator('textarea').first().fill('Private actor fixture @img1');
  // Prove the debounced text revision was actually committed before switching actors.
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('veevee-composer-metadata', 1);
    open.onsuccess = () => {
      const db = open.result; const query = db.transaction('drafts').objectStore('drafts').getAll();
      query.onsuccess = () => { resolve(query.result.some(value => value.prompt === 'Private actor fixture @img1')); db.close(); };
      query.onerror = () => { resolve(false); db.close(); };
    };
    open.onerror = () => resolve(false);
  }))).toBeTruthy();
  await page.reload();
  await expect(page.locator('textarea').first()).toHaveValue('Private actor fixture @img1');
  expect(await order(page)).toEqual(ids);
  const actor = randomUUID();
  const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await sql`INSERT INTO users (id,email,password_hash,password_salt,name,role,created_at) VALUES (${actor},${`${actor}@example.test`},'unused','unused','Other QA actor','user',${Date.now()})`;
  const payload = Buffer.from(JSON.stringify({ uid: actor, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
  await page.reload();
  await expect(page.getByText('Other QA actor').first()).toBeVisible();
  await expect(page.locator('[data-reference-id]')).toHaveCount(0);
  await expect(page.locator('textarea').first()).not.toHaveValue('Private actor fixture @img1');
});

test('Goal2 native file drag events stage media and reject unsupported files without navigation', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const fixture = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const bytes = [...await fixture.body()];
  const transfer = await page.evaluateHandle(bytes => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'native-file.png', { type: 'image/png' }));
    return dt;
  }, bytes);
  const target = page.locator('.composer-shell').first();
  const before = page.url();
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await page.screenshot({ path: testInfo.outputPath('native-file-valid-drop.png') });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('[data-reference-id]')).toHaveCount(1);
  expect(page.url()).toBe(before);
  const invalid = await page.evaluateHandle(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['fixture'], 'unsupported.exe', { type: 'application/octet-stream' })); return dt;
  });
  await target.dispatchEvent('dragenter', { dataTransfer: invalid });
  await target.dispatchEvent('dragover', { dataTransfer: invalid });
  await page.screenshot({ path: testInfo.outputPath('native-file-invalid-drop.png') });
  await target.dispatchEvent('drop', { dataTransfer: invalid });
  await expect(page.locator('[data-reference-id]')).toHaveCount(1);
  expect(page.url()).toBe(before);
  await transfer.dispose(); await invalid.dispose();
});

test('Goal2 200-project menu keeps action footer visible at scroll bottom', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const prefix = `QA200-${randomUUID()}`;
  await sql`INSERT INTO projects (id,name,created_at,updated_at) SELECT gen_random_uuid(),${prefix}||'-'||lpad(i::text,3,'0'),1,1 FROM generate_series(1,200) AS i`;
  try {
    await page.reload();
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.locator('#desktop-history-panel').getByRole('button', { name: 'Switch workspace', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search projects', exact: true }).fill(prefix);
    const footer = page.getByTestId('project-actions-footer');
    await expect(footer.getByRole('menuitem', { name: 'New project', exact: true })).toBeVisible();
    const list = footer.locator('..').locator('.overflow-y-auto');
    await list.hover(); await page.mouse.wheel(0, 20000);
    await expect.poll(() => list.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBeTruthy();
    await expect(footer.getByRole('menuitem', { name: 'New project', exact: true })).toBeVisible();
    await footer.locator('..').screenshot({ path: testInfo.outputPath('200-project-open-menu-footer.png') });
    await page.screenshot({ path: testInfo.outputPath('200-project-sticky-footer.png') });
  } finally { await sql`DELETE FROM projects WHERE name LIKE ${`${prefix}%`}`; }
});

test('Goal2 material inspector and Magnific variants render fixture source at desktop narrow and mobile widths', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const projectFeed = await context.request.get('/api/projects');
  const projectId = (await projectFeed.json()).projects[0].id;
  const id = randomUUID(), name = `QA material ${id.slice(0, 8)}`;
  await sql`INSERT INTO assets (id,kind,name,slug,images,project_id,created_by_id,created_at,updated_at)
    SELECT ${id},'character',${name},${`qa-${id}`},jsonb_build_array(url),${projectId},${userId},1,1 FROM generations WHERE id='10000000-0000-4000-8000-000000000001'`;
  try {
    await page.reload(); // Discard the pre-fixture material feed cache.
    await page.getByRole('button', { name: 'material', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Material library', exact: true }).click();
    const material = page.getByRole('dialog', { name: 'Material Library', exact: true });
    await material.getByPlaceholder('Search materials or @slug...').fill(name);
    await expect(material.getByRole('img', { name, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('material-library.png') });
    await material.getByRole('img', { name, exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Material Sheet Full View', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('material-inspector.png') });
    await page.getByRole('button', { name: 'Close Lightbox', exact: true }).click();
    await material.getByRole('button', { name: 'Close Material Library', exact: true }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Upscale', exact: true }).click();
    const image = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
    await page.locator('input[type=file][accept="image/png,image/jpeg,image/webp"]').setInputFiles({ name: 'magnific-source.png', mimeType: 'image/png', buffer: await image.body() });
    await expect(page.getByRole('img', { name: 'Source preview', exact: true })).toBeVisible();
    for (const model of ['Creative', 'Precision V2', 'Precision V1']) {
      await page.getByRole('button', { name: new RegExp(`^${model}`) }).click();
      await expect(page.getByRole('img', { name: 'Source preview', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`magnific-${model.replaceAll(' ', '-')}.png`) });
    }
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('img', { name: 'Source preview', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`magnific-${width}.png`) });
    }
  } finally { await sql`DELETE FROM assets WHERE id=${id}`; }
});

test('Goal2 long three-level folders keyboard scroll eight colours hide reload and pending conflict remain authoritative', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120000);
  await ready(page, context, baseURL);
  const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const projectId = randomUUID(), name = `QA folder ${projectId.slice(0, 8)}`;
  await sql`INSERT INTO projects (id,name,created_at,updated_at) VALUES (${projectId},${name},1,1)`;
  const names = [1, 2, 3].map(level => `${name} level${level} — ${'A complete long destination name '.repeat(6)}`.slice(0, 100));
  const ids = [];
  for (const folderName of names) {
    const response = await context.request.post('/api/folders', { headers: { Origin: baseURL }, data: { name: folderName, projectId, parentId: ids.at(-1) || null, idempotencyKey: randomUUID() } });
    expect(response.ok()).toBeTruthy(); ids.push((await response.json()).folder.id);
  }
  let release;
  try {
    await page.reload();
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const panel = page.locator('#desktop-history-panel');
    await panel.getByRole('button', { name: 'Switch workspace', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    await expect(panel.getByRole('tree', { name: 'Folder Hierarchy', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: `Expand ${names[0]}`, exact: true }).click();
    await panel.getByRole('button', { name: `Expand ${names[1]}`, exact: true }).click();
    const viewport = panel.getByTestId('folder-hierarchy-viewport');
    await page.screenshot({ path: testInfo.outputPath('long-three-level-folders-initial.png') });
    await viewport.focus();
    for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => viewport.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await expect(panel.getByRole('button', { name: `${name} Unsorted`, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('long-three-level-folder-scroll-unsorted.png') });
    for (let step = 0; step < 6; step++) await viewport.press('ArrowLeft');
    for (const colour of ['Gray', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Default']) {
      await panel.getByRole('button', { name: `Tree folder actions: ${names[0]}`, exact: true }).click();
      const response = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/folders');
      await page.getByRole('button', { name: colour, exact: true }).click();
      expect((await response).ok()).toBeTruthy();
      expect((await sql`SELECT color FROM folders WHERE id=${ids[0]}`)[0].color).toBe(colour === 'Default' ? null : colour.toLowerCase());
    }
    const hide = page.getByRole('button', { name: 'Hide folders', exact: true });
    if (await hide.count()) {
      await page.screenshot({ path: testInfo.outputPath('folders-shown-compact.png') });
      await hide.click(); await page.reload();
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await expect(page.getByRole('button', { name: 'Show folders', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('folders-hidden-reloaded.png') });
      await page.getByRole('button', { name: 'Show folders', exact: true }).click();
    }
    const gate = new Promise(resolve => { release = resolve; });
    let attempts = 0;
    await page.route('**/api/folders', async route => {
      if (route.request().method() !== 'PATCH' || !route.request().postDataJSON()?.name) return route.continue();
      attempts += 1; await gate;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Folder changed elsewhere', code: 'VERSION_CONFLICT' }) });
    });
    await panel.getByRole('button', { name: `Tree folder actions: ${names[0]}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: 'Rename folder', exact: true });
    await editor.fill(`${name} cancelled`); await editor.press('Escape');
    await expect(editor).toHaveCount(0); expect(attempts).toBe(0);
    expect((await sql`SELECT name FROM folders WHERE id=${ids[0]}`)[0].name).toBe(names[0]);
    await panel.getByRole('button', { name: `Tree folder actions: ${names[0]}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await editor.fill(`${name} pending`); await editor.press('Enter');
    await expect(editor).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => attempts).toBe(1);
    await editor.press('Enter');
    expect(attempts).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('folder-pending-rename.png') });
    release();
    await expect(panel.getByRole('alert')).toContainText('Folder changed elsewhere');
    expect((await sql`SELECT name FROM folders WHERE id=${ids[0]}`)[0].name).toBe(names[0]);
    await page.screenshot({ path: testInfo.outputPath('folder-version-conflict.png') });
    await editor.press('Escape');
    await expect(editor).toHaveCount(0);
  } finally {
    release?.(); await page.unroute('**/api/folders').catch(() => {});
    await sql`DELETE FROM folders WHERE project_id=${projectId}`;
    await sql`DELETE FROM projects WHERE id=${projectId}`;
  }
});

test('Goal2 actual touch swipe scrolls thumbnails and touch grip alone reorders', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 12);
  const strip = page.getByTestId('reference-strip');
  const bounds = await strip.boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
  await touch('touchStart', bounds.x + bounds.width - 50, bounds.y + 40);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', bounds.x + bounds.width - 50 - i * 45, bounds.y + 40); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  expect(await order(page)).toEqual(ids);
  await strip.hover(); await page.mouse.wheel(-2000, 0);
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeLessThan(5);
  const grip = await page.locator('[data-reference-grip]').first().boundingBox();
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  await touch('touchStart', x, y);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', x + i * 13, y); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await expect.poll(async () => (await order(page))[1]).toBe(ids[0]);
  await page.screenshot({ path: testInfo.outputPath('touch-scroll-grip-reorder.png') });
  await cdp.detach();
});

test('Goal2 mixed image video audio namespaces survive an image finalization completing last', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitem', { name: /^Seedance 2\.5(?:\s|$)/ }).click();
  const image = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const movie = await context.request.get('/api/generations/20000000-0000-4000-8000-000000000001/download');
  const wav = Buffer.alloc(1644); wav.write('RIFF'); wav.writeUInt32LE(1636, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(1600,40);
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/uploads/*/finalize', async route => {
    if (!held) { held = true; await gate; } await route.continue();
  });
  try {
    const input = page.locator('input[type=file][multiple][accept="image/*,video/*,audio/*"]');
    await input.setInputFiles({ name: 'late-image.png', mimeType: 'image/png', buffer: await image.body() });
    await expect.poll(() => held).toBeTruthy();
    await input.setInputFiles([{ name: 'early-video.mov', mimeType: 'video/quicktime', buffer: await movie.body() }, { name: 'early-audio.wav', mimeType: 'audio/wav', buffer: wav }]);
    await expect(page.getByRole('button', { name: 'Remove reference clip 1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove audio note 1', exact: true })).toBeVisible();
    release();
    await expect(page.locator('[data-reference-id]')).toHaveCount(1);
    await page.locator('textarea').first().fill('Use @img1 with @vid1 and @audio1');
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/generate/video'));
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const response = await responsePromise; expect(response.ok()).toBeTruthy();
    const payload = response.request().postDataJSON();
    expect(payload.prompt).toBe('Use @img1 with @vid1 and @audio1');
    expect(payload.referenceImages).toHaveLength(1); expect(payload.referenceVideos).toHaveLength(1); expect(payload.referenceAudios).toHaveLength(1);
    expect(payload.referenceImages[0]).toContain('/uploads/image-reference/');
    expect(payload.referenceVideos[0]).toContain('/uploads/video-reference/');
    expect(payload.referenceAudios[0]).toContain('/uploads/audio-reference/');
    await page.screenshot({ path: testInfo.outputPath('mixed-references-late-image-postsubmit.png') });
  } finally { release?.(); await page.unroute('**/api/uploads/*/finalize'); }
});

test('Goal2 portrait inspector confirmed bulk deletion keeps partial failure selected for retry', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const image = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const prefix = `QA-delete-${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Portrait Gallery', exact: true });
  const buffer = await image.body();
  await gallery.locator('input[type=file]').setInputFiles([0, 1].map(i => ({ name: `${prefix}-${i}.png`, mimeType: 'image/png', buffer })));
  await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(2);
  await gallery.getByRole('textbox', { name: 'Search portraits', exact: true }).fill(prefix);
  await page.screenshot({ path: testInfo.outputPath('portrait-normal-two-fixtures.png') });
  await gallery.getByRole('button', { name: `View ${prefix}-0`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Portrait Full View', exact: true });
  await expect(inspector).toBeVisible();
  await expect.poll(() => inspector.locator('img').first().evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('portrait-right-inspector.png') });
  await inspector.getByRole('button', { name: 'Close Lightbox', exact: true }).click();
  const tiles = gallery.locator('article').filter({ hasText: prefix });
  await tiles.first().click(); await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
  let attempts = 0;
  await page.route('**/api/assets/portraits?assetId=*', async route => {
    if (route.request().method() === 'DELETE' && ++attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture temporary delete failure' }) });
    return route.continue();
  });
  try {
    await gallery.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toContainText('Delete 2 portraits?');
    await confirmation.getByRole('button', { name: 'Delete 2', exact: true }).click();
    await expect(gallery.getByRole('alert')).toContainText('Deleted 1; 1 failed');
    await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(1);
    await expect(gallery.getByRole('button', { name: 'Add 1 to prompt', exact: true })).toBeVisible();
    expect(attempts).toBe(2);
    const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
    expect((await sql`SELECT id FROM portrait_assets WHERE name LIKE ${`${prefix}%`}`)).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('portrait-partial-delete-failure.png') });
    await page.unroute('**/api/assets/portraits?assetId=*');
    await gallery.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete 1', exact: true }).click();
    await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(0);
    expect((await sql`SELECT id FROM portrait_assets WHERE name LIKE ${`${prefix}%`}`)).toHaveLength(0);
  } finally { await page.unroute('**/api/assets/portraits?assetId=*').catch(() => {}); }
});
