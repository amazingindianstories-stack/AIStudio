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
  }, project.id);
  return project.id;
}

async function fakeState() {
  return (await fetch(`${FAKE}/state`)).json();
}

test('Create with AI quotes, runs once, places sticky notes and an image on the board, refines in place and never re-places', async ({ page, context, baseURL }) => {
  test.setTimeout(180000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await authenticate(context, baseURL);
  const projectId = await freshProject(context, page);
  const boardJobsBefore = FAKE ? (await fakeState()).board_jobs : 0;
  let boardId;
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
    // Opening the board view creates the project's first board.
    await expect.poll(async () => {
      boardId = (await (await context.request.get(`/api/canvas-boards?projectId=${projectId}`)).json()).boards[0]?.id;
      return Boolean(boardId);
    }).toBeTruthy();
    const nodes = async () => (await (await context.request.get(`/api/canvas-boards/${boardId}`)).json()).data.nodes;

    await page.getByRole('button', { name: 'Create with AI', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Create with AI' });
    await expect(panel).toBeVisible();
    const generate = panel.getByRole('button', { name: 'Generate', exact: true });
    await expect(generate).toBeDisabled();

    // A suggestion fills the prompt; the cost is quoted before the job can run.
    await panel.getByRole('button', { name: 'Questions to ask before a location scout' }).click();
    await expect(panel.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Questions to ask before a location scout');
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await expect(generate).toBeEnabled();

    // A double click queues one job.
    const submitted = page.waitForResponse(response => response.url().endsWith(`/api/canvas-boards/${boardId}/ai-jobs`) && response.request().method() === 'POST');
    await generate.dblclick();
    const first = (await (await submitted).json()).job;
    expect(first.format).toBe('stickies');

    await expect(panel.getByText(/Refining \d+ sticky notes?:/)).toBeVisible({ timeout: 60000 });
    await expect.poll(async () => (await nodes()).filter(node => node.type === 'sticky').length, { timeout: 30000 }).toBe(3);
    const stickies = (await nodes()).filter(node => node.type === 'sticky');
    const rows = await db`SELECT kind, status, created_via, user_id::text AS user_id FROM generations WHERE id = ${first.generationId}`;
    expect(rows).toEqual([{ kind: 'text', status: 'succeeded', created_via: 'board', user_id: USER_ID }]);
    expect((await db`SELECT count(*)::int AS n FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`)[0].n).toBe(1);
    if (FAKE) {
      expect((await fakeState()).board_jobs - boardJobsBefore).toBe(1);
      expect(stickies.map(node => node.text)).toEqual(['Simulated idea: open on the empty stage', 'Simulated idea: the lights fail mid-scene',
        'Simulated idea: end on a single spotlight']);
    }

    // Refining replaces those notes in place.
    const refinement = panel.getByRole('textbox', { name: 'Refinement' });
    await refinement.fill('make them shorter');
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await refinement.press('Enter');
    await expect.poll(async () => {
      const current = (await nodes()).filter(node => node.type === 'sticky');
      return current.length === 3 && current.every(node => !stickies.some(old => old.id === node.id));
    }, { timeout: 60000 }).toBeTruthy();
    if (FAKE) expect((await fakeState()).board_jobs - boardJobsBefore).toBe(2);

    // An image result becomes one image node from the library.
    await panel.getByRole('button', { name: 'New prompt', exact: true }).click();
    await panel.getByRole('radio', { name: 'Image' }).click();
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('A lighthouse at dusk in heavy fog');
    await panel.getByRole('radio', { name: '16:9' }).click();
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(async () => (await nodes()).filter(node => node.type === 'image').length, { timeout: 90000 }).toBe(1);
    const [image] = (await nodes()).filter(node => node.type === 'image');
    expect(image.src).toMatch(/^\/api\/media\//);
    expect([image.w, image.h]).toEqual([320, 180]);
    // It went to free space next to the notes, not on top of them.
    const notes = (await nodes()).filter(node => node.type === 'sticky');
    expect(notes.some(node => node.x < image.x + image.w && image.x < node.x + node.w && node.y < image.y + image.h && image.y < node.y + node.h)).toBe(false);

    // A reload resumes nothing: every result was placed exactly once.
    const count = (await nodes()).length;
    await page.reload();
    await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
    await page.waitForTimeout(3000);
    expect((await nodes()).length).toBe(count);
    expect((await db`SELECT count(*)::int AS n FROM canvas_board_ai_jobs WHERE board_id = ${boardId} AND placed_at IS NULL`)[0].n).toBe(0);
  } finally {
    if (boardId) {
      const generations = await db`SELECT generation_id FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      await db`DELETE FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      for (const row of generations) await db`DELETE FROM generations WHERE id = ${row.generation_id}`;
    }
  }
});
