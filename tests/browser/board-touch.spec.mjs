import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Boards on phones and tablets: touch devices open a board view-only (pan and
// zoom with one finger, pinch, double tap, double tap and swipe), the owner taps
// Edit, double taps text or long presses an object to edit, a swipe that starts
// on a connector or a frame title still pans, and a view-role teammate never
// gets an Edit button.
// Gestures are real touch events dispatched through CDP, so the pointer-event
// handling in CanvasSurface is exercised the way a phone drives it.

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000015', name: 'Touch owner', email: 'touch-owner@example.test' };
const VIEWER = { id: 'b0a2d000-0000-4000-8000-000000000016', name: 'Touch viewer', email: 'touch-viewer@example.test' };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function seedUsers() {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, VIEWER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  return db;
}

async function signIn(browser, baseURL, user, projectId, device = { viewport: { width: 1440, height: 900 } }) {
  const context = await browser.newContext(device);
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  const page = await context.newPage();
  return { context, page };
}

async function openBoard(page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

async function addSticky(page, canvas, position) {
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  const saved = page.waitForResponse((response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) &&
    ['PUT', 'PATCH'].includes(response.request().method()));
  await canvas.click({ position });
  const response = await saved;
  expect(response.status()).toBe(200);
  return response.url();
}

/** Zoom readout of the board, as a number (100 means 100%). */
async function zoomPercent(page) {
  const text = await page.getByText(/^\d+%$/).first().textContent();
  return Number.parseInt(text, 10);
}

/** Real multi-touch through CDP; Playwright's `tap` is single-finger only. */
class Touch {
  constructor(session) { this.session = session; }
  async start(points) { this.moved = false; await this.session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points.map(({ x, y }, id) => ({ x, y, id })) }); }
  async move(points) { this.moved = true; await this.session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points.map(({ x, y }, id) => ({ x, y, id })) }); }
  /** Lifts every finger. A finger that moved rests first: lifting mid-swipe starts a browser fling, and Chromium swallows the next tap to stop it. */
  async end() {
    if (this.moved) await new Promise((resolve) => setTimeout(resolve, 120));
    await this.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async tap(point) { await this.start([point]); await this.end(); }
  /** Pinch from `from` to `to` (each a pair of points) in `steps` moves. */
  async pinch(from, to, steps = 8) {
    await this.start(from);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await this.move(from.map((p, k) => ({ x: p.x + (to[k].x - p.x) * t, y: p.y + (to[k].y - p.y) * t })));
    }
    await this.end();
  }
  /** One finger from `from` to `to`, optionally holding still for `holdMs` first. */
  async drag(from, to, { steps = 6, holdMs = 0 } = {}) {
    await this.start([from]);
    if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await this.move([{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }]);
    }
    await this.end();
  }
}

/** Nothing spills outside the viewport or overflows its own box, and the page never scrolls sideways. */
async function pixelClean(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBeTruthy();
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Board canvas"] ~ *, [aria-label="Board canvas"] ~ * *')].filter((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.position === 'fixed') return false;
    if (node.closest('[data-node-id]')) return false; // board content is meant to be panned off screen
    for (let a = node.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).textOverflow === 'ellipsis') return false; // truncated by an ancestor
    return box.left < -0.5 || box.right > innerWidth + 0.5 || box.top < -0.5 || box.bottom > innerHeight + 0.5 ||
      (node.scrollWidth > node.clientWidth + 1 && !['auto', 'scroll', 'hidden'].includes(style.overflowX) && style.textOverflow !== 'ellipsis');
  }).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 80)}`));
  expect(overflowing).toEqual([]);
}

async function separate(a, b) {
  const x = await a.boundingBox(), y = await b.boundingBox();
  expect(x && y && (x.x + x.width <= y.x + 1 || y.x + y.width <= x.x + 1 || x.y + x.height <= y.y + 1 || y.y + y.height <= x.y + 1)).toBeTruthy();
}

/** Pans with one finger on empty space until the node's centre sits mid-screen. */
async function centreNode(touch, node, box) {
  // Pan on empty canvas, in steps when needed, until the node is centred on screen.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  for (let round = 0; round < 6; round += 1) {
    const b = await node.boundingBox();
    const dx = box.x + box.width / 2 - (b.x + b.width / 2), dy = box.y + box.height / 2 - (b.y + b.height / 2);
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break;
    const onNode = (p) => p.x >= b.x - 12 && p.x <= b.x + b.width + 12 && p.y >= b.y - 12 && p.y <= b.y + b.height + 12;
    const grid = [];
    for (let gx = 24; gx <= box.width - 24; gx += (box.width - 48) / 4) {
      for (let gy = 140; gy <= box.height - 140; gy += (box.height - 280) / 4) grid.push({ x: box.x + gx, y: box.y + gy });
    }
    // Start where the finger has the most room to travel towards the target.
    const target = (p) => ({ x: clamp(p.x + dx, box.x + 16, box.x + box.width - 16), y: clamp(p.y + dy, box.y + 120, box.y + box.height - 120) });
    const reach = (p) => { const q = target(p); return Math.hypot(q.x - p.x, q.y - p.y); };
    const from = grid.filter((p) => !onNode(p)).sort((a, c) => reach(c) - reach(a))[0];
    expect(from, 'an empty start point for the pan').toBeTruthy();
    const to = target(from);
    await touch.drag(from, to, { steps: 10 });
    await node.page().waitForTimeout(150);
  }
  await expect(node).toBeInViewport({ ratio: 0.9 });
}

async function shot(page, info, name) {
  const body = await page.screenshot();
  await info.attach(name, { body, contentType: 'image/png' });
}

test('Board touch: a phone opens the board view-only, pans and zooms by touch, and Edit moves nodes', async ({ browser, baseURL }, info) => {
  test.setTimeout(150000);
  const db = await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board touch ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  // A desktop session seeds a sticky with the mouse; desktop behaviour is unchanged by the touch work.
  const desk = await signIn(browser, baseURL, OWNER, project.id);
  const deskCanvas = await openBoard(desk.page);
  await expect(desk.page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  const boardUrl = await addSticky(desk.page, deskCanvas, { x: 500, y: 300 });
  const boardPath = new URL(boardUrl).pathname;
  const board = await (await desk.context.request.get(boardPath)).json();
  expect(board.data.nodes).toHaveLength(1);
  const stickyId = board.data.nodes[0].id;
  await desk.context.close();

  const phone = await signIn(browser, baseURL, OWNER, project.id, PHONE);
  const writes = [];
  phone.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && ['PUT', 'PATCH'].includes(request.method())) writes.push(request.url());
  });
  const canvas = await openBoard(phone.page);
  expect(await phone.page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBeTruthy();
  const touch = new Touch(await phone.context.newCDPSession(phone.page));
  const edit = phone.page.getByRole('button', { name: 'Edit', exact: true });
  const sticky = phone.page.locator(`[data-node-id="${stickyId}"]`);

  // View-only by default: Edit is offered, the tool dock is not, and the status says so.
  await expect(edit).toBeVisible();
  await expect(phone.page.getByRole('toolbar', { name: 'Board tools' })).toHaveCount(0);
  await expect(phone.page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible();
  await expect(phone.page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
  await expect(phone.page.getByRole('button', { name: 'Show asset panel' })).toBeVisible();
  await expect(sticky).toBeVisible();
  await pixelClean(phone.page);
  await separate(edit, phone.page.getByRole('button', { name: 'Share', exact: true }));
  await shot(phone.page, info, 'phone-view-only');
  const box = await canvas.boundingBox();
  const at = (x, y) => ({ x: box.x + x, y: box.y + y });

  // One finger on empty space pans; the sticky (world 400,200) starts past the phone's right edge.
  const offscreen = await sticky.boundingBox();
  expect(offscreen.x).toBeGreaterThan(box.width - 1);
  await touch.drag(at(300, 650), at(80, 650));
  const before = await sticky.boundingBox();
  expect(before.x).toBeLessThan(box.width - 60);
  expect(offscreen.x - before.x).toBeGreaterThan(200);
  await expect(sticky).toBeInViewport();

  // One finger on a node pans the board in view mode instead of moving the node.
  await touch.drag(at(before.x - box.x + before.width / 2, before.y - box.y + before.height / 2), at(before.x - box.x + before.width / 2 + 90, before.y - box.y + before.height / 2 + 60));
  const panned = await sticky.boundingBox();
  expect(panned.x - before.x).toBeGreaterThan(70);
  expect(panned.y - before.y).toBeGreaterThan(40);
  expect(await zoomPercent(phone.page)).toBe(100);

  // Pinch out zooms in around the fingers; pinch in zooms back out.
  await touch.pinch([at(150, 400), at(240, 400)], [at(60, 400), at(330, 400)]);
  const pinched = await zoomPercent(phone.page);
  expect(pinched).toBeGreaterThan(250);
  expect(pinched).toBeLessThan(350);
  await touch.pinch([at(60, 400), at(330, 400)], [at(150, 400), at(240, 400)]);
  expect(await zoomPercent(phone.page)).toBe(100);

  // Double tap zooms in by a step around the tap.
  await touch.tap(at(195, 420));
  await touch.tap(at(195, 420));
  await expect.poll(() => zoomPercent(phone.page)).toBe(200);

  // Double tap and swipe: the second tap stays down and slides. Up zooms in further, down zooms out.
  await touch.tap(at(195, 500));
  await touch.drag(at(195, 500), at(195, 380));
  const swipedUp = await zoomPercent(phone.page);
  expect(swipedUp).toBeGreaterThan(200);
  await touch.tap(at(195, 500));
  await touch.drag(at(195, 500), at(195, 700));
  await expect.poll(() => zoomPercent(phone.page)).toBeLessThan(swipedUp);
  await phone.page.getByText(/^\d+%$/).first().click();
  await phone.page.getByRole('menuitem', { name: /Zoom to 100%/ }).click();
  await expect.poll(() => zoomPercent(phone.page)).toBe(100);

  // Viewing changed no content: the viewport autosaves as it does on desktop, nodes stay put.
  await phone.page.waitForTimeout(1500);
  const viewed = await (await phone.context.request.get(boardPath)).json();
  expect(viewed.data.nodes).toEqual(board.data.nodes);
  expect(viewed.data.connectors).toEqual(board.data.connectors);
  writes.length = 0;

  // Edit mode: the dock appears, a one-finger drag moves the node and the move is saved.
  await edit.tap();
  const done = phone.page.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeVisible();
  await expect(phone.page.getByRole('toolbar', { name: 'Board tools' })).toBeVisible();
  await expect(phone.page.getByRole('button', { name: 'Sticky note', exact: true })).toBeVisible();
  await pixelClean(phone.page);
  await separate(phone.page.getByRole('toolbar', { name: 'Board tools' }), phone.page.getByRole('group', { name: 'Zoom', exact: true }));
  await shot(phone.page, info, 'phone-edit-mode');
  await centreNode(touch, sticky, box);
  const start = await sticky.boundingBox();
  const centre = at(start.x - box.x + start.width / 2, start.y - box.y + start.height / 2);
  const saved = phone.page.waitForResponse((response) => response.url().endsWith(boardPath) && ['PUT', 'PATCH'].includes(response.request().method()));
  await touch.drag(centre, { x: centre.x - 80, y: centre.y + 50 });
  expect((await saved).status()).toBe(200);
  const moved = await sticky.boundingBox();
  expect(start.x - moved.x).toBeGreaterThan(60);
  expect(moved.y - start.y).toBeGreaterThan(30);
  const afterMove = await (await phone.context.request.get(boardPath)).json();
  expect(afterMove.data.nodes[0].x).toBeLessThan(board.data.nodes[0].x);
  expect(afterMove.data.nodes[0].y).toBeGreaterThan(board.data.nodes[0].y);
  expect(writes.length).toBeGreaterThan(0);

  // Long press on empty space then drag draws a marquee that selects the node; the style inspector shows.
  const inspector = phone.page.getByRole("button", { name: "More", exact: true });
  await expect(inspector).toBeVisible(); // still selected from the move
  await touch.tap(at(20, 700)); // tap empty space: clears the selection
  await expect(inspector).toHaveCount(0);
  await centreNode(touch, sticky, box);
  const target = await sticky.boundingBox();
  await touch.drag(at(target.x - box.x - 30, target.y - box.y - 30), at(target.x - box.x + target.width + 30, target.y - box.y + target.height + 30), { holdMs: 650 });
  await expect(inspector).toBeVisible();
  await pixelClean(phone.page);
  await shot(phone.page, info, 'phone-marquee-selection');
  const stillThere = await sticky.boundingBox();
  expect(Math.abs(stillThere.x - target.x)).toBeLessThan(2);

  // Double tap on the sticky in edit mode opens its text for editing.
  const inner = await sticky.boundingBox();
  const mid = at(inner.x - box.x + inner.width / 2, inner.y - box.y + inner.height / 2);
  await touch.tap(mid);
  await touch.tap(mid);
  await expect(sticky.locator('[contenteditable="true"]')).toBeVisible();

  // Done returns to view-only and ends the edit.
  await done.tap();
  await expect(edit).toBeVisible();
  await expect(phone.page.getByRole('toolbar', { name: 'Board tools' })).toHaveCount(0);
  await expect(sticky.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(inspector).toHaveCount(0);

  // The asset panel opens as a drawer over the board and closes again.
  await phone.page.getByRole('button', { name: 'Show asset panel' }).tap();
  await expect(phone.page.getByRole('button', { name: 'Collapse asset panel' })).toBeVisible();
  await pixelClean(phone.page);
  await shot(phone.page, info, 'phone-asset-drawer');
  await phone.page.getByRole('button', { name: 'Collapse asset panel' }).tap();
  await expect(edit).toBeVisible();

  await phone.context.close();
  await db.end();
});

test('Board touch: a tablet lays out every control and a view-role teammate never sees Edit', async ({ browser, baseURL }, info) => {
  const db = await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board touch tablet ${randomUUID()}` }, headers: { Origin: baseURL } });
  const { project } = await created.json();
  await setup.context.close();

  const desk = await signIn(browser, baseURL, OWNER, project.id);
  const boardPath = new URL(await addSticky(desk.page, await openBoard(desk.page), { x: 500, y: 300 })).pathname;
  const boardId = boardPath.split('/').at(-1);
  // Team access would otherwise let every teammate edit; narrow it, then give the viewer view access.
  const narrowed = await desk.context.request.post(`${boardPath}/access`, {
    data: { op: 'setTeamRole', role: 'view' }, headers: { Origin: baseURL } });
  expect(narrowed.ok()).toBeTruthy();
  const granted = await desk.context.request.post(`${boardPath}/access`, {
    data: { op: 'setMember', userId: VIEWER.id, role: 'view' }, headers: { Origin: baseURL } });
  expect(granted.ok()).toBeTruthy();
  await desk.context.close();

  // Owner on a tablet: view-only with Edit, every control inside the viewport, the asset panel open as a column.
  const tablet = await signIn(browser, baseURL, OWNER, project.id, TABLET);
  const canvas = await openBoard(tablet.page);
  const edit = tablet.page.getByRole('button', { name: 'Edit', exact: true });
  await expect(edit).toBeVisible();
  await expect(tablet.page.getByRole('toolbar', { name: 'Board tools' })).toHaveCount(0);
  await expect(tablet.page.getByRole('button', { name: 'Collapse asset panel' })).toBeVisible();
  await pixelClean(tablet.page);
  await shot(tablet.page, info, 'tablet-view-only');
  await edit.tap();
  await expect(tablet.page.getByRole('toolbar', { name: 'Board tools' })).toBeVisible();
  const dock = tablet.page.getByRole('toolbar', { name: 'Board tools' });
  await separate(dock, tablet.page.getByRole('group', { name: 'Zoom', exact: true }));
  await separate(dock, tablet.page.getByRole('complementary', { name: 'Asset panel' }));
  await pixelClean(tablet.page);
  await shot(tablet.page, info, 'tablet-edit-mode');
  const touch = new Touch(await tablet.context.newCDPSession(tablet.page));
  const box = await canvas.boundingBox();
  await touch.pinch([{ x: box.x + 400, y: box.y + 500 }, { x: box.x + 500, y: box.y + 500 }], [{ x: box.x + 350, y: box.y + 500 }, { x: box.x + 550, y: box.y + 500 }]);
  await expect.poll(() => zoomPercent(tablet.page)).toBe(200);
  await tablet.context.close();

  // A view-role teammate: no Edit, no dock, and pinch and pan still work.
  const viewer = await signIn(browser, baseURL, VIEWER, project.id, TABLET);
  const writes = [];
  viewer.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && request.method() !== 'GET') writes.push(request.url());
  });
  await viewer.page.goto('/');
  const loaded = viewer.page.waitForResponse((response) => response.url().endsWith(boardPath) && response.request().method() === 'GET');
  await viewer.page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const viewerCanvas = viewer.page.getByRole('application', { name: 'Board canvas' });
  await expect(viewerCanvas).toBeVisible();
  expect((await (await loaded).json()).role).toBe('view');
  await expect(viewer.page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(viewer.page.getByRole('toolbar', { name: 'Board tools' })).toHaveCount(0);
  const viewerTouch = new Touch(await viewer.context.newCDPSession(viewer.page));
  const vbox = await viewerCanvas.boundingBox();
  const sticky = viewer.page.locator('[data-node-id]').first();
  await expect(sticky).toBeVisible();
  const before = await sticky.boundingBox();
  await viewerTouch.drag({ x: vbox.x + 400, y: vbox.y + 700 }, { x: vbox.x + 300, y: vbox.y + 650 });
  const after = await sticky.boundingBox();
  expect(before.x - after.x).toBeGreaterThan(80);
  await viewerTouch.pinch([{ x: vbox.x + 400, y: vbox.y + 500 }, { x: vbox.x + 500, y: vbox.y + 500 }], [{ x: vbox.x + 350, y: vbox.y + 500 }, { x: vbox.x + 550, y: vbox.y + 500 }]);
  await expect.poll(() => zoomPercent(viewer.page)).toBe(200);
  await pixelClean(viewer.page);
  await shot(viewer.page, info, 'tablet-viewer');
  await viewer.page.waitForTimeout(1000);
  expect(writes).toEqual([]);
  expect((await (await viewer.context.request.get(`/api/canvas-boards/${boardId}`)).json()).role).toBe('view');
  await viewer.context.close();
  await db.end();
});

async function createProject(browser, baseURL, name) {
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `${name} ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();
  return project;
}

async function boardData(context, boardPath) {
  return (await (await context.request.get(boardPath)).json()).data;
}

/** Replaces the board's graph the way autosave does: against the version it read, under a fresh save id. */
async function seedBoard(context, boardPath, data, baseURL) {
  const { version } = await (await context.request.get(boardPath)).json();
  return context.request.put(boardPath, { data: { data, baseVersion: version, saveId: randomUUID() }, headers: { Origin: baseURL } });
}

test('Board touch: viewing, a keyboard cannot edit, save trouble stays visible, and a double tap or long press switches to Edit', async ({ browser, baseURL }) => {
  test.setTimeout(150000);
  const db = await seedUsers();
  const project = await createProject(browser, baseURL, 'Board touch view-only');
  const desk = await signIn(browser, baseURL, OWNER, project.id);
  const boardPath = new URL(await addSticky(desk.page, await openBoard(desk.page), { x: 500, y: 300 })).pathname;
  const original = await boardData(desk.context, boardPath);
  const stickyId = original.nodes[0].id;
  await desk.context.close();

  const phone = await signIn(browser, baseURL, OWNER, project.id, PHONE);
  const canvas = await openBoard(phone.page);
  const touch = new Touch(await phone.context.newCDPSession(phone.page));
  const edit = phone.page.getByRole('button', { name: 'Edit', exact: true });
  const done = phone.page.getByRole('button', { name: 'Done', exact: true });
  const viewOnly = phone.page.getByRole('status').filter({ hasText: 'View only' });
  const sticky = phone.page.locator(`[data-node-id="${stickyId}"]`);
  const editor = sticky.locator('[contenteditable="true"]');
  const box = await canvas.boundingBox();
  const at = (x, y) => ({ x: box.x + x, y: box.y + y });
  await expect(edit).toBeVisible();
  await expect(viewOnly).toBeVisible();

  // A hardware keyboard, a paste and a file drop change nothing while viewing.
  let chooserOpened = false;
  phone.page.on('filechooser', () => { chooserOpened = true; });
  const nodes = phone.page.locator('[data-node-id]');
  for (const key of ['Control+a', 'Backspace', 'Control+d', 'Control+g', 'Shift+I']) {
    await phone.page.keyboard.press(key);
    await expect(nodes).toHaveCount(1);
  }
  await expect(sticky).toHaveCount(1);
  await phone.page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'pasted.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  });
  const dropped = await phone.page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' }));
    return data;
  });
  await canvas.dispatchEvent('drop', { dataTransfer: dropped, clientX: box.x + 195, clientY: box.y + 420 });
  await phone.page.waitForTimeout(2000);
  await expect(phone.page.getByText(/Uploading \d+ image|images? added/)).toHaveCount(0);
  expect(chooserOpened).toBe(false);
  await expect(edit).toBeVisible();
  expect((await boardData(phone.context, boardPath)).nodes).toEqual(original.nodes);

  // Viewing still autosaves the viewport; a failed save shows the error and Retry in place of View only.
  const isBoard = (url) => new URL(url).pathname === boardPath;
  await phone.page.route(isBoard, (route) => (['PUT', 'PATCH'].includes(route.request().method())
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' })
    : route.continue()));
  await touch.drag(at(300, 650), at(120, 650));
  await expect(phone.page.getByText(/Could not save/)).toBeVisible({ timeout: 10000 });
  await expect(viewOnly).toHaveCount(0);
  await phone.page.unroute(isBoard);
  await phone.page.getByRole('button', { name: 'Retry', exact: true }).tap();
  await expect(viewOnly).toBeVisible({ timeout: 10000 });
  await expect(phone.page.getByText(/Could not save/)).toHaveCount(0);

  // A double tap on the sticky switches to Edit and opens its text, without zooming.
  await centreNode(touch, sticky, box);
  const zoom = await zoomPercent(phone.page);
  const tapped = await sticky.boundingBox();
  const mid = { x: tapped.x + tapped.width / 2, y: tapped.y + tapped.height / 2 };
  await touch.tap(mid);
  await touch.tap(mid);
  await expect(done).toBeVisible();
  await expect(editor).toBeVisible();
  expect(await zoomPercent(phone.page)).toBe(zoom);
  await done.tap();
  await expect(edit).toBeVisible();
  await expect(editor).toHaveCount(0);

  // A long press on the sticky switches to Edit and picks it up; the drag moves it and the move is saved.
  const start = await sticky.boundingBox();
  const centre = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  await touch.drag(centre, { x: centre.x - 80, y: centre.y + 50 }, { holdMs: 650 });
  await expect(done).toBeVisible();
  const moved = await sticky.boundingBox();
  expect(start.x - moved.x).toBeGreaterThan(60);
  expect(moved.y - start.y).toBeGreaterThan(30);
  await expect.poll(async () => (await boardData(phone.context, boardPath)).nodes[0].x).toBeLessThan(original.nodes[0].x);
  expect((await boardData(phone.context, boardPath)).nodes[0].y).toBeGreaterThan(original.nodes[0].y);

  await phone.context.close();
  await db.end();
});

test('Board touch: after a one-finger crop drag, taps select, a double tap opens Crop and one finger pans without zooming', async ({ browser, baseURL }) => {
  test.setTimeout(150000);
  const db = await seedUsers();
  const project = await createProject(browser, baseURL, 'Board touch crop');
  const desk = await signIn(browser, baseURL, OWNER, project.id);
  const boardPath = new URL(await addSticky(desk.page, await openBoard(desk.page), { x: 500, y: 300 })).pathname;
  const original = await boardData(desk.context, boardPath);
  const imageId = randomUUID();
  const image = { id: imageId, type: 'image', x: 100, y: 100, w: 240, h: 160, parentId: null, groupId: null,
    src: '/api/media/canvas/touch-crop-fixture.png', aspectLocked: false, naturalW: 480, naturalH: 320 };
  const seeded = await seedBoard(desk.context, boardPath, { ...original, nodes: [image] }, baseURL);
  expect(seeded.ok()).toBeTruthy();
  await desk.context.close();

  const phone = await signIn(browser, baseURL, OWNER, project.id, PHONE);
  const canvas = await openBoard(phone.page);
  const touch = new Touch(await phone.context.newCDPSession(phone.page));
  const box = await canvas.boundingBox();
  const at = (x, y) => ({ x: box.x + x, y: box.y + y });
  const empty = at(330, 560); // below the centred image and above the tool dock
  const node = phone.page.locator(`[data-node-id="${imageId}"]`);
  const cropButton = phone.page.getByRole('button', { name: 'Crop image', exact: true });
  const cropControls = phone.page.locator('[data-crop-controls]');
  await phone.page.getByRole('button', { name: 'Edit', exact: true }).tap();
  await expect(phone.page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await centreNode(touch, node, box);
  expect(await zoomPercent(phone.page)).toBe(100);

  // Select the image, open Crop and drag the crop with one finger.
  const placed = await node.boundingBox();
  const centre = { x: placed.x + placed.width / 2, y: placed.y + placed.height / 3 };
  await touch.tap(centre);
  await cropButton.tap();
  await expect(cropControls).toBeVisible();
  await phone.page.waitForTimeout(400); // well past the double tap window
  await touch.drag(centre, { x: centre.x + 40, y: centre.y });
  await phone.page.getByRole('button', { name: 'Apply crop', exact: true }).tap();
  await expect(cropControls).toHaveCount(0);

  // The lifted crop finger is gone: a tap on empty space clears the selection and a tap on the image selects it.
  await expect(cropButton).toBeVisible();
  await touch.tap(empty);
  await expect(cropButton).toHaveCount(0);
  await phone.page.waitForTimeout(400);
  await touch.tap(centre);
  await expect(cropButton).toBeVisible();

  // While editing, a double tap on the image opens its crop, as a mouse double click does, without zooming.
  await phone.page.waitForTimeout(400);
  await touch.tap(centre);
  await touch.tap(centre);
  await expect(cropControls).toBeVisible();
  expect(await zoomPercent(phone.page)).toBe(100);
  await phone.page.getByRole('button', { name: 'Apply crop', exact: true }).tap();
  await expect(cropControls).toHaveCount(0);

  // One finger on empty space pans by the finger's travel and leaves the zoom alone.
  const before = await node.boundingBox();
  await phone.page.waitForTimeout(400);
  await touch.drag(empty, at(150, 560));
  const after = await node.boundingBox();
  expect(before.x - after.x).toBeGreaterThan(150);
  expect(before.x - after.x).toBeLessThan(200);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(await zoomPercent(phone.page)).toBe(100);

  await phone.context.close();
  await db.end();
});

test('Board touch: a phone that opened the board before still starts with the asset panel collapsed, and desktop keeps its saved choice', async ({ browser, baseURL }) => {
  const db = await seedUsers();
  const project = await createProject(browser, baseURL, 'Board touch panel');
  // The previous release wrote this key on every mount, including on phones behind the desktop-only gate.
  const legacy = (value) => (context) => context.addInitScript((v) => {
    localStorage.setItem('veevee-canvas-asset-panel-collapsed-v1', v);
  }, value);
  const show = (page) => page.getByRole('button', { name: 'Show asset panel' });
  const collapse = (page) => page.getByRole('button', { name: 'Collapse asset panel' });

  const phone = await signIn(browser, baseURL, OWNER, project.id, PHONE);
  await legacy('0')(phone.context);
  await openBoard(phone.page);
  await expect(show(phone.page)).toBeVisible();
  await expect(collapse(phone.page)).toHaveCount(0);
  // Opening it is a choice, and a choice is remembered.
  await show(phone.page).tap();
  await expect(collapse(phone.page)).toBeVisible();
  await openBoard(phone.page);
  await expect(collapse(phone.page)).toBeVisible();
  await phone.context.close();

  const desk = await signIn(browser, baseURL, OWNER, project.id);
  await legacy('1')(desk.context);
  await openBoard(desk.page);
  await expect(show(desk.page)).toBeVisible();
  await expect(collapse(desk.page)).toHaveCount(0);
  await desk.context.close();
  await db.end();
});

test('Board touch: a double tap inside an open text editor keeps it open and every typed word is saved', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const db = await seedUsers();
  const project = await createProject(browser, baseURL, 'Board touch editor');
  const desk = await signIn(browser, baseURL, OWNER, project.id);
  const boardPath = new URL(await addSticky(desk.page, await openBoard(desk.page), { x: 500, y: 300 })).pathname;
  const stickyId = (await boardData(desk.context, boardPath)).nodes[0].id;
  await desk.context.close();

  const phone = await signIn(browser, baseURL, OWNER, project.id, PHONE);
  const canvas = await openBoard(phone.page);
  const touch = new Touch(await phone.context.newCDPSession(phone.page));
  const box = await canvas.boundingBox();
  const sticky = phone.page.locator(`[data-node-id="${stickyId}"]`);
  const editor = sticky.locator('[contenteditable="true"]');
  const done = phone.page.getByRole('button', { name: 'Done', exact: true });
  await phone.page.getByRole('button', { name: 'Edit', exact: true }).tap();
  await expect(done).toBeVisible();
  await centreNode(touch, sticky, box);
  const zoom = await zoomPercent(phone.page);

  const placed = await sticky.boundingBox();
  const mid = { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 };
  await touch.tap(mid);
  await touch.tap(mid);
  await expect(editor).toBeVisible();
  await phone.page.keyboard.type('Hello');
  await phone.page.waitForTimeout(400); // well past the double tap window

  // Two quick taps inside the text belong to the editor: it stays open, the board does not zoom, and typing goes on.
  const typed = await editor.boundingBox();
  const inText = { x: typed.x + typed.width / 2, y: typed.y + typed.height / 2 };
  await touch.tap(inText);
  await touch.tap(inText);
  await phone.page.waitForTimeout(400);
  await expect(editor).toBeVisible();
  expect(await zoomPercent(phone.page)).toBe(zoom);
  await phone.page.keyboard.press('End');
  await phone.page.keyboard.type(' world');
  await expect(editor).toHaveText('Hello world');

  await done.tap();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await boardData(phone.context, boardPath)).nodes[0].text, { timeout: 10000 }).toBe('Hello world');

  await phone.context.close();
  await db.end();
});

test('Board touch: viewing, a swipe that starts on a connector or a frame title pans the board and selects nothing, and in Edit a double tap on the title renames the frame', async ({ browser, baseURL }) => {
  test.setTimeout(120000);
  const db = await seedUsers();
  const project = await createProject(browser, baseURL, 'Board touch connector');
  const desk = await signIn(browser, baseURL, OWNER, project.id);
  const boardPath = new URL(await addSticky(desk.page, await openBoard(desk.page), { x: 500, y: 300 })).pathname;
  const original = await boardData(desk.context, boardPath);
  const sticky = (id, x) => ({ id, type: 'sticky', x, y: 260, w: 100, h: 100, parentId: null, groupId: null,
    text: '', fill: '#fff59d', fontSize: 16, color: '#000000' });
  const [leftId, rightId, frameId] = [randomUUID(), randomUUID(), randomUUID()];
  const frame = { id: frameId, type: 'frame', x: 40, y: 540, w: 300, h: 140, parentId: null, groupId: null,
    name: 'Touch frame', fill: 'transparent', stroke: '#ffffff' };
  const arrow = { id: randomUUID(), from: { nodeId: leftId, anchor: 'right' }, to: { nodeId: rightId, anchor: 'left' },
    kind: 'arrow', stroke: '#ffffff', strokeWidth: 2 };
  const seeded = await seedBoard(desk.context, boardPath, { ...original,
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [sticky(leftId, 30), sticky(rightId, 260), frame], connectors: [arrow] }, baseURL);
  expect(seeded.ok()).toBeTruthy();
  await desk.context.close();

  const phone = await signIn(browser, baseURL, OWNER, project.id, PHONE);
  await openBoard(phone.page);
  const touch = new Touch(await phone.context.newCDPSession(phone.page));
  const left = phone.page.locator(`[data-node-id="${leftId}"]`);
  await expect(phone.page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible();
  await expect(left).toBeVisible();

  // The middle of the arrow on screen, from its drawn path.
  const onArrow = await phone.page.locator('path[marker-end]').evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM();
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  });
  const before = await left.boundingBox();
  await touch.drag(onArrow, { x: onArrow.x, y: onArrow.y + 120 }, { steps: 10 });
  const after = await left.boundingBox();
  expect(after.y - before.y).toBeGreaterThan(100);
  expect(after.y - before.y).toBeLessThan(140);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(await zoomPercent(phone.page)).toBe(100);

  // A finger on the frame title shows no connection handles and swiping it pans the board back up.
  const title = phone.page.getByText('Touch frame', { exact: true });
  const named = await title.boundingBox();
  const onTitle = { x: named.x + named.width / 2, y: named.y + named.height / 2 };
  const beforeTitle = await left.boundingBox();
  await touch.start([onTitle]);
  await expect(phone.page.getByRole('button', { name: /^Draw connector from/ })).toHaveCount(0);
  for (let i = 1; i <= 10; i += 1) await touch.move([{ x: onTitle.x, y: onTitle.y - 12 * i }]);
  await touch.end();
  const afterTitle = await left.boundingBox();
  expect(beforeTitle.y - afterTitle.y).toBeGreaterThan(100);
  expect(beforeTitle.y - afterTitle.y).toBeLessThan(140);
  expect(Math.abs(afterTitle.x - beforeTitle.x)).toBeLessThan(2);
  expect(await zoomPercent(phone.page)).toBe(100);

  // Nothing was selected: the frame shows no selection ring and, in Edit, the arrow no endpoint handles.
  await expect(phone.page.locator(`[data-node-id="${frameId}"] .ring-brand`)).toHaveCount(0);
  await phone.page.getByRole('button', { name: 'Edit', exact: true }).tap();
  await expect(phone.page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(phone.page.locator('[aria-label^="Connector start endpoint"]')).toHaveCount(0);

  // The title sits above the frame's box; a double tap on it opens the name for typing instead of zooming.
  const label = await title.boundingBox();
  const onLabel = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  await touch.tap(onLabel);
  await touch.tap(onLabel);
  await expect(phone.page.locator(`[data-node-id="${frameId}"] input`)).toHaveValue('Touch frame');
  expect(await zoomPercent(phone.page)).toBe(100);

  await phone.context.close();
  await db.end();
});
