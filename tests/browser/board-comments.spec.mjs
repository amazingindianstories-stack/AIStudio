import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0c0d000-0000-4000-8000-000000000001', name: 'Comment owner', email: 'comment-owner@example.test' };
const MATE = { id: 'b0c0d000-0000-4000-8000-000000000002', name: 'Comment teammate', email: 'comment-teammate@example.test' };

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

test('Board comments: pin a comment on an object, mention a teammate, reply, react, resolve and read it from the bell', async ({ browser, baseURL }, info) => {
  test.setTimeout(180000);
  await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', { data: { op: 'createProject', name: `Board comments ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const canvas = await openBoard(owner.page);
  await owner.page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  const saved = owner.page.waitForResponse((response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method()));
  await canvas.click({ position: { x: 460, y: 340 } });
  const boardPath = new URL((await saved).url()).pathname;
  const boardId = boardPath.split('/').at(-1);

  // The teammate may comment but not edit: the team default drops to view and they are added as a commenter.
  const team = await owner.context.request.post(`${boardPath}/access`, { data: { op: 'setTeamRole', role: 'view' }, headers: { Origin: baseURL } });
  expect(team.ok()).toBeTruthy();
  const added = await owner.context.request.post(`${boardPath}/access`, { data: { op: 'setMember', userId: MATE.id, role: 'comment' }, headers: { Origin: baseURL } });
  expect(added.ok()).toBeTruthy();

  // Place a comment on the sticky, mentioning the teammate from the suggestions.
  await owner.page.keyboard.press('Escape');
  await owner.page.getByTestId('add-comment').click();
  await owner.page.getByTestId('comment-capture').click({ position: { x: 460, y: 340 } });
  const composer = owner.page.getByTestId('comment-draft').getByRole('textbox');
  await composer.fill('Please check this @Comment');
  await owner.page.getByRole('option', { name: /Comment teammate/ }).click();
  await composer.pressSequentially('now');
  await owner.page.getByTestId('comment-draft').getByRole('button', { name: 'Comment', exact: true }).click();
  const thread = owner.page.getByRole('region', { name: 'Comment thread' });
  await expect(thread).toContainText('Please check this');
  await expect(thread.locator('[data-mention]')).toHaveText('@Comment teammate');
  await expect(owner.page.locator('[data-pin]')).toHaveCount(1);
  await info.attach('owner-comment', { body: await owner.page.screenshot(), contentType: 'image/png' });

  // Dragging the pin onto empty canvas detaches it; dragging it onto the sticky attaches it again.
  const pin = owner.page.locator('[data-pin]');
  const dragPinTo = async (x, y) => {
    const box = await pin.boundingBox();
    await owner.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await owner.page.mouse.down();
    await owner.page.mouse.move(x, y, { steps: 8 });
    await owner.page.mouse.up();
  };
  const anchorNode = async () => (await (await owner.context.request.get(`${boardPath}/comments`)).json()).comments[0].anchor?.nodeId ?? null;
  expect(await anchorNode()).not.toBeNull();
  await dragPinTo(900, 600);
  await expect.poll(anchorNode, { timeout: 15000 }).toBeNull();
  await dragPinTo(460, 430);
  await expect.poll(anchorNode, { timeout: 15000 }).not.toBeNull();
  await expect(thread).toContainText('Please check this');

  // The teammate sees an unread pin and a bell notification for the mention.
  const mate = await signIn(browser, baseURL, MATE, project.id);
  await openBoard(mate.page);
  await expect(mate.page.locator('[data-pin] [data-unread-dot]')).toBeVisible({ timeout: 20000 });
  await expect(mate.page.getByTestId('notification-count')).toHaveText('1', { timeout: 20000 });
  await expect(mate.page.getByTestId('add-comment')).toBeVisible();
  await expect(mate.page.getByRole('button', { name: 'Sticky note', exact: true })).toHaveCount(0);
  await mate.page.getByTestId('notification-bell').click();
  const item = mate.page.getByRole('dialog', { name: 'Notifications' }).locator('[data-notification]').first();
  await expect(item).toContainText('mentioned you');
  await item.click();
  const mateThread = mate.page.getByRole('region', { name: 'Comment thread' });
  await expect(mateThread).toBeVisible();
  await expect(mate.page.locator('[data-pin] [data-unread-dot]')).toHaveCount(0);

  // Reply, react and resolve.
  await mateThread.getByRole('textbox').fill('Looks good to me');
  await mateThread.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(mateThread).toContainText('Looks good to me');
  await mateThread.getByRole('button', { name: 'Add reaction' }).first().click();
  await mateThread.getByRole('menuitem', { name: '👍' }).click();
  await expect(mateThread.getByRole('button', { name: '👍 1' }).first()).toHaveAttribute('aria-pressed', 'true');
  await mateThread.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(mateThread).toContainText('Resolved');
  await info.attach('teammate-thread', { body: await mate.page.screenshot(), contentType: 'image/png' });

  // The owner's board catches up by polling: the reply arrives, the people bar shows the teammate.
  await expect(owner.page.getByTestId('people-bar')).toBeVisible({ timeout: 20000 });
  await owner.page.getByTestId('comments-panel-toggle').click();
  await owner.page.getByRole('tab', { name: 'Resolved' }).click();
  await expect(owner.page.locator('[data-panel-thread]')).toHaveCount(1, { timeout: 20000 });

  // Hiding comments removes the pins for this viewer only and survives a reload.
  await owner.page.getByRole('tab', { name: 'Open' }).click();
  await owner.page.getByTestId('toggle-comments-visibility').click();
  await expect(owner.page.locator('[data-pin]')).toHaveCount(0);
  await owner.page.reload();
  await openBoard(owner.page);
  await expect(owner.page.getByRole('button', { name: 'Show comments on the board' })).toBeVisible();
  expect(boardId).toBeTruthy();

  // A viewer can read comments but not write them: the server refuses and the button is gone.
  const downgraded = await owner.context.request.post(`${boardPath}/access`, { data: { op: 'setMember', userId: MATE.id, role: 'view' }, headers: { Origin: baseURL } });
  expect(downgraded.ok()).toBeTruthy();
  const refused = await mate.context.request.post(`${boardPath}/comments`, { data: { body: 'nope', x: 1, y: 1 }, headers: { Origin: baseURL } });
  expect(refused.status()).toBe(403);
  await mate.page.reload();
  await openBoard(mate.page);
  await expect(mate.page.getByTestId('add-comment')).toHaveCount(0);
  await expect(mate.page.getByTestId('comments-panel-toggle')).toBeVisible();

  await owner.context.close();
  await mate.context.close();
});
