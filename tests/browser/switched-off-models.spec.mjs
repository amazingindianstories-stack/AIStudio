import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// The harness runs Django with VEEVEE_KLING off and Gemini Omni and Magnific upscaling on (production on 2026-10-20).
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
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId, mode: 'image', model: 'Kling Image 3.0' }));
  }, project.id);
  return project;
}

test('switched-off Kling leaves the pickers, while its history still shows and Clone & try says what it uses instead', async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const me = await (await context.request.get('/api/auth/me')).json();
  expect(me.availability.models).toContain('gemini-omni-1-1-flash');
  expect(me.availability.models).toContain('magnific-creative');
  expect(me.availability.models.filter(id => id.startsWith('kling'))).toEqual([]);

  const project = await freshProject(context, page, 'Switched-off models');
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const id = randomUUID();
  const prompt = `Kling history lantern ${id.slice(0, 8)}`;
  const [fixture] = await db`SELECT url FROM generations WHERE id = '10000000-0000-4000-8000-000000000000'`;
  const now = Date.now();
  await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, resolution, url, user_id, project_id, cost_cents, created_at, updated_at)
           VALUES (${id}, 'image', 'succeeded', 'Kling Image 3.0', ${prompt}, '3:2', '2K', ${fixture.url}, ${USER_ID}, ${project.id}, 1, ${now}, ${now})`;
  try {
    // The saved composer pointed at Kling Image 3.0; it opens on the image default instead, with no error.
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    const picker = page.getByRole('button', { name: /^Model:/ });
    await expect(picker).toContainText('Nano Banana Pro');
    await picker.click();
    // The menu renders after the click; snapshot its items only once it is open.
    await expect(page.getByRole('menuitem', { name: /^Nano Banana Pro/ })).toBeVisible();
    const images = await page.getByRole('menuitem').allInnerTexts();
    expect(images.some(text => text.startsWith('Nano Banana Pro'))).toBeTruthy();
    expect(images.filter(text => /Kling/.test(text))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('image-picker-without-kling.png') });
    await page.keyboard.press('Escape');

    // Switched-on features stay: Gemini Omni Flash 1.1 in the video picker, Upscale in the sections.
    const sections = page.getByRole('navigation', { name: 'Sections' });
    await expect(sections.getByRole('button', { name: 'Upscale', exact: true })).toBeVisible();
    await sections.getByRole('button', { name: 'Video', exact: true }).click();
    await picker.click();
    await expect(page.getByRole('menuitem', { name: /^Gemini Omni Flash 1\.1(?:\s|$)/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // The Kling row reads normally in the project thread, model label included.
    const image = page.getByRole('img', { name: prompt, exact: true });
    await expect(image).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('main').getByText('Kling Image 3.0', { exact: true }).first()).toBeVisible();

    await image.hover();
    await page.getByRole('main').getByRole('button', { name: 'Edit in composer', exact: true }).first().click();
    await page.getByRole('button', { name: 'Replace composer', exact: true }).click();
    await expect(page.getByText("Kling Image 3.0 isn't available right now. Using Nano Banana Pro instead.", { exact: true })).toBeVisible();
    await expect(picker).toContainText('Nano Banana Pro');
    await expect(page.locator('textarea').first()).toHaveValue(prompt);
    await page.screenshot({ path: testInfo.outputPath('clone-switched-off-notice.png') });
  } finally {
    await db`DELETE FROM generations WHERE id = ${id}`;
  }
});
