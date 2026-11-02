import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Board "Create with AI": the panel quotes, queues one job per click, the generation worker runs it and the result
// lands on the board once. Run with `scripts/dev/browser-harness.py --fake-providers` to drive the real Gemini
// adapters against testsupport.fake_provider_server (and assert its calls); without the flag jobs end through
// MOCK_GENERATION and the provider assertions are skipped.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
const FAKE = process.env.E2E_FAKE_PROVIDER_URL;

async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

async function freshProject(context, page) {
  const response = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Board AI ${randomUUID()}` },
    headers: { Origin: process.env.E2E_BASE_URL } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  await page.addInitScript(projectId => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
    // Scripted wheels read as a mouse wheel (which zooms in auto mode); this person scrolls like a trackpad.
    localStorage.setItem('veevee.board.viewPrefs', JSON.stringify({ navigationMode: 'trackpad' }));
  }, project.id);
  return project.id;
}

async function fakeState() {
  return (await fetch(`${FAKE}/state`)).json();
}

// Board AI on a selection: one-click actions edit text in place and cluster notes, the context menu offers the
// same actions, a diagram becomes shapes and connectors, and the AI inputs can be turned off per person.
test('AI acts on the selection, builds diagrams, and can be turned off', async ({ page, context, baseURL }) => {
  test.setTimeout(240000);
  await authenticate(context, baseURL);
  const projectId = await freshProject(context, page);
  let boardId;
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  await expect.poll(async () => {
    boardId = (await (await context.request.get(`/api/canvas-boards?projectId=${projectId}`)).json()).boards[0]?.id;
    return Boolean(boardId);
  }).toBeTruthy();
  const board = async () => (await (await context.request.get(`/api/canvas-boards/${boardId}`)).json()).data;

  // Three sticky notes to work on, made the ordinary way.
  await page.getByRole('button', { name: 'Create with AI', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Create with AI' });
  await panel.getByRole('button', { name: 'Questions to ask before a location scout' }).click();
  await expect(panel.getByText(/Estimated cost/)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(async () => (await board()).nodes.filter(node => node.type === 'sticky').length, { timeout: 60000 }).toBe(3);
  const original = (await board()).nodes.filter(node => node.type === 'sticky').map(node => node.text);

  // Select them: the panel offers actions for the selection. Edit in place, as one undo step.
  await panel.getByRole('button', { name: 'New prompt', exact: true }).click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ControlOrMeta+a');
  await expect(panel.getByLabel('Selection', { exact: true })).toContainText('3 selected');
  await panel.getByRole('button', { name: 'Fix grammar and spelling' }).click();
  await expect(panel.getByRole('textbox', { name: 'Prompt' })).toHaveValue(/Fix grammar/);
  await expect(panel.getByText(/Estimated cost/)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(async () => (await board()).nodes.filter(node => node.type === 'sticky').map(node => node.text), { timeout: 60000 })
    .toEqual(original.map(text => expect.stringMatching(new RegExp(`^(EDITED|Mock) ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await board()).nodes.filter(node => node.type === 'sticky').map(node => node.text), { timeout: 30000 }).toEqual(original);

  // Cluster by keywords adds titled columns.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ControlOrMeta+a');
  await panel.getByRole('button', { name: 'Cluster by keywords' }).click();
  await expect(panel.getByText(/Estimated cost/)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(async () => (await board()).nodes.filter(node => node.type === 'text').length, { timeout: 60000 }).toBe(2);

  // A diagram result is shapes joined by connectors; nothing is selected as context.
  await page.mouse.click(1200, 300);
  await expect(panel.getByLabel('Selection', { exact: true })).toHaveCount(0);
  await panel.getByRole('radio', { name: 'Diagram' }).click();
  await panel.getByRole('button', { name: 'A flowchart of our review and approval process' }).click();
  await expect(panel.getByText(/Estimated cost/)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(async () => (await board()).connectors?.length ?? 0, { timeout: 60000 }).toBeGreaterThan(0);
  const data = await board();
  expect(data.nodes.filter(node => node.type !== 'sticky' && node.type !== 'text').length).toBeGreaterThanOrEqual(2);
  if (FAKE) expect((await fakeState()).board_jobs).toBeGreaterThanOrEqual(4);

  // Turning AI off hides every entry point; turning it on brings the button back.
  await panel.getByRole('button', { name: 'Turn AI off' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Create with AI', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn on AI inputs' }).click();
  await expect(page.getByRole('button', { name: 'Create with AI', exact: true })).toBeVisible();
});
