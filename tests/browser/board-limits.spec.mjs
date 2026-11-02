import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Two ordinary fixture users who both edit one board.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000021', name: 'Limits owner', email: 'limits-owner@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000022', name: 'Limits teammate', email: 'limits-teammate@example.test' };

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
    // Scripted wheels read as a mouse wheel (which zooms in auto mode); this person scrolls like a trackpad.
    localStorage.setItem('veevee.board.viewPrefs', JSON.stringify({ navigationMode: 'trackpad' }));
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

test('Board limits: a sticky past its text cap is refused with an explanation, and the board stays editable', async ({ browser, baseURL }) => {
  await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board limits ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const made = await owner.context.request.post('/api/canvas-boards', {
    data: { op: 'createBoard', projectId: project.id, name: 'Limits board' }, headers: { Origin: baseURL } });
  expect(made.ok()).toBeTruthy();
  const boardPath = `/api/canvas-boards/${(await made.json()).board.id}`;
  const empty = await (await owner.context.request.get(boardPath)).json();
  const sticky = { id: randomUUID(), type: 'sticky', x: 100, y: 100, w: 200, h: 200, text: '' };
  const stored = { ...empty, data: { ...empty.data, nodes: [sticky] } };
  const first = await owner.context.request.put(boardPath, {
    data: { data: stored.data, baseVersion: empty.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(first.status()).toBe(200);
  stored.version = (await first.json()).version;

  // A sticky holds up to 3,000 characters: one more is refused with the server's own wording.
  const save = (text, version) => owner.context.request.put(boardPath, {
    data: { data: { ...stored.data, nodes: [{ ...sticky, text }] }, baseVersion: version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  const refused = await save('a'.repeat(3001), stored.version);
  expect(refused.status()).toBe(413);
  const body = await refused.json();
  expect(body.limit).toBe('text');
  expect(body.error).toMatch(/up to 3,000 characters/);
  expect(body.error).not.toContain('\u2014');

  // A text at the cap is saved, and a refused save left the board untouched.
  const accepted = await save('a'.repeat(3000), stored.version);
  expect(accepted.status()).toBe(200);
  expect((await (await owner.context.request.get(boardPath)).json()).data.nodes[0].text).toHaveLength(3000);
  await owner.context.close();
});
