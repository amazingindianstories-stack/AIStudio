import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000021', name: 'Stickies owner', email: 'stickies-owner@example.test' };
const VIEWER = { id: 'b0a2d000-0000-4000-8000-000000000022', name: 'Stickies viewer', email: 'stickies-viewer@example.test' };
const BLUE = '#6f9bd1';
const YELLOW = '#e3c56a';

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
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

/** The stored board once the autosaves have caught up with `ready`. */
async function storedBoard(context, boardId, ready) {
  let board;
  await expect.poll(async () => {
    board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return ready(board);
  }, { timeout: 15000 }).toBe(true);
  return board;
}

const stickies = (board) => board.data.nodes.filter((node) => node.type === 'sticky');
const byText = (board, text) => board.data.nodes.find((node) => node.text === text);

test('Board stickies: bulk mode, colors, shape, auto size, tags, reactions, author, fonts, style copy, switch, CSV, clustering, stacks and pasted cells', async ({ browser, baseURL }, info) => {
  test.setTimeout(180000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, VIEWER].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board stickies ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openBoard(page);

  // Bulk mode: one sticky per line, auto sized by default.
  await page.getByRole('button', { name: 'Sticky options' }).click();
  await page.getByRole('menuitem', { name: 'Bulk mode' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add stickies in bulk' });
  await expect(dialog.getByRole('textbox')).toBeFocused();
  await dialog.getByRole('textbox').fill('Alpha\n\nBeta\nGamma\n');
  await info.attach('bulk-mode', { body: await page.screenshot(), contentType: 'image/png' });
  const firstSave = page.waitForResponse(isSave);
  await dialog.getByRole('button', { name: 'Add 3 stickies' }).click();
  await expect(dialog).toHaveCount(0);
  const boardId = new URL((await firstSave).url()).pathname.split('/').pop();
  let board = await storedBoard(context, boardId, (b) => stickies(b).length === 3);
  expect(stickies(board).map((node) => [node.text, node.fill, node.autoFit])).toEqual([
    ['Alpha', YELLOW, true], ['Beta', YELLOW, true], ['Gamma', YELLOW, true]]);
  const alpha = byText(board, 'Alpha');
  const beta = byText(board, 'Beta');
  const gamma = byText(board, 'Gamma');
  const node = (id) => page.locator(`[data-node-id="${id}"]`);
  // Auto size fills the note: a short word is set far larger than the default size.
  const autoSize = await node(alpha.id).locator('[data-sticky-text]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(autoSize).toBeGreaterThan(30);
  // It shrinks the text before it would break a word.
  const gammaLines = await node(gamma.id).locator('[data-sticky-text]').evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const tops = new Set();
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
    }
    return tops.size;
  });
  expect(gammaLines).toBe(1);
  // The new stickies arrive selected; start from an empty selection.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Fill', exact: true })).toHaveCount(0);

  // Styling one sticky from the inspector.
  await node(alpha.id).click();
  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  await expect(page.locator('[data-color-picker]')).toBeVisible();
  await info.attach('sticky-colors', { body: await page.screenshot(), contentType: 'image/png' });
  await page.locator('[data-color-picker]').getByRole('button', { name: 'Blue', exact: true }).click();
  await page.keyboard.press('Escape');
  await node(alpha.id).click();
  await page.getByRole('button', { name: 'Rectangular sticky' }).click();
  await page.getByRole('button', { name: 'Auto font size' }).click();
  await expect(page.getByRole('button', { name: 'Auto font size' })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: 'Font', exact: true }).click();
  const fonts = page.locator('[data-font-picker]');
  await fonts.getByRole('textbox', { name: 'Search fonts' }).fill('cav');
  await info.attach('font-picker', { body: await page.screenshot(), contentType: 'image/png' });
  await fonts.getByRole('menuitemradio', { name: 'Caveat' }).click();

  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  const tagInput = page.getByRole('textbox', { name: 'Find or create a tag' });
  await tagInput.fill('Urgent');
  await tagInput.press('Enter');
  await expect(page.getByRole('menuitemcheckbox', { name: 'Urgent' })).toHaveAttribute('aria-checked', 'true');
  await info.attach('tags', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');

  await node(alpha.id).click();
  await page.getByRole('button', { name: 'React', exact: true }).click();
  await page.getByRole('button', { name: 'React 👍' }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show author' }).click();
  await expect(node(alpha.id).locator('[data-sticky-author]')).toHaveText(OWNER.name);
  await expect(node(alpha.id).locator('[data-sticky-tag]')).toHaveText('Urgent');
  await expect(node(alpha.id).locator('[data-sticky-reaction]')).toHaveAttribute('aria-pressed', 'true');

  board = await storedBoard(context, boardId, (b) => byText(b, 'Alpha')?.showAuthor === true);
  const tag = board.data.tags.find((item) => item.name === 'Urgent');
  expect(byText(board, 'Alpha')).toMatchObject({ fill: BLUE, fontFamily: 'caveat', w: 350, h: 200,
    tagIds: [tag.id], reactions: { '👍': [OWNER.id] }, showAuthor: true });
  // A fixed size is the default, so the board leaves autoFit out.
  expect(byText(board, 'Alpha').autoFit).toBeUndefined();
  await info.attach('styled-sticky', { body: await page.screenshot(), contentType: 'image/png' });

  // Copy style (Cmd+Alt+C) from Alpha and paste it (Cmd+Alt+V) onto Beta.
  await node(alpha.id).click();
  await page.keyboard.press('ControlOrMeta+Alt+KeyC');
  await node(beta.id).click();
  await page.keyboard.press('ControlOrMeta+Alt+KeyV');
  board = await storedBoard(context, boardId, (b) => byText(b, 'Beta')?.fill === BLUE);
  expect(byText(board, 'Beta')).toMatchObject({ fontFamily: 'caveat', text: 'Beta' });

  // Export every sticky to CSV.
  await canvas.click({ position: { x: 1000, y: 120 } });
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export 3 stickies to CSV' }).click();
  const csv = await download;
  expect(csv.suggestedFilename()).toMatch(/ stickies\.csv$/);
  const rows = (await readFile(await csv.path(), 'utf8')).replace(/^﻿/, '').trim().split('\r\n');
  expect(rows[0]).toBe('Text,Color,Tags,Author');
  expect(rows).toContain(`Alpha,Blue,Urgent,${OWNER.name}`);
  expect(rows).toContain(`Gamma,Yellow,,${OWNER.name}`);

  // Cluster by color in palette order: Yellow first, then Blue, each under a title.
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Color', exact: true }).click();
  board = await storedBoard(context, boardId, (b) => b.data.nodes.some((item) => item.type === 'text'));
  expect(board.data.nodes.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(['Yellow (1)', 'Blue (2)']);
  expect(byText(board, 'Beta').x).toBeGreaterThan(byText(board, 'Gamma').x);
  await info.attach('clustered', { body: await page.screenshot(), contentType: 'image/png' });

  // Switch Gamma to a text box; its text stays.
  await page.keyboard.press('Escape');
  await node(gamma.id).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('group', { name: 'Switch to' }).getByRole('menuitem', { name: 'Text', exact: true }).click();
  board = await storedBoard(context, boardId, (b) => b.data.nodes.find((item) => item.id === gamma.id)?.type === 'text');
  expect(byText(board, 'Gamma').id).toBe(gamma.id);

  // A sticky stack hands out a new sticky in its color each time one is dragged off it.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sticky options' }).click();
  await page.getByRole('menuitem', { name: 'Sticky stack' }).click();
  const stack = page.locator('[data-sticky-stack]');
  await expect(stack).toBeVisible();
  board = await storedBoard(context, boardId, (b) => b.data.nodes.some((item) => item.type === 'stack'));
  const stackNode = board.data.nodes.find((item) => item.type === 'stack');
  const before = stickies(board).length;
  const box = await stack.boundingBox();
  await page.keyboard.press('Escape');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 160, { steps: 8 });
  await page.mouse.move(box.x + box.width / 2 + 260, box.y + box.height / 2 + 300, { steps: 8 });
  await page.mouse.up();
  board = await storedBoard(context, boardId, (b) => stickies(b).length === before + 1);
  const peeled = stickies(board).at(-1);
  expect(peeled.fill).toBe(stackNode.fill);
  expect(peeled.x).toBeGreaterThan(stackNode.x + 200);
  expect(board.data.nodes.find((item) => item.type === 'stack')).toMatchObject({ x: stackNode.x, y: stackNode.y });
  await info.attach('sticky-stack', { body: await page.screenshot(), contentType: 'image/png' });

  // Cells pasted from a spreadsheet become one sticky each.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'North\tSouth\nEast\t"West\nwing"\n');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  board = await storedBoard(context, boardId, (b) => stickies(b).length === before + 5);
  expect(stickies(board).slice(-4).map((item) => item.text)).toEqual(['North', 'South', 'East', 'West\nwing']);
  expect(errors).toEqual([]);

  // A viewer sees tags, votes and authors but cannot vote, restyle or add stickies.
  await db`UPDATE canvas_boards SET team_role = 'view' WHERE id = ${boardId}`;
  const viewer = await signIn(browser, baseURL, VIEWER, project.id);
  const writes = [];
  viewer.page.on('request', (request) => {
    if (request.url().includes('/api/canvas-boards/') && request.method() !== 'GET') writes.push(request.url());
  });
  await openBoard(viewer.page);
  await expect(viewer.page.getByRole('status').filter({ hasText: 'View only' })).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Sticky options' })).toHaveCount(0);
  const viewerAlpha = viewer.page.locator(`[data-node-id="${alpha.id}"]`);
  await expect(viewerAlpha.locator('[data-sticky-author]')).toHaveText(OWNER.name);
  await expect(viewerAlpha.locator('[data-sticky-tag]')).toHaveText('Urgent');
  await expect(viewerAlpha.locator('[data-sticky-reaction]')).toBeDisabled();
  await viewerAlpha.click();
  await expect(viewer.page.getByRole('button', { name: 'Tags', exact: true })).toHaveCount(0);
  await viewer.page.waitForTimeout(1500);
  expect(writes).toEqual([]);
  await info.attach('viewer', { body: await viewer.page.screenshot(), contentType: 'image/png' });

  await viewer.context.close();
  await context.close();
});

test('Board text: lists, custom colors, fonts and the remembered style', async ({ browser, baseURL }, info) => {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`]);
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board text ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openBoard(page);
  const editor = page.locator('[data-rich-editor]');

  // "- " starts a bulleted list, Enter continues it and Tab nests an item.
  await page.keyboard.press('t');
  const firstSave = page.waitForResponse(isSave);
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(editor).toBeFocused();
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('nested');
  await page.keyboard.press('ControlOrMeta+Enter');
  const boardId = new URL((await firstSave).url()).pathname.split('/').pop();
  let board = await storedBoard(context, boardId, (b) => b.data.nodes.some((node) => node.text === '• one\n• two\n\t◦ nested'));
  const list = board.data.nodes.find((node) => node.type === 'text');

  // "1. " starts a numbered list; Enter on an empty item ends it, and the next Enter is a plain new line.
  await page.keyboard.press('t');
  await canvas.click({ position: { x: 300, y: 420 } });
  await expect(editor).toBeFocused();
  await page.keyboard.type('1. first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('plain');
  await page.keyboard.press('ControlOrMeta+Enter');
  await storedBoard(context, boardId, (b) => b.data.nodes.some((node) => node.text === '1. first\n2. second\n\nplain'));
  await info.attach('lists', { body: await page.screenshot(), contentType: 'image/png' });

  // A hex color is applied and saved to this person's colors; a font from the library.
  await page.locator(`[data-node-id="${list.id}"]`).click();
  await page.getByRole('button', { name: 'Text color', exact: true }).click();
  const picker = page.locator('[data-color-picker]');
  await picker.getByRole('textbox', { name: 'Hex color' }).fill('#123ABC');
  await picker.getByRole('button', { name: 'Use', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator(`[data-node-id="${list.id}"]`).click();
  await page.getByRole('button', { name: 'Text color', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Custom color #123abc' })).toBeVisible();
  await info.attach('custom-colors', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await page.locator(`[data-node-id="${list.id}"]`).click();
  await page.getByRole('button', { name: 'Font', exact: true }).click();
  await page.locator('[data-font-picker]').getByRole('menuitemradio', { name: 'Lora' }).click();
  board = await storedBoard(context, boardId, (b) => b.data.nodes.find((node) => node.id === list.id)?.fontFamily === 'lora');
  expect(board.data.nodes.find((node) => node.id === list.id).color).toBe('#123abc');

  // The next text box takes the style last chosen for text.
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await canvas.click({ position: { x: 700, y: 200 } });
  await expect(editor).toBeFocused();
  await page.keyboard.type('after');
  await page.keyboard.press('ControlOrMeta+Enter');
  board = await storedBoard(context, boardId, (b) => b.data.nodes.some((node) => node.text === 'after'));
  expect(board.data.nodes.find((node) => node.text === 'after')).toMatchObject({ color: '#123abc', fontFamily: 'lora' });

  // Text inside a shape stops at 6,000 characters and aligns from the inspector (centered by default).
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  await canvas.click({ position: { x: 300, y: 650 } });
  board = await storedBoard(context, boardId, (b) => b.data.nodes.some((node) => node.type === 'rect'));
  const rect = board.data.nodes.find((node) => node.type === 'rect');
  const rectNode = page.locator(`[data-node-id="${rect.id}"]`);
  await rectNode.dblclick();
  await expect(editor).toBeFocused();
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'x'.repeat(5998) + 'abcdef');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.type('yz');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  board = await storedBoard(context, boardId, (b) => Boolean(b.data.nodes.find((node) => node.id === rect.id)?.text));
  expect(board.data.nodes.find((node) => node.id === rect.id).text).toBe('x'.repeat(5998) + 'ab');
  await expect(rectNode.locator('div').filter({ hasText: /^x+ab$/ }).last()).toHaveCSS('text-align', 'center');
  await rectNode.click();
  await expect(page.getByRole('button', { name: 'Align center' })).toHaveClass(/bg-ink-600/);
  await page.getByRole('button', { name: 'Align right' }).click();
  await storedBoard(context, boardId, (b) => b.data.nodes.find((node) => node.id === rect.id)?.align === 'right');
  await expect(rectNode.locator('div').filter({ hasText: /^x+ab$/ }).last()).toHaveCSS('text-align', 'right');
  expect(errors).toEqual([]);
  await context.close();
});
