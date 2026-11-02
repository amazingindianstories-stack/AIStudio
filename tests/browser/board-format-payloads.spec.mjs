import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-0000000000a1', name: 'Formats owner', email: 'formats-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
  await context.addInitScript((id) => {
    // Also runs inside sandboxed embeds, which have no storage access.
    try { localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id })); } catch { /* sandboxed frame */ }
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

let boardPath = '';
const LONG = Array.from({ length: 500 }, (_, index) => `Paragraph ${index} of the long doc.`).join(' ');

test('Board formats: a long Doc keeps its text outside the board JSON, saves and reloads', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board payloads ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const dialog = page.getByRole('dialog', { name: 'Format focus mode' });
  const toggle = page.getByRole('button', { name: /^Formats/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

  const first = page.waitForResponse(isSave);
  await page.getByRole('button', { name: 'New doc', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Format title').fill('Long doc');
  const firstSave = await first;
  expect(firstSave.status()).toBe(200);
  boardPath = new URL(firstSave.url()).pathname;
  const stored = async (query = '') => (await context.request.get(boardPath + query)).json();
  const longDoc = async () => (await stored()).data.nodes.find((n) => n.format === 'doc')?.blocks?.find((b) => b.text === LONG);

  // The text is far past the old 5,000 character block cap and lands in the doc's own row, not in the board JSON.
  await dialog.getByLabel('Insert doc block').selectOption('p');
  await dialog.getByRole('button', { name: 'Edit block 3' }).click();
  await page.keyboard.insertText(LONG);
  await dialog.getByLabel('Format title').click();
  await expect.poll(longDoc, { timeout: 20000 }).toBeTruthy();

  const lazy = await stored('?payloads=lazy');
  const node = lazy.data.nodes.find((n) => n.format === 'doc');
  expect(node.blocks).toBeUndefined();
  expect(node.payload.size).toBeGreaterThan(LONG.length);
  expect(JSON.stringify(lazy.data).length).toBeLessThan(5000);
  const loaded = await (await context.request.get(`${boardPath}/payloads/${node.id}`)).json();
  expect(loaded.blocks.some((b) => b.text === LONG)).toBe(true);

  // After a reload the doc opens with the whole text, and a further edit saves over it.
  await page.goto(`/?board=${boardPath.split('/').pop()}&focus=${node.id}`);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Format title')).toHaveValue('Long doc');
  await expect(dialog.getByText('Paragraph 499 of the long doc.')).toBeVisible();
  const edited = page.waitForResponse(isSave);
  await dialog.getByLabel('Format title').fill('Long doc, edited');
  expect((await edited).status()).toBe(200);
  await expect.poll(async () => (await stored()).data.nodes.find((n) => n.format === 'doc')?.name).toBe('Long doc, edited');
  expect(await longDoc()).toBeTruthy();
  expect(errors).toEqual([]);
  await context.close();
});
