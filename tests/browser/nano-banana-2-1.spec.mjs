import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';

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

test('Nano Banana 2.1 is picked in the composer and generates through Django enqueue and the worker', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const project = await freshProject(context, page, 'Nano Banana 2.1');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Image', exact: true }).click();

  // Pro stays the default; 2.1 is listed right after it with its own hint and badge.
  const picker = page.getByRole('button', { name: /^Model:/ });
  await expect(picker).toContainText('Nano Banana Pro');
  await picker.click();
  const items = page.getByRole('menuitem');
  const names = await items.allInnerTexts();
  const pro = names.findIndex(text => text.startsWith('Nano Banana Pro'));
  expect(pro).toBeGreaterThanOrEqual(0);
  expect(names[pro + 1]).toContain('Nano Banana 2.1');
  const option = page.getByRole('menuitem', { name: /^Nano Banana 2\.1(?:\s|$)/ });
  await expect(option).toContainText('Flash-speed Gemini image · up to 14 references · 1K/2K/4K');
  await expect(option).toContainText('FAST');
  await shot(page, testInfo, 'nano-banana-2-1-model-picker.png');
  await option.click();
  await expect(picker).toContainText('Nano Banana 2.1');

  // Capability-driven controls: ten aspect ratios and 1K/2K/4K (no 512px).
  await page.getByRole('button', { name: 'Generation settings', exact: true }).click();
  for (const ratio of ['1:1', '3:4', '4:3', '4:5', '5:4', '2:3', '3:2', '9:16', '16:9', '21:9']) {
    await expect(page.getByRole('button', { name: ratio, exact: true })).toBeVisible();
  }
  for (const size of ['1K', '2K', '4K']) await expect(page.getByRole('button', { name: size, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '512', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '4:5', exact: true }).click();
  await page.getByRole('button', { name: '4K', exact: true }).click();
  await shot(page, testInfo, 'nano-banana-2-1-settings.png');
  await page.getByRole('button', { name: 'Generation settings', exact: true }).click();

  const prompt = `Nano Banana 2.1 lantern at dusk ${randomUUID().slice(0, 8)}`;
  await page.locator('textarea').first().fill(prompt);
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/generate/image') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBeTruthy();
  const submitted = response.request().postDataJSON();
  expect(submitted).toMatchObject({ model: 'Nano Banana 2.1', aspectRatio: '4:5', resolution: '4K', prompt, projectId: project.id });
  const { id } = await response.json();

  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  try {
    // The worker finishes the job (mock provider); the row keeps the model, size and the 4K estimate.
    await expect.poll(async () => (await db`SELECT status FROM generations WHERE id = ${id}`)[0]?.status, { timeout: 30000 }).toBe('succeeded');
    const [row] = await db`SELECT model, resolution, aspect_ratio, cost_cents, cost_basis, project_id, user_id FROM generations WHERE id = ${id}`;
    expect(row).toEqual({ model: 'Nano Banana 2.1', resolution: '4K', aspect_ratio: '4:5', cost_cents: 12, cost_basis: 'estimated',
      project_id: project.id, user_id: USER_ID });
    // The conversation card shows the stored model and controls with the finished image.
    const image = page.getByRole('img', { name: prompt, exact: true });
    await expect(image).toBeVisible({ timeout: 30000 });
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Proportion 4:5', { exact: true })).toBeVisible();
    await expect(page.getByText('Resolution 4K', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('Nano Banana 2.1', { exact: true }).first()).toBeVisible();
    await page.getByText('Proportion 4:5', { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'nano-banana-2-1-generated-card.png');
  } finally {
    await db`DELETE FROM generations WHERE id = ${id}`;
  }
});
