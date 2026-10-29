import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
const RETIRED = 'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.';

async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

async function freshProject(context, page, label) {
  const response = await context.request.post('/api/projects', {
    data: { op: 'createProject', name: `${label} ${randomUUID()}` }, headers: { Origin: process.env.E2E_BASE_URL } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  await page.addInitScript(projectId => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
  }, project.id);
  return project;
}

async function shot(target, testInfo, name) {
  await target.screenshot({ path: testInfo.outputPath(name) });
}

test('Gemini Omni Flash 1.1 replaces Gemini Omni Flash in the composer and generates through Django enqueue and the worker', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const project = await freshProject(context, page, 'Gemini Omni Flash 1.1');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Video', exact: true }).click();

  // 1.1 is offered right after Seedance 2.5; the retired preview is gone from the picker.
  const picker = page.getByRole('button', { name: /^Model:/ });
  await picker.click();
  // The menu renders after the click; snapshot its items only once it is open.
  await expect(page.getByRole('menuitem', { name: /^Seedance 2\.5/ })).toBeVisible();
  const names = await page.getByRole('menuitem').allInnerTexts();
  const seedance = names.findIndex(text => text.startsWith('Seedance 2.5'));
  expect(seedance).toBeGreaterThanOrEqual(0);
  expect(names[seedance + 1]).toContain('Gemini Omni Flash 1.1');
  expect(names.filter(text => /^Gemini Omni Flash(?!\s*1\.1)/.test(text))).toEqual([]);
  const option = page.getByRole('menuitem', { name: /^Gemini Omni Flash 1\.1(?:\s|$)/ });
  await expect(option).toContainText('Google Interactions API · 360p draft or 720p · 4-10s · 16:9/9:16 · sound from the prompt');
  await expect(option).toContainText('NEW');
  await shot(page, testInfo, 'omni-1-1-model-picker.png');
  await option.click();
  await expect(picker).toContainText('Gemini Omni Flash 1.1');

  // Only the documented controls: 16:9/9:16, 360p/720p, 4-10s, no audio toggle.
  await page.getByRole('button', { name: 'Generation settings', exact: true }).click();
  for (const name of ['16:9', '9:16', '360p', '720p', '4s', '6s', '8s', '10s']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const name of ['21:9', '1:1', '480p', '1080p', '5s', '15s']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  const settings = page.locator('div')
    .filter({ has: page.getByText('Aspect ratio', { exact: true }) })
    .filter({ has: page.getByText('Batch (per generate)', { exact: true }) }).last();
  await expect(settings.getByText('Duration', { exact: true })).toBeVisible();
  await expect(settings.getByText('Audio', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '9:16', exact: true }).click();
  await page.getByRole('button', { name: '360p', exact: true }).click();
  await page.getByRole('button', { name: '10s', exact: true }).click();
  await shot(page, testInfo, 'omni-1-1-settings.png');
  await page.getByRole('button', { name: 'Generation settings', exact: true }).click();

  const prompt = `Omni 1.1 lantern river ${randomUUID().slice(0, 8)}`;
  await page.locator('textarea').first().fill(prompt);
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/generate/video') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toMatchObject({ model: 'Gemini Omni Flash 1.1', aspectRatio: '9:16', resolution: '360p',
    duration: 10, generateAudio: false, prompt, projectId: project.id });
  const { id } = await response.json();

  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  try {
    // The worker finishes the job (mock provider); the row keeps the model, controls and the 360p estimate (11 x 10 / 3).
    await expect.poll(async () => (await db`SELECT status FROM generations WHERE id = ${id}`)[0]?.status, { timeout: 30000 }).toBe('succeeded');
    const [row] = await db`SELECT model, resolution, duration, cost_cents, cost_basis, project_id, user_id FROM generations WHERE id = ${id}`;
    expect(row).toEqual({ model: 'Gemini Omni Flash 1.1', resolution: '360p', duration: 10, cost_cents: 37, cost_basis: 'estimated',
      project_id: project.id, user_id: USER_ID });
    await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('main').getByText('Gemini Omni Flash 1.1', { exact: true }).first()).toBeVisible();
    for (const label of ['Proportion 9:16', 'Resolution 360p', 'Duration 10s']) {
      await expect(page.getByRole('main').getByText(label, { exact: true }).first()).toBeVisible();
    }
    // The conversation card leaves its queued state once the live feed delivers the finished row.
    await expect(page.getByRole('main').getByText('Queued', { exact: true })).toHaveCount(0, { timeout: 30000 });
    await page.getByText(prompt, { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'omni-1-1-generated-card.png');
  } finally {
    await db`DELETE FROM generations WHERE id = ${id}`;
  }
});

test('the retired Gemini Omni Flash takes no new jobs, while its history still reads and downloads', async ({ context, baseURL }) => {
  await authenticate(context, baseURL);
  const refused = await context.request.post('/api/generate/video', { headers: { Origin: process.env.E2E_BASE_URL }, data: {
    prompt: 'a lantern', model: 'Gemini Omni Flash', aspectRatio: '16:9', resolution: '720p', duration: 8 } });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toEqual({ error: RETIRED });

  // A finished generation made before the retirement (it reuses the seeded native video as its master).
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const id = randomUUID();
  const prompt = `Retired Omni history ${id.slice(0, 8)}`;
  const [fixture] = await db`SELECT url FROM generations WHERE id = '20000000-0000-4000-8000-000000000001'`;
  const now = Date.now();
  await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, resolution, duration, url, user_id, cost_cents, created_at, updated_at)
           VALUES (${id}, 'video', 'succeeded', 'Gemini Omni Flash', ${prompt}, '16:9', '720p', 8, ${fixture.url}, ${USER_ID}, 80, ${now}, ${now})`;
  try {
    const history = await (await context.request.get('/api/history?limit=60')).json();
    const item = history.items.find(row => row.id === id);
    expect(item).toMatchObject({ model: 'Gemini Omni Flash', status: 'succeeded', costCents: 80, prompt });
    const download = await context.request.get(`/api/generations/${id}/download`);
    expect(download.status()).toBe(200);
    expect((await download.body()).length).toBeGreaterThan(0);
  } finally {
    await db`DELETE FROM generations WHERE id = ${id}`;
  }
});
