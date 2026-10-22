import { test, expect } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';
import { portraitPng } from './portrait-image.mjs';

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
  await expect(page.locator('[data-reference-grip]')).toHaveCount(0);
  const handle = page.locator('[data-reference-preview]').first();
  // Editing the prompt re-lays the cards out with a layout animation; hover waits until the thumbnail
  // has stopped moving, so the press lands on it and the measured geometry is the resting one.
  await handle.hover();
  const h = await handle.boundingBox();
  const bounds = await strip.boundingBox();
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 2, h.y + h.height / 2, { steps: 20 });
  await expect.poll(async () => strip.evaluate(el => el.scrollLeft + el.clientWidth >= el.scrollWidth - 5), { timeout: 20000 }).toBeTruthy();
  await page.mouse.move(bounds.x + bounds.width - 1, h.y + h.height / 2);
  await expect.poll(async () => (await order(page)).at(-1)).toBe(ids[0]);
  await page.mouse.up();
  expect((await order(page)).at(-1)).toBe(ids[0]);
  // Tags are positional: the drag reorders the strip but never rewrites the typed prompt.
  await expect(page.locator('textarea').first()).toHaveValue('@img1 @img10 @img50 literal @img100 @named');
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
  // As above: press the thumbnail only once the layout animation has settled.
  await page.locator('[data-reference-preview]').first().hover();
  const grip = await page.locator('[data-reference-preview]').first().boundingBox();
  const stripBounds = await page.getByTestId('reference-strip').boundingBox();
  await page.mouse.down();
  await page.mouse.move(stripBounds.x + stripBounds.width - 1, grip.y + grip.height / 2, { steps: 15 });
  await expect.poll(async () => (await order(page)).at(-1)).toBe(ids[0]);
  await page.mouse.up();
  expect((await order(page)).at(-1)).toBe(ids[0]);
  await expect(page.locator('textarea').first()).toHaveValue('@img1 @img10 @img100 @named');
  await page.getByRole('button', { name: 'Undo reorder', exact: true }).click();
  expect(await order(page)).toEqual(ids);
  await expect(page.locator('textarea').first()).toHaveValue('@img1 @img10 @img100 @named');
  await page.locator('[data-reference-id]').first().hover();
  await page.getByRole('button', { name: 'Move reference 1 right', exact: true }).click();
  expect((await order(page))[1]).toBe(ids[0]);
  const moved = page.locator(`[data-reference-id="${ids[0]}"] [data-reference-preview]`);
  await expect(moved).toBeFocused();
  await moved.press('Alt+ArrowRight');
  expect((await order(page))[2]).toBe(ids[0]);
  await expect(moved).toBeFocused();
  // The position control is visually hidden until it has keyboard focus.
  const toPosition = page.locator(`[data-reference-id="${ids[0]}"]`).getByRole('button', { name: /to position$/ });
  await toPosition.focus(); await toPosition.press('Enter');
  await page.getByRole('spinbutton', { name: 'Move to position' }).fill('10');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  expect((await order(page)).at(-1)).toBe(ids[0]);
  await expect(page.locator('textarea').first()).toHaveValue('@img1 @img10 @img100 @named');
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
  // Providers receive canonical masters; the strip's preview parameters (?w=512...) never leave the browser.
  const canonical = (url) => url.split('?')[0];
  const expectedSources = [...sources.slice(1), sources[0]].map(canonical);
  expect(submitted.referenceImages).toEqual(expectedSources);
  expect(submitted.referenceImages.some((url) => url.includes('?'))).toBe(false);
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
  await page.locator('[data-reference-id]').first().hover();
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
  const prefix = `QA-${Date.now()}`;
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Portrait Gallery', exact: true });
  // Identical bytes would collapse into one gallery portrait, so each file is a different valid image.
  await gallery.locator('input[type=file]').setInputFiles(Array.from({ length: 6 }, (_, i) => ({ name: `${prefix}-${i}.png`, mimeType: 'image/png', buffer: portraitPng(`${prefix}-${i}`) })));
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

test('Goal2 reordering and removing references leave the prompt alone, as in Higgsfield', async ({ page, context, baseURL }) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 3);
  const prompt = page.locator('textarea').first();
  await prompt.fill('@img1 then @img3');
  await page.locator('[data-reference-id]').first().hover();
  await page.getByRole('button', { name: 'Move reference 1 right', exact: true }).click();
  expect(await order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await expect(prompt).toHaveValue('@img1 then @img3');
  await page.getByRole('button', { name: 'Undo reorder', exact: true }).click();
  expect(await order(page)).toEqual(ids);
  await page.getByRole('button', { name: 'Remove reference 2', exact: true }).click();
  expect(await order(page)).toEqual([ids[0], ids[2]]);
  // @img3 now points past the last slot and shows as unresolved until it is replaced.
  await expect(prompt).toHaveValue('@img1 then @img3');
});

test('Goal2 clicking an unresolved tag replaces it from a menu of the attached references', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  await stage(page, context, 2);
  const prompt = page.locator('textarea').first();
  await prompt.fill('@img1 walks past @img3 while @img3 waves');
  const tag = page.locator('[data-mention-start="17"]');
  // Veevee marks a tag past the last slot amber (literal text), where Higgsfield shows red.
  await expect(tag).toHaveClass(/text-amber-200/);
  const box = await tag.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const menu = page.locator('[data-tag-replace-menu="open"]');
  await expect(menu).toContainText('Replace @img3 with:');
  await expect(menu.getByRole('option')).toHaveText([/@img1/, /@img2/]);
  await expect(menu.getByRole('combobox', { name: 'Search references' })).toBeFocused();
  // The menu follows the tag while the composer settles, centred on it.
  await expect.poll(async () => {
    const [menuBox, tagBox] = [await menu.boundingBox(), await tag.boundingBox()];
    return Math.abs(menuBox.x + menuBox.width / 2 - (tagBox.x + tagBox.width / 2));
  }).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('tag-replace-menu.png') });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(prompt).toHaveValue('@img1 walks past @img2 while @img2 waves');
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate(el => el.selectionStart)).toBe('@img1 walks past @img2'.length);
  await page.keyboard.type('X');
  await expect(prompt).toHaveValue('@img1 walks past @img2X while @img2 waves');
});

test('Goal2 hover side arrows shift neighbours without overlap and thumbnail drag reorders', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 20);
  await page.locator('textarea').first().fill('@img1 then @img2');
  await page.mouse.move(10, 10);
  const firstCard = page.locator('[data-reference-id]').first();
  const secondCard = page.locator('[data-reference-id]').nth(1);
  const rightArrow = page.getByRole('button', { name: 'Move reference 1 right', exact: true });
  const arrowWidth = () => rightArrow.evaluate((el) => el.getBoundingClientRect().width);
  await expect.poll(arrowWidth).toBe(0);
  const secondBefore = await secondCard.boundingBox();
  await firstCard.hover();
  await expect.poll(arrowWidth).toBeGreaterThan(10);
  const arrowBox = await rightArrow.boundingBox();
  const thumbBox = await firstCard.locator('[data-reference-preview]').boundingBox();
  const secondAfter = await secondCard.boundingBox();
  // Right arrow sits outside the right edge of the thumbnail and shifts the second card right with no overlap.
  expect(arrowBox.x).toBeGreaterThanOrEqual(thumbBox.x + thumbBox.width - 2);
  expect(secondAfter.x).toBeGreaterThan(secondBefore.x + 15);
  expect(secondAfter.x).toBeGreaterThanOrEqual(arrowBox.x + arrowBox.width - 1);
  await page.mouse.move(10, 10);
  await expect.poll(arrowWidth).toBe(0);
  // The arrow collapses before the neighbour finishes sliding back, so wait for the card to settle.
  await expect.poll(async () => Math.abs((await secondCard.boundingBox()).x - secondBefore.x)).toBeLessThan(0.5);
  // Focus on the thumbnail alone keeps the arrows hidden; tabbing onto an arrow reveals it and makes
  // the same room; blurring hides it.
  await page.getByRole('button', { name: 'Move reference 1 to position', exact: true }).focus();
  await expect.poll(arrowWidth).toBe(0);
  await page.keyboard.press('Tab');
  await expect(rightArrow).toBeFocused();
  await expect.poll(arrowWidth).toBeGreaterThan(10);
  expect((await secondCard.boundingBox()).x).toBeGreaterThan(secondBefore.x + 15);
  await page.evaluate(() => document.activeElement?.blur());
  await expect.poll(arrowWidth).toBe(0);
  const strip = page.getByTestId('reference-strip');
  await strip.hover();
  await page.mouse.wheel(400, 0);
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeGreaterThan(50);
  expect(await order(page)).toEqual(ids);
  await page.mouse.wheel(-1000, 0);
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeLessThan(5);
  const previewThumb = await firstCard.locator('[data-reference-preview]').boundingBox();
  const x = previewThumb.x + previewThumb.width / 2, y = previewThumb.y + previewThumb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x + i * 9, y); await page.waitForTimeout(16); }
  await page.mouse.up();
  await expect.poll(async () => (await order(page))[1]).toBe(ids[0]);
  await expect(page.locator('textarea').first()).toHaveValue('@img1 then @img2');
  await page.screenshot({ path: testInfo.outputPath('hover-arrows-and-thumbnail-drag-reorder.png') });
});

test('Goal2 repeated side arrow clicks in place never open the preview of the moved reference', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 3);
  const dialog = page.getByRole('dialog', { name: 'Reference Preview', exact: true });
  const cardOf = (id) => page.locator(`[data-reference-id="${id}"]`);
  const underPointer = (x, y) => page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return { card: hit?.closest('[data-reference-id]')?.dataset.referenceId || null, preview: Boolean(hit?.closest('[data-reference-preview]')) };
  }, { x, y });
  // Work in the expanded composer, so a click that focuses the strip does not expand it and move the
  // thumbnails out from under a pointer held in place.
  const prompt = page.locator('textarea').first();
  await prompt.fill('@img1 then @img2');
  await prompt.press('Escape');
  await expect(page.getByTestId('prompt-composer')).toHaveAttribute('data-composer-collapsed', 'false');
  await page.mouse.move(10, 10);

  // Moving right: after the move the moved card's thumbnail slides under the pointer.
  await cardOf(ids[0]).hover();
  const right = await page.getByRole('button', { name: 'Move reference 1 right', exact: true }).boundingBox();
  const rx = right.x + right.width / 2, ry = right.y + right.height / 2;
  await page.mouse.click(rx, ry);
  expect(await order(page)).toEqual([ids[1], ids[0], ids[2]]);
  expect(await underPointer(rx, ry)).toEqual({ card: ids[0], preview: true });
  await page.mouse.click(rx, ry);
  await page.waitForTimeout(150);
  await expect(dialog).toHaveCount(0);
  expect(await order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await page.screenshot({ path: testInfo.outputPath('repeat-right-arrow-click-no-preview.png') });

  // A deliberate later click on the same thumbnail, without leaving it, still previews.
  await page.waitForTimeout(600);
  await page.mouse.click(rx, ry);
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('deliberate-later-click-previews.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Moving left: the second click lands on the moved card's thumbnail in its new first slot.
  await page.mouse.move(10, 10);
  await cardOf(ids[0]).hover();
  const left = await page.getByRole('button', { name: 'Move reference 2 left', exact: true }).boundingBox();
  const lx = left.x + left.width / 2, ly = left.y + left.height / 2;
  await page.mouse.click(lx, ly);
  expect(await order(page)).toEqual(ids);
  expect(await underPointer(lx, ly)).toEqual({ card: ids[0], preview: true });
  await page.mouse.click(lx, ly);
  await page.waitForTimeout(150);
  await expect(dialog).toHaveCount(0);
  expect(await order(page)).toEqual(ids);

  // Leaving the card ends the repeat window: coming straight back and clicking previews at once.
  await page.mouse.move(10, 10);
  await cardOf(ids[0]).hover();
  const again = await page.getByRole('button', { name: 'Move reference 1 right', exact: true }).boundingBox();
  await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
  expect(await order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await page.mouse.move(10, 10);
  const moved = await cardOf(ids[0]).locator('[data-reference-preview]').boundingBox();
  await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Goal2 actual touch swipe scrolls thumbnails, long press drags to reorder and tap previews', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const ids = await stage(page, context, 30);
  await page.locator('textarea').first().fill('@img1 then @img2');
  // Close the @mention suggestions, which float over the strip, so the swipe lands on thumbnails.
  await page.locator('textarea').first().press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  // Let the prompt-edit layout settle before measuring the strip, then move the mouse away.
  await page.locator('[data-reference-preview]').first().hover();
  await page.mouse.move(10, 10);
  const strip = page.getByTestId('reference-strip');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
  // The swipe starts on a thumbnail, not on a gap between cards.
  const swipeStart = await strip.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const thumb = Array.from(el.querySelectorAll('[data-reference-preview]')).map((t) => t.getBoundingClientRect()).filter((r) => r.right <= box.right).at(-1);
    return { x: thumb.left + thumb.width / 2, y: thumb.top + thumb.height / 2 };
  });
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-reference-preview]')), swipeStart)).toBe(true);
  await touch('touchStart', swipeStart.x, swipeStart.y);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', swipeStart.x - i * 45, swipeStart.y); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  // The swipe ends in a momentum fling; wait until it stops, or it keeps scrolling over the wheel below.
  let previous = -1;
  await expect.poll(async () => {
    const current = await strip.evaluate(el => el.scrollLeft);
    const settled = current === previous;
    previous = current;
    return settled;
  }, { intervals: [150] }).toBe(true);
  expect(await order(page)).toEqual(ids);
  await expect(page.getByRole('dialog', { name: 'Reference Preview', exact: true })).toHaveCount(0);
  await strip.hover(); await page.mouse.wheel(-4000, 0);
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeLessThan(5);
  await page.mouse.move(10, 10);

  // A long press on the first thumbnail starts the drag; moving past the second card reorders.
  const first = await page.locator('[data-reference-preview]').first().boundingBox();
  const second = await page.locator('[data-reference-preview]').nth(1).boundingBox();
  const x = first.x + first.width / 2, y = first.y + first.height / 2;
  const target = second.x + second.width / 2 + 12;
  await touch('touchStart', x, y);
  await expect(strip).toHaveAttribute('data-reference-strip-dragging', 'true');
  for (let i = 1; i <= 8; i++) { await touch('touchMove', x + (target - x) * i / 8, y); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await expect.poll(async () => (await order(page))[1]).toBe(ids[0]);
  expect((await order(page))[0]).toBe(ids[1]);
  expect(await strip.evaluate(el => el.scrollLeft)).toBeLessThan(5);
  await expect(page.locator('textarea').first()).toHaveValue('@img1 then @img2');
  await expect(page.getByRole('dialog', { name: 'Reference Preview', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('touch-scroll-long-press-reorder.png') });

  // A tap previews the reference.
  const tapped = await page.locator('[data-reference-preview]').first().boundingBox();
  await touch('touchStart', tapped.x + tapped.width / 2, tapped.y + tapped.height / 2);
  await touch('touchEnd');
  await expect(page.getByRole('dialog', { name: 'Reference Preview', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await cdp.detach();
});

test('Goal2 mixed image video audio namespaces survive an image finalization completing last', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitem', { name: /^Seedance 2\.5(?:\s|$)/ }).click();
  const image = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const movie = await context.request.get('/api/generations/20000000-0000-4000-8000-000000000001/download');
  // 2.5 s of 8 kHz 16-bit mono silence: Seedance accepts reference audio of 2-30 s.
  const audioBytes = 40000;
  const wav = Buffer.alloc(44 + audioBytes); wav.write('RIFF'); wav.writeUInt32LE(36 + audioBytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(audioBytes,40);
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
  const prefix = `QA-delete-${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Portrait Gallery', exact: true });
  await gallery.locator('input[type=file]').setInputFiles([0, 1].map(i => ({ name: `${prefix}-${i}.png`, mimeType: 'image/png', buffer: portraitPng(`${prefix}-${i}`) })));
  await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(2, { timeout: 90000 });
  await gallery.getByRole('textbox', { name: 'Search portraits', exact: true }).fill(prefix);
  await expect(gallery.locator('article')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('portrait-normal-two-fixtures.png') });
  await gallery.locator('article').filter({ hasText: `${prefix}-0` }).dblclick();
  const inspector = page.getByRole('complementary', { name: 'Portrait Full View', exact: true });
  await expect(inspector).toBeVisible();
  await expect.poll(() => inspector.locator('img').first().evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('portrait-right-inspector.png') });
  await inspector.getByRole('button', { name: 'Close Lightbox', exact: true }).click();
  const tiles = gallery.locator('article').filter({ hasText: prefix });
  await expect(gallery.getByTestId('portrait-selection-toolbar')).toHaveCount(0);
  await tiles.first().click(); await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
  const sql = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const live = () => sql`SELECT id FROM managed_portrait_assets WHERE name LIKE ${`${prefix}%`} AND status NOT IN ('DELETING', 'DELETED') AND hidden_at IS NULL`;
  let attempts = 0;
  // The first bulk request is cut down to its first id so the real endpoint deletes one portrait,
  // and the answer reports the other as refused.
  await page.route('**/api/portraits/delete', async route => {
    if (++attempts > 1) return route.continue();
    const { ids } = route.request().postDataJSON();
    const response = await route.fetch({ postData: JSON.stringify({ ids: ids.slice(0, 1) }) });
    await route.fulfill({ response, json: { results: [{ id: ids[0], ok: true }, { id: ids[1], ok: false, error: 'FIXTURE', message: 'Fixture temporary delete failure.' }] } });
  });
  try {
    await gallery.getByRole('button', { name: 'Delete 2', exact: true }).click();
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toContainText('Delete 2 portraits?');
    await confirmation.getByRole('button', { name: 'Delete 2', exact: true }).click();
    await expect(gallery.getByRole('alert')).toContainText('Deleted 1');
    await expect(gallery.getByRole('alert')).toContainText('1 could not be deleted');
    await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(1);
    await expect(gallery.getByRole('button', { name: 'Add 1 to prompt', exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    expect(await live()).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('portrait-partial-delete-failure.png') });
    await gallery.getByRole('button', { name: 'Delete 1', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete 1', exact: true }).click();
    await expect(gallery.locator('article').filter({ hasText: prefix })).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(await live()).toHaveLength(0);
  } finally { await page.unroute('**/api/portraits/delete').catch(() => {}); await sql.end?.(); }
});

test('Goal2 composer inline reference strip dividers blue tags zoomable preview lightbox and collapse', async ({ page, context, baseURL }, testInfo) => {
  await ready(page, context, baseURL);
  const composer = page.getByTestId('prompt-composer');
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'true');

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitem', { name: /^Seedance 2\.5(?:\s|$)/ }).click();

  const image1 = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
  const image2 = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000002/download');
  const movie = await context.request.get('/api/generations/20000000-0000-4000-8000-000000000001/download');
  const audioBytes = 40000;
  const wav = Buffer.alloc(44 + audioBytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + audioBytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(audioBytes, 40);

  const input = page.locator('input[type=file][multiple][accept="image/*,video/*,audio/*"]');
  await input.setInputFiles([
    { name: 'ref-a.png', mimeType: 'image/png', buffer: await image1.body() },
    { name: 'ref-b.png', mimeType: 'image/png', buffer: await image2.body() },
    { name: 'clip-1.mov', mimeType: 'video/quicktime', buffer: await movie.body() },
    { name: 'voice-1.wav', mimeType: 'audio/wav', buffer: wav },
  ]);

  await expect(page.locator('[data-reference-id]')).toHaveCount(2, { timeout: 60000 });
  await expect(page.locator('[data-reference-media="video"]')).toHaveCount(1);
  await expect(page.locator('[data-reference-media="audio"]')).toHaveCount(1);
  await expect(page.locator('[data-reference-grip]')).toHaveCount(0);

  // Verify single inline strip order: images, divider, videos, divider, audio
  const strip = page.getByTestId('reference-strip');
  const stripChildrenOrder = await strip.evaluate((el) =>
    Array.from(el.children).map((child) => child.getAttribute('data-reference-media') || child.getAttribute('data-divider-between'))
  );
  expect(stripChildrenOrder).toEqual(['image', 'image', 'image-video', 'video', 'video-audio', 'audio']);

  // Verify compact Higgsfield-style 48x48px image reference chips
  const firstCard = page.locator('[data-reference-id]').first();
  const secondCard = page.locator('[data-reference-id]').nth(1);
  const card1Box = await firstCard.boundingBox();
  const thumb1Box = await firstCard.locator('[data-reference-preview]').boundingBox();
  expect(Math.round(card1Box.height)).toBe(48);
  expect(Math.round(thumb1Box.width)).toBeGreaterThanOrEqual(46);
  expect(Math.round(thumb1Box.width)).toBeLessThanOrEqual(48);

  // Verify hover outside side arrows have no background and shift neighbouring thumbnails without overlap
  await page.mouse.move(10, 10);
  const rightArrow = page.getByRole('button', { name: 'Move reference 1 right', exact: true });
  await expect.poll(() => rightArrow.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  const secondBefore = await secondCard.boundingBox();
  await firstCard.hover();
  const arrowStyle = await rightArrow.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return { bg: cs.backgroundColor, width: el.getBoundingClientRect().width };
  });
  expect(arrowStyle.bg).toBe('rgba(0, 0, 0, 0)');
  expect(arrowStyle.width).toBeGreaterThanOrEqual(18);
  const rightArrowBox = await rightArrow.boundingBox();
  const secondAfter = await secondCard.boundingBox();
  expect(secondAfter.x).toBeGreaterThan(secondBefore.x);
  expect(secondAfter.x).toBeGreaterThanOrEqual(rightArrowBox.x + rightArrowBox.width - 1);
  await page.screenshot({ path: testInfo.outputPath('shot-01-hover-arrows.png') });

  // Focus textarea, enter multi-line prompt with @img1, @vid1, @audio1
  const textarea = composer.locator('textarea').first();
  const longLines = Array.from({ length: 14 }, (_, idx) => `Scene direction line ${idx + 1}`).join('\n');
  const promptText = `Blend @img1 subject with @img2 palette, @vid1 motion, and @audio1 rhythm.\n${longLines}`;
  await textarea.focus();
  await textarea.fill(promptText);
  await textarea.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'false');

  // Verify dusty light blue (#589edb -> rgb(88, 158, 219)) highlight colour on @tags
  const tagColors = await textarea.evaluate((ta) =>
    Array.from(ta.previousElementSibling?.querySelectorAll('span') || []).map((el) => ({
      tag: el.textContent,
      color: window.getComputedStyle(el).color,
    }))
  );
  expect(tagColors.length).toBeGreaterThanOrEqual(4);
  for (const item of tagColors) {
    expect(item.color).toBe('rgb(88, 158, 219)');
  }

  // The expanded composer reaches its cap: at most half the panel behind it, wholly inside that
  // panel, and scrolling internally for the rest.
  const panelBox = await page.locator('main').boundingBox();
  const expandedBox = await composer.boundingBox();
  expect(await composer.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(expandedBox.height).toBeLessThanOrEqual(panelBox.height * 0.5 + 1);
  expect(expandedBox.y + expandedBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 0.5);
  await page.screenshot({ path: testInfo.outputPath('shot-02-inline-strip-blue-tags-expanded.png') });

  // Click reference 1 to open dynamic zoomable preview lightbox
  const previewBtn1 = page.getByRole('button', { name: 'Preview reference 1', exact: true });
  await previewBtn1.click();
  const dialog = page.getByRole('dialog', { name: 'Reference Preview', exact: true });
  await expect(dialog).toBeVisible();
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'false');

  const zoomReadout = dialog.getByTestId('lightbox-zoom-reset');
  const stage = dialog.getByTestId('lightbox-stage');
  await expect(zoomReadout).toHaveText('100%');

  // Button zoom in
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(zoomReadout).toHaveText('125%');

  // Keyboard '+' zoom in
  await page.keyboard.press('+');
  await expect(zoomReadout).toHaveText('150%');

  // Ctrl+wheel (trackpad pinch) zoom in
  await stage.dispatchEvent('wheel', { deltaY: -100, ctrlKey: true });
  await expect.poll(async () => Number.parseInt((await zoomReadout.textContent()) || '0', 10)).toBeGreaterThan(150);

  // Pan by drag when zoomed
  const stageBox = await stage.boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 45, stageBox.y + stageBox.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await stage.getAttribute('data-pan-x'))).toBeGreaterThan(10);
  await page.screenshot({ path: testInfo.outputPath('shot-03-open-lightbox-zoomed.png') });

  // Keyboard '0' resets zoom and pan; double-click toggles 200%; '-' steps down
  await page.keyboard.press('0');
  await expect(zoomReadout).toHaveText('100%');
  await expect(stage).toHaveAttribute('data-pan-x', '0');
  await stage.dblclick();
  await expect(zoomReadout).toHaveText('200%');
  await page.keyboard.press('-');
  await expect(zoomReadout).toHaveText('175%');

  // Escape closes lightbox and returns focus to the reference thumbnail button
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(previewBtn1).toBeFocused();

  // The restored focus leaves the strip still, so the first click on a later chip opens its preview.
  await expect.poll(() => rightArrow.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  const clipBox = await page.getByRole('button', { name: 'Preview reference clip 1', exact: true }).boundingBox();
  await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('video')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Move pointer and focus outside composer -> composer collapses while preserving prompt and references
  await page.mouse.move(10, 10);
  await page.evaluate(() => document.activeElement?.blur?.());
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'true');
  const collapsedBox = await composer.boundingBox();
  expect(collapsedBox.height).toBeLessThan(expandedBox.height);
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue(promptText);
  // Only the first prompt line paints; the second cannot peek through the bottom padding.
  const overlayClip = await textarea.evaluate((ta) => {
    const overlay = ta.previousElementSibling;
    const cs = window.getComputedStyle(overlay);
    return { height: overlay.getBoundingClientRect().height, firstLineBottom: parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight) };
  });
  expect(overlayClip.height).toBeLessThanOrEqual(overlayClip.firstLineBottom + 0.5);
  await expect(composer.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await expect(page.locator('[data-reference-id]')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('shot-04-composer-collapsed.png') });

  // Leaving by keyboard right after typing a tag, while its autocomplete is still open or closing,
  // collapses the composer with the pointer held still outside.
  await textarea.focus();
  await textarea.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type(' @img2');
  await expect(page.getByRole('listbox')).toBeVisible();
  for (let step = 0; step < 20 && await composer.evaluate((el) => el.contains(document.activeElement)); step += 1) {
    await page.keyboard.press('Shift+Tab');
  }
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'true');
  await textarea.fill(promptText);

  // Re-focus expands composer, then sending prompt collapses composer
  await textarea.focus();
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'false');
  await page.mouse.move(10, 10);
  const responsePromise = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/api/generate/video'));
  await composer.getByRole('button', { name: 'Generate', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  await expect(composer).toHaveAttribute('data-composer-collapsed', 'true');
  await expect(page.locator('[data-reference-id]')).toHaveCount(2);
});
