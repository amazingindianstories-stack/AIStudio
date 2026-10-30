import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000041', name: 'Arrange owner', email: 'arrange-owner@example.test' };

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
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());
const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

test('Board arrange: lasso, precise marquee, filter, align, guides, ruler, smart duplicate, clear content and auto layout', async ({ browser, baseURL }, info) => {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board arrange ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, project.id);
  await page.goto('/');
  const canvas = await openBoard(page);
  const placed = page.waitForResponse(isSave);
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await canvas.click({ position: { x: 300, y: 300 } });
  const boardPath = new URL((await placed).url()).pathname;
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await (await page.request.get(boardPath)).json()).data.nodes.length).toBe(1);
  const stored = await (await page.request.get(boardPath)).json();
  const [template] = stored.data.nodes;
  const sticky = (id, x, y, text) => ({ ...template, id, x, y, w: 120, h: 120, text, parentId: null, groupId: null });
  const nodes = [
    sticky('arr-a', 300, 200, 'Alpha'),
    sticky('arr-b', 600, 240, 'Beta'),
    { id: 'arr-r', type: 'rect', x: 900, y: 210, w: 100, h: 100, fill: '#ffffff', stroke: '#000000', strokeWidth: 2, opacity: 1, parentId: null, groupId: null },
    sticky('arr-f', 300, 560, 'Far'),
  ];
  // The asset panel covers the canvas's left edge: the board starts scrolled so everything sits right of it.
  const seeded = await context.request.put(boardPath, {
    data: { data: { ...stored.data, viewport: { x: -250, y: 0, zoom: 1 }, nodes, connectors: [] }, baseVersion: stored.version, saveId: randomUUID() },
    headers: { Origin: baseURL } });
  expect(seeded.status()).toBe(200);
  await page.reload();
  await openBoard(page);
  const node = (id) => page.locator(`[data-node-id="${id}"]`);
  await expect(node('arr-a')).toBeVisible();
  await expect(node('arr-r')).toBeVisible();

  const board = async () => (await (await page.request.get(boardPath)).json()).data;
  const storedNode = async (id) => (await board()).nodes.find((n) => n.id === id);
  // Screen position of a world point, measured from Alpha's on-screen box.
  const aBox = await node('arr-a').boundingBox();
  const zoom = aBox.width / 120;
  const screenOf = (x, y) => ({ x: aBox.x + (x - 300) * zoom, y: aBox.y + (y - 200) * zoom });
  const alignButton = page.getByRole('button', { name: 'Align', exact: true });
  const filterButton = page.getByRole('button', { name: 'Filter selection', exact: true });

  // Lasso: loop around Alpha, Beta and the rectangle (not Far) and the selection holds all three.
  await page.getByRole('button', { name: 'Lasso select', exact: true }).click();
  const loop = [[270, 170], [700, 150], [1040, 180], [1040, 400], [600, 420], [270, 400]].map(([x, y]) => screenOf(x, y));
  await page.mouse.move(loop[0].x, loop[0].y);
  await page.mouse.down();
  for (const p of loop.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
  await expect(page.getByTestId('lasso-path')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('lasso-path')).toHaveCount(0);
  await expect(alignButton).toBeVisible();

  // Filter: two sticky notes and one shape; picking Shapes leaves just the rectangle.
  await filterButton.click();
  await expect(page.getByRole('menuitem', { name: 'Sticky notes, 2' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Shapes, 1' }).click();
  await expect(filterButton).toHaveCount(0);
  await expect(alignButton).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A plain marquee picks everything it touches: Alpha and half of Beta.
  const m0 = screenOf(260, 160);
  const m1 = screenOf(660, 400);
  await page.mouse.move(m0.x, m0.y);
  await page.mouse.down();
  await page.mouse.move(m1.x, m1.y, { steps: 8 });
  await page.mouse.up();
  await expect(alignButton).toBeVisible();
  await page.mouse.click(screenOf(800, 500).x, screenOf(800, 500).y);
  await expect(alignButton).toHaveCount(0);

  // The same marquee after a held press is precise: only Alpha, which it fully covers.
  await page.mouse.move(m0.x, m0.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.move(m1.x, m1.y, { steps: 8 });
  await expect(page.getByTestId('precise-marquee')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('precise-marquee')).toHaveCount(0);
  await expect(alignButton).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible();

  // Distance ruler: Alpha selected, Option/Alt held over Beta shows the 180 gap between them.
  const aCenter = centerOf(await node('arr-a').boundingBox());
  await page.mouse.click(aCenter.x, aCenter.y);
  await page.keyboard.down('Alt');
  const bCenter = centerOf(await node('arr-b').boundingBox());
  await page.mouse.move(bCenter.x, bCenter.y, { steps: 3 });
  await expect(page.getByTestId('distance-ruler').filter({ hasText: '180' })).toBeVisible();
  await page.keyboard.up('Alt');
  await expect(page.getByTestId('distance-ruler')).toHaveCount(0);

  // Align from the context menu: Alpha and Beta, Align top, one save that lines Beta up with Alpha.
  await page.keyboard.down('Shift');
  await page.mouse.click(bCenter.x, bCenter.y);
  await page.keyboard.up('Shift');
  await expect(alignButton).toBeVisible();
  await page.mouse.click(bCenter.x, bCenter.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Align', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Align top' }).click();
  await expect.poll(async () => (await storedNode('arr-b')).y).toBe(200);
  expect((await storedNode('arr-a')).y).toBe(200);

  // Alignment guides: drag Far towards Beta's left edge; it snaps to x = 600 and a guide shows.
  const fCenter = centerOf(await node('arr-f').boundingBox());
  await page.mouse.click(screenOf(800, 500).x, screenOf(800, 500).y);
  await page.mouse.move(fCenter.x, fCenter.y);
  await page.mouse.down();
  await page.mouse.move(fCenter.x + 297 * zoom, fCenter.y + 40 * zoom, { steps: 12 });
  // A guide is a 1px SVG line with no area, so Playwright counts it as hidden: check it is drawn instead.
  await expect(page.getByTestId('alignment-guide').first()).toBeAttached();
  await page.mouse.up();
  await expect(page.getByTestId('alignment-guide')).toHaveCount(0);
  await expect.poll(async () => (await storedNode('arr-f')).x).toBe(600);

  // Smart duplicate: Option/Alt+Right copies Alpha 20 beyond its right edge and selects the copy.
  await page.mouse.click(aCenter.x, aCenter.y);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => (await board()).nodes.length).toBe(5);
  const copy = (await board()).nodes.find((n) => !nodes.some((seed) => seed.id === n.id));
  expect([copy.x, copy.y, copy.text]).toEqual([440, 200, 'Alpha']);

  // Clear content: Cmd/Ctrl+Backspace empties the selected copy, keeps its colour and keeps Alpha's text.
  await page.keyboard.press('ControlOrMeta+Backspace');
  await expect.poll(async () => (await storedNode(copy.id)).text).toBe('');
  expect((await storedNode(copy.id)).fill).toBe(template.fill);
  expect((await storedNode('arr-a')).text).toBe('Alpha');
  expect((await board()).nodes.length).toBe(5);

  // Auto layout: Alpha, the copy and Beta in a row; drag the spacing handle to space them evenly.
  await page.keyboard.down('Shift');
  await page.mouse.click(aCenter.x, aCenter.y);
  await page.mouse.click(bCenter.x, bCenter.y);
  await page.keyboard.up('Shift');
  const handle = page.getByTestId('auto-layout-handle');
  await expect(handle).toBeVisible();
  const h = centerOf(await handle.boundingBox());
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x + 120 * zoom, h.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => {
    const all = await board();
    const row = ['arr-a', copy.id, 'arr-b'].map((id) => all.nodes.find((n) => n.id === id)).sort((p, q) => p.x - q.x);
    return { ys: row.map((n) => n.y), gaps: [row[1].x - row[0].x - 120, row[2].x - row[1].x - 120] };
  }).toEqual({ ys: [200, 200, 200], gaps: [90, 90] });

  // Each command was one undo step: undo puts the row back where the copy sat.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await storedNode(copy.id)).x).toBe(440);

  await info.attach('arranged', { body: await page.screenshot(), contentType: 'image/png' });
  await context.close();
});
