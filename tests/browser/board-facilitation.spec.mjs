import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Two ordinary fixture users who both edit one board: a facilitator and a participant.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000021', name: 'Facilitator', email: 'facilitator@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000022', name: 'Participant', email: 'participant@example.test' };

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
  const page = await context.newPage();
  return { context, page };
}

const isBoardGet = (response) => /\/api\/canvas-boards\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET';

async function openBoard(page) {
  const loaded = page.waitForResponse(isBoardGet);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Facilitate' })).toBeVisible();
  return new URL((await loaded).url()).pathname;
}

const sticky = (id, text, x, y) => ({ id, type: 'sticky', x, y, w: 200, h: 200, text });

/** Replaces the board's objects the way a client save does (the whole graph at the current version). */
async function putNodes(context, baseURL, boardPath, nodes) {
  const current = await (await context.request.get(boardPath)).json();
  const response = await context.request.put(boardPath, {
    data: { data: { ...current.data, nodes }, baseVersion: current.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(response.status()).toBe(200);
}

const facilitate = async (page, item) => {
  await page.getByRole('button', { name: 'Facilitate' }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

test('Facilitation: a shared timer, a voting session with secret ballots, and private mode with a countdown reveal', async ({ browser, baseURL }, info) => {
  test.setTimeout(180000);
  await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Facilitation ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const boardPath = await openBoard(owner.page);
  const shared = await owner.context.request.post(`${boardPath}/access`, {
    data: { op: 'setMember', userId: MATE.id, role: 'edit' }, headers: { Origin: baseURL } });
  expect(shared.ok()).toBeTruthy();
  await putNodes(owner.context, baseURL, boardPath, [sticky('idea-a', 'Idea A', 400, 250), sticky('idea-b', 'Idea B', 650, 250)]);
  const mate = await signIn(browser, baseURL, MATE, project.id);
  await openBoard(mate.page);
  await owner.page.reload();
  await openBoard(owner.page);
  await expect(owner.page.locator('[data-node-id="idea-a"]')).toBeVisible();
  await expect(mate.page.locator('[data-node-id="idea-b"]')).toBeVisible();

  // Timer: start, and the participant's board counts down too; add time, pause and stop.
  await facilitate(owner.page, 'Timer');
  await owner.page.getByRole('button', { name: 'Start timer' }).click();
  const ownerTimer = owner.page.locator('[data-board-timer]');
  const mateTimer = mate.page.locator('[data-board-timer]');
  await expect(ownerTimer.locator('[data-timer-clock]')).toHaveText(/^[45]:\d\d$/);
  await expect(mateTimer.locator('[data-timer-clock]')).toHaveText(/^[45]:\d\d$/, { timeout: 15000 });
  await ownerTimer.getByRole('button', { name: 'Add five minutes' }).click();
  await expect(ownerTimer.locator('[data-timer-clock]')).toHaveText(/^(9|10):\d\d$/);
  await info.attach('timer', { body: await owner.page.screenshot(), contentType: 'image/png' });
  await ownerTimer.getByRole('button', { name: 'Pause timer' }).click();
  await expect(ownerTimer).toContainText('Paused');
  await expect(mateTimer).toContainText('Paused', { timeout: 15000 });
  await ownerTimer.getByRole('button', { name: 'Mute timer sounds' }).click();
  await ownerTimer.getByRole('button', { name: 'Stop timer' }).click();
  await expect(ownerTimer).toHaveCount(0);
  await expect(mateTimer).toHaveCount(0, { timeout: 15000 });

  // Voting: two votes each; the participant's ballot is private, the facilitator sees progress.
  await facilitate(owner.page, 'Start voting');
  await owner.page.getByLabel('Votes per person').fill('2');
  await owner.page.getByRole('button', { name: 'Start voting' }).click();
  const bar = owner.page.locator('[data-voting-bar]');
  await expect(bar).toContainText('2 of 2 votes left');
  const mateBar = mate.page.locator('[data-voting-bar]');
  await expect(mateBar).toContainText('2 of 2 votes left', { timeout: 15000 });
  const ideaA = mate.page.locator('[data-vote-badge="idea-a"]');
  await ideaA.getByRole('button', { name: 'Add a vote' }).click();
  await ideaA.getByRole('button', { name: 'Add a vote' }).click();
  await expect(ideaA.locator('[data-vote-count]')).toHaveText('2');
  await expect(ideaA.getByRole('button', { name: 'Add a vote' })).toBeDisabled();
  await expect(mate.page.locator('[data-vote-badge="idea-b"]').getByRole('button', { name: 'Add a vote' })).toBeDisabled();
  await expect(owner.page.locator('[data-vote-badge="idea-a"] [data-vote-count]')).toHaveText('0');
  await mateBar.getByRole('button', { name: "I'm done" }).click();
  await expect(bar.locator('[data-voting-progress]')).toHaveText('1 voted, 1 done', { timeout: 15000 });
  await info.attach('voting', { body: await owner.page.screenshot(), contentType: 'image/png' });
  await bar.getByRole('button', { name: 'End voting' }).click();
  await expect(bar).toHaveCount(0);
  await facilitate(owner.page, 'Voting results');
  const history = owner.page.locator('[data-voting-history]');
  const rows = history.locator('[data-result-row]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Idea A');
  await expect(rows.first()).toContainText('2');
  await history.getByRole('button', { name: 'Keep results on board' }).click();
  await owner.page.keyboard.press('Escape');
  await expect(owner.page.locator('[data-vote-total]')).toHaveText('2 votes');
  await expect(mate.page.locator('[data-vote-total]')).toHaveText('2 votes', { timeout: 15000 });
  await info.attach('results', { body: await mate.page.screenshot(), contentType: 'image/png' });

  // Private mode: the participant's new note stays hidden from the facilitator until the reveal.
  await facilitate(owner.page, 'Private mode');
  await owner.page.getByRole('button', { name: 'Start private mode' }).click();
  await expect(owner.page.locator('[data-private-bar]')).toContainText('notes are hidden');
  await expect(mate.page.locator('[data-private-bar]')).toBeVisible({ timeout: 15000 });
  const seen = await (await mate.context.request.get(boardPath)).json();
  await putNodes(mate.context, baseURL, boardPath, [...seen.data.nodes, sticky('secret', 'Participant secret', 900, 250)]);
  const hidden = owner.page.locator('[data-node-id="secret"] [data-sticky-hidden]');
  await expect(hidden).toBeVisible({ timeout: 15000 });
  expect(JSON.stringify((await (await owner.context.request.get(boardPath)).json()).data)).not.toContain('Participant secret');
  await expect(mate.page.locator('[data-node-id="secret"]')).toContainText('Participant secret');
  await info.attach('private-hidden', { body: await owner.page.screenshot(), contentType: 'image/png' });
  await owner.page.getByRole('button', { name: 'Reveal all' }).click();
  await expect(owner.page.locator('[data-reveal-countdown]')).toContainText('Revealing in');
  await expect(owner.page.locator('[data-node-id="secret"]')).toContainText('Participant secret', { timeout: 20000 });
  await expect(owner.page.locator('[data-private-bar]')).toHaveCount(0);
  await expect(hidden).toHaveCount(0);

  await owner.context.close();
  await mate.context.close();
});
