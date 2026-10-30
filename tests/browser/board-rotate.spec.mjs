import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000031', name: 'Rotate owner', email: 'rotate-owner@example.test' };

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

test('Board rotate: objects turn by handle and by number, resize precisely, and frames stay upright', async ({ browser, baseURL }, info) => {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board rotate ${randomUUID()}` }, headers: { Origin: baseURL } });
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
  const nodes = [
    { ...template, id: 'rot-a', x: 300, y: 250, w: 160, h: 160, text: 'Alpha', parentId: null },
    { ...template, id: 'rot-b', x: 600, y: 250, w: 160, h: 160, text: 'Beta', parentId: null },
    { id: 'rot-frame', type: 'frame', x: 300, y: 560, w: 360, h: 200, name: 'Upright frame', fill: 'transparent', stroke: '#888888', parentId: null, groupId: null },
  ];
  const seeded = await context.request.put(boardPath, {
    data: { data: { ...stored.data, viewport: { x: 0, y: 0, zoom: 1 }, nodes, connectors: [] }, baseVersion: stored.version, saveId: randomUUID() },
    headers: { Origin: baseURL } });
  expect(seeded.status()).toBe(200);
  await page.reload();
  await openBoard(page);
  const nodeA = page.locator('[data-node-id="rot-a"]');
  const nodeB = page.locator('[data-node-id="rot-b"]');
  await expect(nodeA).toBeVisible();

  const storedNode = async (id) => (await (await page.request.get(boardPath)).json()).data.nodes.find((n) => n.id === id);
  const rotationOf = async (id) => (await storedNode(id))?.rotation ?? 0;

  // One object: Shift-drag the handle a quarter turn clockwise; it snaps to 90 degrees.
  const aCenter = centerOf(await nodeA.boundingBox());
  await page.mouse.click(aCenter.x, aCenter.y);
  const handle = page.getByRole('button', { name: 'Rotate', exact: true });
  await expect(handle).toBeVisible();
  const handleCenter = centerOf(await handle.boundingBox());
  await page.keyboard.down('Shift');
  await page.mouse.move(handleCenter.x, handleCenter.y);
  await page.mouse.down();
  await page.mouse.move(aCenter.x + 60, aCenter.y - 40, { steps: 6 });
  await page.mouse.move(aCenter.x + 140, aCenter.y + 3, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(nodeA).toHaveAttribute('style', /rotate\(90deg\)/);
  await expect.poll(() => rotationOf('rot-a')).toBe(90);
  // The object stayed where it was: only its angle changed.
  expect(await storedNode('rot-a')).toMatchObject({ x: 300, y: 250, w: 160, h: 160 });

  // Undo and redo each take the whole turn.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rotationOf('rot-a')).toBe(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => rotationOf('rot-a')).toBe(90);

  // Typed size and angle: W 200, rotation 45.
  await page.getByRole('button', { name: 'Size and rotation', exact: true }).click();
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await expect(width).toHaveValue('160');
  await width.fill('200');
  await width.press('Enter');
  await expect.poll(async () => (await storedNode('rot-a')).w).toBe(200);
  // Deleting characters in a field never deletes the selected object.
  await width.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(width).toHaveValue('20');
  await page.keyboard.press('Escape');
  await expect(nodeA).toBeVisible();
  const angle = page.getByRole('textbox', { name: 'Rotation', exact: true });
  if (!(await angle.isVisible())) await page.getByRole('button', { name: 'Size and rotation', exact: true }).click();
  await angle.fill('45');
  await angle.press('Enter');
  await expect.poll(() => rotationOf('rot-a')).toBe(45);
  expect((await storedNode('rot-a')).w).toBe(200);
  await page.keyboard.press('Escape');

  // A click inside the turned object, but outside where it sat upright, selects it.
  await page.mouse.click(1100, 450);
  await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toHaveCount(0);
  const turned = await storedNode('rot-a');
  // The drawn box turns about the object's center, so its screen box shares that center.
  const screenCenter = centerOf(await nodeA.boundingBox());
  const zoom = (await page.locator('[data-node-id="rot-frame"]').boundingBox()).width / 360;
  // 95 px straight above the center: past the upright top edge (80 px up), inside the box turned 45 degrees.
  expect(turned.h / 2).toBeLessThan(95);
  const outsideUpright = { x: screenCenter.x, y: screenCenter.y - 95 * zoom };
  await page.mouse.click(outsideUpright.x, outsideUpright.y);
  await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toBeVisible();
  await info.attach('rotated-selected', { body: await page.screenshot(), contentType: 'image/png' });

  // A multi-selection turns about the middle of the pair: each object orbits and turns.
  const bCenter = centerOf(await nodeB.boundingBox());
  await page.keyboard.down('Shift');
  await page.mouse.click(bCenter.x, bCenter.y);
  await page.keyboard.up('Shift');
  const groupHandle = page.getByRole('button', { name: 'Rotate selection', exact: true });
  await expect(groupHandle).toBeVisible();
  const before = { a: await storedNode('rot-a'), b: await storedNode('rot-b') };
  const groupHandleCenter = centerOf(await groupHandle.boundingBox());
  const pairCenter = { x: groupHandleCenter.x, y: (centerOf(await nodeA.boundingBox()).y + bCenter.y) / 2 };
  await page.keyboard.down('Shift');
  await page.mouse.move(groupHandleCenter.x, groupHandleCenter.y);
  await page.mouse.down();
  await page.mouse.move(pairCenter.x + 150, pairCenter.y - 150, { steps: 6 });
  await page.mouse.move(pairCenter.x + 300, pairCenter.y + 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => rotationOf('rot-b')).toBe(90);
  expect(await rotationOf('rot-a')).toBe(135);
  const after = { a: await storedNode('rot-a'), b: await storedNode('rot-b') };
  // B, right of the pair's middle, swung below it; A swung above.
  expect(after.b.y).toBeGreaterThan(before.b.y + 100);
  expect(after.a.y).toBeLessThan(before.a.y - 100);
  await info.attach('group-rotated', { body: await page.screenshot(), contentType: 'image/png' });

  // Frames have no rotation handle and no angle field.
  await page.mouse.click(1100, 450);
  const frame = page.locator('[data-node-id="rot-frame"]');
  const frameBox = await frame.boundingBox();
  await page.mouse.click(frameBox.x + 40, frameBox.y + frameBox.height - 20);
  await expect(page.getByRole('button', { name: 'Size and rotation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rotate', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Size and rotation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Width', exact: true })).toHaveValue('360');
  await expect(page.getByRole('textbox', { name: 'Rotation', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await rotationOf('rot-frame')).toBe(0);
  await context.close();
});
