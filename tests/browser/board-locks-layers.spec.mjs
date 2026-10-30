import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// The board owner, a project co-owner and a project editor.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000051', name: 'Locks owner', email: 'locks-owner@example.test' };
const CO = { id: 'b0a2d000-0000-4000-8000-000000000052', name: 'Locks co-owner', email: 'locks-co-owner@example.test' };
const EDITOR = { id: 'b0a2d000-0000-4000-8000-000000000053', name: 'Locks editor', email: 'locks-editor@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function seedUsers() {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, CO, EDITOR].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  return db;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
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

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) &&
  ['PUT', 'PATCH'].includes(response.request().method());

/** Runs `action` and waits for the save it causes. */
async function saved(page, action) {
  const response = page.waitForResponse(isSave);
  await action();
  expect((await response).status()).toBe(200);
}

const board = async (page, path) => (await (await page.request.get(path)).json());
const nodeIn = async (page, path, id) => (await board(page, path)).data.nodes.find((node) => node.id === id);

/** The id of the sticky drawn on top where the two stickies overlap. */
async function topOfOverlap(page) {
  const a = await page.locator('[data-node-id="s1"]').boundingBox();
  const b = await page.locator('[data-node-id="s2"]').boundingBox();
  const x = (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2;
  const y = (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2;
  return page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-node-id]')?.dataset.nodeId, [x, y]);
}

/** A point on the sticky that the other one never covers: s1's top left, s2's bottom right. */
async function grabPoint(page, id) {
  const box = await page.locator(`[data-node-id="${id}"]`).boundingBox();
  return id === 's1' ? { x: box.x + 30, y: box.y + 14 } : { x: box.x + box.width - 30, y: box.y + box.height - 14 };
}

async function dragBy(page, id, dx, dy) {
  const { x, y } = await grabPoint(page, id);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function select(page, id) {
  const { x, y } = await grabPoint(page, id);
  await page.mouse.click(x, y);
}

async function contextMenu(page, id) {
  const { x, y } = await grabPoint(page, id);
  await page.mouse.click(x, y, { button: 'right' });
}

test('Board locks and layers: lock, Unlock all, layer order, hide and lock, and a co-owner protected lock', async ({ browser, baseURL }, info) => {
  const db = await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board locks ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();
  await db.transaction([[CO, 'co_owner'], [EDITOR, 'editor']].map(([user, role]) => db.statement`
    INSERT INTO project_members (project_id, user_id, role, added_by, created_at, updated_at)
    VALUES (${project.id}, ${user.id}, ${role}, ${OWNER.id}, 1, 1)`));

  // The owner's board: two overlapping stickies, s2 drawn above s1.
  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const canvas = await openBoard(owner.page);
  const placed = owner.page.waitForResponse(isSave);
  await owner.page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await canvas.click({ position: { x: 900, y: 600 } });
  const boardPath = new URL((await placed).url()).pathname;
  await owner.page.keyboard.press('Escape');
  await expect.poll(async () => (await board(owner.page, boardPath)).data.nodes.length).toBe(1);
  const stored = await board(owner.page, boardPath);
  const [template] = stored.data.nodes;
  const sticky = (id, x, y) => ({ ...template, id, x, y, w: 200, h: 200, text: id });
  const seeded = await owner.context.request.put(boardPath, { headers: { Origin: baseURL }, data: {
    data: { ...stored.data, viewport: { x: -400, y: -60, zoom: 1 }, nodes: [sticky('s1', 200, 120), sticky('s2', 300, 220)] },
    baseVersion: stored.version, saveId: randomUUID() } });
  expect(seeded.status()).toBe(200);
  await owner.page.reload();
  await openBoard(owner.page);
  await expect(owner.page.locator('[data-node-id="s1"]')).toBeVisible();
  expect(await topOfOverlap(owner.page)).toBe('s2');

  // Cmd/Ctrl+Shift+L locks: a badge shows, the toolbar says so, and the save names the owner.
  await select(owner.page, 's1');
  await saved(owner.page, () => owner.page.keyboard.press('ControlOrMeta+Shift+L'));
  await expect(owner.page.locator('[data-node-id="s1"] [data-lock-badge]')).toBeVisible();
  await expect(owner.page.locator('[data-locked-toolbar]')).toContainText('Locked');
  expect(await nodeIn(owner.page, boardPath, 's1')).toMatchObject({ locked: true, lockedBy: OWNER.id });
  await info.attach('locked-sticky', { body: await owner.page.screenshot(), contentType: 'image/png' });

  // A locked sticky cannot be dragged, deleted or opened for text editing.
  const before = await owner.page.locator('[data-node-id="s1"]').boundingBox();
  await dragBy(owner.page, 's1', 140, 90);
  expect(await owner.page.locator('[data-node-id="s1"]').boundingBox()).toEqual(before);
  await select(owner.page, 's1');
  await owner.page.keyboard.press('Delete');
  await expect(owner.page.locator('[data-node-id="s1"]')).toBeVisible();
  await owner.page.mouse.dblclick(...Object.values(await grabPoint(owner.page, 's1')));
  await expect(owner.page.locator('[data-rich-editor]')).toHaveCount(0);
  await owner.page.keyboard.press('Escape');
  expect(await nodeIn(owner.page, boardPath, 's1')).toMatchObject({ x: 200, y: 120, locked: true });

  // The shortcut unlocks it again, and then it moves.
  await select(owner.page, 's1');
  await saved(owner.page, () => owner.page.keyboard.press('ControlOrMeta+Shift+L'));
  await expect(owner.page.locator('[data-lock-badge]')).toHaveCount(0);
  await saved(owner.page, () => dragBy(owner.page, 's1', -60, 0));
  await expect.poll(async () => (await nodeIn(owner.page, boardPath, 's1')).x).toBeLessThan(200);

  // Lock both from the context menu, then Unlock all from the board's background menu.
  await select(owner.page, 's1');
  await owner.page.keyboard.press('ControlOrMeta+a');
  await contextMenu(owner.page, 's2');
  await saved(owner.page, () => owner.page.getByRole('menuitem', { name: 'Lock', exact: true }).click());
  await expect(owner.page.locator('[data-lock-badge]')).toHaveCount(2);
  await canvas.click({ button: 'right', position: { x: 1000, y: 700 } });
  await saved(owner.page, () => owner.page.getByRole('menuitem', { name: 'Unlock all', exact: true }).click());
  await expect.poll(async () => (await board(owner.page, boardPath)).data.nodes.filter((node) => node.locked).length).toBe(0);

  // Layers: a new layer is active; moving s1 onto it draws s1 above s2.
  await owner.page.getByRole('button', { name: 'Layers', exact: true }).click();
  const panel = owner.page.getByRole('region', { name: 'Layers' });
  await expect(panel).toBeVisible();
  await saved(owner.page, () => panel.getByRole('button', { name: 'New layer' }).click());
  const layerTwo = (await board(owner.page, boardPath)).data.settings.layers[0];
  expect(layerTwo.name).toBe('Layer 2');
  await expect(panel.locator(`[data-layer-row="${layerTwo.id}"]`)).toHaveAttribute('data-active', 'true');
  await select(owner.page, 's1');
  await panel.getByRole('button', { name: 'More for Layer 2' }).click();
  await saved(owner.page, () => owner.page.getByRole('menuitem', { name: 'Move selection here' }).click());
  expect((await nodeIn(owner.page, boardPath, 's1')).layerId).toBe(layerTwo.id);
  expect(await topOfOverlap(owner.page)).toBe('s1');
  await expect(panel.locator(`[data-layer-row="${layerTwo.id}"]`)).toContainText('1 object');
  await info.attach('layers-panel', { body: await owner.page.screenshot(), contentType: 'image/png' });

  // Hiding is personal and saves nothing; the hidden sticky is gone from the canvas until shown.
  const writes = [];
  owner.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && request.method() !== 'GET') writes.push(request.method());
  });
  await panel.getByRole('button', { name: 'Hide Layer 2' }).click();
  await expect(owner.page.locator('[data-node-id="s1"]')).toHaveCount(0);
  await owner.page.waitForTimeout(1500);
  expect(writes).toEqual([]);
  await panel.getByRole('button', { name: 'Show Layer 2' }).click();
  await expect(owner.page.locator('[data-node-id="s1"]')).toBeVisible();

  // A locked layer locks what is on it, for everyone.
  await saved(owner.page, () => panel.getByRole('button', { name: 'Lock Layer 2' }).click());
  expect((await board(owner.page, boardPath)).data.settings.layers[0].locked).toBe(true);
  const onLocked = await owner.page.locator('[data-node-id="s1"]').boundingBox();
  await dragBy(owner.page, 's1', 120, 0);
  expect(await owner.page.locator('[data-node-id="s1"]').boundingBox()).toEqual(onLocked);
  await select(owner.page, 's1');
  await owner.page.keyboard.press('Delete');
  await expect(owner.page.locator('[data-node-id="s1"]')).toBeVisible();
  await saved(owner.page, () => panel.getByRole('button', { name: 'Unlock Layer 2' }).click());

  // Reorder: a third layer holding s2 is on top; dragging Layer 2 above it puts s1 back on top.
  await saved(owner.page, () => panel.getByRole('button', { name: 'New layer' }).click());
  const layerThree = (await board(owner.page, boardPath)).data.settings.layers[1];
  await select(owner.page, 's2');
  await panel.getByRole('button', { name: `More for ${layerThree.name}` }).click();
  await saved(owner.page, () => owner.page.getByRole('menuitem', { name: 'Move selection here' }).click());
  expect(await topOfOverlap(owner.page)).toBe('s2');
  await saved(owner.page, () => panel.locator(`[data-layer-row="${layerTwo.id}"]`)
    .dragTo(panel.locator(`[data-layer-row="${layerThree.id}"]`), { targetPosition: { x: 60, y: 4 } }));
  expect((await board(owner.page, boardPath)).data.settings.layers.map((layer) => layer.id)).toEqual([layerThree.id, layerTwo.id]);
  expect(await topOfOverlap(owner.page)).toBe('s1');
  // And Move down through the menu puts it back.
  await panel.getByRole('button', { name: 'More for Layer 2' }).click();
  await saved(owner.page, () => owner.page.getByRole('menuitem', { name: 'Move down' }).click());
  expect(await topOfOverlap(owner.page)).toBe('s2');
  await owner.context.close();

  // The co-owner sets a protected lock on s1.
  const co = await signIn(browser, baseURL, CO, project.id);
  await openBoard(co.page);
  await expect(co.page.locator('[data-node-id="s1"]')).toBeVisible();
  await select(co.page, 's1');
  await contextMenu(co.page, 's1');
  await saved(co.page, () => co.page.getByRole('menuitem', { name: 'Lock (protected)', exact: true }).click());
  expect(await nodeIn(co.page, boardPath, 's1')).toMatchObject({ locked: true, lockedBy: CO.id, lockProtected: true });
  await co.context.close();

  // The editor sees who locked it and has no way to unlock it, by menu, toolbar, shortcut or Unlock all.
  const editor = await signIn(browser, baseURL, EDITOR, project.id);
  const editorCanvas = await openBoard(editor.page);
  await expect(editor.page.locator('[data-node-id="s1"]')).toBeVisible();
  await select(editor.page, 's1');
  await expect(editor.page.locator('[data-locked-toolbar]')).toContainText(`Locked by ${CO.name}`);
  await expect(editor.page.locator('[data-locked-toolbar]').getByRole('button', { name: 'Unlock' })).toHaveCount(0);
  await contextMenu(editor.page, 's1');
  const menu = editor.page.getByRole('menu');
  await expect(menu.locator('[data-lock-holder]')).toContainText(`Locked by ${CO.name}`);
  await expect(menu.getByRole('menuitem', { name: 'Unlock', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Lock (protected)', exact: true })).toHaveCount(0);
  await info.attach('protected-lock-editor', { body: await editor.page.screenshot(), contentType: 'image/png' });
  await editor.page.keyboard.press('Escape');
  await editorCanvas.click({ button: 'right', position: { x: 1000, y: 700 } });
  await expect(editor.page.getByRole('menuitem', { name: 'Unlock all', exact: true })).toHaveCount(0);
  await editor.page.keyboard.press('Escape');
  await select(editor.page, 's1');
  await editor.page.keyboard.press('ControlOrMeta+Shift+L');
  await editor.page.keyboard.press('Delete');
  await expect(editor.page.locator('[data-node-id="s1"]')).toBeVisible();

  // The server holds the same rule for an editor whose client tries anyway, and keeps the rest of the save.
  const current = await board(editor.page, boardPath);
  const s1 = current.data.nodes.find((node) => node.id === 's1');
  const s2x = current.data.nodes.find((node) => node.id === 's2').x;
  const forced = await editor.context.request.put(boardPath, { headers: { Origin: baseURL }, data: {
    data: { ...current.data, nodes: current.data.nodes.map((node) => node.id === 's1' ? { ...node, x: 900, locked: false }
      : { ...node, x: node.x + 10 }) },
    baseVersion: current.version, saveId: randomUUID() } });
  expect(forced.status()).toBe(200);
  const body = await forced.json();
  expect(body.version).toBe(current.version + 1);
  expect(body.board.nodes.find((node) => node.id === 's1')).toMatchObject({ x: s1.x, lockProtected: true, lockedBy: CO.id });
  expect((await nodeIn(editor.page, boardPath, 's2')).x).toBe(s2x + 10);
  await editor.context.close();
});
