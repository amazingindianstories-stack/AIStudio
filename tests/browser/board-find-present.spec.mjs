import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// One ordinary fixture user who owns (and so edits) the board.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000021', name: 'Find owner', email: 'find-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(OWNER.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  const page = await context.newPage();
  return { context, page };
}

async function openBoard(page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

const isBoardSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());

async function stored(page, boardPath) {
  return (await (await page.request.get(boardPath)).json()).data;
}

const nodeOf = (data, id) => data.nodes.find((n) => n.id === id);
const clipboardText = (page) => page.evaluate(() => navigator.clipboard.readText());

test('Board find, frames, presenting, links, keyboard and shortcuts work from the data model', async ({ browser, baseURL }, info) => {
  test.setTimeout(180000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`;
  const setup = await signIn(browser, baseURL, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board find ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  // The board is made by placing one sticky, then replaced with two frames and three stickies.
  const { context, page } = await signIn(browser, baseURL, project.id);
  await page.goto('/');
  let canvas = await openBoard(page);
  const placed = page.waitForResponse(isBoardSave);
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await canvas.click({ position: { x: 300, y: 300 } });
  const boardPath = new URL((await placed).url()).pathname;
  const boardId = boardPath.split('/').pop();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await stored(page, boardPath)).nodes.length).toBe(1);
  const first = await (await page.request.get(boardPath)).json();
  const [template] = first.data.nodes;
  const frame = (id, name, x) => ({ ...template, id, type: 'frame', name, x, y: 0, w: 600, h: 400, fill: 'transparent', stroke: '#ffffff' });
  const sticky = (id, text, x, y, parentId = null) => ({ ...template, id, text, x, y, w: 200, h: 200, parentId, groupId: null });
  const board = {
    ...first.data,
    viewport: { x: -40, y: -80, zoom: 0.8 },
    nodes: [
      frame('f-intro', 'Intro', 0),
      frame('f-next', 'Frame 2', 800),
      sticky('s-plan', 'Launch plan', 40, 40, 'f-intro'),
      sticky('s-day', 'launch day', 840, 40, 'f-next'),
      sticky('s-loose', 'Loose idea', 0, 600),
    ],
    connectors: [],
  };
  const seeded = await context.request.put(boardPath, {
    data: { data: board, baseVersion: first.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(seeded.status()).toBe(200);
  await page.reload();
  canvas = await openBoard(page);
  await expect(page.locator('[data-node-id="s-plan"]')).toBeVisible();
  const announcer = page.getByTestId('board-announcer');
  const focusEmptyBoard = () => canvas.click({ position: { x: 1300, y: 760 } });

  // Find: Cmd+F, every hit highlighted and the rest dimmed, Enter jumps to the next hit.
  await focusEmptyBoard();
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('search', { name: 'Find on board' });
  await expect(find.getByRole('textbox', { name: 'Find on board' })).toBeFocused();
  await page.keyboard.type('launch');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 2');
  await expect(page.getByTestId('find-overlay')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('find-count')).toHaveText('2 of 2');
  // Typing in find never fires single-key tools.
  await expect(page.getByRole('button', { name: 'Sticky note', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await info.attach('find', { body: await page.screenshot(), contentType: 'image/png' });

  // Replace all is saved, and undone as one step.
  await find.getByRole('button', { name: 'Show replace' }).click();
  await find.getByRole('textbox', { name: 'Replace with' }).fill('release');
  let save = page.waitForResponse(isBoardSave);
  await find.getByRole('button', { name: 'Replace all (2)' }).click();
  expect((await save).status()).toBe(200);
  await expect.poll(async () => nodeOf(await stored(page, boardPath), 's-day').text).toBe('release day');
  expect(nodeOf(await stored(page, boardPath), 's-plan').text).toBe('release plan');
  await expect(page.getByTestId('find-count')).toHaveText('No results');
  await expect(find.getByRole('textbox', { name: 'Replace with' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(canvas).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => nodeOf(await stored(page, boardPath), 's-day').text).toBe('launch day');
  expect(nodeOf(await stored(page, boardPath), 's-plan').text).toBe('Launch plan');

  // Keyboard: Tab walks top-level objects in reading order, Enter goes into a frame, Cmd+C copies text.
  await focusEmptyBoard();
  await page.keyboard.press('Tab');
  await expect(announcer).toHaveText('Frame: Intro, 1 object');
  await page.keyboard.press('Tab');
  await expect(announcer).toHaveText('Frame: Frame 2, 1 object');
  await page.keyboard.press('Shift+Tab');
  await expect(announcer).toHaveText('Frame: Intro, 1 object');
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText(page)).toBe('Intro\nLaunch plan');
  await page.keyboard.press('Enter');
  await expect(announcer).toHaveText('Sticky note: Launch plan');
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboardText(page)).toBe('Launch plan');
  await page.keyboard.press('Escape');
  await expect(announcer).toHaveText('Frame: Intro, 1 object');
  await page.keyboard.press('End');
  await expect(announcer).toHaveText('Sticky note: Loose idea');

  // The skip link selects the first object.
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Skip to first object' }).focus();
  await expect(page.getByRole('link', { name: 'Skip to first object' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(canvas).toBeFocused();
  await expect(announcer).toHaveText('Frame: Intro, 1 object');

  // Frames panel: reorder with Alt+Up, write presenter notes, copy a link; all saved in the board.
  const boardMenu = page.locator('button[aria-haspopup="menu"]', { hasText: /^Board$/ });
  await boardMenu.click();
  await page.getByRole('menuitemcheckbox', { name: 'Frames' }).click();
  const framesPanel = page.getByRole('region', { name: 'Frames' });
  const rows = framesPanel.getByTestId('frame-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Intro');
  await rows.nth(1).focus();
  save = page.waitForResponse(isBoardSave);
  await page.keyboard.press('Alt+ArrowUp');
  expect((await save).status()).toBe(200);
  await expect(rows.nth(0)).toContainText('Frame 2');
  await expect.poll(async () => {
    const data = await stored(page, boardPath);
    return [nodeOf(data, 'f-next').frameOrder, nodeOf(data, 'f-intro').frameOrder];
  }).toEqual([0, 1]);
  await rows.filter({ hasText: 'Intro' }).click();
  const notes = framesPanel.getByRole('textbox', { name: 'Presenter notes for Intro' });
  await expect(framesPanel.getByText('Not private: anyone who can open this board can read these notes.')).toBeVisible();
  await notes.fill('Welcome everyone');
  await notes.blur();
  await expect.poll(async () => nodeOf(await stored(page, boardPath), 'f-intro').notes).toBe('Welcome everyone');
  await rows.filter({ hasText: 'Intro' }).hover();
  await framesPanel.getByRole('button', { name: 'Copy link to Intro' }).click();
  await expect.poll(() => clipboardText(page)).toContain('object=f-intro');
  const link = await clipboardText(page);
  expect(new URL(link).searchParams.get('board')).toBe(boardId);
  await info.attach('frames', { body: await page.screenshot(), contentType: 'image/png' });

  // Presenting: frames as slides in the saved order, toolbars hidden, notes and the slide grid on demand.
  const viewportBefore = (await stored(page, boardPath)).viewport;
  await framesPanel.getByRole('button', { name: 'Present', exact: true }).click();
  const presentation = page.getByTestId('presentation');
  await expect(presentation).toBeVisible();
  await expect(page.getByTestId('slide-counter')).toHaveText('1 / 2');
  await expect(page.getByRole('toolbar', { name: 'Board tools' })).toBeHidden();
  await expect(framesPanel).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('slide-counter')).toHaveText('2 / 2');
  await page.keyboard.press('n');
  await expect(page.getByRole('complementary', { name: 'Presenter notes' })).toContainText('Welcome everyone');
  await info.attach('presenting', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('g');
  await expect(page.getByTestId('slide-grid')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('slide-grid')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show board' }).click();
  await page.getByRole('button', { name: 'Back to slide 2' }).click();
  await expect(page.getByTestId('slide-counter')).toHaveText('2 / 2');
  await page.keyboard.press('Escape');
  await expect(presentation).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Board tools' })).toBeVisible();
  // Presenting moved only the local view: nothing about it was saved.
  expect((await stored(page, boardPath)).viewport).toEqual(viewportBefore);

  // A link to an object opens the board centered on it, with a prompt to go back.
  await page.goto(link);
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('object')).toBeNull();
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('button', { name: 'Go back' })).toHaveCount(0);
  canvas = page.getByRole('application', { name: 'Board canvas' });

  // Shortcut reference and the single-key switch, remembered on this device.
  await focusEmptyBoard();
  await page.keyboard.press('Shift+Slash');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await info.attach('shortcuts', { body: await page.screenshot(), contentType: 'image/png' });
  await shortcuts.getByRole('checkbox', { name: /Single-key shortcuts/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(shortcuts).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: 'Sticky note', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  canvas = await openBoard(page);
  await focusEmptyBoard();
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: 'Sticky note', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('F1');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('checkbox', { name: /Single-key shortcuts/ }).check();
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: 'Sticky note', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Command palette: search and run a board command.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('explore');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  const outline = page.getByRole('region', { name: 'Explore board content' });
  await expect(outline).toContainText('5 objects');
  await outline.getByRole('button', { name: /Loose idea/ }).click();
  await expect(announcer).toHaveText('Sticky note: Loose idea');

  // Accessibility check: the default-named frame is listed and fixed in place.
  await boardMenu.click();
  await page.getByRole('menuitemcheckbox', { name: 'Check accessibility' }).click();
  const checks = page.getByRole('region', { name: 'Accessibility check' });
  await expect(outline).toHaveCount(0);
  await expect(checks.getByRole('list', { name: 'Accessibility issues' })).toContainText('Frame 2');
  await info.attach('accessibility', { body: await page.screenshot(), contentType: 'image/png' });

  // The creation toolbar: unpinning a tool is remembered; undo and redo buttons act on the board.
  await page.getByRole('button', { name: 'Customize toolbar' }).click();
  await page.getByRole('list', { name: 'Toolbar tools' }).getByRole('checkbox', { name: 'Frame' }).uncheck();
  await page.keyboard.press('Escape');
  const tools = page.getByRole('toolbar', { name: 'Board tools' });
  await expect(tools.getByRole('button', { name: 'Frame', exact: true })).toHaveCount(0);
  await page.reload();
  await openBoard(page);
  await expect(page.getByRole('toolbar', { name: 'Board tools' }).getByRole('button', { name: 'Frame', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await context.close();
});
