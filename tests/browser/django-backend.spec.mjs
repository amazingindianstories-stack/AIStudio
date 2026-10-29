
async function postAsBrowser(api, path, options = {}) {
  return api.post(path, { ...options, headers: { Origin: process.env.E2E_BASE_URL, ...options.headers } });
}
import { test, expect } from '@playwright/test';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtureDatabase } from './fixture-db.mjs';
import { portraitPng } from './portrait-image.mjs';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}
async function ready(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
}

async function freshProject(context, page, label) {
  const response = await postAsBrowser(context.request, '/api/projects', { data: { op: 'createProject', name: `${label} ${randomUUID()}` } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  await page.addInitScript(projectId => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
  }, project.id);
}

test('same-origin history delete retains uncertain paid receipts and permits settled deletion', async ({ context, baseURL }) => {
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const id = randomUUID();
  await db`INSERT INTO generations (id,kind,status,model,prompt,aspect_ratio,user_id,created_at,updated_at,provider_status,task_id)
    VALUES (${id},'video','failed','Seedance 2.5','Delete hold fixture','16:9',${USER_ID},${Date.now()},${Date.now()},'SUBMISSION_UNCERTAIN','accepted-fixture')`;
  try {
    const before = await db`SELECT * FROM generations WHERE id=${id}`;
    const names = await db`SELECT * FROM generation_naming WHERE generation_id=${id}`;
    const denied = await context.request.delete(`/api/history?id=${id}`, { headers: { Origin: baseURL } });
    expect(denied.status()).toBe(409);
    expect((await denied.json()).error).toBe('GENERATION_REQUIRES_RECONCILIATION');
    expect(await db`SELECT * FROM generations WHERE id=${id}`).toEqual(before);
    expect(await db`SELECT * FROM generation_naming WHERE generation_id=${id}`).toEqual(names);
    await db`UPDATE generations SET provider_status='COMPLETED' WHERE id=${id}`;
    const settled = await context.request.delete(`/api/history?id=${id}`, { headers: { Origin: baseURL } });
    expect(settled.status()).toBe(200);
    expect(await settled.json()).toEqual({ ok: true });
    expect(await db`SELECT id FROM generations WHERE id=${id}`).toEqual([]);
  } finally { await db`DELETE FROM generations WHERE id=${id}`; }
});

test('existing Audio modal uploads original WAV, displays immediate transcript and reloads saved history', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  await freshProject(context, page, 'Audio history');
  await ready(page);
  const samples = Buffer.alloc(1600);
  const wav = Buffer.alloc(44 + samples.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44);
  const transcript = '[00:00.000 - 00:00.100] Sound: Offline audio fixture.';
  await page.getByRole('button', { name: 'Audio transcription', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Audio transcription' });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'offline-original.wav', mimeType: 'audio/wav', buffer: wav });
  const submitted = page.waitForResponse(response => response.url().endsWith('/api/audio/transcribe') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Transcribe audio', exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(200);
  const item = await response.json();
  expect(item.transcript).toBe(transcript);
  expect(item.productionMetadata.originalName).toBe('offline-original.wav');
  expect(item.referenceAudios[0]).toMatch(/^\/api\/media\/uploads\/audio-reference\//);
  expect(item.submissionInput).toBeUndefined();
  await expect(dialog.locator('pre')).toHaveText(transcript);
  const source = await context.request.get(item.referenceAudios[0]);
  expect(source.status()).toBe(200);
  expect(source.headers()['content-type']).toMatch(/^audio\/wav/);
  expect(createHash('sha256').update(await source.body()).digest('hex')).toBe(createHash('sha256').update(wav).digest('hex'));
  await page.reload();
  await page.getByRole('button', { name: 'Audio transcription', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Audio transcription' });
  await dialog.locator('aside').getByRole('button').filter({ hasText: transcript }).click();
  await expect(dialog.locator('pre')).toHaveText(transcript);
  await testInfo.attach('audio-transcription-native-input', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Django authenticates browser login and protects admin server rendering', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/);
  await page.getByPlaceholder('you@example.com').fill('desktop-browser@example.test');
  await page.locator('input[type="password"]').fill('LocalBrowserFixture!42');
  const response = page.waitForResponse(response => response.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await response).status()).toBe(200);
  // The first visit to /admin compiles the route in next dev, which can take
  // well over the default 10s on a loaded machine.
  await expect(page).toHaveURL(/\/admin$/, { timeout: 45000 });
  await expect(page.getByText('Desktop fixture').first()).toBeVisible();
});

test('Django worker completes queued image after its browser closes and Python export streams ZIP', async ({ browser, context, page, baseURL }) => {
  await authenticate(context, baseURL);
  await ready(page);
  const executionCalls = [];
  context.on('request', request => { if (request.url().includes('/api/queue/execute')) executionCalls.push(request.url()); });
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Image', exact: true }).click();
  const prompt = `Worker independence ${randomUUID()}`;
  await page.locator('textarea').first().fill(prompt);
  const submitted = page.waitForResponse(response => response.url().endsWith('/api/generate/image') && response.request().method() === 'POST');
  await page.locator('button[aria-label="Generate"]').click();
  const response = await submitted;
  expect(response.ok()).toBeTruthy();
  const item = await response.json();
  expect(item.id).toBeTruthy();
  const cookies = await context.cookies();
  await page.close();
  const observer = await browser.newContext({ baseURL });
  await observer.addCookies(cookies);
  try {
    let finished;
    await expect.poll(async () => {
      const result = await observer.request.get(`/api/history?id=${item.id}`);
      const data = await result.json();
      finished = data.item || data.items?.find(row => row.id === item.id) || data;
      return finished.status;
    }, { timeout: 30000 }).toBe('succeeded');
    const master = await observer.request.get(`/api/generations/${item.id}/download`);
    expect(master.status()).toBe(200);
    expect(master.headers()['content-type']).toMatch(/^image\/png/);
    expect((await master.body()).subarray(1, 4).toString()).toBe('PNG');
    const created = await postAsBrowser(observer.request, '/api/history/exports');
    const job = await created.json();
    expect(created.status()).toBe(201);
    expect((await postAsBrowser(observer.request, `/api/history/exports/${job.id}/items`, { data: { ids: [item.id] } })).ok()).toBeTruthy();
    expect((await postAsBrowser(observer.request, `/api/history/exports/${job.id}/finalize`, { data: {} })).ok()).toBeTruthy();
    await expect.poll(async () => (await (await observer.request.get(`/api/history/exports/${job.id}`)).json()).status, { timeout: 30000 }).toBe('ready');
    const archive = await observer.request.get(`/api/history/exports/${job.id}/download`);
    expect(archive.status()).toBe(200);
    expect((await archive.body()).subarray(0, 2).toString()).toBe('PK');
    expect(executionCalls).toEqual([]);
  } finally { await observer.close(); }
});

test('browser downloads native 10-bit MOV through MediaCard without changing bytes and range reads preserve MIME', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  await ready(page);
  const path = '/api/generations/20000000-0000-4000-8000-000000000001/download';
  const range = await context.request.get(path, { headers: { Range: 'bytes=0-31' } });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-type']).toBe('video/quicktime');
  expect((await range.body()).length).toBe(32);
  const panel = page.locator('#desktop-history-panel');
  const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await panel.getByRole('button', { name: 'Global library', exact: true }).click();
  // A new search swaps the grid for its loading skeleton and renders the results afresh, so the
  // card shown before the response is not the one that stays; use only the final card.
  const searched = page.waitForResponse(response => response.url().includes('q=Native+MOV+fixture') && response.url().includes('limit='));
  await panel.getByRole('textbox', { name: 'Search prompts' }).fill('Native MOV fixture');
  await searched;
  const card = panel.locator('[data-asset-card-id="20000000-0000-4000-8000-000000000001"]');
  await expect(card).toBeVisible();
  // Download lives in the card's context menu and asks for confirmation.
  await card.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Generation actions' }).getByRole('menuitem', { name: /^Download/ }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Download the original?' });
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.mov$/);
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
  expect(bytes.subarray(8, 12).toString()).toBe('qt  ');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(process.env.E2E_MOV_SHA256);
  await testInfo.attach('native-mov-mediacard-download', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Canvas browser edits persist through Django after reload', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  await freshProject(context, page, 'Canvas browser edits');
  await ready(page);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  const saved = page.waitForResponse(response => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT');
  await canvas.click({ position: { x: 300, y: 250 } });
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const boardUrl = response.url();
  const data = await (await context.request.get(boardUrl)).json();
  expect(data.data.nodes.length).toBeGreaterThan(0);
  const node = data.data.nodes.at(-1);
  expect(node.type).toBe('sticky');
  await page.reload();
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  const persisted = await (await context.request.get(boardUrl)).json();
  expect(persisted.data.nodes.some(row => row.id === node.id)).toBeTruthy();
});

test('Two sessions editing one board merge each other\'s work, undo only their own and keep in-progress typing', async ({ browser, baseURL }) => {
  const boardPath = /\/api\/canvas-boards\/[^/]+$/;
  const isSave = response => boardPath.test(new URL(response.url()).pathname) && response.request().method() === 'PUT';
  const sessions = [];
  for (const label of ['A', 'B']) {
    const context = await browser.newContext({ baseURL });
    await authenticate(context, baseURL);
    sessions.push({ label, context, page: await context.newPage() });
  }
  const [a, b] = sessions;
  try {
    const created = await postAsBrowser(a.context.request, '/api/projects', { data: { op: 'createProject', name: `Canvas two sessions ${randomUUID()}` } });
    expect(created.ok()).toBeTruthy();
    const { project } = await created.json();
    for (const session of sessions) {
      await session.page.addInitScript(projectId => {
        localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: projectId }));
      }, project.id);
      await ready(session.page);
      session.loaded = session.page.waitForResponse(response => boardPath.test(new URL(response.url()).pathname) && response.request().method() === 'GET');
      await session.page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
      session.canvas = session.page.getByRole('application', { name: 'Board canvas' });
      await expect(session.canvas).toBeVisible();
      session.boardUrl = (await session.loaded).url();
      session.conflicts = 0;
      session.page.on('response', response => { if (isSave(response) && response.status() === 409) session.conflicts += 1; });
    }
    expect(b.boardUrl).toBe(a.boardUrl);
    const serverNodes = async () => (await (await a.context.request.get(a.boardUrl)).json()).data.nodes;
    const node = (session, id) => session.page.locator(`[data-node-id="${id}"]`);
    const addRect = async (session, x, y) => {
      await session.canvas.click({ position: { x: 1300, y: 700 } });
      await session.page.keyboard.press('r');
      const before = new Set((await session.page.locator('[data-node-id]').evaluateAll(els => els.map(el => el.dataset.nodeId))));
      await session.canvas.click({ position: { x, y } });
      const after = await session.page.locator('[data-node-id]').evaluateAll(els => els.map(el => el.dataset.nodeId));
      return after.find(id => !before.has(id));
    };

    // A's save reaches B through polling within seconds.
    const firstSave = a.page.waitForResponse(isSave);
    const r1 = await addRect(a, 650, 250);
    expect((await firstSave).ok()).toBeTruthy();
    await expect(node(b, r1)).toBeVisible({ timeout: 10000 });

    // Concurrent edits: B's polls wait until B has sent its save, and that save waits until A's lands,
    // so B always saves over a stale version and must merge.
    let releaseB, markBSent;
    const aLanded = new Promise(resolve => { releaseB = resolve; });
    const bSent = new Promise(resolve => { markBSent = resolve; });
    const boardOrVersion = /\/api\/canvas-boards\/[^/]+(\/version)?$/;
    await b.page.route(boardOrVersion, async route => {
      if (route.request().method() === 'PUT') { markBSent(); await aLanded; }
      else if (route.request().url().endsWith('/version')) await bSent;
      await route.continue();
    });
    const aSaved = a.page.waitForResponse(isSave);
    const r2 = await addRect(a, 900, 250);
    const r3 = await addRect(b, 650, 480);
    expect((await aSaved).ok()).toBeTruthy();
    releaseB();
    await expect.poll(() => b.conflicts, { timeout: 15000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await serverNodes()).map(row => row.id).sort(), { timeout: 15000 }).toEqual([r1, r2, r3].sort());
    await b.page.unroute(boardOrVersion);
    for (const session of sessions) {
      for (const id of [r1, r2, r3]) await expect(node(session, id)).toBeVisible({ timeout: 10000 });
    }

    // Undo in B removes only B's own rectangle; A's work stays on both screens and on the server.
    await b.canvas.click({ position: { x: 1300, y: 700 } });
    await b.page.keyboard.press('ControlOrMeta+z');
    await expect(node(b, r3)).toHaveCount(0);
    await expect(node(b, r1)).toBeVisible();
    await expect(node(b, r2)).toBeVisible();
    await expect.poll(async () => (await serverNodes()).map(row => row.id).sort(), { timeout: 15000 }).toEqual([r1, r2].sort());
    await expect(node(a, r3)).toHaveCount(0, { timeout: 10000 });

    // B types into a new sticky while A adds a rectangle. A's change waits until B ends the edit,
    // then it merges, the typing survives and both edits save.
    await b.canvas.click({ position: { x: 1300, y: 700 } });
    await b.page.getByRole('button', { name: 'Sticky note', exact: true }).click();
    await b.canvas.click({ position: { x: 1000, y: 520 } });
    await b.page.keyboard.type('typed while A edits');
    // B's save of the new sticky may land first, so A's save can meet a 409, merge and save again.
    const aSavedR4 = a.page.waitForResponse(response => isSave(response) && response.ok());
    const r4 = await addRect(a, 1150, 250);
    await aSavedR4;
    const editor = b.page.locator('[contenteditable="true"]');
    await expect(editor).toHaveText('typed while A edits');
    await b.page.keyboard.type(' and after');
    // Clicking empty canvas ends the edit, as a person would.
    await b.canvas.click({ position: { x: 1300, y: 700 } });
    await expect(editor).toHaveCount(0);
    await expect(node(b, r4)).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await serverNodes()).find(row => row.type === 'sticky')?.text, { timeout: 15000 }).toBe('typed while A edits and after');
    expect((await serverNodes()).map(row => row.id)).toEqual(expect.arrayContaining([r1, r2, r4]));
    await expect(a.page.getByText('typed while A edits and after')).toBeVisible({ timeout: 10000 });
  } finally {
    for (const session of sessions) await session.context.close();
  }
});

test('Agent browser chat stores Django messages and restores them after reload', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  await freshProject(context, page, 'Agent browser chat');
  await ready(page);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents', exact: true }).click();
  const created = page.waitForResponse(response => response.url().endsWith('/api/agent-conversations') &&
    response.request().method() === 'POST' && response.request().postDataJSON()?.op === 'createConversation');
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  expect((await created).ok()).toBeTruthy();
  // New chat intentionally autofocuses its title editor. Finish that user flow
  // before typing into the composer, rather than racing the delayed autofocus.
  const title = page.getByRole('complementary').getByRole('textbox');
  await expect(title).toBeVisible();
  const renamed = page.waitForResponse(response => response.url().endsWith('/api/agent-conversations') &&
    response.request().method() === 'POST' && response.request().postDataJSON()?.op === 'renameConversation');
  await title.fill('Browser qualification chat');
  await title.press('Enter');
  expect((await renamed).ok()).toBeTruthy();
  await expect(page.getByText('Loading chat…', { exact: true })).not.toBeVisible();
  const input = page.getByPlaceholder(/Talk through your/);
  await expect(input).toBeEnabled();
  await input.fill('Design a close-up with soft side light.');
  await expect(input).toHaveValue('Design a close-up with soft side light.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = 'I can help you develop a prompt for your scene.';
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
});

test('Portrait upload and full preview feed a character plus motion clip into Seedance Generate and Edit', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  await freshProject(context, page, 'Portrait motion');
  await ready(page);
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitem', { name: /^Seedance 2\.5(?:\s|$)/ }).click();
  const name = `Portrait ${randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'material', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Portrait Gallery', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'Portrait Gallery', exact: true });
  const registered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/portraits' && response.request().method() === 'POST');
  await gallery.locator('input[type="file"]').setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: portraitPng(name) });
  const registration = await registered;
  expect(registration.ok()).toBeTruthy();
  expect((await registration.json()).results[0].ok).toBe(true);
  const card = gallery.getByRole('article', { name, exact: true });
  await expect(card).toBeVisible();
  const thumbnail = card.locator('img');
  await expect.poll(() => thumbnail.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await card.dblclick();
  const preview = page.getByRole('complementary', { name: 'Portrait Full View' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.locator('img').first().evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await preview.getByRole('button', { name: 'Use in Prompt', exact: true }).click();
  if (await preview.isVisible()) await preview.getByRole('button', { name: 'Close Lightbox' }).click();
  // Attach original native bytes through the current resumable/finalize contract.
  const fixtureMovie = await context.request.get('/api/generations/20000000-0000-4000-8000-000000000001/download');
  const movieBytes = await fixtureMovie.body();
  const binaryUpload = page.waitForResponse(response => /^\/api\/uploads\/[^/]+\/local$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT');
  const finalized = page.waitForResponse(response => /^\/api\/uploads\/[^/]+\/finalize$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.locator('input[type="file"][accept="image/*,video/*,audio/*"]').setInputFiles({ name: 'motion.mov', mimeType: 'video/quicktime', buffer: movieBytes });
  expect((await binaryUpload).status()).toBe(200);
  const readyResponse = await finalized;
  expect(readyResponse.ok()).toBeTruthy();
  const readyUpload = await readyResponse.json();
  expect(readyUpload.state).toBe('ready');
  expect(readyUpload.byteSize).toBe(movieBytes.length);
  const storedMovie = await context.request.get(readyUpload.ref);
  expect(storedMovie.ok()).toBeTruthy();
  expect((await storedMovie.body()).equals(movieBytes)).toBeTruthy();
  const prompt = 'Keep @img1 as the only character; use @vid1 only for camera motion. Dolly forward.';
  await page.locator('textarea').first().fill(prompt);
  for (const mode of ['generate', 'edit']) {
    await page.locator('textarea').first().fill(prompt);
    if (mode === 'edit') {
      await page.getByRole('button', { name: 'Generation settings', exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('button', { name: 'Generation settings', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).not.toBeVisible();
    }
    // Retained references intentionally require confirmation before another job.
    if (mode === 'edit') page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toBe('Generate the same prompt and references again? This creates a new paid job.');
      await dialog.accept();
    });
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/generate/video') && response.request().method() === 'POST');
    await page.locator('button[aria-label="Generate"]').click();
    const response = await accepted;
    expect(response.ok()).toBeTruthy();
    const submitted = response.request().postDataJSON();
    expect(submitted.model).toBe('Seedance 2.5');
    expect(submitted.videoTaskMode).toBe(mode);
    expect(submitted.prompt).toBe(prompt);
    expect(submitted.referenceImages).toHaveLength(1);
    // The gallery adds the portrait's own stored image; the worker recognises the face and prepares it.
    expect(submitted.referenceImages[0]).toContain('/uploads/portrait/');
    expect(submitted.referenceVideos).toHaveLength(1);
    expect(submitted.draftMode).toBe(false);
    expect(submitted.bitrateMode).toBe('high');
    const item = await response.json();
    expect(item.id).toBeTruthy();
    // The browser harness has no BytePlus fake, so a face reference can still be waiting for its portrait
    // to be prepared; the job must be accepted and must not have been rejected for the reference.
    const status = async () => (await (await context.request.get(`/api/history?limit=60`)).json()).items.find(row => row.id === item.id)?.status;
    await expect.poll(status, { timeout: 30000 }).toMatch(/^(queued|running|succeeded)$/);
  }
});

test('same-origin gateway preserves auth failures, duplicate queries, HEAD and origin rejection', async ({ context, baseURL }) => {
  expect((await context.request.get('/api/history')).status()).toBe(401);
  await authenticate(context, baseURL);
  const history = await context.request.get('/api/history?limit=2&limit=1');
  expect(history.status()).toBe(200);
  expect((await history.json()).items).toHaveLength(2);
  const forbidden = await postAsBrowser(context.request, '/api/projects', { headers: { Origin: 'https://untrusted.example' }, data: { op: 'createProject', name: 'Must not create' } });
  expect(forbidden.status()).toBe(403);
  expect(await forbidden.json()).toEqual({ error: 'FORBIDDEN_ORIGIN' });
  const head = await context.request.head('/api/generations/20000000-0000-4000-8000-000000000001/download');
  expect(head.status()).toBe(200);
  expect(head.headers()['content-type']).toBe('video/quicktime');
  expect(Number(head.headers()['content-length'])).toBeGreaterThan(32);
  expect(await head.body()).toHaveLength(0);
  const retired = await postAsBrowser(context.request, '/api/queue/execute', { data: { id: randomUUID() } });
  expect(retired.status()).toBe(410);
  expect((await retired.json()).error).toBe('QUEUE_EXECUTION_MOVED');
});

test('queued upscale persists inputs and finishes offline after the submitting browser closes', async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await authenticate(context, baseURL);
  const source = await context.request.get('/api/media/generations/10000000-0000-4000-8000-000000000000.png');
  expect(source.ok()).toBeTruthy();
  const data = (await source.body()).toString('base64');
  const response = await postAsBrowser(context.request, '/api/generate/upscale', { data: {
    model: 'Magnific Precision V2', image: `data:image/png;base64,${data}`,
    params: { scaleFactor: '4x', flavor: 'photo', sharpen: 7, smartGrain: 7, ultraDetail: 30 },
  }});
  expect(response.status()).toBe(200);
  const item = await response.json();
  expect(item.status).toBe('queued');
  expect(item.taskId).toBeUndefined();
  expect(item.submissionInput).toBeUndefined();
  await context.close();
  const reader = await browser.newContext();
  await authenticate(reader, baseURL);
  try {
    await expect.poll(async () => {
      const status = await reader.request.get(`/api/generate/upscale/status?id=${item.id}`);
      expect(status.status()).toBe(200);
      return (await status.json()).status;
    }, { timeout: 20000 }).toBe('succeeded');
    const status = await reader.request.get(`/api/generate/upscale/status?id=${item.id}`);
    const completed = await status.json();
    expect(completed.providerStatus).toBe('MOCK_COMPLETED');
    expect(completed.url).toMatch(/^\/api\/media\/references\//);
  } finally { await reader.close(); }
});

test('queued image and video cards explain a worker slot wait after reload', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const ids = [randomUUID(), randomUUID()];
  const now = Date.now();
  try {
    for (const [index, kind] of ['image', 'video'].entries()) {
      await db`INSERT INTO generations (id,kind,status,model,prompt,aspect_ratio,user_id,created_at,updated_at,
        provider_status,progress_message,next_poll_at)
        VALUES (${ids[index]},${kind},'queued',${kind === 'image' ? 'seedream-5-pro' : 'Seedance 2.5'},
        'Worker slot waiting fixture','1:1',${USER_ID},${now + index},${now + index},
        'WORKER_SLOT_WAITING','Waiting for a free worker slot',${now + 3600000})`;
    }
    // The reload restores the Global Library, so its grid is already painted when
    // the panel opens. Reduced motion opens it at full width: while the panel widens
    // the masonry re-packs, and a card fading out of its old column is a second copy.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ready(page);
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const panel = page.locator('#desktop-history-panel');
    await panel.getByRole('button', { name: 'Global library', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await panel.getByRole('button', { name: 'Global library', exact: true }).click();
    for (const id of ids) {
      const card = page.getByTestId(`media-card-${id}`);
      await expect(card.getByText('Queued', { exact: true })).toBeVisible();
      await expect(card.getByText('Waiting for a free worker slot', { exact: true })).toBeVisible();
    }
    await testInfo.attach('worker-slot-wait-cards', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    await db`DELETE FROM generations WHERE id IN ${db(ids)}`;
  }
});
