import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER = 'b0a2d000-0000-4000-8000-000000000041';
function cookie() {
  const payload = Buffer.from(JSON.stringify({ uid: USER, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

test('Board work: create cards, edit details, arrange columns, reload persisted records', async ({ browser, baseURL }) => {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([db.statement`INSERT INTO users (id,email,password_hash,password_salt,created_at,name,role,is_active,auth_version)
    VALUES (${USER},'work-owner@example.test','unused','unused',1,'Work owner','user',true,0)
    ON CONFLICT (id) DO UPDATE SET is_active=true, auth_version=0`]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: cookie(), url: baseURL }]);
  const result = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Work ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(result.ok()).toBeTruthy();
  const { project } = await result.json();
  await context.addInitScript(id => localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id })), project.id);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Cards and work' });
  await panel.getByRole('button', { name: 'Add card (D)', exact: true }).click();
  await panel.getByLabel('title', { exact: true }).fill('Ship milestone');
  await panel.getByLabel('description', { exact: true }).fill('Review the release checklist');
  await panel.getByLabel('end', { exact: true }).fill('2026-12-15');
  await panel.getByLabel('Assignee', { exact: true }).selectOption(USER);
  await panel.getByRole('button', { name: 'Add columns', exact: true }).click();
  await panel.getByLabel('lanes name 1', { exact: true }).fill('Backlog');
  await panel.getByRole('button', { name: 'Add card to columns', exact: true }).click();
  await panel.getByLabel('title', { exact: true }).fill('Lane task');
  const boards = await (await context.request.get(`/api/canvas-boards?projectId=${project.id}`)).json();
  const boardId = boards.boards[0].id;
  await expect.poll(async () => {
    const board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return board.data.nodes.filter(n => n.type === 'card').map(n => n.record.title).sort();
  }).toEqual(['Lane task', 'Ship milestone']);
  await page.reload();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await panel.getByLabel('Selected widget').selectOption({ label: 'Ship milestone' });
  await expect(panel.getByLabel('description', { exact: true })).toHaveValue('Review the release checklist');
  await expect(panel.getByLabel('Assignee', { exact: true })).toHaveValue(USER);
  await context.close();
});
