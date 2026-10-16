async function postAsBrowser(api, path, options = {}) {
  return api.post(path, { ...options, headers: { Origin: process.env.E2E_BASE_URL, ...options.headers } });
}
import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

// A finished Seedance 2.5 draft made through the real enqueue route and worker (mock provider).
async function draft(context, prompt) {
  const response = await postAsBrowser(context.request, '/api/generate/video', { data: {
    prompt, model: 'Seedance 2.5', aspectRatio: '16:9', resolution: '480p', duration: 5, draftMode: true,
    generateAudio: false, bitrateMode: 'high', videoTaskMode: 'generate', referenceImages: [], referenceVideos: [], referenceAudios: [] } });
  expect(response.ok()).toBeTruthy();
  const { id } = await response.json();
  await expect.poll(async () => {
    const history = await context.request.get('/api/history?limit=60');
    return (await history.json()).items.find(row => row.id === id)?.status;
  }, { timeout: 30000 }).toBe('succeeded');
  return id;
}

test('Generate 1080p final finalizes the draft on screen, after keyboard navigation and with the dialog open', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  const tag = randomUUID().slice(0, 8);
  const promptA = `Finalize draft A ${tag}`, promptB = `Finalize draft B ${tag}`;
  const a = await draft(context, promptA);
  const b = await draft(context, promptB);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    const panel = page.locator('#desktop-history-panel');
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await panel.getByRole('button', { name: 'Global library', exact: true }).click();
    const searched = page.waitForResponse(response => response.url().includes(`q=${tag}`) && response.url().includes('limit='));
    await panel.getByRole('textbox', { name: 'Search prompts' }).fill(tag);
    await searched;
    await expect(panel.locator(`[data-asset-card-id="${a}"]`)).toBeVisible();
    await expect(panel.locator(`[data-asset-card-id="${b}"]`)).toBeVisible();

    // Open draft A, then move to draft B with the keyboard, as an artist browsing drafts would.
    // Click the picture itself; the lower half of a small card carries the hover folder link and prompt.
    await panel.locator(`[data-asset-card-id="${a}"]`).click({ position: { x: 88, y: 24 } });
    const finalButton = page.getByRole('button', { name: 'Generate 1080p final' });
    const viewer = page.locator('div').filter({ has: page.getByRole('button', { name: 'Close viewer' }) }).filter({ has: finalButton }).last();
    await expect(viewer.getByText(promptA, { exact: true })).toBeVisible();
    for (let step = 0; step < 4 && !(await viewer.getByText(promptB, { exact: true }).isVisible()); step++) await page.keyboard.press('ArrowRight');
    await expect(viewer.getByText(promptB, { exact: true })).toBeVisible();

    // The confirmation does not name the video, so navigation must be frozen while it is open.
    await finalButton.click();
    const confirmation = page.getByRole('alertdialog', { name: 'Generate the 1080p final?' });
    await expect(confirmation).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(viewer.getByText(promptB, { exact: true })).toBeVisible();
    const finalize = page.waitForRequest(request => request.url().endsWith('/api/generate/video/finalize') && request.method() === 'POST');
    await confirmation.getByRole('button', { name: 'Generate final', exact: true }).click();
    expect((await finalize).postDataJSON()).toEqual({ sourceGenerationId: b });

    // Django links the final to exactly that draft and its provider task, and nothing to draft A.
    await expect.poll(async () => (await db`SELECT count(*)::int AS n FROM generations WHERE source_generation_id = ${b}`)[0].n).toBe(1);
    const [{ task_id: draftTask }] = await db`SELECT task_id FROM generations WHERE id = ${b}`;
    const [final] = await db`SELECT prompt, draft_task_id, draft_mode, resolution FROM generations WHERE source_generation_id = ${b}`;
    expect(draftTask).toBeTruthy();
    expect(final).toEqual({ prompt: promptB, draft_task_id: draftTask, draft_mode: false, resolution: '1080p' });
    expect((await db`SELECT count(*)::int AS n FROM generations WHERE source_generation_id = ${a}`)[0].n).toBe(0);
  } finally {
    await db`DELETE FROM generations WHERE source_generation_id IN ${db([a, b])}`;
    await db`DELETE FROM generations WHERE id IN ${db([a, b])}`;
  }
});
