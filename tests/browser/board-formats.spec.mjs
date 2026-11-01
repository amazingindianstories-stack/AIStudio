import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000031', name: 'Formats owner', email: 'formats-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
  await context.addInitScript((id) => {
    // Also runs inside sandboxed embeds, which have no storage access.
    try { localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id })); } catch { /* sandboxed frame */ }
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



test('Board formats: docs, status, focus link, Mermaid code diagrams, HTML embeds and wireframes', async ({ browser, baseURL }) => {
  test.setTimeout(150000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board formats ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  const other = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board formats other ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(other.ok()).toBeTruthy();
  const { project: otherProject } = await other.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBoard(page);
  const dialog = page.getByRole('dialog', { name: 'Format focus mode' });
  const openPanel = async () => {
    const toggle = page.getByRole('button', { name: /^Formats/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  };

  // A doc opens in focus mode, takes a title, a heading block and a status, and saves on the board.
  await openPanel();
  let board = await saved(page, async () => {
    await page.getByRole('button', { name: 'New doc', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Format title').fill('Launch plan');
    await dialog.getByLabel('Format status').selectOption('in_review');
  }, (b) => b.data.nodes.some((n) => n.type === 'format' && n.format === 'doc' && n.name === 'Launch plan' && n.status === 'in_review'));
  const doc = board.data.nodes.find((n) => n.type === 'format');
  await dialog.getByLabel('Insert doc block').selectOption('h1');
  await dialog.getByLabel('Insert doc block').selectOption('todo');
  await expect(dialog.locator('[data-doc-block]')).toHaveCount(4);

  // A block can be edited again after its first edit commits, and its typing shortcut applies.
  const blockText = (b) => b.data.nodes.find((n) => n.id === doc.id)?.blocks[1];
  await saved(page, async () => {
    await dialog.getByRole('button', { name: 'Edit block 2' }).click();
    await page.keyboard.type('## Goals');
    await dialog.getByLabel('Format title').click();
  }, (b) => blockText(b)?.type === 'h2' && blockText(b)?.text === 'Goals');
  await saved(page, async () => {
    await dialog.getByRole('button', { name: 'Edit block 2' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' now');
    await dialog.getByLabel('Format title').click();
  }, (b) => blockText(b)?.text === 'Goals now');

  // Closing a block editor from the keyboard keeps focus in focus mode, so board keys cannot delete the open doc.
  await dialog.getByRole('button', { name: 'Edit block 2' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Edit block 2' })).toBeFocused();
  await page.keyboard.press('Backspace');
  await expect(dialog.getByLabel('Format title')).toHaveValue('Launch plan');

  // Default view with lock, and the focus link restores the format after a reload.
  await dialog.getByLabel('Board default').check();
  board = await saved(page, () => dialog.getByLabel('Lock default').check(), (b) => b.data.nodes.some((n) => n.id === doc.id && n.defaultView && n.viewLocked));
  await page.goto(`/?board=${boardPath.split('/').pop()}&focus=${doc.id}`);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Format title')).toHaveValue('Launch plan');
  // The lock only holds viewers in the default format; the owner can leave it with Escape.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Mermaid text becomes editable native shapes and connectors, and the board status chip follows.
  await openPanel();
  await page.getByRole('button', { name: 'New Mermaid', exact: true }).click();
  await dialog.getByLabel('Mermaid source').fill('flowchart LR\n  A[Draft] --> B[Review]\n  B --> C[Ship]');
  board = await saved(page, () => dialog.getByRole('button', { name: 'Create diagram' }).click(),
    (b) => b.data.connectors.length === 2 && b.data.nodes.some((n) => n.type === 'diagram'));
  expect(board.data.nodes.filter((n) => n.text && ['Draft', 'Review', 'Ship'].includes(n.text))).toHaveLength(3);
  await dialog.getByRole('button', { name: 'Back to board' }).click();

  // Unsupported Mermaid is reported and leaves the board untouched.
  await openPanel();
  await page.getByRole('button', { name: 'New Mermaid', exact: true }).click();
  await dialog.getByLabel('Mermaid source').fill('flowchart TD\n  A --> B\n  foo bar baz');
  await dialog.getByRole('button', { name: 'Create diagram' }).click();
  await expect(dialog.getByRole('status')).toContainText('Unsupported');
  await dialog.getByRole('button', { name: 'Back to board' }).click();

  // HTML embeds are static pages in a permissionless sandbox: scripts, refreshes and links cannot navigate them.
  await openPanel();
  await page.getByRole('button', { name: 'New HTML embed', exact: true }).click();
  await dialog.getByLabel('HTML source').fill('<meta http-equiv="refresh" content="0;url=/?escaped=refresh"><script>location.href = "/?escaped=script"</script><a id="out" href="/?escaped=link">Out</a><button id="b">Hello</button>');
  const frame = dialog.locator('iframe[title="HTML prototype preview"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  const embed = page.frameLocator('iframe[title="HTML prototype preview"]');
  await expect(embed.locator('#b')).toBeVisible();
  await embed.locator('#out').click();
  await page.waitForTimeout(1000);
  expect((await (await frame.elementHandle()).contentFrame()).url()).toBe('about:srcdoc');
  await expect(embed.locator('#b')).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to board' }).click();

  // Wireframing: a mobile screen from the library lands on the board.
  await openPanel();
  board = await saved(page, () => page.getByRole('button', { name: 'Mobile screen', exact: true }).click(),
    (b) => b.data.nodes.some((n) => n.type === 'frame' && n.name === 'Mobile screen'));
  expect(errors).toEqual([]);
  await context.close();

  // A focus link opens the board and its format even while another project is active.
  const away = await signIn(browser, baseURL, OWNER, otherProject.id);
  await away.page.goto(`/?board=${boardPath.split('/').pop()}&focus=${doc.id}`);
  await away.page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const awayDialog = away.page.getByRole('dialog', { name: 'Format focus mode' });
  await expect(awayDialog).toBeVisible();
  await expect(awayDialog.getByLabel('Format title')).toHaveValue('Launch plan');
  // The link is used once: later visits follow the project and board the person picks.
  await expect(away.page).not.toHaveURL(/[?&](board|focus)=/);
  await away.context.close();
});
