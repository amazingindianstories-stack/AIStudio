import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

async function login(page, context, baseURL, width, height = width === 390 ? 844 : 1000) {
  const payload = Buffer.from(JSON.stringify({ uid: 'e33e1832-9e29-427f-af61-796b842a4b37', ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${sig}`, url: baseURL }]);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.getByRole('button', { name: width < 768 ? 'D' : /Desktop fixture/, exact: width < 768 })).toBeVisible();
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
  test(`Phone layouts admin errors ${width}`, async ({ page, context, baseURL }, info) => {
    await login(page, context, baseURL, width);
    await page.route('**/api/admin/errors?*', route => route.fulfill({ json: { rows: [{ id: 'phone-error', userEmail: 'artist@example.test', model: 'Seedance 2.5', provider: 'seedance', createdAt: 1792600000000, code: 'InputAudioSensitiveContentDetected', message: 'The provider rejected the supplied audio. Please choose another reference.', requestId: 'request-012345678901234567890123456789', records: [] }], total: 1, nextCursor: null, models: ['Seedance 2.5'], providers: ['seedance'] } }));
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Errors', exact: true }).click();
    await expect(page.getByText('Showing 1 of 1 errors')).toBeVisible();
    await page.screenshot({ path: info.outputPath('admin-errors.png') });
    const frame = page.locator('table').filter({ visible: true }).locator('..');
    expect(await frame.evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe(width === 390 ? '0px' : '1px');
    const copy = page.getByRole('button', { name: 'Copy support details', exact: true }).filter({ visible: true });
    await contained(copy);
    await copy.click();
    await expect(copy).toHaveText('Copied');
    const code = page.getByText('InputAudioSensitiveContentDetected', { exact: true }).filter({ visible: true });
    await contained(code); await separate(code, copy);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByRole('button', { name: 'Show error details' }).filter({ visible: true }).click();
    await expect(page.getByText('No raw provider response was stored for this error.').filter({ visible: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('admin-errors-detail.png') });
    const [card, detail] = await Promise.all([0, 1].map(i => page.locator('tbody > tr:visible').nth(i).boundingBox()));
    expect(Math.abs(card.y + card.height - detail.y)).toBeLessThan(1);
    expect(Math.abs(card.x - detail.x) + Math.abs(card.width - detail.width)).toBeLessThan(1);
    await noPageOverflow(page);
  });
}
for (const [width, height] of [[390, 844], [844, 390], [768, 1024], [1440, 1000]]) {
  test(`Phone layouts library ${width}x${height}`, async ({ page, context, baseURL }, info) => {
    await login(page, context, baseURL, width, height);
    const drawer = width < 1024;
    if (drawer) await page.getByRole('button', { name: 'Open assets panel', exact: true }).click();
    else {
      const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    }
    const panel = page.locator('.history-panel:visible');
    const navToggle = panel.getByRole('button', { name: 'Folders', exact: true });
    const allAssets = panel.getByRole('button', { name: 'All assets', exact: true });
    if (drawer) {
      await expect(allAssets).toBeHidden();
      await navToggle.click();
      await allAssets.click();
      await expect(allAssets).toBeHidden();
      await expect(navToggle).toBeFocused();
    } else {
      await expect(navToggle).toBeHidden();
      await allAssets.click();
      await expect(allAssets).toBeVisible();
    }
    const search = panel.getByRole('textbox', { name: 'Search prompts' });
    await search.fill('Desktop fixture');
    await page.screenshot({ path: info.outputPath('library.png') });
    expect((await search.boundingBox()).width).toBeGreaterThan(drawer ? 180 : 100);
    await contained(panel.locator('main'));
    const view = panel.getByRole('button', { name: 'View settings' });
    await contained(view); await separate(search, view);
    await contained(panel.getByRole('button', { name: 'Filter by type' }));
    await noPageOverflow(page);
    await view.click();
    await expect(page.getByText('Thumbnail Size', { exact: true })).toBeVisible();
    await view.click();
    await expect(page.getByText('Thumbnail Size', { exact: true })).toBeHidden();
    const card = panel.locator('[data-asset-card-id]').first();
    const select = card.getByRole('checkbox', { name: 'Select' });
    await card.scrollIntoViewIfNeeded();
    const before = await card.boundingBox();
    await select.click();
    await expect(panel.getByTestId('selection-toolbar')).toBeVisible();
    expect((await card.boundingBox()).y).toBe(before.y);
    await select.click();
    await expect(search).toBeVisible();
    expect((await card.boundingBox()).y).toBe(before.y);
    if (drawer) {
      await navToggle.click();
      await expect(allAssets).toBeVisible();
      await expect(search).toBeHidden();
      await contained(panel.locator('aside'));
      const switcher = panel.getByRole('button', { name: 'Switch workspace' });
      expect(Math.abs((await switcher.boundingBox()).width - (await panel.locator('aside').boundingBox()).width)).toBeLessThan(2);
      await page.screenshot({ path: info.outputPath('library-folders.png') });
      const close = page.getByRole('button', { name: 'Close assets panel' });
      const unsorted = panel.getByRole('button', { name: / Unsorted$/ });
      await unsorted.focus();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(unsorted).toBeFocused();
      const menu = page.getByRole('menu');
      for (const target of [switcher, menu.getByRole('textbox', { name: 'Search projects' })]) {
        await switcher.click();
        await target.focus();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(switcher).toBeFocused();
        await expect(allAssets).toBeVisible();
        await expect(page.getByRole('button', { name: 'Close assets panel' })).toBeVisible();
      }
      await panel.getByRole('button', { name: 'Back to assets', exact: true }).press('Escape');
      await expect(navToggle).toBeFocused();
      await expect(page.getByRole('button', { name: 'Close assets panel' })).toBeVisible();
      await expect(search).toBeVisible();
      for (const shortcut of ['/', 'ControlOrMeta+f']) {
        await navToggle.click();
        await expect(allAssets).toBeVisible();
        await page.keyboard.press(shortcut);
        await expect(search).toBeFocused();
        await expect(allAssets).toBeHidden();
      }
    }
  });
}
for (const width of [390, 768, 1024, 1280]) {
  test(`Phone layouts header ${width}`, async ({ page, context, baseURL }, info) => {
    await login(page, context, baseURL, width);
    await page.screenshot({ path: info.outputPath('header.png'), clip: { x: 0, y: 0, width, height: 56 } });
    const nav = page.getByRole('navigation', { name: 'Sections' });
    expect(await nav.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await noPageOverflow(page);
    const account = page.getByRole('button', { name: width < 768 ? 'D' : /Desktop fixture/, exact: width < 768 });
    const controls = [account, ...(width < 1024 ? [page.getByRole('button', { name: 'Open assets panel', exact: true })] : [])];
    for (const section of await nav.getByRole('button').all()) {
      await contained(section);
      for (const control of controls) await separate(section, control);
    }
    for (const label of ['Image', 'Video', 'Board', 'Audio', 'Agents']) {
      const text = nav.getByText(label, { exact: true });
      if (width >= 1024) await expect(text).toBeVisible();
      else await expect(text).toBeHidden();
    }
  });
}
for (const role of ['admin', 'user']) {
  test(`Phone layouts header labels never overflow as a ${role}`, async ({ page, context, baseURL }) => {
    if (role === 'user') await page.route('**/api/auth/me', async route => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, user: { ...body.user, role, name: 'Desktop fixture with a long display name' } } });
    });
    await login(page, context, baseURL, 1280);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByText('Agents', { exact: true })).toBeVisible();
    if (role === 'user') await expect(nav.locator('[aria-disabled="true"]')).toBeVisible();
    for (let width = 960; width <= 1200; width += 3) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await nav.evaluate(el => {
        const controls = el.nextElementSibling.getBoundingClientRect().left;
        const labels = [...el.querySelectorAll('.topbar-label')].map(label => label.getBoundingClientRect().width > 0);
        return {
          fits: el.scrollWidth <= el.clientWidth && [...el.children].every(item => item.getBoundingClientRect().right <= controls - 8),
          labels: new Set(labels).size === 1 ? labels[0] : 'mixed',
        };
      });
      expect(layout, `${width}px`).toEqual({ fits: true, labels: width === 1200 || (role === 'admin' && width >= 1024) ? true : expect.any(Boolean) });
    }
  });
}
