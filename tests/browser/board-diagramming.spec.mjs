import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000021', name: 'Diagram owner', email: 'diagram-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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

let boardPath = '';

/**
 * Waits for an autosave after `action`, then returns the stored board once `ready` holds. The
 * first save response can belong to an earlier edit still in flight, so poll the stored board.
 */
async function saved(page, action, ready) {
  const response = page.waitForResponse(isSave);
  await action();
  const result = await response;
  expect(result.status()).toBe(200);
  boardPath = new URL(result.url()).pathname;
  let board;
  await expect.poll(async () => {
    board = await (await page.context().request.get(boardPath)).json();
    return ready(board);
  }, { timeout: 15000 }).toBe(true);
  return board;
}

/** Screen point (page coordinates) of a world point on a board at zoom 1. */
async function screenPoint(canvas, board, world) {
  const box = await canvas.boundingBox();
  const vp = board.data.viewport;
  return { x: box.x + (world.x - vp.x) * vp.zoom, y: box.y + (world.y - vp.y) * vp.zoom };
}


const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><path d="M2 2 L22 2 L12 22 Z" fill="none" stroke="#000"/></svg>';

/** Opens the shapes panel with S, searches it and places the named shape at a canvas position. */
async function place(page, canvas, search, label, position) {
  await page.keyboard.press('s');
  const panel = page.getByRole('menu');
  await panel.getByLabel('Search shapes').fill(search);
  await panel.getByRole('menuitem', { name: label, exact: true }).first().click();
  await expect(panel).toHaveCount(0);
  await canvas.click({ position });
}

test('Board diagramming: shape packs, structured objects, connection lines, quick diagrams and custom packs', async ({ browser, baseURL }, info) => {
  test.setTimeout(150000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board diagramming ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openBoard(page);

  // Shapes panel: searchable across packs, a flowchart shape and a pack-only shape land as path shapes.
  await place(page, canvas, 'database', 'Database', { x: 300, y: 200 });
  await place(page, canvas, 'terminator', 'Terminator', { x: 620, y: 200 });
  await info.attach('shapes-panel-search', { body: await page.screenshot(), contentType: 'image/png' });
  let board = await saved(page, () => place(page, canvas, 'kubernetes pod', 'Kubernetes Pod', { x: 940, y: 200 }),
    (b) => b.data.nodes.length === 3);
  expect(board.data.nodes.map((node) => node.shape)).toEqual(['fc-database', 'fc-terminator', 'k8s-pod']);
  const [database, terminator] = board.data.nodes;

  // Structured objects: an ER entity, a swimlane pool and a diagram container.
  await place(page, canvas, 'entity', 'ER entity table', { x: 300, y: 420 });
  await place(page, canvas, 'pool', 'Swimlane pool (horizontal)', { x: 700, y: 420 });
  board = await saved(page, () => place(page, canvas, 'container', 'Diagram container', { x: 300, y: 780 }),
    (b) => b.data.nodes.length === 6);
  expect(board.data.nodes.slice(3).map((node) => node.type)).toEqual(['erd', 'swimlane', 'diagram']);
  expect(board.data.nodes[4].lanes.length).toBeGreaterThanOrEqual(2);
  await expect(page.locator(`[data-node-id="${board.data.nodes[3].id}"]`)).toBeVisible();

  // Connection line: drag from the database's right handle onto the terminator.
  await page.mouse.click(1380, 960);
  const dbCenter = await screenPoint(canvas, board, { x: database.x + database.w / 2, y: database.y + database.h / 2 });
  await page.mouse.move(dbCenter.x, dbCenter.y);
  const handle = page.locator(`[data-node-id="${database.id}"]`).getByRole('button', { name: 'Draw connector from right edge' });
  const handleBox = await handle.boundingBox();
  const termCenter = await screenPoint(canvas, board, { x: terminator.x + terminator.w / 2, y: terminator.y + terminator.h / 2 });
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  board = await saved(page, async () => {
    await page.mouse.down();
    await page.mouse.move(termCenter.x, termCenter.y, { steps: 10 });
    await page.mouse.up();
  }, (b) => b.data.connectors.length === 1);
  expect(board.data.connectors).toHaveLength(1);
  const connectorId = board.data.connectors[0].id;

  // Line types, arrowheads and labels from the inspector.
  const connector = page.locator(`[data-connector-id="${connectorId}"]`).first();
  await connector.click({ force: true });
  await page.getByRole('button', { name: 'Orthogonal line' }).click();
  await page.getByLabel('End cap').selectOption('open-arrow');
  await page.getByLabel('Start cap').selectOption('diamond');
  await page.getByRole('button', { name: 'Add line label' }).click();
  await page.getByLabel('Line label text').fill('yes');
  board = await saved(page, () => page.getByRole('button', { name: 'Dashed border' }).click(),
    (b) => b.data.connectors[0]?.strokeStyle === 'dashed');
  const line = board.data.connectors[0];
  expect([line.shape, line.endCap, line.startCap, line.strokeStyle, line.labels[0].text]).toEqual(['orthogonal', 'open-arrow', 'diamond', 'dashed', 'yes']);
  await info.attach('connection-line', { body: await page.screenshot(), contentType: 'image/png' });

  // Insert a shape on the line: one connector becomes two with a node between.
  board = await saved(page, () => page.getByRole('button', { name: 'Insert shape on line' }).click(),
    (b) => b.data.connectors.length === 2);
  expect(board.data.connectors).toHaveLength(2);
  expect(board.data.nodes).toHaveLength(7);
  const [first, second] = board.data.connectors;
  expect(first.to.nodeId).toBe(second.from.nodeId);

  // Quick diagram creation: a selected shape's handle click makes a linked copy and a connector.
  await page.mouse.click(1380, 960);
  const pod = board.data.nodes.find((node) => node.shape === 'k8s-pod');
  const podCenter = await screenPoint(canvas, board, { x: pod.x + pod.w / 2, y: pod.y + pod.h / 2 });
  await page.mouse.click(podCenter.x, podCenter.y);
  const quick = page.locator(`[data-node-id="${pod.id}"]`).getByRole('button', { name: 'Draw connector from bottom edge' });
  board = await saved(page, () => quick.click(), (b) => b.data.connectors.length === 3);
  expect(board.data.nodes).toHaveLength(8);
  expect(board.data.connectors).toHaveLength(3);
  expect(board.data.connectors[2].from.nodeId).toBe(pod.id);

  // Custom shape pack: the sanitizer strips the script, and the shape places on the board.
  await page.keyboard.press('s');
  const panel = page.getByRole('menu');
  await panel.getByRole('button', { name: 'New custom shape pack' }).click();
  await panel.getByLabel('Custom shape pack name').fill('Plant icons');
  await panel.getByRole('button', { name: 'Create pack' }).click();
  await page.getByLabel('Upload SVG to Plant icons').setInputFiles({ name: 'valve.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) });
  await expect(panel.getByRole('menuitem', { name: 'valve' })).toBeVisible();
  const packs = await (await context.request.get('/api/canvas-shape-packs')).json();
  expect(packs.packs).toHaveLength(1);
  expect(JSON.stringify(packs.packs[0].shapes)).not.toContain('script');
  await panel.getByRole('menuitem', { name: 'valve' }).click();
  await expect(panel).toHaveCount(0);
  await canvas.click({ position: { x: 1100, y: 780 } });
  await expect.poll(async () => {
    board = await (await context.request.get(boardPath)).json();
    return board.data.nodes.find((node) => node.svg)?.svg ?? '';
  }).toContain('<path');
  expect(JSON.stringify(board.data)).not.toContain('script');

  expect(errors).toEqual([]);
  await context.close();
});
