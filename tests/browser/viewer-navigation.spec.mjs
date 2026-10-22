import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';
import { openTreeFolder } from './tree.mjs';

// Arrow keys in the viewer step through exactly the list the viewer was opened from, in the
// order shown: the open folder, Unsorted, or the chat thread - and across a page boundary they
// continue into the next page of the same folder query instead of jumping anywhere else.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
const IN_FOLDER = 45; // three pages at the 20-row page size
const IN_OTHER_FOLDER = 12;
const UNSORTED = 8;

async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

async function postAsBrowser(api, path, options = {}) {
  return api.post(path, { ...options, headers: { Origin: process.env.E2E_BASE_URL, ...options.headers } });
}

const scoped = test.extend({
  scope: async ({ page, context, baseURL }, provide) => {
    await authenticate(context, baseURL);
    const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
    const tag = `Viewer nav ${randomUUID().slice(0, 8)}`;
    const projectResponse = await postAsBrowser(context.request, '/api/projects', { data: { op: 'createProject', name: tag } });
    expect(projectResponse.ok()).toBeTruthy();
    const { project } = await projectResponse.json();
    const folder = async (name) => {
      const response = await postAsBrowser(context.request, '/api/folders', {
        data: { name: `${tag} ${name}`, projectId: project.id, parentId: null, idempotencyKey: randomUUID() },
      });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).folder;
    };
    const target = await folder('Target');
    const other = await folder('Other');
    // Newest first is how every scope orders; the three groups interleave in time so that a viewer
    // reading the wrong list would visibly leave the folder.
    const base = Date.now() - 10_000_000;
    const seed = async (label, count, folderId, offset) => {
      await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, folder_id, created_at, updated_at)
        SELECT gen_random_uuid(), 'image', 'succeeded', 'Nano Banana Pro', ${`${tag} ${label} `} || n, '3:2',
          '/api/media/generations/' || gen_random_uuid() || '.png', ${USER_ID}, ${project.id}, ${folderId},
          ${base} + n * 3000 + ${offset}, ${base} + n * 3000 + ${offset}
        FROM generate_series(1, ${count}) AS n`;
    };
    await seed('target', IN_FOLDER, target.id, 0);
    await seed('other', IN_OTHER_FOLDER, other.id, 1000);
    await seed('unsorted', UNSORTED, null, 2000);
    await page.addInitScript((projectId) => {
      const key = 'veevee-draft-settings-v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
    }, project.id);
    const rows = async (query) => {
      const response = await context.request.get(`/api/history?projectId=${project.id}&${query}&limit=100`);
      return (await response.json()).items.filter((row) => row.status === 'succeeded').map((row) => row.id);
    };
    try {
      await provide({ db, tag, project, target, other, rows });
    } finally {
      await db`DELETE FROM generations WHERE project_id = ${project.id}`;
      await db`DELETE FROM folders WHERE project_id = ${project.id}`;
      await db`DELETE FROM projects WHERE id = ${project.id}`;
    }
  },
});

async function openPanel(page) {
  await page.goto('/');
  const panel = page.locator('#desktop-history-panel');
  const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  return panel;
}

const shown = (page) => page.locator('[data-viewer-item-id]').first();

scoped('arrow keys inside a folder walk only that folder, in grid order, across page boundaries', async ({ page, scope }, testInfo) => {
  const expected = await scope.rows(`folderId=${scope.target.id}`);
  expect(expected).toHaveLength(IN_FOLDER);
  const panel = await openPanel(page);
  await openTreeFolder(panel, `${scope.tag} Target`);
  await expect(panel.locator('[data-asset-card-id]').first()).toBeVisible();
  await expect.poll(() => panel.locator('[data-asset-card-id]').count()).toBeGreaterThanOrEqual(20);
  // From here on every paged list request belongs to the open folder.
  const requested = [];
  page.on('request', (request) => {
    const query = request.url().includes('/api/history?') ? new URL(request.url()).searchParams : null;
    if (query?.has('cursor')) requested.push(query);
  });
  await panel.locator(`[data-asset-card-id="${expected[0]}"]`).click({ position: { x: 88, y: 24 } });
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', expected[0]);

  // Right walks reading order. 44 presses cross the page 1 -> 2 and 2 -> 3 boundaries.
  for (let index = 1; index < IN_FOLDER; index += 1) {
    await page.keyboard.press('ArrowRight');
    await expect(shown(page)).toHaveAttribute('data-viewer-item-id', expected[index]);
  }
  await testInfo.attach('viewer-last-of-folder', { body: await page.screenshot(), contentType: 'image/png' });

  // Rows beyond the first page came from this folder's own keyset query, never another scope's. (The
  // grid's scroller may already have fetched one continuation, and a background revalidation can repeat
  // a cursor, so only the scope of the requests seen after opening is asserted.)
  expect(requested.length).toBeGreaterThanOrEqual(1);
  for (const query of requested) {
    expect(query.get('folderId')).toBe(scope.target.id);
    expect(query.get('projectId')).toBe(scope.project.id);
  }

  // The folder is now fully loaded: the end wraps inside the same folder, and Left steps back through it.
  await page.keyboard.press('ArrowRight');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', expected[0]);
  await page.keyboard.press('ArrowLeft');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', expected[IN_FOLDER - 1]);
  await page.keyboard.press('ArrowLeft');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', expected[IN_FOLDER - 2]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close viewer' })).toHaveCount(0);
});

scoped('Up and Down walk the card column the user sees', async ({ page, scope }) => {
  const expected = await scope.rows(`folderId=${scope.target.id}`);
  const panel = await openPanel(page);
  await openTreeFolder(panel, `${scope.tag} Target`);
  await expect.poll(() => panel.locator('[data-asset-card-id]').count()).toBeGreaterThanOrEqual(20);
  // Group the rendered cards by their column (left edge), top to bottom: that is what Down must follow.
  const columns = await panel.locator('[data-asset-card-id]').evaluateAll((cards) => {
    const byLeft = new Map();
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      const left = Math.round(box.left);
      if (!byLeft.has(left)) byLeft.set(left, []);
      byLeft.get(left).push({ id: card.getAttribute('data-asset-card-id'), top: box.top });
    }
    return [...byLeft.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list.sort((a, b) => a.top - b.top).map((card) => card.id));
  });
  expect(columns.length).toBeGreaterThan(1);
  const column = columns[0];
  expect(column.length).toBeGreaterThan(3);
  await panel.locator(`[data-asset-card-id="${column[0]}"]`).click({ position: { x: 88, y: 24 } });
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', column[0]);
  for (let index = 1; index < 4; index += 1) {
    await page.keyboard.press('ArrowDown');
    await expect(shown(page)).toHaveAttribute('data-viewer-item-id', column[index]);
  }
  await page.keyboard.press('ArrowUp');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', column[2]);
});

scoped("Unsorted steps through the project's Unsorted rows only", async ({ page, scope }) => {
  const unsorted = (await scope.rows('folderId=none')).sort();
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: /Unsorted$/ }).first().click();
  await expect.poll(() => panel.locator('[data-asset-card-id]').count()).toBe(UNSORTED);
  const first = await panel.locator('[data-asset-card-id]').first().getAttribute('data-asset-card-id');
  await panel.locator(`[data-asset-card-id="${first}"]`).click({ position: { x: 88, y: 24 } });
  const seen = new Set();
  for (let step = 0; step < UNSORTED + 2; step += 1) {
    await expect(shown(page)).toHaveAttribute('data-viewer-item-id', /.+/);
    seen.add(await shown(page).getAttribute('data-viewer-item-id'));
    await page.keyboard.press('ArrowRight');
  }
  expect([...seen].sort()).toEqual(unsorted);
});

scoped('a viewer opened from the chat thread walks the thread, not the folder the panel is showing', async ({ page, scope }) => {
  const targetIds = new Set(await scope.rows(`folderId=${scope.target.id}`));
  const panel = await openPanel(page);
  await openTreeFolder(panel, `${scope.tag} Other`);
  await expect.poll(() => panel.locator('[data-asset-card-id]').count()).toBe(IN_OTHER_FOLDER);
  const threadIds = await page.locator('[data-generation-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-generation-id')));
  expect(threadIds.length).toBeGreaterThan(IN_OTHER_FOLDER);
  // The newest thread card that is NOT in the panel's folder: it used to open nothing at all.
  const outside = [...threadIds].reverse().find((id) => targetIds.has(id));
  expect(outside).toBeTruthy();
  const index = threadIds.indexOf(outside);
  expect(index).toBeGreaterThan(0);
  await page.locator(`[data-generation-id="${outside}"] img`).first().click();
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', outside);
  // Left goes to the card drawn above it in the thread.
  await page.keyboard.press('ArrowLeft');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', threadIds[index - 1]);
  await page.keyboard.press('ArrowRight');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', outside);
  await page.keyboard.press('ArrowRight');
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', threadIds[index + 1] ?? threadIds[0]);
});

scoped('while maintenance is ON the viewer covers the banner and its close button takes the click', async ({ page, scope }) => {
  // The status poll is the only thing stubbed: the banner, the viewer and their stacking are real.
  await page.route('**/api/maintenance', (route) => route.fulfill({ json: { enabled: true, available: true } }));
  const expected = await scope.rows(`folderId=${scope.target.id}`);
  const panel = await openPanel(page);
  await expect(page.getByRole('status').filter({ hasText: 'Veevee is being updated' })).toBeVisible();
  await openTreeFolder(panel, `${scope.tag} Target`);
  await panel.locator(`[data-asset-card-id="${expected[0]}"]`).click({ position: { x: 88, y: 24 } });
  await expect(shown(page)).toHaveAttribute('data-viewer-item-id', expected[0]);
  const close = page.getByRole('button', { name: 'Close viewer' });
  const topmost = await close.evaluate((button) => {
    const box = button.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button;
  });
  expect(topmost).toBe(true);
  await close.click();
  await expect(close).toHaveCount(0);
});
