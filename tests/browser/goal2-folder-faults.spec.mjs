import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const actor = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function ready(page, context, baseURL) {
  if (process.env.MIGRATION_TEST_ISOLATED !== '1' || !process.env.AUTH_SECRET || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Folder faults require verified disposable Django.');
  const payload = Buffer.from(JSON.stringify({ uid: actor, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`, url: baseURL }]);
  await page.goto('/');
  await expect(page.getByText('Desktop fixture').first()).toBeVisible();
  const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.locator('#desktop-history-panel')).toBeVisible();
  // Observe the existing production store, without changing source or mocking its actions.
  await page.evaluate(() => {
    window.webpackChunk_N_E.push([[`folder-test-${Date.now()}`], {}, (require) => {
      const id = Object.keys(require.m).find(key => key.endsWith('/src/lib/store.js'));
      if (!id) throw new Error('Production store module not loaded.');
      window.__folderFaultStore = require(id).useStore;
    }]);
  });
  await expect.poll(() => page.evaluate(() => window.__folderFaultStore.getState().currentUser?.id)).toBe(actor);
  return fixtureDatabase(process.env.E2E_DATABASE_URL);
}
async function createFolder(page, name) {
  return page.evaluate(async (name) => {
    const state = window.__folderFaultStore.getState();
    const folder = await state.createFolder({ name, projectId: null, parentId: null });
    state.setRightTab('project');
    return folder;
  }, name);
}
async function dbFolder(sql, id) { return (await sql`SELECT id,name,version FROM folders WHERE id=${id}`)[0]; }
async function begin(page, id, names) {
  await page.evaluate(({ id, names }) => {
    window.__folderFaultResults = [];
    for (const name of names) window.__folderFaultStore.getState().renameFolder({ id, name }).then(() => window.__folderFaultResults.push({ name, ok: true }), error => window.__folderFaultResults.push({ name, ok: false, code: error.code, error: error.message }));
  }, { id, names });
}
async function operation(page, id) {
  return page.evaluate(id => Object.entries(window.__folderFaultStore.getState().operations).filter(([, op]) => JSON.parse(op.entity)[1] === id).map(([logical, op]) => ({ logical, ...op })), id);
}

test('Goal2 folder faults: slow duplicate mutation, two queued edits, cancellation and authoritative reload', async ({ page, context, baseURL }) => {
  const sql = await ready(page, context, baseURL);
  const folder = await createFolder(page, `Fault slow ${randomUUID()}`);
  const original = await dbFolder(sql, folder.id);
  const first = `Slow first ${randomUUID()}`, second = `Slow second ${randomUUID()}`, cancelled = `Cancelled ${randomUUID()}`;
  let release; const held = new Promise(resolve => { release = resolve; });
  const submitted = [];
  await page.route('**/api/folders', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = route.request().postDataJSON(); submitted.push(body);
    if (body.name === first) await held;
    await route.continue();
  });
  await begin(page, folder.id, [first, first, second, cancelled]);
  await expect.poll(() => submitted.length).toBe(1);
  const tree = page.locator('[role="treeitem"]').filter({ hasText: folder.name }).first();
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  await expect(tree.locator('[inert]')).toHaveCount(1);
  await expect.poll(async () => (await operation(page, folder.id)).filter(op => op.status === 'queued').length).toBe(2);
  const queued = (await operation(page, folder.id)).find(op => JSON.parse(op.logical)[2][0].name === cancelled);
  expect(await page.evaluate(key => window.__folderFaultStore.getState().cancelFolderOperation(key), queued.logical)).toBeTruthy();
  expect((await dbFolder(sql, folder.id)).name).toBe(original.name);
  release();
  await expect.poll(() => page.evaluate(() => window.__folderFaultResults.length)).toBe(4);
  expect(submitted.map(body => body.name)).toEqual([first, second]);
  expect(submitted[1].expectedVersion).toBe(original.version + 1);
  const persisted = await dbFolder(sql, folder.id);
  expect(persisted.name).toBe(second); expect(persisted.version).toBe(original.version + 2);
  expect((await operation(page, folder.id)).find(op => op.logical === queued.logical).status).toBe('cancelled');
  await page.reload();
  const panelToggle = page.locator('button[aria-controls="desktop-history-panel"]');
  if (await panelToggle.getAttribute("aria-expanded") !== "true") await panelToggle.click();
  await page.locator("#desktop-history-panel").getByRole("button", { name: "Global library", exact: true }).click();
  await expect(page.locator('[role="treeitem"]').filter({ hasText: second }).first()).toBeVisible();
  expect(await sql`SELECT key FROM organization_idempotency_keys WHERE key=${submitted[0].idempotencyKey}`).toHaveLength(1);
});

test('Goal2 folder faults: lost response retry reuses idempotency key and persists one version', async ({ page, context, baseURL }) => {
  const sql = await ready(page, context, baseURL);
  const folder = await createFolder(page, `Fault retry ${randomUUID()}`);
  const original = await dbFolder(sql, folder.id);
  const renamed = `Lost ack ${randomUUID()}`;
  const submitted = []; let lostAcks = 0;
  await page.route('**/api/folders', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    submitted.push(route.request().postDataJSON());
    if (lostAcks < 2) { lostAcks++; const response = await route.fetch(); expect(response.ok()).toBeTruthy(); await route.abort('connectionreset'); }
    else await route.continue();
  });
  await begin(page, folder.id, [renamed]);
  await expect.poll(() => page.evaluate(() => window.__folderFaultResults.length)).toBe(1);
  expect((await dbFolder(sql, folder.id)).name).toBe(renamed);
  const failed = (await operation(page, folder.id)).find(op => op.status === 'failed');
  expect(failed).toBeTruthy();
  await page.locator('[role="status"]').filter({ hasText: 'failed' }).getByRole('button', { name: 'Retry', exact: true }).last().click();
  await expect.poll(async () => (await operation(page, folder.id)).find(op => op.logical === failed.logical)?.attempt).toBe(2);
  await expect.poll(async () => (await operation(page, folder.id)).find(op => op.logical === failed.logical)?.status).toBe("failed");
  await page.locator('[role="status"]').filter({ hasText: "failed" }).getByRole("button", { name: "Retry", exact: true }).last().click();
  await expect.poll(async () => (await operation(page, folder.id)).find(op => op.logical === failed.logical)?.status).toBe("confirmed");
  expect(submitted).toHaveLength(3);
  expect(submitted[1].idempotencyKey).toBe(submitted[0].idempotencyKey);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(submitted[2]).toEqual(submitted[0]);
  expect((await dbFolder(sql, folder.id)).version).toBe(original.version + 1);
  expect(await sql`SELECT key FROM organization_idempotency_keys WHERE key=${submitted[0].idempotencyKey}`).toHaveLength(1);
});

test('Goal2 folder faults: real server conflict reconciles another editor and offline reconnect retries explicitly', async ({ page, context, baseURL }) => {
  const sql = await ready(page, context, baseURL);
  const folder = await createFolder(page, `Fault conflict ${randomUUID()}`);
  const original = await dbFolder(sql, folder.id);
  const concurrent = `Other editor ${randomUUID()}`;
  // An independent browser-session API client performs the concurrent real Django mutation.
  const response = await context.request.patch('/api/folders', { data: { id: folder.id, name: concurrent, expectedVersion: original.version, idempotencyKey: randomUUID() }, headers: { Origin: baseURL } });
  expect(response.ok()).toBeTruthy();
  const staleName = `Stale editor ${randomUUID()}`;
  await begin(page, folder.id, [staleName]);
  await expect.poll(() => page.evaluate(() => window.__folderFaultResults.length)).toBe(1);
  expect(await page.evaluate(() => window.__folderFaultResults[0].code)).toBe('VERSION_CONFLICT');
  await expect(page.locator('[role="treeitem"]').filter({ hasText: concurrent }).first()).toBeVisible();
  expect((await dbFolder(sql, folder.id)).name).toBe(concurrent);
  const offlineName = `Reconnect ${randomUUID()}`;
  await context.setOffline(true);
  await begin(page, folder.id, [offlineName]);
  await expect.poll(() => page.evaluate(() => window.__folderFaultResults.length)).toBe(1);
  const failed = (await operation(page, folder.id)).find(op => JSON.parse(op.logical)[2][0].name === offlineName);
  expect(failed.status).toBe('failed');
  expect((await dbFolder(sql, folder.id)).name).toBe(concurrent);
  await context.setOffline(false);
  await page.evaluate(async key => { const [, action, args] = JSON.parse(key); await window.__folderFaultStore.getState()[action](...args); }, failed.logical);
  expect((await dbFolder(sql, folder.id)).name).toBe(offlineName);
  expect((await dbFolder(sql, folder.id)).version).toBe(original.version + 2);
});

test('Goal2 folder faults: actual rename editor Enter and blur cannot double-submit a slow Django mutation', async ({ page, context, baseURL }) => {
  const sql = await ready(page, context, baseURL);
  const folder = await createFolder(page, `Fault editor ${randomUUID()}`);
  const original = await dbFolder(sql, folder.id);
  const renamed = `Editor committed ${randomUUID()}`;
  let release; const held = new Promise(resolve => { release = resolve; });
  const submitted = [];
  await page.route('**/api/folders', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    submitted.push(route.request().postDataJSON()); await held; await route.continue();
  });
  await page.getByRole('button', { name: `Tree folder actions: ${folder.name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Rename folder', exact: true });
  await input.fill(renamed); await input.press('Enter'); await input.press('Enter');
  await page.getByRole('button', { name: 'Scroll folder names right', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect((await dbFolder(sql, folder.id)).name).toBe(original.name);
  await expect(input).toHaveAttribute('readonly', '');
  release();
  await expect(input).toHaveCount(0);
  await expect(page.locator('[role="treeitem"]').filter({ hasText: renamed }).first()).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect((await dbFolder(sql, folder.id)).version).toBe(original.version + 1);
});

test('Goal2 folder faults: queued folder moves expose real pending cancel and failed status with committed batch counts', async ({ page, context, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sql = await ready(page, context, baseURL);
  const firstParent = await createFolder(page, `Move destination one ${randomUUID()}`);
  const secondParent = await createFolder(page, `Move destination two ${randomUUID()}`);
  const source = await createFolder(page, `Queued move source ${randomUUID()}`);
  const before = (await sql`SELECT parent_id, version FROM folders WHERE id=${source.id}`)[0];
  let release; const held = new Promise(resolve => { release = resolve; });
  const submitted = [];
  await page.route('**/api/folders', async route => {
    if (route.request().method() !== 'PATCH' || !route.request().postDataJSON().destination) return route.continue();
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) await held;
    await route.continue();
  });
  await page.evaluate(({ sourceId, parentOne, parentTwo }) => {
    const state = window.__folderFaultStore.getState();
    window.__folderMoveResults = [];
    for (const folderId of [parentOne, parentTwo]) state.moveFolder(sourceId, { type: 'folder', folderId }).then(() => window.__folderMoveResults.push({ folderId, ok: true }), error => window.__folderMoveResults.push({ folderId, ok: false, error: error.message }));
  }, { sourceId: source.id, parentOne: firstParent.id, parentTwo: secondParent.id });
  await expect.poll(() => submitted.length).toBe(1);
  const sourceRow = page.locator('[role="treeitem"]').filter({ hasText: source.name }).first();
  await expect(sourceRow).toHaveAttribute('aria-busy', 'true');
  const status = page.locator('#desktop-history-panel [role="status"]').filter({ hasText: 'move Folder' });
  await expect(status).toContainText('pending');
  await expect(status).toContainText('queued');
  await expect(status.getByRole('button', { name: 'Cancel queued', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('folder-move-pending-queued.png') });
  await status.getByRole('button', { name: 'Cancel queued', exact: true }).click();
  await expect(status).toContainText('cancelled');
  expect((await sql`SELECT parent_id FROM folders WHERE id=${source.id}`)[0].parent_id).toBe(before.parent_id);
  await page.screenshot({ path: testInfo.outputPath('folder-move-queued-cancelled.png') });
  release();
  await expect.poll(() => page.evaluate(() => window.__folderMoveResults.length)).toBe(2);
  const committed = (await sql`SELECT parent_id, version FROM folders WHERE id=${source.id}`)[0];
  expect(committed.parent_id).toBe(firstParent.id);
  expect(committed.version).toBe(before.version + 1);
  expect(submitted).toHaveLength(1);
  expect(submitted[0].destination.folderId).toBe(firstParent.id);
  await expect(status).toContainText('confirmed');
  // Real Django rejects moving the parent into its now-persisted descendant.
  const invalid = await page.evaluate(async ({ parentId, childId }) => {
    try { await window.__folderFaultStore.getState().moveFolder(parentId, { type: 'folder', folderId: childId }); return { rejected: false }; }
    catch (error) { return { rejected: true, code: error.code }; }
  }, { parentId: firstParent.id, childId: source.id });
  expect(invalid.rejected).toBeTruthy();
  await expect(status).toContainText('failed');
  await expect(status.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect((await sql`SELECT parent_id FROM folders WHERE id=${firstParent.id}`)[0].parent_id).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('folder-move-real-failure.png') });
  const fixtureIds = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];
  const batch = await page.evaluate(async ({ ids, folderId }) => window.__folderFaultStore.getState().moveGenerationsToDestination(ids, { type: 'folder', folderId, projectId: null }), { ids: fixtureIds, folderId: secondParent.id });
  expect(batch.movedCount).toBe(3);
  expect((await sql`SELECT id FROM generations WHERE id IN ${sql(fixtureIds)} AND folder_id=${secondParent.id}`)).toHaveLength(3);
  await expect(page.locator('#desktop-history-panel [role="status"]').filter({ hasText: 'Moved 3 of 3 assets' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('batch-move-real-committed-count.png') });
});
