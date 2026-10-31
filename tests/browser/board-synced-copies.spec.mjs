import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// The board owner, and a teammate who only comments on the board holding the copies.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000051', name: 'Synced owner', email: 'synced-owner@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000052', name: 'Synced commenter', email: 'synced-commenter@example.test' };

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

async function openBoards(page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  // The asset panel covers the left of the canvas; out of the way, every copy and control on the board is reachable.
  await page.getByRole('button', { name: 'Collapse asset panel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show asset panel', exact: true })).toBeVisible();
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Opens `board` from the board switcher, unless it is already the open board. */
async function switchTo(page, boards, board) {
  const trigger = page.getByRole('button', { name: new RegExp(`^(${boards.map((b) => escape(b.name)).join('|')})$`) });
  await expect(trigger).toBeVisible();
  if ((await trigger.textContent()).trim() === board.name) return;
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/canvas-boards/${board.id}` &&
    response.request().method() === 'GET');
  await trigger.click();
  await page.getByRole('menuitem', { name: board.name }).click();
  expect((await loaded).status()).toBe(200);
  await expect(trigger).toHaveText(board.name);
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());

/** Inserts a synced copy of `label` from `source` with the toolbar picker and returns the saved copy's id. */
async function insertCopy(page, source, label) {
  await page.getByRole('button', { name: 'Synced copy', exact: true }).click();
  const picker = page.getByRole('menu');
  await picker.getByRole('combobox', { name: 'Source board' }).selectOption(source.id);
  const choice = picker.getByRole('button', { name: label, exact: true });
  await expect(choice).toBeVisible();
  const saved = page.waitForResponse(isSave);
  await choice.click();
  expect((await saved).status()).toBe(200);
}

/** The screen positions of a connector path's two ends. */
async function connectorEnds(path) {
  return path.evaluate((element) => {
    const matrix = element.getScreenCTM();
    const at = (length) => {
      const point = element.getPointAtLength(length);
      return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
    };
    return [at(0), at(element.getTotalLength())];
  });
}

const sticky = (id, text, x, y, parentId, layer) => ({ id, type: 'sticky', x, y, w: 100, h: 80, text, fill: '#fff59d', fontSize: 16,
  color: '#000000', parentId, groupId: null, ...(layer ? { diagramLayerId: layer } : {}) });
const link = (id, from, to) => ({ id, from: { nodeId: from }, to: { nodeId: to }, kind: 'arrow', shape: 'straight', stroke: '#ffffff', strokeWidth: 2 });

// A diagram whose "Drafts" layer is hidden, and a frame its owner hides from everyone else.
const SOURCE_GRAPH = {
  version: 1,
  viewport: { x: -200, y: -150, zoom: 1 },
  nodes: [
    { id: 'flow', type: 'diagram', x: 0, y: 0, w: 440, h: 240, name: 'Flow', fill: 'transparent', stroke: '#ffffff', strokeWidth: 2,
      parentId: null, groupId: null, layers: [{ id: 'main', name: 'Main', visible: true }, { id: 'drafts', name: 'Drafts', visible: false }] },
    sticky('start', 'Start', 40, 80, 'flow', 'main'),
    sticky('finish', 'Finish', 300, 80, 'flow', 'main'),
    sticky('draft', 'Draft idea', 170, 150, 'flow', 'drafts'),
    { id: 'secret', type: 'frame', x: 640, y: 0, w: 320, h: 200, name: 'Secret plan', fill: 'transparent', stroke: '#ffffff',
      parentId: null, groupId: null, hidden: true },
    sticky('codes', 'Launch codes', 700, 60, 'secret'),
  ],
  connectors: [link('flow-link', 'start', 'finish'), link('draft-link', 'start', 'draft')],
};

test('Board synced copies: a diagram copy with its connectors, the list of copies, and what a commenter sees', async ({ browser, baseURL }, info) => {
  test.setTimeout(180000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, MATE].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));

  // Setup through the API: a project with a source board (the diagram and the hidden frame) and a target board.
  const setup = await signIn(browser, baseURL, OWNER, null);
  const post = (path, data) => setup.context.request.post(path, { data, headers: { Origin: baseURL } });
  const tag = randomUUID().slice(0, 8);
  const created = await post('/api/projects', { op: 'createProject', name: `Synced copies ${tag}` });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  const boards = [];
  for (const name of [`Flow source ${tag}`, `Copies target ${tag}`]) {
    const response = await post('/api/canvas-boards', { op: 'createBoard', projectId: project.id, name });
    expect(response.ok()).toBeTruthy();
    boards.push((await response.json()).board);
  }
  const [source, target] = boards;
  const seeded = await setup.context.request.put(`/api/canvas-boards/${source.id}`, {
    data: { data: SOURCE_GRAPH, baseVersion: 1, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(seeded.status()).toBe(200);
  // Teammates may view the source and comment on the target.
  for (const [board, role] of [[source, 'view'], [target, 'comment']]) {
    expect((await post(`/api/canvas-boards/${board.id}/access`, { op: 'setTeamRole', role })).ok()).toBeTruthy();
  }
  await setup.context.close();

  // Owner, on the target board: the picker lists the diagram, and the copy draws it with its connector.
  const owner = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  owner.page.on('pageerror', (error) => errors.push(error.message));
  await openBoards(owner.page);
  await switchTo(owner.page, boards, target);
  await owner.page.getByRole('button', { name: 'Synced copy', exact: true }).click();
  const picker = owner.page.getByRole('menu');
  await picker.getByRole('combobox', { name: 'Source board' }).selectOption(source.id);
  await expect(picker.getByRole('button', { name: 'Flow · Diagram', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Secret plan', exact: true })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Synced copy', exact: true }).click();
  await expect(picker).toHaveCount(0);

  await insertCopy(owner.page, source, 'Flow · Diagram');
  // Pan so the next copy lands beside this one instead of on top of it.
  const canvasBox = await owner.page.getByRole('application', { name: 'Board canvas' }).boundingBox();
  await owner.page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await owner.page.mouse.wheel(560, 0);
  await insertCopy(owner.page, source, 'Secret plan');

  let stored;
  await expect.poll(async () => {
    stored = await (await owner.context.request.get(`/api/canvas-boards/${target.id}`)).json();
    return stored.data.nodes.filter((node) => node.type === 'synced').map((node) => node.sourceNodeId).sort();
  }, { timeout: 15000 }).toEqual(['flow', 'secret']);
  const copyOf = (sourceNodeId) => stored.data.nodes.find((node) => node.type === 'synced' && node.sourceNodeId === sourceNodeId).id;
  const flowCopy = owner.page.locator(`[data-synced-id="${copyOf('flow')}"]`);
  await expect(flowCopy.getByRole('button', { name: `${source.name}: Flow` })).toBeVisible();
  await expect(flowCopy.getByText('Start', { exact: true })).toBeVisible();
  await expect(flowCopy.getByText('Finish', { exact: true })).toBeVisible();
  await expect(flowCopy.getByText('Draft idea')).toHaveCount(0);
  // The copy's badge names the diagram; the diagram's own header and its controls are not drawn under it.
  await expect(flowCopy.getByRole('button')).toHaveCount(1);
  await expect(flowCopy.getByText('Focus mode')).toHaveCount(0);
  await expect(flowCopy.locator('[data-node-id="draft"]')).toHaveCount(0);
  await expect(flowCopy.locator('[data-connector-id]')).toHaveCount(1);
  await expect(flowCopy.locator('[data-connector-id="draft-link"]')).toHaveCount(0);
  // The arrow runs from Start's right edge to Finish's left edge, drawn where the board's own connector geometry puts it.
  const startBox = await flowCopy.locator('[data-node-id="start"]').boundingBox();
  const finishBox = await flowCopy.locator('[data-node-id="finish"]').boundingBox();
  const [from, to] = await connectorEnds(flowCopy.locator('[data-connector-id="flow-link"] path').first());
  expect(Math.abs(from.x - (startBox.x + startBox.width))).toBeLessThan(4);
  expect(Math.abs(to.x - finishBox.x)).toBeLessThan(4);
  for (const end of [from, to]) {
    expect(end.y).toBeGreaterThanOrEqual(startBox.y - 1);
    expect(end.y).toBeLessThanOrEqual(startBox.y + startBox.height + 1);
  }
  // The owner manages the hidden frame, so its copy shows the content.
  const secretCopy = owner.page.locator(`[data-synced-id="${copyOf('secret')}"]`);
  await expect(secretCopy.getByText('Launch codes', { exact: true })).toBeVisible();
  await info.attach('owner-synced-copies', { body: await owner.page.screenshot(), contentType: 'image/png' });

  // Owner, on the source board: the diagram's controls offer only its copies, which list the target board.
  await switchTo(owner.page, boards, source);
  const diagram = owner.page.locator('[data-node-id="flow"]');
  await expect(diagram).toBeVisible();
  const diagramBox = await diagram.boundingBox();
  await owner.page.mouse.click(diagramBox.x + diagramBox.width - 16, diagramBox.y + diagramBox.height - 16);
  const controls = owner.page.getByRole('toolbar', { name: 'Diagram controls' });
  await expect(controls).toBeVisible();
  await expect(controls.getByRole('combobox', { name: 'Frame size' })).toHaveCount(0);
  await expect(controls.getByRole('button', { name: /Hide frame|Reveal frame/ })).toHaveCount(0);
  await controls.getByRole('button', { name: 'Copies', exact: true }).click();
  const copies = controls.getByRole('dialog', { name: 'Synced copies' });
  await expect(copies.getByRole('button')).toHaveText([target.name]);
  await info.attach('owner-diagram-copies', { body: await owner.page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
  await owner.context.close();

  // Commenter, on the target board: the diagram copy is readable, the hidden frame's copy is not, and the
  // notes panel is read-only with no editing hint.
  const mate = await signIn(browser, baseURL, MATE, project.id);
  const writes = [];
  mate.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  mate.page.on('pageerror', (error) => errors.push(error.message));
  await openBoards(mate.page);
  await switchTo(mate.page, boards, target);
  await expect(mate.page.getByRole('status').filter({ hasText: 'Comment only' })).toBeVisible();
  await expect(mate.page.locator(`[data-synced-id="${copyOf('flow')}"]`).getByText('Finish', { exact: true })).toBeVisible();
  const blocked = mate.page.locator(`[data-synced-id="${copyOf('secret')}"]`);
  await expect(blocked.getByText('The original is no longer available to you.')).toBeVisible();
  await expect(blocked.getByText('Launch codes')).toHaveCount(0);
  await expect(blocked.locator('[data-node-id]')).toHaveCount(0);
  await expect(mate.page.getByText('Launch codes')).toHaveCount(0);
  // The server refuses the hidden frame to the commenter directly too.
  expect((await mate.context.request.get(`/api/canvas-boards/${source.id}/frames/secret`)).status()).toBe(404);
  const listed = await (await mate.context.request.get(`/api/canvas-boards/${source.id}/frames`)).json();
  expect(listed.frames.map((frame) => frame.id)).toEqual(['flow']);

  await mate.page.getByRole('button', { name: 'Board notes', exact: true }).click();
  const notes = mate.page.getByRole('complementary', { name: 'Board notes' });
  await expect(notes.getByText('No notes yet.')).toBeVisible();
  await expect(notes.getByText('Double-click the text to edit')).toHaveCount(0);
  await expect(notes.locator('footer')).toHaveText('');
  await expect(notes.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'Link selection', exact: true })).toHaveCount(0);
  await notes.getByText('No notes yet.').dblclick();
  await expect(notes.getByRole('textbox')).toHaveCount(0);
  await info.attach('commenter-synced-and-notes', { body: await mate.page.screenshot(), contentType: 'image/png' });
  await mate.page.waitForTimeout(1500);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await mate.context.close();
});
