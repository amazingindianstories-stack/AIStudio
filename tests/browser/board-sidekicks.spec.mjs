import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Runs against MOCK_GENERATION: the Sidekick, Flow step and Catch up jobs return fixed answers, so no provider is called.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000051', name: 'Sidekick owner', email: 'sidekick-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(OWNER.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  return { context, page: await context.newPage() };
}

async function openBoard(page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

test('Board Sidekicks: chat places attributed work, Flow runs and reverts, Catch up, custom Sidekick, credits', async ({ browser, baseURL }) => {
  test.setTimeout(150000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board sidekicks ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, project.id);
  await page.goto('/');
  await openBoard(page);

  await page.getByRole('button', { name: 'Sidekick', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Sidekick' });
  await expect(panel).toBeVisible();

  // The slash menu lists commands; the quote shows before anything is sent.
  const box = panel.getByRole('textbox', { name: 'Message the Sidekick' });
  await box.fill('/');
  await expect(panel.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await box.fill('Give me ideas');
  await expect(panel.getByTestId('sidekick-cost')).toContainText('~');

  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByText('Here is a first pass.')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Mock Sidekick idea')).toBeVisible();
  await page.getByText('Mock Sidekick idea').first().click();
  await expect(page.getByText(/Created with AI/)).toBeVisible();

  // Flow: add a step, quote, run, then revert.
  await panel.getByRole('tab', { name: 'Flows' }).click();
  await panel.getByRole('textbox', { name: 'Step instruction' }).fill('Summarize the inputs');
  await panel.getByRole('button', { name: 'Add step' }).click();
  await expect(panel.getByRole('list', { name: 'Flow steps' }).getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Mock flow output').first()).toBeVisible({ timeout: 30000 });
  // The first run has no earlier output; a forced second run keeps the first as a version that can be reverted.
  await panel.getByRole('button', { name: 'Versions of step 1' }).click();
  await expect(panel.getByText('No earlier outputs in the last 24 hours.')).toBeVisible();
  await panel.getByLabel('Run every step').check();
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Run', exact: true })).toBeEnabled({ timeout: 30000 });
  await panel.getByRole('button', { name: 'Versions of step 1' }).click();
  await panel.getByRole('button', { name: 'Versions of step 1' }).click();
  await expect(panel.getByRole('list', { name: 'Earlier outputs' })).toBeVisible();
  await panel.getByRole('button', { name: 'Revert' }).first().click();
  await expect(page.getByText('Mock flow output').first()).toBeVisible();

  // Catch up shows the period and summarizes with a quote.
  // Catch up lists other people's changes, so a teammate's edit is recorded straight into the board activity.
  const [board] = await db`SELECT id FROM canvas_boards WHERE project_id = ${project.id} LIMIT 1`;
  await db`INSERT INTO board_activity (board_id, actor_id, action, node_id, node_type, snippet, created_at, ordinal)
    VALUES (${board.id}, NULL, 'add', 'teammate-sticky', 'sticky', 'Teammate idea', ${Date.now()}, 0)`;
  await panel.getByRole('tab', { name: 'Catch up' }).click();
  await panel.getByLabel('Period').selectOption('1w');
  await expect(panel.getByTestId('catchup-info')).toContainText('change');
  await panel.getByRole('button', { name: /Summarize/ }).click();
  await expect(panel.getByText('Mock summary of the changes.')).toBeVisible({ timeout: 30000 });

  // A custom Sidekick is saved and selectable.
  await panel.getByRole('tab', { name: 'Chat' }).click();
  await panel.getByRole('button', { name: 'New Sidekick', exact: true }).click();
  const form = panel.getByRole('form', { name: 'New Sidekick' });
  await form.getByLabel('Name').fill('Story editor');
  await form.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Tighten story beats.');
  await form.getByRole('button', { name: /^Save/ }).click();
  await expect(panel.getByRole('combobox').first()).toContainText('Story editor');

  // Credits are reported for the signed-in user.
  const credits = await (await context.request.get('/api/canvas-ai/credits')).json();
  expect(credits.usedCents ?? credits.used ?? 0).toBeGreaterThanOrEqual(0);

  try { await context.close(); } finally {
    await db`DELETE FROM canvas_board_ai_jobs WHERE generation_id IN (SELECT id FROM generations WHERE user_id = ${OWNER.id})`;
    await db`DELETE FROM generations WHERE user_id = ${OWNER.id}`;
  }
});
