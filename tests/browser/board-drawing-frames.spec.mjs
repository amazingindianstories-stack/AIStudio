import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000041', name: 'Drawing owner', email: 'drawing-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
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

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());

async function storedBoard(context, boardId, ready) {
  let board;
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return ready(board);
  }, { timeout: 15000 }).toBe(true);
  return board;
}

const ofType = (board, type) => board.data.nodes.filter((node) => node.type === type);

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2 + 20, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

test('Board drawing and frames: pen, eraser, grid from CSV, frame around selection, hide, and notes', async ({ browser, baseURL }, info) => {
  test.setTimeout(180000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board drawing ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openBoard(page);
  const box = await canvas.boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Pen: two strokes become two compact ink objects.
  await page.keyboard.press('p');
  const firstSave = page.waitForResponse(isSave);
  await drag(page, at(0.3, 0.4), at(0.4, 0.45));
  await drag(page, at(0.3, 0.6), at(0.42, 0.62));
  const boardId = new URL((await firstSave).url()).pathname.split('/').pop();
  let board = await storedBoard(context, boardId, (b) => ofType(b, 'ink').length === 2);
  expect(ofType(board, 'ink')[0].pts.length).toBeLessThan(80);
  await info.attach('pen', { body: await page.screenshot(), contentType: 'image/png' });

  // Eraser: sweeping across one stroke removes it and keeps the other.
  await page.keyboard.press('e');
  await drag(page, at(0.29, 0.405), at(0.41, 0.455));
  board = await storedBoard(context, boardId, (b) => ofType(b, 'ink').length === 1);

  // Frame around the remaining selection (Cmd/Ctrl+Alt+F).
  await page.keyboard.press('v');
  await page.keyboard.press('ControlOrMeta+KeyA');
  await page.keyboard.press('ControlOrMeta+Alt+KeyF');
  board = await storedBoard(context, boardId, (b) => ofType(b, 'frame').length === 1 && ofType(b, 'ink')[0].parentId === ofType(b, 'frame')[0].id);
  await expect(page.getByRole('toolbar', { name: 'Frame controls' })).toBeVisible();

  // Hide the frame from everyone else.
  await page.getByRole('button', { name: 'Hide frame' }).click();
  board = await storedBoard(context, boardId, (b) => ofType(b, 'frame')[0].hidden === true);
  await info.attach('hidden-frame', { body: await page.screenshot(), contentType: 'image/png' });

  // Grid from pasted CSV.
  await page.getByRole('button', { name: 'Grid' }).click();
  await page.getByRole('textbox', { name: 'Paste table text' }).fill('Name,Role\nAda,Lead\nBo,Artist');
  await page.getByRole('button', { name: 'Create grid from text' }).click();
  board = await storedBoard(context, boardId, (b) => ofType(b, 'grid').length === 1);
  const grid = ofType(board, 'grid')[0];
  expect([grid.rows, grid.cols]).toEqual([3, 2]);

  // Notes: open the panel, type, close and read it back from the saved board.
  await page.getByRole('button', { name: 'Board notes' }).click();
  const panel = page.getByRole('complementary', { name: 'Board notes' });
  await panel.getByRole('button', { name: 'Edit' }).click();
  await page.keyboard.type('Plan for tomorrow');
  await panel.getByRole('heading', { name: 'Notes' }).click();
  board = await storedBoard(context, boardId, (b) => b.data.notes?.text === 'Plan for tomorrow');
  expect(board.data.notes.updatedBy).toBeTruthy();
  await info.attach('notes', { body: await page.screenshot(), contentType: 'image/png' });

  expect(errors).toEqual([]);
  await context.close();
});
