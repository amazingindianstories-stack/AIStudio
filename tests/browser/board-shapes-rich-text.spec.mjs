import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000011', name: 'Shapes owner', email: 'shapes-owner@example.test' };
const VIEWER = { id: 'b0a2d000-0000-4000-8000-000000000012', name: 'Shapes viewer', email: 'shapes-viewer@example.test' };

// The basic shapes panel, in order, with the node each entry creates.
const SHAPES = [
  ['Rectangle', 'rect'], ['Rounded rectangle', 'rect'], ['Circle', 'ellipse'], ['Triangle', 'triangle'], ['Diamond', 'diamond'],
  ['Parallelogram', 'parallelogram'], ['Trapezoid', 'trapezoid'], ['Pentagon', 'pentagon'], ['Hexagon', 'hexagon'],
  ['Octagon', 'octagon'], ['Star', 'star'], ['Cross', 'cross'], ['Cylinder', 'cylinder'], ['Left arrow', 'arrow-left'],
  ['Right arrow', 'arrow-right'], ['Double arrow', 'arrow-both'], ['Chevron', 'chevron'], ['Speech bubble', 'callout'], ['Cloud', 'cloud'],
];

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

/** Waits for the autosave that follows `action`, then returns the stored board. */
async function saved(page, action) {
  const response = page.waitForResponse(isSave);
  await action();
  const result = await response;
  expect(result.status()).toBe(200);
  const board = await (await page.context().request.get(new URL(result.url()).pathname)).json();
  return board;
}

/** Screen point (page coordinates) of a world point on a board at zoom 1. */
async function screenPoint(canvas, board, world) {
  const box = await canvas.boundingBox();
  const vp = board.data.viewport;
  return { x: box.x + (world.x - vp.x) * vp.zoom, y: box.y + (world.y - vp.y) * vp.zoom };
}

/** Selects [start, end) of the open editor's text, by UTF-16 offsets. */
async function selectText(page, start, end) {
  await page.evaluate(([from, to]) => {
    const editor = document.querySelector('[data-rich-editor]');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const length = node.data.length;
      if (from >= offset && from <= offset + length && range.startContainer === document) range.setStart(node, from - offset);
      if (to >= offset && to <= offset + length) { range.setEnd(node, to - offset); break; }
      offset += length;
    }
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, [start, end]);
}

test('Board shapes and rich text: every basic shape, outline hit-testing and anchors, formatted text, read-only viewers', async ({ browser, baseURL }, info) => {
  // Places 19 shapes, edits three texts and opens a second session: longer than the default budget.
  test.setTimeout(180000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, VIEWER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board shapes ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openBoard(page);

  // S opens the shapes panel; each basic shape is placed with one click.
  let board;
  for (const [index, [label]] of SHAPES.entries()) {
    await page.keyboard.press('s');
    const panel = page.getByRole('menu');
    await expect(panel.getByRole('group', { name: 'Basic shapes' })).toBeVisible();
    if (index === 0) {
      await info.attach('shapes-panel', { body: await page.screenshot(), contentType: 'image/png' });
    }
    await panel.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(panel).toHaveCount(0);
    const position = { x: 420 + (index % 5) * 210, y: 130 + Math.floor(index / 5) * 175 };
    if (index === SHAPES.length - 1) board = await saved(page, () => canvas.click({ position }));
    else await canvas.click({ position });
  }
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${board.id}`)).json();
    return board.data.nodes.length;
  }).toBe(SHAPES.length);
  expect(board.data.nodes.map((node) => node.type === 'shape' ? node.shape : node.type)).toEqual(SHAPES.map(([, kind]) => kind));
  expect(board.data.nodes[0].cornerRadius).toBe(0);
  expect(board.data.nodes[1].cornerRadius).toBe(16);
  for (const node of board.data.nodes.filter((item) => item.type === 'shape')) {
    await expect(page.locator(`[data-node-id="${node.id}"] [data-shape-outline="${node.shape}"]`)).toBeVisible();
  }
  await page.mouse.click(300 + 1100, 900);
  await info.attach('all-basic-shapes', { body: await page.screenshot(), contentType: 'image/png' });

  // Hit-testing follows the outline: the empty corner of the star's box selects nothing.
  const star = board.data.nodes.find((node) => node.shape === 'star');
  const starRing = page.locator(`[data-node-id="${star.id}"] .ring-brand`);
  const corner = await screenPoint(canvas, board, { x: star.x + 4, y: star.y + 4 });
  await page.mouse.click(corner.x, corner.y);
  await expect(starRing).toHaveCount(0);
  const starCenter = await screenPoint(canvas, board, { x: star.x + star.w / 2, y: star.y + star.h / 2 });
  await page.mouse.click(starCenter.x, starCenter.y);
  await expect(starRing).toHaveCount(1);

  // Resize keeps the kind and scales the outline.
  const handle = page.locator(`[data-node-id="${star.id}"]`).getByRole('button', { name: 'Resize se' });
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + 4, handleBox.y + 4);
  board = await saved(page, async () => {
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 44, handleBox.y + 34, { steps: 6 });
    await page.mouse.up();
  });
  const resized = board.data.nodes.find((node) => node.id === star.id);
  expect([resized.shape, Math.round(resized.w), Math.round(resized.h)]).toEqual(['star', Math.round(star.w + 40), Math.round(star.h + 30)]);

  // Connector handles sit on the outline: the star's top handle touches its top tip.
  await page.mouse.click(1380, 900);
  const resizedCenter = await screenPoint(canvas, board, { x: resized.x + resized.w / 2, y: resized.y + resized.h / 2 });
  await page.mouse.move(resizedCenter.x, resizedCenter.y);
  const topHandle = page.locator(`[data-node-id="${star.id}"]`).getByRole('button', { name: 'Draw connector from top edge' });
  await expect(topHandle).toBeVisible();
  const topBox = await topHandle.boundingBox();
  const tip = await screenPoint(canvas, board, { x: resized.x + resized.w / 2, y: resized.y });
  expect(Math.abs(topBox.x + topBox.width / 2 - tip.x)).toBeLessThan(2);
  expect(Math.abs(topBox.y + topBox.height - tip.y)).toBeLessThan(2);
  const hexagon = board.data.nodes.find((node) => node.shape === 'hexagon');
  const hexagonCenter = await screenPoint(canvas, board, { x: hexagon.x + hexagon.w / 2, y: hexagon.y + hexagon.h / 2 });
  await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2);
  board = await saved(page, async () => {
    await page.mouse.down();
    await page.mouse.move(hexagonCenter.x, hexagonCenter.y, { steps: 10 });
    await page.mouse.up();
  });
  expect(board.data.connectors.map(({ from, to }) => ({ from, to }))).toEqual([
    { from: { nodeId: star.id, anchor: 'top' }, to: { nodeId: hexagon.id, anchor: 'auto' } },
  ]);

  // Rich text in a text box: every format, partial ranges, keyboard shortcuts and the format bar.
  await page.keyboard.press('t');
  await canvas.click({ position: { x: 520, y: 820 } });
  const editor = page.locator('[data-rich-editor]');
  await expect(editor).toBeFocused();
  const sentence = 'Bold italic under strike mark link';
  await page.keyboard.type(sentence);
  await selectText(page, 0, 4);
  await page.keyboard.press('ControlOrMeta+b');
  const formatBar = page.getByRole('group', { name: 'Text formatting' });
  await expect(formatBar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await selectText(page, 5, 11);
  await page.keyboard.press('ControlOrMeta+i');
  await selectText(page, 12, 17);
  await page.keyboard.press('ControlOrMeta+u');
  await selectText(page, 18, 24);
  await formatBar.getByRole('button', { name: 'Strikethrough' }).click();
  await selectText(page, 25, 29);
  await formatBar.getByRole('button', { name: 'Highlight' }).click();
  await formatBar.getByRole('button', { name: 'Yellow highlight' }).click();
  await selectText(page, 30, 34);
  await page.keyboard.press('ControlOrMeta+k');
  const linkField = formatBar.getByLabel('Link address');
  await expect(linkField).toBeFocused();
  // The wrapped text stays fully in view while editing: the box and its selection ring grow
  // instead of scrolling the first line up under the format bar.
  expect(await editor.evaluate((el) => ({ scrollTop: el.scrollTop, clipped: el.scrollHeight > el.clientHeight })))
    .toEqual({ scrollTop: 0, clipped: false });
  const editorBox = await editor.boundingBox();
  const barBox = await formatBar.boundingBox();
  const nodeBox = await editor.locator('xpath=ancestor::*[@data-node-id][1]').boundingBox();
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(editorBox.y);
  expect(nodeBox.y + nodeBox.height).toBeGreaterThanOrEqual(editorBox.y + editorBox.height);
  await info.attach('format-bar-link', { body: await page.screenshot(), contentType: 'image/png' });
  await linkField.fill('example.com/docs');
  await linkField.press('Enter');
  await expect(editor).toBeFocused();
  board = await saved(page, () => page.keyboard.press('ControlOrMeta+Enter'));
  const textNode = board.data.nodes.find((node) => node.type === 'text');
  expect(textNode.text).toBe(sentence);
  // Formatting wrapped the sentence onto a second line; the box grew to show it.
  expect(textNode.h).toBeGreaterThan(40);
  expect(textNode.marks).toEqual([
    [0, 4, 'b'], [5, 11, 'i'], [12, 17, 'u'], [18, 24, 's'], [25, 29, 'h', '#fde047'], [30, 34, 'a', 'https://example.com/docs'],
  ]);
  const shownText = page.locator(`[data-node-id="${textNode.id}"]`);
  await expect(shownText.locator('b')).toHaveText('Bold');
  await expect(shownText.locator('i')).toHaveText('italic');
  await expect(shownText.locator('a')).toHaveAttribute('href', 'https://example.com/docs');
  await expect(shownText.locator('a')).toHaveAttribute('rel', 'noopener noreferrer nofollow');

  // Partial formatting inside a shape: double-click the star to type into it.
  const starNow = board.data.nodes.find((node) => node.id === star.id);
  const starMiddle = await screenPoint(canvas, board, { x: starNow.x + starNow.w / 2, y: starNow.y + starNow.h / 2 });
  await page.mouse.dblclick(starMiddle.x, starMiddle.y);
  await expect(editor).toBeFocused();
  await page.keyboard.type('Go now');
  await selectText(page, 0, 2);
  await page.keyboard.press('ControlOrMeta+b');
  board = await saved(page, () => page.keyboard.press('ControlOrMeta+Enter'));
  const starText = board.data.nodes.find((node) => node.id === star.id);
  expect([starText.text, starText.marks]).toEqual(['Go now', [[0, 2, 'b']]]);

  // A sticky: pasted HTML arrives as plain text only.
  await page.keyboard.press('n');
  await canvas.click({ position: { x: 1000, y: 800 } });
  await expect(editor).toBeFocused();
  await page.keyboard.type('Sticky ');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<img src="x" onerror="window.__pasted=1"><b>loud</b><a href="javascript:alert(1)">bad</a>');
    data.setData('text/plain', 'pasted');
    document.querySelector('[data-rich-editor]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor).not.toContainText('loud');
  expect(await editor.locator('img, a, b').count()).toBe(0);
  await selectText(page, 0, 6);
  await page.keyboard.press('ControlOrMeta+i');
  // Placing the sticky queued a debounced autosave of the empty note, which can land after this
  // commit starts; wait for the stored board to carry the committed text rather than the next save.
  await canvas.click({ position: { x: 1300, y: 860 } });
  let sticky;
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${board.id}`)).json();
    sticky = board.data.nodes.find((node) => node.type === 'sticky');
    return [sticky?.text, sticky?.marks];
  }).toEqual(['Sticky pasted', [[0, 6, 'i']]]);
  expect(await page.evaluate(() => window.__pasted)).toBeUndefined();
  await info.attach('formatted-text', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);

  // A viewer sees the shapes and formatting but cannot open the panel or edit text.
  await db`UPDATE canvas_boards SET team_role = 'view' WHERE id = ${board.id}`;
  const viewer = await signIn(browser, baseURL, VIEWER, project.id);
  const writes = [];
  viewer.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && request.method() !== 'GET') writes.push(request.url());
  });
  await openBoard(viewer.page);
  await expect(viewer.page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Shapes', exact: true })).toHaveCount(0);
  await viewer.page.keyboard.press('s');
  await expect(viewer.page.getByRole('menu')).toHaveCount(0);
  const viewerText = viewer.page.locator(`[data-node-id="${textNode.id}"]`);
  await expect(viewerText.locator('b')).toHaveText('Bold');
  await expect(viewerText.locator('a')).toHaveAttribute('title', 'https://example.com/docs');
  await viewerText.dblclick();
  await viewer.page.locator(`[data-node-id="${star.id}"] [data-shape-outline="star"]`).dblclick();
  await expect(viewer.page.locator('[data-rich-editor]')).toHaveCount(0);
  await viewer.page.keyboard.press('ControlOrMeta+b');
  await viewer.page.waitForTimeout(2000);
  expect(writes).toEqual([]);
  await info.attach('viewer', { body: await viewer.page.screenshot(), contentType: 'image/png' });

  await viewer.context.close();
  await context.close();
});
