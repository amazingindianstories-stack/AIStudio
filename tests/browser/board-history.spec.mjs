import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Two ordinary fixture users who both edit one board.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000011', name: 'History owner', email: 'history-owner@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000012', name: 'History teammate', email: 'history-teammate@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function seedUsers() {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, MATE].map((user) => db.statement`
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
  const page = await context.newPage();
  return { context, page };
}

async function openBoard(page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

const isBoardSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());

/** Runs `action` and returns the board as stored once a save of it lands. */
async function saved(page, boardPath, action, until) {
  const response = page.waitForResponse(isBoardSave);
  await action();
  expect((await response).status()).toBe(200);
  await expect.poll(async () => until((await (await page.request.get(boardPath)).json()).data)).toBeTruthy();
  return (await (await page.request.get(boardPath)).json()).data;
}

/** Nothing in the panel spills outside the viewport or its own box. */
async function pixelClean(page, root) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const overflowing = await root.evaluate((element) => [...element.querySelectorAll('*')].filter((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden') return false;
    return box.left < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5 || node.scrollWidth > node.clientWidth + 1 &&
      !['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowX) && getComputedStyle(node).textOverflow !== 'ellipsis';
  }).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`));
  expect(overflowing).toEqual([]);
}

test('Board history: edits are stamped and listed by person, moves are not, and only editors can read it', async ({ browser, baseURL }, info) => {
  await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board history ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  // The owner adds a sticky and writes on it.
  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const canvas = await openBoard(owner.page);
  const placed = owner.page.waitForResponse(isBoardSave);
  await owner.page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await canvas.click({ position: { x: 520, y: 320 } });
  const boardPath = new URL((await placed).url()).pathname;
  const boardId = boardPath.split('/').at(-1);
  const editor = owner.page.locator('[data-rich-editor]');
  await expect(editor).toBeFocused();
  await owner.page.keyboard.type('Opening shot');
  let data = await saved(owner.page, boardPath, () => canvas.click({ position: { x: 1100, y: 700 } }),
    (graph) => graph.nodes[0]?.text === 'Opening shot');
  const sticky = data.nodes[0];
  expect(sticky).toMatchObject({ createdBy: OWNER.id, updatedBy: OWNER.id });
  expect(sticky.createdAt).toBeLessThanOrEqual(sticky.updatedAt);

  // A move is not a change: no new history entry and the stamps stay.
  const history = async (page) => (await (await page.request.get(`${boardPath}/activity`)).json()).activity;
  const beforeMove = await history(owner.page);
  expect(beforeMove.map((entry) => entry.action)).toEqual(['edit', 'add']);
  const node = owner.page.locator(`[data-node-id="${sticky.id}"]`);
  const box = await node.boundingBox();
  data = await saved(owner.page, boardPath, async () => {
    await owner.page.mouse.move(box.x + 20, box.y + 20);
    await owner.page.mouse.down();
    await owner.page.mouse.move(box.x + 140, box.y + 90, { steps: 8 });
    await owner.page.mouse.up();
  }, (graph) => graph.nodes[0].x !== sticky.x);
  expect(data.nodes[0]).toMatchObject({ createdAt: sticky.createdAt, updatedAt: sticky.updatedAt });
  expect(await history(owner.page)).toEqual(beforeMove);

  // A forged stamp in a save is replaced by the server's.
  const stored = await (await owner.page.request.get(boardPath)).json();
  const forged = { ...stored.data, nodes: stored.data.nodes.map((item) => ({ ...item, text: 'Forged', createdBy: MATE.id, createdAt: 1 })) };
  const forgedSave = await owner.context.request.put(boardPath, {
    data: { data: forged, baseVersion: stored.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(forgedSave.status()).toBe(200);
  const forgedNode = (await (await owner.page.request.get(boardPath)).json()).data.nodes[0];
  expect(forgedNode).toMatchObject({ text: 'Forged', createdBy: OWNER.id, createdAt: sticky.createdAt, updatedBy: OWNER.id });

  // The teammate edits the sticky; the selection shows who made and changed it.
  const shared = await owner.context.request.post(`${boardPath}/access`, {
    data: { op: 'setMember', userId: MATE.id, role: 'edit' }, headers: { Origin: baseURL } });
  expect(shared.ok()).toBeTruthy();
  const mate = await signIn(browser, baseURL, MATE, project.id);
  const mateCanvas = await openBoard(mate.page);
  const mateNode = mate.page.locator(`[data-node-id="${sticky.id}"]`);
  await mateNode.click();
  const mateInfo = mate.page.getByLabel('Object info');
  await expect(mateInfo).toContainText(`Created by ${OWNER.name}`);
  await mateNode.dblclick();
  await expect(mate.page.locator('[data-rich-editor]')).toBeFocused();
  await mate.page.keyboard.press('ControlOrMeta+a');
  await mate.page.keyboard.type('Opening shot, take two');
  await saved(mate.page, boardPath, () => mateCanvas.click({ position: { x: 1100, y: 700 } }),
    (graph) => graph.nodes[0]?.text === 'Opening shot, take two');
  await mateNode.click();
  await expect(mateInfo).toContainText(`Created by ${OWNER.name}`);
  await expect(mateInfo).toContainText(`Last changed by ${MATE.name} · just now`);
  await info.attach('object-info', { body: await mate.page.screenshot(), contentType: 'image/png' });

  // The owner's History panel lists both people, newest first, and jumps to the sticky.
  await owner.page.reload();
  await openBoard(owner.page);
  await owner.page.getByRole('button', { name: 'History', exact: true }).click();
  const panel = owner.page.getByRole('region', { name: 'Board history' });
  await expect(panel).toBeVisible();
  const groups = panel.locator('ol > li');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText(MATE.name);
  await expect(groups.nth(0)).toContainText('Edited sticky note');
  await expect(groups.nth(0)).toContainText('“Opening shot, take two”');
  await expect(groups.nth(1)).toContainText(OWNER.name);
  await expect(groups.nth(1).locator('ul > li')).toHaveCount(3);
  await expect(groups.nth(1)).toContainText('Added sticky note');
  await pixelClean(owner.page, panel);
  // Scrolled away from the sticky, choosing its entry selects it and brings it back into view.
  const ownerNode = owner.page.locator(`[data-node-id="${sticky.id}"]`);
  await owner.page.mouse.move(1100, 700);
  for (let step = 0; step < 6; step += 1) await owner.page.mouse.wheel(0, 900);
  await expect(ownerNode).not.toBeInViewport();
  await groups.nth(0).getByRole('button', { name: /Edited sticky note/ }).click();
  await expect(ownerNode).toBeInViewport();
  await expect(owner.page.getByLabel('Object info')).toContainText(`Last changed by ${MATE.name}`);
  await info.attach('history-panel', { body: await owner.page.screenshot(), contentType: 'image/png' });

  // Deleting the sticky is recorded, and the deleted object can no longer be jumped to.
  await saved(owner.page, boardPath, async () => {
    await ownerNode.click();
    await owner.page.keyboard.press('Delete');
  }, (graph) => graph.nodes.length === 0);
  await expect(groups.nth(0)).toContainText('Deleted sticky note');
  await expect(panel.getByRole('button', { name: /sticky note/ })).toHaveCount(0);
  await owner.page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Commenters and viewers cannot read history.
  const narrowed = await owner.context.request.post(`${boardPath}/access`, {
    data: { op: 'setTeamRole', role: 'view' }, headers: { Origin: baseURL } });
  expect(narrowed.ok()).toBeTruthy();
  const demoted = await owner.context.request.post(`${boardPath}/access`, {
    data: { op: 'setMember', userId: MATE.id, role: 'comment' }, headers: { Origin: baseURL } });
  expect(demoted.ok()).toBeTruthy();
  await mate.page.reload();
  await openBoard(mate.page);
  await expect(mate.page.getByRole('status').filter({ hasText: 'Comment only' })).toBeVisible();
  await expect(mate.page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  expect((await mate.context.request.get(`/api/canvas-boards/${boardId}/activity`)).status()).toBe(403);
  await expect(mate.page.getByLabel('Object info')).toHaveCount(0);
  await info.attach('commenter-no-history', { body: await mate.page.screenshot(), contentType: 'image/png' });

  await owner.context.close();
  await mate.context.close();
});
