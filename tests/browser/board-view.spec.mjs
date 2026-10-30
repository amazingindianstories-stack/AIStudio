import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Two ordinary fixture users: the board owner and a teammate who opens the board for the first time.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000061', name: 'View owner', email: 'view-owner@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000062', name: 'View teammate', email: 'view-teammate@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function seedUsers() {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, MATE].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  return { context, page: await context.newPage() };
}

async function openBoard(page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());
const near = (a, b) => Math.abs(a - b) <= 1;
const zoomLabel = (page) => page.getByRole('group', { name: 'Zoom' }).getByRole('button', { name: /^\d+%$/ });
const zoomPercent = async (page) => Number((await zoomLabel(page).innerText()).replace(/\D/g, ''));
const boxOf = async (locator) => {
  const box = await locator.boundingBox();
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
};

/** A two-finger trackpad scroll as Chrome and Safari on macOS report it. */
function trackpadScroll(canvas, point, deltaX, deltaY) {
  return canvas.evaluate((element, { point, deltaX, deltaY }) => {
    const box = element.getBoundingClientRect();
    const event = new WheelEvent('wheel', { deltaX, deltaY, deltaMode: 0, clientX: box.left + point.x, clientY: box.top + point.y,
      bubbles: true, cancelable: true });
    Object.defineProperty(event, 'wheelDeltaX', { value: -3 * deltaX });
    Object.defineProperty(event, 'wheelDeltaY', { value: -3 * deltaY });
    element.dispatchEvent(event);
  }, { point, deltaX, deltaY });
}

async function openViewMenu(page) {
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  // The zoom menu may still be fading out, so pick the View menu by its content.
  const menu = page.getByRole('menu').filter({ hasText: 'Wheel and trackpad' });
  await expect(menu).toBeVisible();
  return menu;
}

async function choose(page, role, name) {
  const menu = await openViewMenu(page);
  await menu.getByRole(role, { name, exact: true }).click();
  if (await menu.isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Nothing in `root` spills outside the viewport or its own box. */
async function pixelClean(page, root) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const overflowing = await root.evaluate((element) => [...element.querySelectorAll('*')].filter((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden') return false;
    return box.left < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5 || box.top < -0.5;
  }).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`));
  expect(overflowing).toEqual([]);
}

test('Board view: zoom to 2000%, wheel modes, grid, minimap, scroll bars, dimensions, background, full screen and start view', async ({ browser, baseURL }, info) => {
  test.setTimeout(150000);
  await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board view ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const page = owner.page;
  const canvas = await openBoard(page);
  const placed = page.waitForResponse(isSave);
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await canvas.click({ position: { x: 500, y: 400 } });
  const boardPath = new URL((await placed).url()).pathname;
  await page.keyboard.press('Escape');
  const boardData = async () => (await (await page.request.get(boardPath)).json()).data;
  await expect.poll(async () => (await boardData()).nodes.length).toBe(1);
  const [stickyData] = (await boardData()).nodes;
  const sticky = page.locator(`[data-node-id="${stickyData.id}"]`);
  await expect(sticky).toBeVisible();
  await page.evaluate(() => document.activeElement?.blur());
  expect(await zoomPercent(page)).toBe(100);

  // Keyboard zoom: Cmd/Ctrl + plus reaches 2000% and stops there; minus and the zoom menu work across the range.
  for (let step = 0; step < 20; step += 1) await page.keyboard.press('ControlOrMeta+Equal');
  await expect(zoomLabel(page)).toHaveText('2000%');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(zoomLabel(page)).toHaveText('2000%');
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect.poll(() => zoomPercent(page)).toBe(1667);
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom in/ }).click();
  await expect(zoomLabel(page)).toHaveText('2000%');
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();
  await expect(zoomLabel(page)).toHaveText('100%');
  // Zooming steps keep the view centre: back at 100% the sticky is where it was.
  await page.keyboard.press('ControlOrMeta+Equal');
  await page.keyboard.press('ControlOrMeta+Minus');
  let home = await boxOf(sticky);

  // Auto mode: a mouse wheel notch zooms. Chromium reports scripted wheels as notches (wheelDeltaY of 120).
  await page.mouse.move(720, 450);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(100);
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();
  await expect(zoomLabel(page)).toHaveText('100%');
  home = await boxOf(sticky);
  // A two-finger trackpad scroll (Chrome and Safari report wheelDeltaY = -3 x deltaY) pans.
  await trackpadScroll(canvas, { x: 720, y: 450 }, 0, 100);
  await expect.poll(async () => near((await boxOf(sticky)).y, home.y - 100)).toBe(true);
  expect(await zoomPercent(page)).toBe(100);
  await trackpadScroll(canvas, { x: 720, y: 450 }, 0, -100);
  await expect.poll(async () => near((await boxOf(sticky)).y, home.y)).toBe(true);
  // Ctrl + wheel, as a trackpad pinch sends, zooms.
  await page.mouse.move(720, 450);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(100);
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();
  await expect(zoomLabel(page)).toHaveText('100%');

  // Mouse mode: the wheel zooms about the cursor; Shift + wheel pans sideways.
  await choose(page, 'menuitemradio', 'Mouse');
  const stickyCentre = await boxOf(sticky);
  const pointer = { x: stickyCentre.x + stickyCentre.w / 2, y: stickyCentre.y + stickyCentre.h / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(100);
  const zoomedIn = await boxOf(sticky);
  expect(Math.abs(zoomedIn.x + zoomedIn.w / 2 - pointer.x)).toBeLessThan(2);
  expect(Math.abs(zoomedIn.y + zoomedIn.h / 2 - pointer.y)).toBeLessThan(2);
  const zoomBeforeShift = await zoomPercent(page);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 150);
  await page.keyboard.up('Shift');
  await expect.poll(async () => near((await boxOf(sticky)).x, zoomedIn.x - 150)).toBe(true);
  expect(near((await boxOf(sticky)).y, zoomedIn.y)).toBe(true);
  expect(await zoomPercent(page)).toBe(zoomBeforeShift);

  // Trackpad mode: two-finger scroll pans in both directions.
  await choose(page, 'menuitemradio', 'Trackpad');
  const beforePan = await boxOf(sticky);
  await page.mouse.move(720, 450);
  await page.mouse.wheel(40, 60);
  await expect.poll(async () => near((await boxOf(sticky)).y, beforePan.y - 60)).toBe(true);
  expect(near((await boxOf(sticky)).x, beforePan.x - 40)).toBe(true);
  expect(await zoomPercent(page)).toBe(zoomBeforeShift);
  await choose(page, 'menuitemradio', 'Auto');
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();
  await page.evaluate(() => document.activeElement?.blur());

  // Grid: G cycles dots, lines, none; the View menu shows the choice; the grid scales with zoom.
  const surfaceStyle = () => canvas.evaluate((element) => ({
    image: element.style.backgroundImage, size: element.style.backgroundSize, color: getComputedStyle(element).backgroundColor }));
  expect((await surfaceStyle()).image).toContain('radial-gradient');
  expect((await surfaceStyle()).size).toBe('24px 24px');
  await page.keyboard.press('g');
  expect((await surfaceStyle()).image).toContain('linear-gradient');
  await page.keyboard.press('g');
  expect((await surfaceStyle()).image).toBe('');
  const gridMenu = await openViewMenu(page);
  await expect(gridMenu.getByRole('menuitemradio', { name: 'None', exact: true })).toHaveAttribute('aria-checked', 'true');
  await gridMenu.getByRole('menuitemradio', { name: 'Dots', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await surfaceStyle()).image).toContain('radial-gradient');
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect.poll(async () => (await surfaceStyle()).size).toBe('28.8px 28.8px');
  await page.keyboard.press('ControlOrMeta+Minus');

  // Object dimensions: one sticky shows its own size; turning the option off hides it.
  await sticky.click();
  const label = page.getByTestId('selection-size');
  await expect(label).toHaveText(`${Math.round(stickyData.w)} x ${Math.round(stickyData.h)}`);
  const labelBox = await boxOf(label);
  const stickyBox = await boxOf(sticky);
  expect(labelBox.y).toBeGreaterThanOrEqual(stickyBox.y + stickyBox.h);
  expect(Math.abs(labelBox.x + labelBox.w / 2 - (stickyBox.x + stickyBox.w / 2))).toBeLessThan(2);
  await info.attach('dimensions', { body: await page.screenshot(), contentType: 'image/png' });
  await choose(page, 'menuitemcheckbox', 'Object dimensions');
  await expect(label).toHaveCount(0);
  await choose(page, 'menuitemcheckbox', 'Object dimensions');
  await expect(label).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(label).toHaveCount(0);

  // Minimap: M shows it; pressing a corner of the map moves the view there; M hides it again.
  await page.evaluate(() => document.activeElement?.blur());
  const minimap = page.getByTestId('board-minimap');
  await expect(minimap).toHaveCount(0);
  await page.keyboard.press('m');
  await expect(minimap).toBeVisible();
  // The map sits inside the window, above the zoom control with a clear gap.
  const mapFrame = await minimap.boundingBox();
  const zoomGroup = await page.getByRole('group', { name: 'Zoom' }).boundingBox();
  expect(mapFrame.x + mapFrame.width).toBeLessThanOrEqual(1440);
  expect(zoomGroup.y - (mapFrame.y + mapFrame.height)).toBeGreaterThanOrEqual(8);
  await info.attach('minimap', { body: await page.screenshot(), contentType: 'image/png' });
  const beforeMap = await boxOf(sticky);
  await minimap.click({ position: { x: 4, y: 4 } });
  await expect.poll(async () => (await boxOf(sticky)).x).toBeGreaterThan(beforeMap.x + 100);
  expect((await boxOf(sticky)).y).toBeGreaterThan(beforeMap.y + 50);
  // Dragging across the map keeps the view under the pointer.
  const mapBox = await minimap.boundingBox();
  await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.mouse.down();
  const atPress = await boxOf(sticky);
  await page.mouse.move(mapBox.x + mapBox.width / 2 + 20, mapBox.y + mapBox.height / 2, { steps: 4 });
  await page.mouse.up();
  expect((await boxOf(sticky)).x).toBeLessThan(atPress.x);
  await page.keyboard.press('m');
  await expect(minimap).toHaveCount(0);
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to fit/ }).click();
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();

  // Scroll bars: off by default; once on, they appear when the board is larger than the view, and
  // dragging the horizontal thumb moves the view.
  await expect(page.getByTestId('board-scrollbar-x')).toHaveCount(0);
  await choose(page, 'menuitemcheckbox', 'Scroll bars');
  await expect(page.getByTestId('board-scrollbar-x')).toHaveCount(0);
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('ControlOrMeta+Equal');
  await expect(zoomLabel(page)).toHaveText('299%');
  const thumb = page.getByTestId('board-scrollbar-x-thumb');
  await expect(thumb).toBeVisible();
  await expect(page.getByTestId('board-scrollbar-y-thumb')).toBeVisible();
  const thumbBox = await thumb.boundingBox();
  const beforeDrag = await boxOf(sticky);
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2 + 60, thumbBox.y + thumbBox.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await boxOf(sticky)).x).toBeLessThan(beforeDrag.x - 20);
  expect(near((await boxOf(sticky)).y, beforeDrag.y)).toBe(true);
  await info.attach('scroll-bars', { body: await page.screenshot(), contentType: 'image/png' });
  await choose(page, 'menuitemcheckbox', 'Scroll bars');
  await expect(thumb).toHaveCount(0);
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();
  await expect(zoomLabel(page)).toHaveText('100%');

  // Reduce motion: the personal toggle marks the page so board animations become instant.
  await choose(page, 'menuitemcheckbox', 'Reduce motion');
  await expect(page.locator('html')).toHaveAttribute('data-board-reduce-motion', 'true');
  await choose(page, 'menuitemcheckbox', 'Reduce motion');
  await expect(page.locator('html')).not.toHaveAttribute('data-board-reduce-motion', 'true');

  // Full screen from the View menu, and out again from the zoom menu.
  await choose(page, 'menuitem', 'Full screen');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await zoomLabel(page).click();
  await page.getByRole('menuitem', { name: 'Exit full screen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  // Personal preferences survive a reload; the View menu reflects them.
  await choose(page, 'menuitemradio', 'Lines');
  await page.reload();
  await openBoard(page);
  expect((await surfaceStyle()).image).toContain('linear-gradient');
  await page.keyboard.press('g');
  await page.keyboard.press('g');

  // Board background: an editor picks a color for everyone; it is saved with the board.
  const backgroundMenu = await openViewMenu(page);
  await expect(backgroundMenu.getByRole('group', { name: 'Board background' }).getByRole('menuitemradio')).toHaveCount(11);
  await pixelClean(page, backgroundMenu);
  await info.attach('view-menu', { body: await page.screenshot(), contentType: 'image/png' });
  const backgroundSaved = page.waitForResponse(isSave);
  await backgroundMenu.getByRole('menuitemradio', { name: 'Navy background', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await backgroundSaved).status()).toBe(200);
  expect((await surfaceStyle()).color).toBe('rgb(18, 26, 46)');
  await expect.poll(async () => (await boardData()).settings?.background).toBe('#121a2e');

  // Start view: the owner sets the current view; the board stays where it is for them.
  await page.mouse.move(720, 450);
  await page.mouse.wheel(-300, -200);
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect(zoomLabel(page)).toHaveText('83%');
  const ownerView = await boxOf(sticky);
  const startSaved = page.waitForResponse(isSave);
  await choose(page, 'menuitem', 'Set current view as start view');
  expect((await startSaved).status()).toBe(200);
  await expect.poll(async () => (await boardData()).settings?.startView?.zoom).toBeCloseTo(1 / 1.2, 5);
  // The owner moves on; their own saved view is not the start view any more.
  await page.keyboard.press('ControlOrMeta+0');
  await expect(zoomLabel(page)).toHaveText('100%');
  await expect.poll(async () => (await boardData()).viewport.zoom).toBe(1);

  // The teammate joins as a viewer: no background or start view controls, and they open at the start view.
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share board' });
  // Team members would otherwise get the default edit access.
  await dialog.getByLabel('Team access').selectOption('view');
  await expect(dialog.getByLabel('Team access')).toHaveValue('view');
  const members = dialog.getByRole('region', { name: 'Board members' });
  await members.getByLabel('Add a teammate to this board').selectOption({ label: MATE.name });
  await members.getByLabel('Role').selectOption('view');
  await members.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(members.getByLabel(`Board role for ${MATE.name}`)).toHaveValue('view');
  await page.keyboard.press('Escape');

  const mate = await signIn(browser, baseURL, MATE, project.id);
  const mateCanvas = await openBoard(mate.page);
  const mateSticky = mate.page.locator(`[data-node-id="${stickyData.id}"]`);
  await expect(mateSticky).toBeVisible();
  await expect(zoomLabel(mate.page)).toHaveText('83%');
  const mateView = await boxOf(mateSticky);
  expect(Math.abs(mateView.x - ownerView.x)).toBeLessThan(2);
  expect(Math.abs(mateView.y - ownerView.y)).toBeLessThan(2);
  expect(await mateCanvas.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(18, 26, 46)');
  const mateMenu = await openViewMenu(mate.page);
  await expect(mateMenu.getByRole('group', { name: 'Board background' })).toHaveCount(0);
  await expect(mateMenu.getByRole('menuitem', { name: 'Set current view as start view' })).toHaveCount(0);
  await expect(mateMenu.getByRole('menuitemcheckbox', { name: 'Minimap' })).toBeVisible();
  await mate.page.keyboard.press('Escape');
  // A second visit on this device keeps the teammate's own view.
  await mate.page.keyboard.press('ControlOrMeta+Equal');
  await expect(zoomLabel(mate.page)).toHaveText('100%');
  await mate.page.reload();
  await openBoard(mate.page);
  await expect(mate.page.locator(`[data-node-id="${stickyData.id}"]`)).toBeVisible();
  await expect(zoomLabel(mate.page)).not.toHaveText('83%');

  // Clearing the start view leaves the board without one.
  const cleared = page.waitForResponse(isSave);
  await choose(page, 'menuitem', 'Clear start view');
  expect((await cleared).status()).toBe(200);
  await expect.poll(async () => (await boardData()).settings?.startView ?? null).toBe(null);
  await mate.context.close();
  await owner.context.close();
});
