import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

async function login(page, context, baseURL, width) {
  const payload = Buffer.from(JSON.stringify({ uid: 'e33e1832-9e29-427f-af61-796b842a4b37', ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${sig}`, url: baseURL }]);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: width === 390 ? 'D' : /Desktop fixture/, exact: width === 390 })).toBeVisible();
}
async function contained(locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
  })).toBeTruthy();
}
async function noPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
}
async function separate(a, b) {
  const x = await a.boundingBox(), y = await b.boundingBox();
  expect(x.x + x.width <= y.x + 1 || y.x + y.width <= x.x + 1 || x.y + x.height <= y.y + 1 || y.y + y.height <= x.y + 1).toBeTruthy();
}
for (const width of [390, 1440]) {
  test(`Phone layouts lightbox ${width}`, async ({ page, context, baseURL }, info) => {
    await login(page, context, baseURL, width);
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Image', exact: true }).click();
    const image = await context.request.get('/api/generations/10000000-0000-4000-8000-000000000001/download');
    await page.locator('input[type=file][multiple][accept="image/*,video/*,audio/*"]').setInputFiles({ name: 'Long composer reference filename for phone preview.png', mimeType: 'image/png', buffer: await image.body() });
    await page.locator('[data-reference-preview]').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath('lightbox.png') });
    const title = dialog.locator('h3');
    expect((await title.boundingBox()).width).toBeGreaterThan(100);
    await contained(dialog.locator('header'));
    await noPageOverflow(page);
    const actions = await dialog.locator('header button:visible').all();
    for (let i = 0; i < actions.length; i++) for (let j = i + 1; j < actions.length; j++) await separate(actions[i], actions[j]);
    for (const button of [dialog.getByRole('button', { name: /Insert/ }), dialog.getByRole('button', { name: 'Zoom in', exact: true }), dialog.getByRole('button', { name: 'Close Lightbox' })]) {
      await contained(button); await separate(title, button);
    }
  });
  test(`Phone layouts library ${width}`, async ({ page, context, baseURL }, info) => {
    await login(page, context, baseURL, width);
    if (width === 390) await page.getByRole('button', { name: 'Open assets panel', exact: true }).click();
    else {
      const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    }
    const panel = page.locator('.history-panel:visible');
    const navToggle = panel.getByRole('button', { name: 'Show folders', exact: true });
    if (width === 390 && await navToggle.count()) await navToggle.click();
    await panel.getByRole('button', { name: 'All assets', exact: true }).click();
    if (width === 390 && await panel.getByRole('button', { name: 'Hide folders', exact: true }).count()) await panel.getByRole('button', { name: 'Hide folders', exact: true }).click();
    const search = panel.getByRole('textbox', { name: 'Search prompts' });
    await search.fill('Desktop fixture');
    await page.screenshot({ path: info.outputPath('library.png') });
    expect((await search.boundingBox()).width).toBeGreaterThan(width === 390 ? 180 : 100);
    await contained(panel.locator('main'));
    const view = panel.getByRole('button', { name: 'View settings' });
    await contained(view); await separate(search, view);
    await contained(panel.getByRole('button', { name: 'Filter by type' }));
    await noPageOverflow(page);
    await view.click();
    await expect(page.getByText('Thumbnail Size', { exact: true })).toBeVisible();
    await view.click();
    await expect(page.getByText('Thumbnail Size', { exact: true })).toBeHidden();
    if (width === 390) {
      await navToggle.click();
      await expect(panel.getByRole('button', { name: 'All assets', exact: true })).toBeVisible();
      await contained(panel.locator('aside'));
      const switcher = panel.getByRole('button', { name: 'Switch workspace' });
      expect(Math.abs((await switcher.boundingBox()).width - (await panel.locator('aside').boundingBox()).width)).toBeLessThan(2);
      await page.screenshot({ path: info.outputPath('library-folders.png') });
      await panel.getByRole('button', { name: 'Hide folders', exact: true }).press('Escape');
      await expect(panel.getByRole('button', { name: 'Show folders', exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Close assets panel' })).toBeVisible();
      await expect(search).toBeVisible();
    }
  });
  test(`Phone layouts admin errors ${width}`, async ({ page, context, baseURL }, info) => {
    await login(page, context, baseURL, width);
    await page.route('**/api/admin/errors?*', route => route.fulfill({ json: { rows: [{ id: 'phone-error', userEmail: 'artist@example.test', model: 'Seedance 2.5', provider: 'seedance', createdAt: 1792600000000, code: 'InputAudioSensitiveContentDetected', message: 'The provider rejected the supplied audio. Please choose another reference.', requestId: 'request-012345678901234567890123456789', records: [] }], total: 1, nextCursor: null, models: ['Seedance 2.5'], providers: ['seedance'] } }));
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Errors', exact: true }).click();
    await expect(page.getByText('Showing 1 of 1 errors')).toBeVisible();
    await page.screenshot({ path: info.outputPath('admin-errors.png') });
    const copy = page.getByRole('button', { name: 'Copy support details', exact: true }).filter({ visible: true });
    await contained(copy);
    await copy.click();
    await expect(copy).toHaveText('Copied');
    const code = page.getByText('InputAudioSensitiveContentDetected', { exact: true }).filter({ visible: true });
    await contained(code); await separate(code, copy);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByRole('button', { name: 'Show error details' }).filter({ visible: true }).click();
    await expect(page.getByText('No raw provider response was stored for this error.').filter({ visible: true })).toBeVisible();
  });
}
