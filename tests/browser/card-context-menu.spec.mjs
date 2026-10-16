import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Library cards carry only the creator avatar, "Draft" on drafts, and a hover
// checkbox and "..." button; details and actions live in the card's menu.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}
const post = (api, path, data) => api.post(path, { data, headers: { Origin: process.env.E2E_BASE_URL } });

// Finished generations made through the real enqueue routes and worker (mock provider).
async function generate(context, kind, body) {
  const response = await post(context.request, `/api/generate/${kind}`, body);
  expect(response.ok(), await response.text()).toBeTruthy();
  const { id } = await response.json();
  await expect.poll(async () => {
    const history = await context.request.get('/api/history?limit=60');
    return (await history.json()).items.find(row => row.id === id)?.status;
  }, { timeout: 30000 }).toBe('succeeded');
  return id;
}

const test2 = test.extend({
  library: async ({ page, context, baseURL }, provide) => {
    await authenticate(context, baseURL);
    const tag = `Menu${randomUUID().slice(0, 8)}`;
    const draft = await generate(context, 'video', {
      prompt: `Lighthouse draft ${tag}`, model: 'Seedance 2.5', aspectRatio: '16:9', resolution: '480p', duration: 5, draftMode: true,
      generateAudio: false, bitrateMode: 'high', videoTaskMode: 'generate', referenceImages: [], referenceVideos: [], referenceAudios: [] });
    const image = await generate(context, 'image', { prompt: `Square portrait ${tag}`, model: 'Nano Banana Pro', aspectRatio: '1:1' });
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
      const draftCard = panel.locator(`[data-asset-card-id="${draft}"]`);
      const imageCard = panel.locator(`[data-asset-card-id="${image}"]`);
      await expect(draftCard).toBeVisible();
      await expect(imageCard).toBeVisible();
      await provide({ panel, draft, image, draftCard, imageCard, tag, db });
    } finally {
      await db`DELETE FROM generations WHERE id IN ${db([draft, image])} OR source_generation_id IN ${db([draft, image])}`;
    }
  },
});

const menu = (page) => page.getByRole('menu', { name: 'Generation actions' });
const popup = (page) => page.locator('[data-card-context-menu]');

async function insideViewport(page) {
  const box = await popup(page).boundingBox();
  const { width, height } = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  return box;
}

test2('card context: the card face is only the avatar, Draft, and the hover checkbox and "..." button', async ({ page, library }) => {
  const { draftCard, imageCard } = library;
  await page.mouse.move(2, 2);
  for (const card of [draftCard, imageCard]) {
    await expect(card.locator('.media-card-avatar')).toBeVisible();
    await expect(card.getByRole('checkbox', { name: 'Select' })).toHaveCSS('opacity', '0');
    await expect(card.getByRole('button', { name: 'More actions' })).toHaveCSS('opacity', '0');
    await expect(card.locator('time')).toHaveCount(0);
  }
  await expect(draftCard.locator('[data-draft-label]')).toHaveText('Draft');
  await expect(draftCard.locator('[data-draft-label]')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(imageCard.locator('[data-draft-label]')).toHaveCount(0);
  // Besides media-state content (an undecodable mock master reads "Preview unavailable" under its poster).
  expect((await draftCard.innerText()).trim()).toMatch(/^(Preview unavailable\. Open to download the original\.\s*)?Draft\s*D$/);
  expect((await imageCard.innerText()).trim()).toBe('D');

  await imageCard.hover();
  await expect(imageCard.getByRole('checkbox', { name: 'Select' })).toHaveCSS('opacity', '1');
  await expect(imageCard.getByRole('button', { name: 'More actions' })).toHaveCSS('opacity', '1');
  // No hover pane, toolbar, prompt or folder link appears any more.
  await expect(page.getByRole('toolbar')).toHaveCount(0);
  await expect(imageCard.getByRole('button')).toHaveCount(1);
  expect(await imageCard.getByRole('button').getAttribute('aria-label')).toBe('More actions');
  await expect(imageCard.getByText(library.tag)).toHaveCount(0);

  // The checkbox selects and stays visible while selected.
  await imageCard.getByRole('checkbox', { name: 'Select' }).click();
  await expect(imageCard).toHaveAttribute('data-selected', 'true');
  await page.mouse.move(2, 2);
  await expect(imageCard.getByRole('checkbox', { name: 'Select' })).toHaveCSS('opacity', '1');
  await expect(imageCard.getByRole('checkbox', { name: 'Select' })).toHaveAttribute('aria-checked', 'true');
});

test2('card context: right click opens the menu at the pointer with the generation details', async ({ page, library }) => {
  const box = await library.draftCard.boundingBox();
  const x = box.x + 30, y = box.y + 20;
  await page.mouse.click(x, y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
  const placed = await insideViewport(page);
  // Opened at the pointer, or flipped to its left when the panel edge is near.
  expect(Math.abs(placed.y - y) < 2 || Math.abs(placed.y + placed.height - y) < 2 || placed.y + placed.height >= page.viewportSize().height - 9).toBeTruthy();
  expect(Math.abs(placed.x - x) < 2 || Math.abs(placed.x + placed.width - x) < 2).toBeTruthy();

  const details = popup(page).getByRole('region', { name: 'Generation details' });
  await expect(details.locator('[data-detail="creator"]')).toHaveText('Desktop fixture');
  await expect(details).toContainText('desktop-browser@example.test');
  await expect(details.locator('[data-detail="model"]')).toHaveText(/^Seedance 2\.5\s*Draft$/);
  await expect(details.locator('[data-detail="output"]')).toHaveText('480p · 16:9 · 5s');
  await expect(details.locator('[data-detail="cost"]')).toHaveText(/^≈?\$\d+\.\d{2}$/);
  await expect(details.locator('[data-detail="generated"] time')).toHaveAttribute('datetime', /T.*Z$/);
  await expect(details.locator('[data-detail="took"]')).toHaveText(/^\d+(s|m( \d{2}s)?)$/);

  const names = await menu(page).getByRole('menuitem').evaluateAll(items => items.map(item => item.dataset.menuItem));
  expect(names).toEqual(['retry', 'edit', 'finalize', 'open', 'download', 'favorite', 'folder', 'select', 'delete']);

  // Opening another card's menu replaces this one; only one is ever open.
  await library.imageCard.focus();
  await page.keyboard.press('Shift+F10');
  await expect(popup(page)).toHaveCount(1);
  await expect(popup(page).locator('[data-detail="model"]')).toHaveText('Nano Banana Pro');
  // Outside click closes.
  await page.mouse.click(5, 300);
  await expect(popup(page)).toHaveCount(0);
});

test2('card context: the menu flips to stay inside the viewport at the right and bottom edges', async ({ page, library }) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  const card = library.imageCard;
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  const x = Math.min(box.x + box.width - 4, 1436), y = Math.min(box.y + box.height - 4, 636);
  await page.mouse.click(x, y, { button: 'right' });
  const placed = await insideViewport(page);
  expect(placed.x + placed.width).toBeLessThanOrEqual(x + 1);
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
});

test2('card context: Download asks for confirmation, then downloads the original', async ({ page, context, library }) => {
  const history = await (await context.request.get('/api/history?limit=60')).json();
  const { filename } = history.items.find(row => row.id === library.draft);
  expect(filename).toBeTruthy();
  await library.draftCard.click({ button: 'right' });
  const item = menu(page).getByRole('menuitem', { name: /^Download/ });
  await expect(item).toContainText(filename.split('.').pop().toUpperCase());
  await item.click();
  await expect(popup(page)).toHaveCount(0);
  const dialog = page.getByRole('alertdialog', { name: 'Download the original?' });
  await expect(dialog).toBeVisible();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  // The frozen library filename and the original's native container (MOV is covered by the django spec).
  expect(download.suggestedFilename()).toBe(filename);
});

test2('card context: Edit & retry fills the composer without generating', async ({ page, library }) => {
  let submissions = 0;
  page.on('request', request => { if (/\/api\/generate\/(video|image)$/.test(new URL(request.url()).pathname) && request.method() === 'POST') submissions++; });
  await library.imageCard.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Edit & retry' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Edit and retry?' });
  await dialog.getByRole('button', { name: 'Load into composer', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('textarea').first()).toHaveValue(`Square portrait ${library.tag}`);
  expect(submissions).toBe(0);
});

test2('card context: Shift+F10 opens it from the keyboard, arrows move, Escape returns focus to the card', async ({ page, library }) => {
  const card = library.imageCard;
  await card.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  const focusedItem = () => page.evaluate(() => document.activeElement?.dataset?.menuItem ?? null);
  await expect.poll(focusedItem).toBe('retry');
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedItem).toBe('edit');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(focusedItem).toBe('delete');
  await page.keyboard.press('Home');
  await expect.poll(focusedItem).toBe('retry');
  // The grid's own arrow/Space handling does not see keys meant for the menu.
  await page.keyboard.press('End');
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
  await expect(card).toBeFocused();
  // Escape closed only the menu; the library and its selection are untouched.
  await expect(library.panel).toBeVisible();

  // The "..." button is a real menu button and the menu anchors to it.
  await card.hover();
  const more = card.getByRole('button', { name: 'More actions' });
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const anchor = await more.boundingBox();
  const placed = await insideViewport(page);
  expect(placed.y >= anchor.y + anchor.height || placed.y + placed.height <= anchor.y).toBeTruthy();
  await more.click();
  await expect(popup(page)).toHaveCount(0);

  // Select in the menu selects the card.
  await card.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Select' }).click();
  await expect(card).toHaveAttribute('data-selected', 'true');
});

test2('card context: Open details opens the viewer and Favourite confirms', async ({ page, library }) => {
  await library.imageCard.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Favourite' }).click();
  await page.getByRole('alertdialog', { name: 'Add to favourites?' }).getByRole('button', { name: 'Add to favourites' }).click();
  await expect.poll(async () => (await library.db`SELECT is_favorite FROM generations WHERE id=${library.image}`)[0].is_favorite).toBe(true);
  await library.imageCard.click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem', { name: 'Unfavourite' })).toBeVisible();
  await menu(page).getByRole('menuitem', { name: 'Open details' }).click();
  await expect(page.getByRole('button', { name: 'Close viewer' })).toBeVisible();
});

test.describe('card context on touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('card context: a long press opens the menu inside the mobile viewport and the tap does not open the viewer', async ({ page, context, baseURL }) => {
    await authenticate(context, baseURL);
    const tag = `Touch${randomUUID().slice(0, 8)}`;
    const id = await generate(context, 'image', { prompt: `Touch square ${tag}`, model: 'Nano Banana Pro', aspectRatio: '1:1' });
    const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
    try {
      await page.goto('/');
      await page.locator('button[aria-controls="mobile-history-panel"]').click();
      const panel = page.locator('#mobile-history-panel');
      await panel.getByRole('button', { name: 'Global library', exact: true }).click();
      const searched = page.waitForResponse(response => response.url().includes(`q=${tag}`) && response.url().includes('limit='));
      await panel.getByRole('textbox', { name: 'Search prompts' }).fill(tag);
      await searched;
      const card = panel.locator(`[data-asset-card-id="${id}"]`);
      await expect(card).toBeVisible();
      // Touch devices cannot hover, so the "..." button is always shown there.
      await expect(card.getByRole('button', { name: 'More actions' })).toHaveCSS('opacity', '1');
      const box = await card.boundingBox();
      const cdp = await context.newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(menu(page)).toBeVisible();
      await insideViewport(page);
      await expect(page.getByRole('button', { name: 'Close viewer' })).toHaveCount(0);
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(popup(page)).toHaveCount(0);
      // Escape on the menu does not also close the drawer.
      await expect(panel).toBeVisible();
    } finally {
      await db`DELETE FROM generations WHERE id=${id}`;
    }
  });
});
