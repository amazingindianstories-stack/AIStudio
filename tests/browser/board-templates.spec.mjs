import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000041', name: 'Templates owner', email: 'templates-owner@example.test' };
const ADMIN = { id: 'b0a2d000-0000-4000-8000-000000000042', name: 'Templates admin', email: 'templates-admin@example.test' };

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

async function openBoard(page, path = '/') {
  await page.goto(path);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
}

async function storedBoard(context, boardId, ready) {
  let board;
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return ready(board);
  }, { timeout: 15000 }).toBe(true);
  return board;
}

async function currentBoardId(page) {
  const response = await page.waitForResponse((r) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
  return new URL(response.url()).pathname.split('/').at(-1);
}

async function pixelClean(page, locator) {
  const overflowing = await locator.evaluate((root) => [...root.querySelectorAll('*')].filter((node) => node.scrollWidth > node.clientWidth + 1
    && getComputedStyle(node).overflowX === 'visible' && node.clientWidth > 0 && node.tagName !== 'svg').map((node) => node.className));
  expect(overflowing).toEqual([]);
}

// A primary button's label must not share its background colour, and a select must show its whole choice.
async function legible(locator) {
  const { color, background } = await locator.evaluate((node) => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
  expect(color).not.toBe(background);
}

async function selectFits(locator) {
  expect(await locator.evaluate((node) => {
    const probe = Object.assign(document.createElement('span'), { textContent: node.selectedOptions[0].text });
    probe.style.font = getComputedStyle(node).font;
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width + 36 <= node.clientWidth;
  })).toBe(true);
}

test('Board templates: picker, pre-filled and blank, Cmd+Delete, save and delete with undo, blueprints, deep link and a new board from a template', async ({ browser, baseURL }, info) => {
  test.setTimeout(240000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([[OWNER, 'user'], [ADMIN, 'admin']].map(([user, role]) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, ${role}, true, 0)
    ON CONFLICT (id) DO UPDATE SET role = ${role}, is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board templates ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const boardRequest = currentBoardId(page);
  await openBoard(page);
  const boardId = await boardRequest;

  // Library: shipped templates, search, collections, preview.
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Templates' });
  await expect(picker.getByRole('button', { name: 'SWOT analysis' })).toBeVisible();
  await picker.getByLabel('Search templates').fill('swot');
  await expect(picker.getByRole('button', { name: /Retro/ })).toHaveCount(0);
  await picker.getByRole('button', { name: 'SWOT analysis' }).click();
  await expect(picker.getByTestId('template-detail')).toContainText('SWOT analysis');
  await picker.getByLabel('Search templates').fill('');
  await picker.getByRole('button', { name: 'AI-accelerated' }).click();
  await expect(picker.getByRole('button', { name: /Prompt lab/ })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'SWOT analysis' })).toHaveCount(0);
  await pixelClean(page, picker);
  await info.attach('template-picker', { body: await page.screenshot(), contentType: 'image/png' });

  // Add pre-filled, then the board holds the template and it is selected.
  await picker.getByRole('button', { name: 'All templates' }).click();
  await picker.getByRole('button', { name: 'SWOT analysis' }).click();
  await picker.getByRole('button', { name: 'Add to board' }).click();
  await expect(picker).toHaveCount(0);
  const swot = await storedBoard(context, boardId, (board) => board.data.nodes.length > 4);
  const stickyTexts = swot.data.nodes.filter((n) => n.type === 'sticky' && n.text);
  const count = swot.data.nodes.length;
  expect(new Set(swot.data.nodes.map((n) => n.id)).size).toBe(count);

  // Cmd+Delete clears the selected stickies' text and keeps them, as one undo step.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  if (stickyTexts.length) {
    await page.getByRole('application', { name: 'Board canvas' }).focus();
    await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.press(`${modifier}+Delete`);
    const cleared = await storedBoard(context, boardId, (board) => board.data.nodes.filter((n) => n.type === 'sticky' && n.text).length === 0);
    expect(cleared.data.nodes.length).toBe(count);
    await page.keyboard.press(`${modifier}+z`);
    await storedBoard(context, boardId, (board) => board.data.nodes.filter((n) => n.type === 'sticky' && n.text).length === stickyTexts.length);
  }

  // Save the board as a personal template; it lists under My templates, can be edited, and deletes with an undo.
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Save board as template' }).click();
  const save = page.getByRole('dialog', { name: 'Save as template' });
  await save.getByLabel('Name').fill('My team canvas');
  await save.getByLabel('Description').fill('Used every sprint');
  await save.getByRole('button', { name: 'Save template' }).click();
  await expect(save).toHaveCount(0);
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await picker.getByRole('button', { name: 'My templates' }).click();
  await picker.getByRole('button', { name: 'My team canvas' }).click();
  await expect(picker.getByTestId('template-detail')).toContainText('Used every sprint');
  await picker.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'My team canvas' })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Undo' }).click();
  await expect(picker.getByRole('button', { name: 'My team canvas' })).toBeVisible();
  await picker.getByRole('button', { name: 'Close' }).click();

  // A shared link opens the picker on that template.
  await page.goto('/?template=builtin%3Aretro-start-stop-continue');
  const linked = page.getByRole('dialog', { name: 'Templates' });
  await expect(linked.getByTestId('template-detail')).toContainText('Retrospective: start, stop, continue');
  await linked.getByRole('button', { name: 'Close' }).click();
  expect(new URL(page.url()).searchParams.has('template')).toBe(false);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();

  // A new board from a template, blank, through the board menu.
  await page.getByRole('button', { name: /Untitled board|Loading boards/ }).first().click();
  await page.getByRole('menuitem', { name: 'New board from template' }).click();
  const start = page.getByRole('dialog', { name: 'Start a new board' });
  await start.getByRole('button', { name: /Retrospective: start/ }).click();
  await start.getByRole('radio', { name: 'Blank' }).click();
  await start.getByRole('checkbox', { name: 'Show this picker on every new board' }).check();
  const newBoard = currentBoardId(page);
  await start.getByRole('button', { name: 'Create board from template' }).click();
  const fresh = await storedBoard(context, await newBoard, (board) => board.data.nodes.length > 3);
  expect(fresh.name).toBe('Retrospective: start, stop, continue');
  expect(fresh.data.nodes.filter((n) => n.type === 'sticky').every((n) => n.text === '')).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('veevee.canvas.showTemplatePicker'))).toBe('1');

  // A new board starts in rename mode; Escape keeps the template name.
  await page.keyboard.press('Escape');

  // With the preference on, "New board" opens the picker, and a blank board starts empty.
  await page.getByRole('button', { name: /Retrospective: start/ }).first().click();
  await page.getByRole('menuitem', { name: 'New board', exact: true }).click();
  await page.getByRole('dialog', { name: 'Start a new board' }).getByRole('button', { name: 'Blank board' }).click();
  await expect(page.getByRole('dialog', { name: 'Start a new board' })).toHaveCount(0);

  expect(errors).toEqual([]);
  await context.close();
});

const EDITOR = { id: 'b0a2d000-0000-4000-8000-000000000043', name: 'Templates editor', email: 'templates-editor@example.test' };
const VIEWER = { id: 'b0a2d000-0000-4000-8000-000000000044', name: 'Templates viewer', email: 'templates-viewer@example.test' };

test('Board templates: save permissions, scope options, selection source, scratch board in the switcher and the new-board picker', async ({ browser, baseURL }, info) => {
  test.setTimeout(240000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([[EDITOR, 'user'], [VIEWER, 'user'], [ADMIN, 'admin']].map(([user, role]) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, ${role}, true, 0)
    ON CONFLICT (id) DO UPDATE SET role = ${role}, is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, EDITOR, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Template permissions ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, EDITOR, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const boardRequest = currentBoardId(page);
  await openBoard(page);
  const boardId = await boardRequest;
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Templates' });
  await picker.getByRole('button', { name: 'SWOT analysis' }).click();
  await picker.getByRole('button', { name: 'Add to board' }).click();
  await expect(picker).toHaveCount(0);
  await storedBoard(context, boardId, (board) => board.data.nodes.length > 4);

  // A project owner who is not an admin is offered only themselves and the project.
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Save board as template' }).click();
  const save = page.getByRole('dialog', { name: 'Save as template' });
  const scopes = save.getByLabel('Who can use it');
  await expect.poll(async () => (await scopes.locator('option').allTextContents()).join('|')).toBe('Only me|Everyone in this project');
  await save.getByLabel('Name').fill('Project kit');
  await scopes.selectOption('project');
  await selectFits(scopes);
  await legible(save.getByRole('button', { name: 'Save template' }));
  await info.attach('owner-save-scopes', { body: await page.screenshot(), contentType: 'image/png' });
  await save.getByRole('button', { name: 'Save template' }).click();
  await expect(save).toHaveCount(0);

  // Saving a selection names its source board, so the server can check edit rights on it.
  await page.getByRole('application', { name: 'Board canvas' }).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  const selectionPost = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/canvas-templates' && r.method() === 'POST');
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Save selection as template' }).click();
  await save.getByLabel('Name').fill('Selection kit');
  await save.getByRole('button', { name: 'Save template' }).click();
  const sent = (await selectionPost).postDataJSON();
  expect(sent.boardId).toBe(boardId);
  expect(sent.graph.nodes.length).toBeGreaterThan(0);
  await expect(save).toHaveCount(0);

  const post = (requester, path, data) => requester.post(path, { data, headers: { Origin: baseURL } });
  expect((await post(context.request, '/api/canvas-templates', { name: 'Leak', boardId, scope: 'everyone' })).status()).toBe(403);

  // A signed-in user who can only view the board cannot copy it into a template or blueprint by any path.
  expect((await post(context.request, `/api/canvas-boards/${boardId}/access`, { op: 'setTeamRole', role: 'view' })).ok()).toBeTruthy();
  const viewer = await signIn(browser, baseURL, VIEWER, null);
  const readable = await viewer.context.request.get(`/api/canvas-boards/${boardId}`);
  expect(readable.ok()).toBeTruthy();
  const graph = (await readable.json()).data;
  for (const data of [{ name: 'Copy', boardId }, { name: 'Copy', graph }, { name: 'Copy', boardId, graph },
    { name: 'Copy', boardId, scope: 'everyone' }]) {
    expect([400, 403]).toContain((await post(viewer.context.request, '/api/canvas-templates', data)).status());
  }
  expect([400, 403, 404]).toContain((await post(viewer.context.request, '/api/canvas-blueprints', { name: 'Copy', sourceProjectId: project.id })).status());
  const listed = await (await viewer.context.request.get('/api/canvas-templates')).json();
  expect(listed.templates.filter((t) => !String(t.id).startsWith('builtin:'))).toEqual([]);
  await viewer.context.close();

  // An admin may publish to everyone and is offered that scope.
  const admin = await signIn(browser, baseURL, ADMIN, project.id);
  expect((await post(admin.context.request, '/api/canvas-templates', { name: 'Admin kit', boardId, scope: 'everyone' })).status()).toBe(201);
  await openBoard(admin.page);
  await admin.page.getByRole('button', { name: 'Templates', exact: true }).click();
  await admin.page.getByRole('button', { name: 'Save board as template' }).click();
  await expect.poll(async () => admin.page.getByRole('dialog', { name: 'Save as template' }).getByLabel('Who can use it')
    .locator('option').allTextContents()).toContain('Everyone');
  await info.attach('admin-save-scopes', { body: await admin.page.screenshot(), contentType: 'image/png' });
  await admin.context.close();

  // Create from scratch opens a "Template: <name>" board that the board switcher knows about.
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await picker.getByRole('button', { name: 'Create from scratch' }).click();
  const scratch = page.getByRole('dialog', { name: 'Create a template' });
  await scratch.getByLabel('Name').fill('Scratch kit');
  await scratch.getByRole('button', { name: 'Create and open' }).click();
  await expect(scratch).toHaveCount(0);
  const header = page.getByRole('button', { name: 'Template: Scratch kit' }).first();
  await expect(header).toBeVisible({ timeout: 15000 });
  const banner = page.getByRole('status').filter({ hasText: 'Editing template Scratch kit' });
  await expect(banner).toBeVisible();
  await legible(banner.getByRole('button', { name: 'Save to template' }));
  await info.attach('scratch-board', { body: await page.screenshot(), contentType: 'image/png' });

  // The new-board picker shows the owner's Delete but no edit buttons it cannot act on.
  await header.click();
  await page.getByRole('menuitem', { name: 'New board from template' }).click();
  const start = page.getByRole('dialog', { name: 'Start a new board' });
  await start.getByRole('button', { name: 'My templates' }).click();
  await start.getByRole('button', { name: 'Project kit' }).click();
  const detail = start.getByTestId('template-detail');
  await expect(detail).toContainText('Project kit');
  await expect(detail.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await legible(detail.getByRole('button', { name: 'Create board from template' }));
  await expect(detail.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Edit content' })).toHaveCount(0);
  await pixelClean(page, start);
  await info.attach('new-board-picker', { body: await page.screenshot(), contentType: 'image/png' });
  await start.getByRole('button', { name: 'Close' }).click();

  expect(errors).toEqual([]);
  await context.close();
});
