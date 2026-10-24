import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// A long permanent name truncates only its folder-ancestry stem: the trailing sequence that tells
// generations apart stays fully visible on library cards and on main chat cards.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

test('a long generation name keeps its whole sequence visible on the library card and the main chat card', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const tag = `Names${randomUUID().slice(0, 8)}`;
  const projectResponse = await context.request.post('/api/projects', { headers: { Origin: baseURL }, data: { op: 'createProject', name: tag } });
  expect(projectResponse.ok()).toBeTruthy();
  const { project } = await projectResponse.json();
  const id = randomUUID();
  const stem = `${tag}_${'Very_Long_Folder_Ancestry_'.repeat(6)}Shot`;
  const now = Date.now();
  await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, permanent_name, created_at, updated_at)
    VALUES (${id}, 'image', 'succeeded', 'Nano Banana Pro', ${`${tag} prompt`}, '1:1', ${`/api/media/generations/${id}.png`},
      ${USER_ID}, ${project.id}, ${`${stem}_0007`}, ${now}, ${now})`;
  await page.addInitScript((projectId) => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
  }, project.id);
  try {
    await page.goto('/');
    const panel = page.locator('#desktop-history-panel');
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await panel.getByRole('button', { name: /Unsorted$/ }).first().click();
    const library = panel.locator(`[data-asset-card-id="${id}"]`);
    const chat = page.locator(`[data-generation-id="${id}"]`);
    for (const card of [library, chat]) {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      const name = card.locator('[data-generation-name]');
      await expect(name).toHaveAttribute('title', new RegExp(`^${stem}_0007\\.\\w+$`));
      const stemPart = name.locator('span').first();
      const sequence = name.locator('span').last();
      await expect(stemPart).toHaveText(stem);
      await expect(sequence).toHaveText('_0007');
      expect(await stemPart.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      const digits = await sequence.boundingBox();
      for (const container of [await name.boundingBox(), await card.boundingBox()]) {
        expect(digits.x).toBeGreaterThanOrEqual(container.x);
        expect(digits.y).toBeGreaterThanOrEqual(container.y);
        expect(digits.x + digits.width).toBeLessThanOrEqual(container.x + container.width + 0.5);
        expect(digits.y + digits.height).toBeLessThanOrEqual(container.y + container.height + 0.5);
      }
      // Nothing clips or covers the last digit.
      expect(await sequence.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.right - 1, box.top + box.height / 2));
      })).toBe(true);
    }
  } finally {
    await db`DELETE FROM generations WHERE project_id = ${project.id}`;
    await db`DELETE FROM projects WHERE id = ${project.id}`;
  }
});
