import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Two ordinary (non-admin) fixture users: the board owner and a teammate.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000001', name: 'Board owner', email: 'board-owner@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000002', name: 'Board teammate', email: 'board-teammate@example.test' };

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

async function addSticky(page, canvas, position) {
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  const saved = page.waitForResponse((response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) &&
    response.request().method() === 'PUT');
  await canvas.click({ position });
  const response = await saved;
  expect(response.status()).toBe(200);
  return response.url();
}

/** Nothing in the dialog spills outside the viewport or its own box. */
async function pixelClean(page, root) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const overflowing = await root.evaluate((element) => [...element.querySelectorAll('*')].filter((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden') return false;
    return box.left < -0.5 || box.right > innerWidth + 0.5 || node.scrollWidth > node.clientWidth + 1 &&
      !['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowX) && getComputedStyle(node).textOverflow !== 'ellipsis';
  }).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`));
  expect(overflowing).toEqual([]);
}

test('Board roles: an owner shares a board and a teammate gets comment, edit and view access', async ({ browser, baseURL }, info) => {
  const db = await seedUsers();
  const ownerSide = await signIn(browser, baseURL, OWNER, null);
  const created = await ownerSide.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board roles ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await ownerSide.context.close();

  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const ownerCanvas = await openBoard(owner.page);
  const boardUrl = await addSticky(owner.page, ownerCanvas, { x: 360, y: 260 });
  const boardPath = new URL(boardUrl).pathname;
  const boardId = boardPath.split('/').at(-1);
  await expect(owner.page.getByRole('status').filter({ hasText: /View only|Comment only/ })).toHaveCount(0);

  // Owner: only the owner and admins may narrow team access; the owner adds the teammate as a commenter.
  await owner.page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = owner.page.getByRole('dialog', { name: 'Share board' });
  await expect(dialog.getByText('Your access:')).toBeVisible();
  await dialog.getByLabel('Team access').selectOption('view');
  await expect(dialog.getByLabel('Team access')).toHaveValue('view');
  const members = dialog.getByRole('region', { name: 'Board members' });
  await members.getByLabel('Add a teammate to this board').selectOption({ label: MATE.name });
  await members.getByLabel('Role').selectOption('comment');
  await members.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(members.getByLabel(`Board role for ${MATE.name}`)).toHaveValue('comment');
  await pixelClean(owner.page, dialog);
  await info.attach('share-dialog-owner', { body: await owner.page.screenshot(), contentType: 'image/png' });

  // Teammate with comment access: read-only canvas, no creation tools, no autosave.
  const mate = await signIn(browser, baseURL, MATE, project.id);
  const writes = [];
  mate.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  const mateCanvas = await openBoard(mate.page);
  await expect(mate.page.getByRole('status').filter({ hasText: 'Comment only' })).toBeVisible();
  await expect(mate.page.getByRole('button', { name: 'Sticky note', exact: true })).toHaveCount(0);
  await expect(mate.page.getByRole('button', { name: 'Add image', exact: true })).toHaveCount(0);
  await expect(mate.page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
  const before = await (await mate.context.request.get(boardPath)).json();
  expect(before.role).toBe('comment');
  const sticky = mate.page.locator(`[data-node-id="${before.data.nodes[0].id}"]`);
  await sticky.click();
  await mate.page.keyboard.press('Delete');
  await sticky.dblclick();
  await mate.page.keyboard.press('s');
  await mateCanvas.click({ position: { x: 700, y: 500 } });
  await mate.page.keyboard.press('Meta+z');
  await mate.page.mouse.wheel(0, 200);
  await mate.page.waitForTimeout(2000);
  expect(writes).toEqual([]);
  const after = await (await mate.context.request.get(boardPath)).json();
  expect(after.data).toEqual(before.data);
  expect(after.updatedAt).toBe(before.updatedAt);
  const refused = await mate.context.request.put(boardPath, { data: { data: before.data }, headers: { Origin: baseURL } });
  expect(refused.status()).toBe(403);
  await info.attach('teammate-comment-only', { body: await mate.page.screenshot(), contentType: 'image/png' });

  // The teammate sees who has access but cannot change it.
  await mate.page.getByRole('button', { name: 'Share', exact: true }).click();
  const mateDialog = mate.page.getByRole('dialog', { name: 'Share board' });
  await expect(mateDialog.getByLabel('Team access')).toBeDisabled();
  await expect(mateDialog.getByLabel('Add a teammate to this board')).toHaveCount(0);
  await expect(mateDialog.getByRole('region', { name: 'Board members' }).getByText('Can comment', { exact: true })).toBeVisible();
  await mateDialog.getByRole('button', { name: 'Close' }).click();

  // Owner promotes the teammate to editor: the teammate can now add and autosave.
  await members.getByLabel(`Board role for ${MATE.name}`).selectOption('edit');
  await expect(members.getByLabel(`Board role for ${MATE.name}`)).toHaveValue('edit');
  await mate.page.reload();
  const editableCanvas = await openBoard(mate.page);
  await expect(mate.page.getByRole('status').filter({ hasText: /View only|Comment only/ })).toHaveCount(0);
  await addSticky(mate.page, editableCanvas, { x: 620, y: 420 });

  // Owner removes the teammate: team access (view) applies again.
  await members.getByRole('button', { name: `Remove ${MATE.name} from this board` }).click();
  await expect(members.getByLabel(`Board role for ${MATE.name}`)).toHaveCount(0);
  await mate.page.reload();
  await openBoard(mate.page);
  await expect(mate.page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible();
  await info.attach('teammate-view-only', { body: await mate.page.screenshot(), contentType: 'image/png' });

  // Transfer ownership: the teammate becomes the owner and the previous owner keeps edit access.
  await members.getByLabel('Add a teammate to this board').selectOption({ label: MATE.name });
  await members.getByLabel('Role').selectOption('view');
  await members.getByRole('button', { name: 'Add', exact: true }).click();
  await members.getByRole('button', { name: 'Make owner' }).click();
  await owner.page.getByRole('alertdialog', { name: 'Transfer ownership' }).getByRole('button', { name: 'Transfer ownership' }).click();
  // The previous owner stays on the board as an editor, and keeps owner powers through the project owner role.
  await expect(members.getByLabel(`Board role for ${OWNER.name}`)).toHaveValue('edit');
  await expect(dialog.getByText('Your access:')).toContainText('Owner');
  const transferred = (await db`SELECT created_by FROM canvas_boards WHERE id = ${boardId}`)[0];
  expect(transferred.created_by).toBe(MATE.id);
  const ownerMember = await db`SELECT role FROM board_members WHERE board_id = ${boardId} AND user_id = ${OWNER.id}`;
  expect(ownerMember).toEqual([{ role: 'edit' }]);

  await owner.context.close();
  await mate.context.close();
});
