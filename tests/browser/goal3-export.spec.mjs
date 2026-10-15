import { test, expect } from '@playwright/test';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fixtureDatabase } from './fixture-db.mjs';

const actor = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function authenticate(context, baseURL, uid = actor) {
  const payload = Buffer.from(JSON.stringify({ uid, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`, url: baseURL }]);
}
async function post(context, path, data) {
  return context.request.post(path, { data, headers: { Origin: process.env.E2E_BASE_URL } });
}
async function panel(page) {
  await page.goto('/');
  await expect(page.getByText('Desktop fixture').first()).toBeVisible();
  const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  return page.locator('#desktop-history-panel');
}
async function observeStore(page) {
  await page.evaluate(() => window.webpackChunk_N_E.push([[`export-test-${Date.now()}`], {}, require => {
    const id = Object.keys(require.m).find(key => key.endsWith('/src/lib/store.js'));
    if (!id) throw new Error('Production store module not loaded.');
    window.__exportTestStore = require(id).useStore;
  }]));
}

test('Goal3 ZIP actual Chromium download preserves exact nested scopes, CRC and native MOV hashes after refresh', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const prefix = `Goal3 ${randomUUID().slice(0, 8)}`;
  const projectIds = [], folderIds = [], generationIds = [];
  let job;
  try {
    const scopes = [];
    for (const suffix of ['A', 'B']) {
      const response = await post(context, '/api/projects', { op: 'createProject', name: `${prefix} ${suffix}` });
      expect(response.status()).toBe(200);
      const { project } = await response.json(); projectIds.push(project.id);
      const rootResponse = await post(context, '/api/folders', { name: 'Scene 01', projectId: project.id, idempotencyKey: randomUUID() });
      expect(rootResponse.ok()).toBeTruthy();
      const { folder: root } = await rootResponse.json(); folderIds.push(root.id);
      const leafResponse = await post(context, '/api/folders', { name: 'Shot 02', projectId: project.id, parentId: root.id, idempotencyKey: randomUUID() });
      expect(leafResponse.ok()).toBeTruthy();
      const { folder: leaf } = await leafResponse.json(); folderIds.push(leaf.id);
      scopes.push({ project, leaf });
    }
    const expected = {};
    for (const { project, leaf } of scopes) {
      const id = randomUUID(); generationIds.push(id);
      await db`INSERT INTO generations(id,kind,status,prompt,model,aspect_ratio,url,project_id,folder_id,user_id,created_at,updated_at)
        SELECT ${id},kind,status,${prefix},model,aspect_ratio,url,${project.id},${leaf.id},user_id,${Date.now()},${Date.now()}
        FROM generations WHERE id='20000000-0000-4000-8000-000000000001'`;
      await db`UPDATE generation_naming SET namespace=${`folder:${leaf.id}`},sequence=7 WHERE generation_id=${id}`;
      expected[`Projects/${project.name}/Scene 01/Shot 02/Shot_02_0007.mov`] = process.env.E2E_MOV_SHA256;
    }
    const globalId = '10000000-0000-4000-8000-000000000000';
    const globalNaming = (await db`SELECT sequence FROM generation_naming WHERE generation_id=${globalId}`)[0];
    const globalMaster = await context.request.get(`/api/generations/${globalId}/download`);
    expect(globalMaster.status()).toBe(200);
    expected[`Global/Unsorted/unsorted_${String(globalNaming.sequence).padStart(4, '0')}.png`] = createHash('sha256').update(await globalMaster.body()).digest('hex');
    const created = await post(context, '/api/history/exports'); job = await created.json();
    expect(created.status()).toBe(201);
    expect((await post(context, `/api/history/exports/${job.id}/items`, { ids: [...generationIds, globalId, globalId] })).status()).toBe(200);
    const finalized = await Promise.all([post(context, `/api/history/exports/${job.id}/finalize`), post(context, `/api/history/exports/${job.id}/finalize`)]);
    expect(finalized.map(response => response.status()).sort()).toEqual([200, 409]);
    // Rename after finalize; the queued archive mapping must remain captured.
    await db`UPDATE folders SET name='Later rename',name_normalized='later rename' WHERE id=${folderIds[1]}`;
    await expect.poll(async () => (await (await context.request.get(`/api/history/exports/${job.id}`)).json()).status, { timeout: 30000 }).toBe('ready');
    const recorded = (await db`SELECT total_items,manifest_version FROM media_exports WHERE id=${job.id}`)[0];
    expect(recorded.total_items).toBe(3); expect(recorded.manifest_version).toBe(3);
    await page.addInitScript(({ actor, id }) => localStorage.setItem(`veevee-active-media-export-v1:${actor}`, id), { actor, id: job.id });
    const downloads = [];
    page.on('request', request => { if (request.url().endsWith(`/exports/${job.id}/download`)) downloads.push(request.url()); });
    await panel(page);
    await expect(page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' }).filter({ hasText: 'ZIP ready' })).toBeVisible();
    await page.reload();
    const restoredToggle = page.locator('button[aria-controls="desktop-history-panel"]');
    if (await restoredToggle.getAttribute('aria-expanded') !== 'true') await restoredToggle.click();
    await expect(page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' }).filter({ hasText: 'ZIP ready' })).toBeVisible();
    expect(downloads).toEqual([]);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' }).getByRole('link', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^Veevee_Assets_\d{4}-\d{2}-\d{2}\.zip$/);
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    expect(await download.failure()).toBeNull();
    const validation = JSON.parse(execFileSync(process.env.E2E_PYTHON, ['-c',
      'import sys,json,zipfile,hashlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; names=z.namelist(); assert len(names)==len(set(names)); print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in names}))', path], { encoding: 'utf8' }));
    expect(validation).toEqual(expected);
    await testInfo.attach('zip-byte-validation', { body: JSON.stringify({ suggestedFilename: download.suggestedFilename(), hashes: validation, entries: recorded.total_items }), contentType: 'application/json' });
    await testInfo.attach('zip-ready-ui', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    if (job) await db`DELETE FROM media_exports WHERE id=${job.id}`;
    if (generationIds.length) await db`DELETE FROM generations WHERE id IN ${db(generationIds)}`;
    for (const id of folderIds.reverse()) await db`DELETE FROM folders WHERE id=${id}`;
    if (projectIds.length) await db`DELETE FROM projects WHERE id IN ${db(projectIds)}`;
  }
});

test('Goal3 ZIP rapid clicks,409 failure and retry remain visible; actor switch hides prior job', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL); await panel(page); await observeStore(page);
  let finalizeCalls = 0, creates = 0, grantCalls = 0;
  await page.route('**/api/history/exports**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/download')) { grantCalls++; return route.abort(); }
    if (path.endsWith('/finalize')) {
      finalizeCalls++;
      return route.fulfill({ status: finalizeCalls === 1 ? 409 : 200, json: finalizeCalls === 1 ? { error: 'Source unavailable; retry after repair.' } : { status: 'queued' } });
    }
    if (path.endsWith('/items')) return route.fulfill({ json: { rejected: [] } });
    if (route.request().method() === 'POST') { creates++; return route.fulfill({ status: 201, json: { id: 'fixture-export' } }); }
    return route.fulfill({ json: { id: 'fixture-export', status: 'ready', totalItems: 1, processedItems: 1 } });
  });
  const history = page.locator('#desktop-history-panel');
  await history.getByRole('button', { name: 'All assets', exact: true }).click();
  // A fixed, finished fixture: newer cards from other specs may still be generating.
  const firstCard = history.getByTestId('media-card-10000000-0000-4000-8000-000000000001');
  await firstCard.hover();
  await firstCard.getByRole('button', { name: 'Select', exact: true }).click();
  const button = history.getByRole('button', { name: 'Download ZIP', exact: true });
  await button.evaluate(button => { button.click(); button.click(); });
  await expect(page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' })).toContainText('Source unavailable');
  expect(creates).toBe(1); expect(finalizeCalls).toBe(1);
  await history.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' })).toContainText('ZIP ready');
  expect(finalizeCalls).toBe(2); expect(grantCalls).toBe(0);
  await page.evaluate(() => window.__exportTestStore.setState({ currentUser: { id: 'other-actor', name: 'Other actor' } }));
  await expect(page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' }).filter({ hasText: 'ZIP ready' })).toHaveCount(0);
});

for (const code of [401, 403, 404, 410]) test(`Goal3 ZIP restored HTTP${code} clears inaccessible job or displays expiry`, async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  await page.addInitScript(actor => localStorage.setItem(`veevee-active-media-export-v1:${actor}`, 'unavailable'), actor);
  await page.route('**/api/history/exports/unavailable', route => route.fulfill({ status: code, json: { error: 'UNAVAILABLE' } }));
  await panel(page);
  if (code === 410) await expect(page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' })).toContainText('expired');
  else await expect.poll(() => page.evaluate(actor => localStorage.getItem(`veevee-active-media-export-v1:${actor}`), actor)).toBeNull();
});

test('Goal3 ZIP cloud307 attachment simulation produces an actual download after authorized click', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const fixture = await context.request.get('/api/generations/20000000-0000-4000-8000-000000000001/download');
  const master = await fixture.body();
  const archive = execFileSync(process.env.E2E_PYTHON, ['-c',
    'import sys,io,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("Global/Unsorted/unsorted_0001.mov",sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())'], { input: master });
  let requests = 0;
  const cloud = http.createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Veevee_Cloud_Fixture.zip"');
    res.setHeader('Cache-Control', 'no-store');
    res.end(archive);
  });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  try {
    await page.addInitScript(actor => localStorage.setItem(`veevee-active-media-export-v1:${actor}`, 'cloud-fixture'), actor);
    await page.route('**/api/history/exports/cloud-fixture', route => route.fulfill({ json: { id: 'cloud-fixture', status: 'ready', totalItems: 1 } }));
    await page.route('**/api/history/exports/cloud-fixture/download', route => route.fulfill({ status: 307,
      headers: { Location: `http://127.0.0.1:${cloud.address().port}/synthetic-grant`, 'Cache-Control': 'no-store' }, body: '' }));
    await panel(page);
    const notice = page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' });
    await expect(notice).toContainText('ZIP ready'); expect(requests).toBe(0);
    const pending = page.waitForEvent('download');
    await notice.getByRole('link', { name: 'Download', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('Veevee_Cloud_Fixture.zip');
    const path = testInfo.outputPath(download.suggestedFilename()); await download.saveAs(path);
    expect(await readFile(path)).toEqual(archive); expect(requests).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(context.pages()).toHaveLength(1);
    await testInfo.attach('cloud307-original-sha256', { body: JSON.stringify({ archiveSha256: createHash('sha256').update(archive).digest('hex'), nativeMovSha256: process.env.E2E_MOV_SHA256, syntheticOnly: true }), contentType: 'application/json' });
  } finally { await new Promise(resolve => cloud.close(resolve)); }
});

for (const width of [1440, 1024, 390]) test(`Goal3 ZIP notice fits ${width}px and keyboard dismissal works with reduced motion`, async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(actor => localStorage.setItem(`veevee-active-media-export-v1:${actor}`, 'width-fixture'), actor);
  await page.route('**/api/history/exports/width-fixture', route => route.fulfill({ json: { id: 'width-fixture', status: 'ready', totalItems: 50, processedItems: 50 } }));
  await page.goto('/');
  if (width >= 640) await expect(page.getByText('Desktop fixture').first()).toBeVisible();
  const panelId = width < 1024 ? 'mobile-history-panel' : 'desktop-history-panel';
  const toggle = page.locator(`button[aria-controls="${panelId}"]`);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const notice = page.locator(`#${panelId}`).getByRole('status', { name: 'ZIP export' });
  await expect(notice).toContainText('ZIP ready');
  const bounds = await notice.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  await testInfo.attach(`zip-${width}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  const dismiss = notice.getByRole('button', { name: 'Dismiss export notice' });
  await dismiss.focus(); await page.keyboard.press('Enter'); await expect(notice).toHaveCount(0);
});

test('Goal3 ZIP download503 then404 leaves an actionable notice and no popup or navigation', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  await page.addInitScript(actor => localStorage.setItem(`veevee-active-media-export-v1:${actor}`, 'download-fault'), actor);
  await page.route('**/api/history/exports/download-fault', route => route.fulfill({ json: { id: 'download-fault', status: 'ready', totalItems: 1 } }));
  let downloads = 0;
  await page.route('**/api/history/exports/download-fault/download', route => {
    downloads++;
    return route.fulfill({ status: downloads === 1 ? 503 : 404, json: { error: downloads === 1 ? 'DOWNLOAD_UNAVAILABLE' : 'ARCHIVE_UNAVAILABLE' } });
  });
  await panel(page);
  const notice = page.locator('#desktop-history-panel').getByRole('status', { name: 'ZIP export' });
  await expect(notice).toContainText('ZIP ready');
  for (const count of [1, 2]) {
    await notice.getByRole('link', { name: 'Download', exact: true }).click();
    await expect.poll(() => downloads).toBe(count);
    await expect(notice).toContainText('Try again or create a new ZIP');
    expect(context.pages()).toHaveLength(1); expect(new URL(page.url()).pathname).toBe('/');
  }
  expect(await page.evaluate(actor => localStorage.getItem(`veevee-active-media-export-v1:${actor}`), actor)).toBe('download-fault');
});
