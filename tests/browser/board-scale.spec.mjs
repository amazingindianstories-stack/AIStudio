import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000021', name: 'Scale owner', email: 'scale-owner@example.test' };
const COLUMNS = 50;
const ROWS = 40;
const SPACING = 260;

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(OWNER.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  return { context, page: await context.newPage() };
}

async function openBoard(page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  return canvas;
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());
const mounted = (page) => page.locator('[data-node-id]').count();
// Every element the board canvas holds: nodes, their content and connector paths.
const canvasElements = (page) => page.getByRole('application', { name: 'Board canvas' }).evaluate((element) => element.querySelectorAll('*').length);

test('Board scale: a 2,000-sticky, 1,960-arrow board mounts only what is near the viewport and an edit saves only that sticky', async ({ browser, baseURL }, info) => {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board scale ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  // The board is made by placing one sticky, which is then copied into a 50 x 40 grid.
  const owner = await signIn(browser, baseURL, project.id);
  await owner.page.goto('/');
  const canvas = await openBoard(owner.page);
  const placed = owner.page.waitForResponse(isSave);
  await owner.page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await canvas.click({ position: { x: 300, y: 300 } });
  const boardPath = new URL((await placed).url()).pathname;
  await owner.page.keyboard.press('Escape');
  await expect.poll(async () => (await (await owner.page.request.get(boardPath)).json()).data.nodes.length).toBe(1);
  const stored = await (await owner.page.request.get(boardPath)).json();
  const [template] = stored.data.nodes;
  // Each sticky also points to its right-hand neighbour: 1,960 arrows.
  const nodes = [];
  const connectors = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      nodes.push({ ...template, id: `scale-${row}-${column}`, x: column * SPACING, y: row * SPACING, text: `Sticky ${row}.${column}` });
      if (column > 0) {
        connectors.push({ id: `scale-arrow-${row}-${column}`, from: { nodeId: `scale-${row}-${column - 1}`, anchor: 'auto' },
          to: { nodeId: `scale-${row}-${column}`, anchor: 'auto' }, kind: 'arrow', stroke: '#ffffff', strokeWidth: 2 });
      }
    }
  }
  const board = { ...stored.data, viewport: { x: -40, y: -40, zoom: 1 }, nodes, connectors };
  const seeded = await owner.context.request.put(boardPath, {
    data: { data: board, baseVersion: stored.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(seeded.status()).toBe(200);
  const fullBoardBytes = JSON.stringify({ data: board, baseVersion: stored.version + 1, saveId: randomUUID() }).length;

  // Load: the first stickies appear and only the ones near the viewport are in the DOM.
  const loadStart = Date.now();
  await owner.page.reload();
  await openBoard(owner.page);
  await expect(owner.page.locator('[data-node-id="scale-0-0"]')).toBeVisible({ timeout: 30000 });
  const loadMs = Date.now() - loadStart;
  const loadedCount = await mounted(owner.page);
  const loadedElements = await canvasElements(owner.page);

  // Pan: eight wheel steps to the right and down; stickies stay under the pointer with no blank frame.
  await owner.page.mouse.move(720, 450);
  const panStart = Date.now();
  for (let step = 0; step < 8; step += 1) {
    await owner.page.mouse.wheel(500, 300);
    await expect.poll(() => owner.page.evaluate(() => {
      return [...document.querySelectorAll('[data-node-id]')].some((node) => {
        const box = node.getBoundingClientRect();
        return box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight;
      });
    })).toBeTruthy();
  }
  const panMs = Date.now() - panStart;
  const pannedCount = await mounted(owner.page);
  const pannedElements = await canvasElements(owner.page);
  await expect(owner.page.locator('[data-node-id="scale-0-0"]')).toHaveCount(0);

  // Edit one visible sticky: the save names it alone.
  const targetId = await owner.page.evaluate(() => document.elementFromPoint(870, 500)?.closest('[data-node-id]')?.dataset.nodeId);
  expect(targetId).toMatch(/^scale-/);
  const box = await owner.page.locator(`[data-node-id="${targetId}"]`).boundingBox();
  await owner.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(owner.page.locator('[data-rich-editor]')).toBeFocused();
  await owner.page.keyboard.press('ControlOrMeta+a');
  await owner.page.keyboard.type('Edited at scale');
  const save = owner.page.waitForResponse(isSave);
  await owner.page.mouse.click(5, 450);
  const response = await save;
  const saveMethod = response.request().method();
  const saveBytes = response.request().postData().length;

  const metrics = { stickies: nodes.length, arrows: connectors.length, loadMs, loadedCount, loadedElements, panMs, pannedCount, pannedElements, saveMethod, saveBytes, fullBoardBytes };
  console.log(`BOARD_SCALE_METRICS ${JSON.stringify(metrics)}`);
  await info.attach('metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  await info.attach('panned', { body: await owner.page.screenshot(), contentType: 'image/png' });

  expect(response.status()).toBe(200);
  expect(loadedCount).toBeLessThan(200);
  expect(pannedCount).toBeLessThan(200);
  // Off-screen arrows are not mounted either (every arrow mounted is about 6,000 elements).
  expect(loadedElements).toBeLessThan(1500);
  expect(pannedElements).toBeLessThan(1500);
  expect(saveMethod).toBe('PATCH');
  expect(saveBytes).toBeLessThan(4000);
  await expect.poll(async () => {
    const data = (await (await owner.page.request.get(boardPath)).json()).data;
    return data.nodes.length === nodes.length && data.connectors.length === connectors.length && data.nodes.find((node) => node.id === targetId)?.text?.includes('Edited at scale');
  }).toBeTruthy();
  await owner.context.close();
});
