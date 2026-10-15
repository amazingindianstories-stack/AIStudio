import { test as base, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
const MULTI_SELECT_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

// A plain click on a finished card opens the viewer; selection is explicit
// through the card's Select checkbox, Space or modifier clicks.
const selectCard = (card) => card.getByRole('button', { name: 'Select', exact: true }).click();
const test = base.extend({
  fixture: async ({ page, context, baseURL }, provideFixture) => {
    if (!process.env.AUTH_SECRET || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Isolated browser harness required');
    const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
    const projectId = randomUUID(), folderId = randomUUID(), name = `Readiness ${randomUUID()}`;
    const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
    const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
    await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
    await db`INSERT INTO projects (id,name,created_at,updated_at) VALUES (${projectId},${name},1,1)`;
    const folder = await context.request.post('/api/folders', { headers: { Origin: baseURL }, data: { id: folderId, name: `${name} target`, projectId, idempotencyKey: randomUUID() } });
    expect(folder.ok()).toBeTruthy();
    const actualFolderId = (await folder.json()).folder.id;
    const ids = Array.from({ length: 25 }, () => randomUUID());
    for (const [index, id] of ids.entries()) {
      await db`INSERT INTO generations (id,kind,status,model,prompt,aspect_ratio,url,user_id,project_id,created_at,updated_at)
        SELECT ${id},'image','succeeded','Nano Banana Pro',${`${name} item ${index}`},'3:2',url,${USER_ID},${projectId},${10000 + index},${10000 + index}
        FROM generations WHERE id='10000000-0000-4000-8000-000000000001'`;
    }
    const open = async () => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: /Desktop fixture/ }).first()).toBeVisible();
      const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const panel = page.locator('#desktop-history-panel');
      await panel.getByRole('button', { name: 'Switch workspace' }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
      await expect(panel.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name);
      await expect(panel.locator('[data-asset-card-id]').first()).toBeVisible();
      return panel;
    };
    try { await provideFixture({ db, projectId, folderId: actualFolderId, folderName: `${name} target`, name, ids, open }); }
    finally {
      await db`DELETE FROM generations WHERE project_id=${projectId}`;
      await db`DELETE FROM folders WHERE project_id=${projectId}`;
      await db`DELETE FROM projects WHERE id=${projectId}`;
      await db.end();
    }
  },
});

async function showFolders(panel) {
  const button = panel.getByRole('button', { name: /^Folders \d+$/ });
  if (await button.count() && await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await expect(panel.getByRole('tree', { name: 'Folder Hierarchy', exact: true })).toBeVisible();
}

test('folder palette persists through Django and reload', async ({ page, fixture }, info) => {
  let panel = await fixture.open();
  await showFolders(panel);
  await panel.getByRole('button', { name: `Tree folder actions: ${fixture.folderName}`, exact: true }).click();
  const changed = page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/folders' && r.request().postDataJSON()?.color === 'purple');
  await page.getByRole('button', { name: 'Purple', exact: true }).click();
  expect((await changed).ok()).toBeTruthy();
  expect((await fixture.db`SELECT color FROM folders WHERE id=${fixture.folderId}`)[0].color).toBe('purple');
  panel = await fixture.open();
  await showFolders(panel);
  const row = panel.getByRole('treeitem').filter({ hasText: fixture.folderName });
  await expect(row.locator('svg.text-purple-400')).toBeVisible();
  await info.attach('persisted-purple-folder', { body: await page.screenshot(), contentType: 'image/png' });
});

test('search filters actual Django feed and scrolling requests a cursor page', async ({ page, fixture }) => {
  // The sentinel may prefetch while open() is still awaiting the first card.
  // Capture from before navigation so that real cursor response is retained.
  const pages = [];
  page.on('response', response => { const url = new URL(response.url()); if (url.pathname === '/api/history' && url.searchParams.get('cursor') && response.ok()) pages.push(url); });
  const panel = await fixture.open();
  const cards = panel.locator('[data-asset-card-id]');
  const search = panel.getByRole('textbox', { name: 'Search prompts' });
  await search.fill(`${fixture.name} item 24`);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute('data-asset-card-id', fixture.ids[24]);
  await search.fill('');
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(20);
  for (let attempt = 0; attempt < 12 && await cards.count() < 25; attempt++) {
    const nextPage = page.waitForResponse(response => new URL(response.url()).pathname === '/api/history' && new URL(response.url()).searchParams.has('cursor'), { timeout: 2000 }).catch(() => null);
    await cards.last().scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 1000);
    await nextPage;
  }
  await expect(cards).toHaveCount(25);
  expect(pages.some(url => url.searchParams.get('projectId') === fixture.projectId)).toBeTruthy();
});

test('Alt marquee subtracts intersecting selected cards', async ({ page, fixture }) => {
  const panel = await fixture.open();
  const cards = panel.locator('[data-asset-card-id]');
  await selectCard(cards.first());
  await cards.nth(1).click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await expect(panel.locator('[data-selected="true"]')).toHaveCount(2);
  await cards.first().scrollIntoViewIfNeeded();
  const box = await cards.first().boundingBox();
  // Hit-test actual grid padding: sidebar controls can cover left padding,
  // and the first card's top corner can lie inside the folder/header area.
  const scroller = panel.getByTestId('asset-grid').locator(':scope > div').first();
  const start = await scroller.evaluate((element, cardBox) => {
    const bounds = element.getBoundingClientRect();
    const y = cardBox.y + cardBox.height / 2;
    for (const x of [bounds.right - 8, bounds.right - 4, bounds.left + 12, bounds.left + 8]) {
      const target = document.elementFromPoint(x, y);
      if (element.contains(target) && !target.closest('[data-asset-card-id],button,a,input,select,textarea,[role="menuitem"]')) return { x, y };
    }
    return null;
  }, box);
  expect(start, 'A real unobstructed grid-padding point is required').not.toBeNull();
  const end = { x: box.x + box.width / 2, y: start.y + 8 };
  await page.keyboard.down('Alt');
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await expect(panel.getByTestId('asset-grid-marquee')).toBeVisible();
    await page.mouse.up();
  } finally { await page.keyboard.up('Alt'); }
  await expect(cards.first()).not.toHaveAttribute('data-selected', 'true');
  await expect(cards.nth(1)).toHaveAttribute('data-selected', 'true');
});

test('real pointer multi-asset drag moves both rows and survives reload', async ({ page, fixture }, info) => {
  const panel = await fixture.open();
  await showFolders(panel);
  const cards = panel.locator('[data-asset-card-id]');
  const ids = [await cards.nth(0).getAttribute('data-asset-card-id'), await cards.nth(1).getAttribute('data-asset-card-id')];
  await selectCard(cards.nth(0));
  await cards.nth(1).click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await expect(panel.locator('[data-selected="true"]')).toHaveCount(2);
  await cards.nth(0).dragTo(panel.getByRole('treeitem').filter({ hasText: fixture.folderName }));
  await expect.poll(async () => (await fixture.db`SELECT id FROM generations WHERE id IN ${fixture.db(ids)} AND folder_id=${fixture.folderId}`).length).toBe(2);
  await fixture.open();
  await showFolders(panel);
  await panel.getByRole('treeitem').filter({ hasText: fixture.folderName }).click();
  await expect(cards).toHaveCount(2);
  for (const id of ids) await expect(panel.locator(`[data-asset-card-id="${id}"]`)).toBeVisible();
  await info.attach('pointer-multi-asset-move', { body: await page.screenshot(), contentType: 'image/png' });
});

test('logout menu click clears cookie and rejects subsequent paid admission', async ({ page, context, fixture }) => {
  await fixture.open();
  await page.getByRole('button', { name: /Desktop fixture/ }).first().click();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/logout');
  await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/login/);
  expect((await context.cookies()).some(cookie => cookie.name === 'veevee_session')).toBeFalsy();
  const denied = await context.request.post('/api/generate/video', { data: { prompt: 'must not submit' } });
  expect(denied.status()).toBe(401);
});
