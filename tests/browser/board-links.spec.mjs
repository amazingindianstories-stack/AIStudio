import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// One ordinary fixture user who owns every board in the project.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000031', name: 'Link owner', email: 'link-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

test('An object link to a board that is not first in its project keeps that board open, centered on the object', async ({ browser, baseURL }, info) => {
  test.setTimeout(240000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(OWNER.id), url: baseURL }]);
  const created = await context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board links ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  for (const name of ['Board one', 'Board two', 'Board three']) {
    const made = await context.request.post('/api/canvas-boards', {
      data: { op: 'createBoard', projectId: project.id, name }, headers: { Origin: baseURL } });
    expect(made.ok()).toBeTruthy();
  }
  const { boards } = await (await context.request.get(`/api/canvas-boards?projectId=${project.id}`)).json();
  // The link targets a board the switcher would not pick on its own: not the first one listed.
  expect(boards).toHaveLength(3);
  const target = boards[1];

  // The target board holds one sticky far from its saved view.
  const boardPath = `/api/canvas-boards/${target.id}`;
  const current = await (await context.request.get(boardPath)).json();
  const sticky = { id: 'far-away', type: 'sticky', text: 'Far away target', x: 4000, y: 3000, w: 200, h: 200, rotation: 0,
    opacity: 1, fill: '#fde68a', fontSize: 16, parentId: null, groupId: null, locked: false };
  const saved = await context.request.put(boardPath, {
    data: { data: { ...current.data, nodes: [sticky], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } },
      baseVersion: current.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(saved.status()).toBe(200);

  // The link names the project that is already active, so only the board changes and the
  // board switcher's own list fetch must not replace the linked board with the first one.
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, project.id);
  const page = await context.newPage();
  const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/canvas-boards'
    && new URL(r.url()).searchParams.get('projectId') === project.id && r.request().method() === 'GET');
  await page.goto(`/?project=${project.id}&board=${target.id}&object=far-away`);
  // A cold dev server may still be compiling the board view on this first visit.
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible({ timeout: 60000 });
  await listed;
  await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  const object = page.locator('[data-node-id="far-away"]');
  await expect(object).toBeVisible();
  await expect(page.getByRole('button', { name: target.name }).first()).toBeVisible();
  const box = await object.boundingBox();
  const view = page.viewportSize();
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(400);
  expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThan(300);
  await info.attach('linked board', { body: await page.screenshot(), contentType: 'image/png' });
  await context.close();
});
