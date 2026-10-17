
async function postAsBrowser(api, path, options = {}) {
  return api.post(path, { ...options, headers: { Origin: process.env.E2E_BASE_URL, ...options.headers } });
}
import { test as base, expect } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { fixtureDatabase } from './fixture-db.mjs';
import { openTreeFolder } from './tree.mjs';
import { portraitPng } from './portrait-image.mjs';


// This suite creates disposable records. Never infer a remote/production target.
const test = base.extend({
  library: async ({ page, context, baseURL }, provideFixture) => {
    const databaseUrl = process.env.E2E_DATABASE_URL;
    if (!databaseUrl || !process.env.AUTH_SECRET) throw new Error("E2E_DATABASE_URL and AUTH_SECRET are required.");
    const target = new URL(databaseUrl);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== '/veevee_django_migration') {
      throw new Error("Browser fixtures require the disposable local Django migration database.");
    }
    if (!["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname)) throw new Error("Browser fixtures cannot target deployed services.");
    const db = fixtureDatabase(databaseUrl);
    const userId = randomUUID();
    const prefix = `Browser ${randomUUID().slice(0, 8)}`;
    const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString("base64url");
    const signature = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
    await db`INSERT INTO users (id, email, password_hash, password_salt, name, role, created_at)
      VALUES (${userId}, ${`${userId}@example.test`}, 'fixture', 'fixture', ${prefix}, 'admin', ${Date.now()})`;
    await context.addCookies([{ name: "veevee_session", value: `${payload}.${signature}`, url: baseURL }]);
    const projectIds = [];
    const createProject = async (suffix) => {
      const response = await postAsBrowser(context.request, "/api/projects", { data: { op: "createProject", name: `${prefix} ${suffix}` } });
      expect(response.ok()).toBeTruthy(); const { project } = await response.json(); projectIds.push(project.id); return project;
    };
    const project = await createProject("A");
    const otherProject = await createProject("B");
    const folderIds = [];
    const createFolder = async (name, projectId = null, parentId = null) => {
      const response = await postAsBrowser(context.request, "/api/folders", { data: { name: `${prefix} ${name}`, projectId, parentId, idempotencyKey: randomUUID() } });
      expect(response.ok()).toBeTruthy(); const { folder } = await response.json(); folderIds.push(folder.id); return folder;
    };
    const globalRoot = await createFolder("Global Root");
    const projectRoot = await createFolder("Project Root", project.id);
    const globalChild = await createFolder("Global Child", null, globalRoot.id);
    const projectChild = await createFolder("Project Child", project.id, projectRoot.id);
    const navigate = async (scope) => {
      const panel = page.locator("#desktop-history-panel");
      if (scope === "global") await panel.getByRole("button", { name: "Global library", exact: true }).click();
      else {
        await panel.getByRole("button", { name: "Switch workspace" }).click();
        await page.getByRole("menuitem", { name: scope === "other" ? otherProject.name : project.name, exact: true }).click();
      }
      await expect(panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText(scope === "global" ? "Global Library" : scope === "other" ? otherProject.name : project.name);
      const show = panel.getByRole('button', { name: 'Show folders', exact: true });
      if (await show.count()) await show.click();
      const expand = panel.getByRole('button', { name: 'Expand folders', exact: true });
      if (await expand.count()) await expand.click();
    };
    await page.goto("/");
    await expect(page.getByRole("button", { name: new RegExp(prefix) }).first()).toBeVisible();
    const panel = page.locator("#desktop-history-panel");
    await expect(page.locator('button[aria-controls="desktop-history-panel"]')).toBeVisible();
    if (await page.locator('button[aria-controls="desktop-history-panel"]').getAttribute("aria-expanded") !== "true") await page.locator('button[aria-controls="desktop-history-panel"]').click();
    await panel.getByRole("button", { name: "Global library", exact: true }).click();
    await expect(panel.getByRole("button", { name: "+ New folder" })).toBeVisible();
    try { await provideFixture({ db, prefix, project, otherProject, globalRoot, projectRoot, globalChild, projectChild, createFolder, navigate, panel }); }
    finally {
      // Delete only this fixture's records, including folders created through real UI buttons.
      await db`DELETE FROM managed_portrait_pins WHERE asset_id IN (SELECT id FROM managed_portrait_assets WHERE name LIKE ${`${prefix}%`})`;
      await db`DELETE FROM managed_portrait_assets WHERE name LIKE ${`${prefix}%`}`;
      await db`DELETE FROM folders WHERE name LIKE ${`${prefix}%`} OR project_id IN ${db(projectIds)}`;
      await db`DELETE FROM projects WHERE id IN ${db(projectIds)}`;
      await db`DELETE FROM activity_logs WHERE user_id = ${userId}`;
      await db`DELETE FROM users WHERE id = ${userId}`;
      await db.end();
    }
  },
});

async function settleFocus(page, input) {
  await expect(input).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(input).toBeFocused();
}

test.describe('pointer folder move evidence', () => {
  test('pointer folder drag persists its subtree after Django move and reload', async ({ page, library }, testInfo) => {
    const destination = await library.createFolder('Pointer destination');
    await page.reload();
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await library.navigate('global');
    const source = library.panel.getByRole('treeitem').filter({ hasText: library.globalRoot.name });
    const target = library.panel.getByRole('treeitem').filter({ hasText: destination.name });
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    const before = (await library.db`SELECT version FROM folders WHERE id = ${library.globalRoot.id}`)[0];
    const mutation = page.waitForResponse(response => response.url().endsWith('/api/folders') &&
      response.request().method() === 'PATCH' && response.request().postDataJSON()?.id === library.globalRoot.id);
    // Playwright performs a pointer gesture; no dispatchEvent/DataTransfer injection.
    await source.dragTo(target);
    expect((await mutation).ok()).toBeTruthy();
    await expect.poll(async () => (await library.db`SELECT parent_id FROM folders WHERE id = ${library.globalRoot.id}`)[0].parent_id).toBe(destination.id);
    const [moved] = await library.db`SELECT version, project_id FROM folders WHERE id = ${library.globalRoot.id}`;
    expect(moved.version).toBeGreaterThan(before.version);
    expect(moved.project_id).toBeNull();
    expect((await library.db`SELECT parent_id FROM folders WHERE id = ${library.globalChild.id}`)[0].parent_id).toBe(library.globalRoot.id);
    await page.reload();
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await library.navigate('global');
    const destinationRow = library.panel.getByRole('treeitem').filter({ hasText: destination.name });
    await expect(destinationRow).toHaveAttribute('aria-expanded', 'false');
    await destinationRow.getByRole('button').first().click();
    await expect(source).toBeVisible();
    await source.getByRole('button').first().click();
    const child = library.panel.getByRole('treeitem').filter({ hasText: library.globalChild.name });
    await expect(child).toBeVisible();
    await openTreeFolder(library.panel, library.globalChild.name);
    await expect(library.panel.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(destination.name);
    await expect(library.panel.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(library.globalChild.name);
    await testInfo.attach('pointer-folder-move-after-reload', { body: await page.screenshot(), contentType: 'image/png' });
  });
});

test("a delayed initial project load preserves the user's explicit global scope", async ({ page, library }) => {
  let release; let held = 0; let delivered = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(); held++; await barrier;
    await route.fulfill({ response }); delivered++;
  });
  await page.reload();
  if (await page.getByRole("button", { name: "Show assets panel", exact: true }).count()) {
    await page.getByRole("button", { name: "Show assets panel", exact: true }).first().click();
  }
  await expect.poll(() => held).toBeGreaterThan(0);
  await library.panel.getByRole("button", { name: "Global library", exact: true }).click();
  release();
  await expect.poll(() => delivered).toBeGreaterThan(0);
  await expect(library.panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Global Library");
  await expect(library.panel.getByRole("button", { name: `Tree folder actions: ${library.globalRoot.name}`, exact: true })).toBeVisible();
});

for (const scope of ["global", "project"]) {
  for (const entry of ["tree", "card", "breadcrumb"]) {
    for (const depth of ["root", "subfolder"]) {
    test(`${scope} ${entry} ${depth} rename retains focus and Enter commits exactly once`, async ({ page, library }, testInfo) => {
      if (scope === "global" && entry === "card") {
        for (let index = 0; index < 12; index++) await library.createFolder(`Dense ${depth} sibling ${index} long descriptive folder name`, null, depth === "root" ? null : library.globalRoot.id);
        await page.reload();
        const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
        await expect(toggle).toBeVisible();
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      }
      await library.navigate(scope);
      const parent = scope === "global" ? library.globalRoot : library.projectRoot;
      const root = depth === "root" ? parent : scope === "global" ? library.globalChild : library.projectChild;
      if (depth === "subfolder") {
        await library.panel.getByRole("treeitem").filter({ hasText: parent.name }).getByRole("button").first().click();
        if (entry === "card") {
          await library.panel.getByRole("treeitem").filter({ hasText: parent.name }).getByText(parent.name, { exact: true }).click();
          await expect(library.panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText(parent.name);
        }
      }
      if (scope === "global" && entry === "card" ) {
        const grid = library.panel.getByTestId("child-folder-list");
        await expect(grid.locator(':scope > [role="button"]').filter({ hasText: library.prefix })).toHaveCount(13);
        const geometry = await grid.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const cards = Array.from(element.children);
          return { width: bounds.width, count: cards.length, overflow: element.scrollWidth > element.clientWidth + 1,
            cards: cards.map((card) => { const box = card.getBoundingClientRect(); const button = card.querySelector('button[aria-label^="Card folder actions:"]'); const action = button.getBoundingClientRect(); return { width: box.width, height: box.height, actionInside: action.left >= box.left && action.right <= box.right, left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }) };
        });
        // The default desktop library panel is narrow: dense folder cards fit at most two columns.
        expect(new Set(geometry.cards.map((card) => Math.round(card.left))).size).toBeLessThanOrEqual(2);
        expect(geometry.count).toBeGreaterThanOrEqual(13);
        expect(geometry.overflow).toBe(false);
        for (const card of geometry.cards) { expect(card.width).toBeGreaterThanOrEqual(160); expect(card.height).toBe(44); expect(card.actionInside).toBe(true); }
        for (let index = 1; index < geometry.cards.length; index++) { const previous = geometry.cards[index - 1], current = geometry.cards[index]; expect(current.top >= previous.bottom || current.left >= previous.right).toBe(true); }
        await testInfo.attach("narrow-folder-geometry", { body: Buffer.from(JSON.stringify(geometry, null, 2)), contentType: "application/json" });
        await page.screenshot({ path: testInfo.outputPath(`narrow-${depth}-folder-cards.png`) });
        const trigger = library.panel.getByRole("button", { name: `Card folder actions: ${root.name}`, exact: true });
        await trigger.scrollIntoViewIfNeeded();
        expect(await trigger.evaluate(button => { const box = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); })).toBe(true);
      }
      if (entry === "breadcrumb") {
        await openTreeFolder(library.panel, root.name);
        await library.panel.getByRole("button", { name: "Current folder actions" }).click();
      } else await library.panel.getByRole("button", { name: `${entry === "tree" ? "Tree" : "Card"} folder actions: ${root.name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      const input = library.panel.getByRole("textbox", { name: "Rename folder", exact: true });
      await settleFocus(page, input);
      const mutations = [];
      page.on("request", (request) => { if (request.method() === "PATCH" && request.url().endsWith("/api/folders")) mutations.push(request); });
      const name = `${library.prefix} Renamed with spaces`;
      await input.fill(""); await input.pressSequentially(name); await input.press("Enter");
      await expect(input).toHaveCount(0);
      await library.panel.getByRole("button", { name: "Global library", exact: true }).click();
      expect(mutations).toHaveLength(1);
      const [row] = await library.db`SELECT name FROM folders WHERE id = ${root.id}`;
      expect(row.name).toBe(name);
    });
  }
  }
  for (const entry of ["root", "tree", "breadcrumb"]) {
    test(`${scope} ${entry} creation focuses, commits once and uses the correct parent`, async ({ page, library }) => {
      await library.navigate(scope);
      const root = scope === "global" ? library.globalRoot : library.projectRoot;
      if (entry === "root") await library.panel.getByRole("button", { name: "+ New folder", exact: true }).click();
      else if (entry === "tree") {
        await library.panel.getByRole("button", { name: `Tree folder actions: ${root.name}`, exact: true }).click();
        await page.getByRole("menuitem", { name: "New subfolder", exact: true }).click();
      } else {
        await openTreeFolder(library.panel, root.name);
        // "+ New folder" creates inside the current folder; wait until the click has made it current.
        await expect(library.panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText(root.name);
        if (entry === "breadcrumb") await library.panel.getByRole("button", { name: "+ New folder", exact: true }).click();
      }
      const input = library.panel.getByRole("textbox", { name: entry === "root" ? "Folder name" : "Subfolder name", exact: true });
      await settleFocus(page, input);
      const mutations = [];
      page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/folders")) mutations.push(request); });
      const name = `${library.prefix} Created`;
      await input.fill(name); await input.press("Enter");
      await expect(input).toHaveCount(0);
      await expect(library.panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText(name);
      expect(mutations).toHaveLength(1);
      const [row] = await library.db`SELECT project_id, parent_id FROM folders WHERE name = ${name}`;
      expect(row.project_id).toBe(scope === "global" ? null : library.project.id);
      expect(row.parent_id).toBe(entry === "root" ? null : root.id);
    });
  }
}

test("rename Escape cancels; blur commits; errors retain draft; conflict retries explicitly", async ({ page, library }) => {
  await library.navigate("global");
  const open = async () => {
    await library.panel.getByRole("button", { name: new RegExp(`^Tree folder actions: ${library.prefix}`) }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  };
  const input = library.panel.getByRole("textbox", { name: "Rename folder" });
  await open(); await input.fill(`${library.prefix} Cancelled`); await input.press("Escape");
  expect((await library.db`SELECT name FROM folders WHERE id = ${library.globalRoot.id}`)[0].name).toBe(library.globalRoot.name);
  await open(); await input.fill(`${library.prefix} Blur`); await library.panel.getByRole("button", { name: "Global library", exact: true }).click();
  await expect(input).toHaveCount(0);
  expect((await library.db`SELECT name FROM folders WHERE id = ${library.globalRoot.id}`)[0].name).toBe(`${library.prefix} Blur`);
  await open(); await input.fill(`${library.prefix} Retry`);
  // A real concurrent version bump exercises the server conflict, not a fake success response.
  await library.db`UPDATE folders SET version = version + 1 WHERE id = ${library.globalRoot.id}`;
  await input.press("Enter");
  await expect(library.panel.getByRole("alert")).toContainText("changed elsewhere");
  await expect(input).toHaveValue(`${library.prefix} Retry`);
  await input.press("Enter"); await expect(input).toHaveCount(0);
});

for (const width of [1024, 1440]) {
  test(`15-level breadcrumb scroll at ${width}px retains ancestors and toolbar`, async ({ page, library }) => {
    let parent = library.globalRoot;
    for (let i = 0; i < 14; i++) parent = await library.createFolder(`Level ${i} long folder name`, null, parent.id);
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await expect(page.locator('button[aria-controls="desktop-history-panel"]')).toBeVisible();
    if (await page.locator('button[aria-controls="desktop-history-panel"]').getAttribute("aria-expanded") !== "true") await page.locator('button[aria-controls="desktop-history-panel"]').click();
    await library.panel.getByRole("button", { name: "Global library", exact: true }).click(); await library.navigate("global");
    let row = library.panel.getByRole("treeitem").filter({ hasText: library.globalRoot.name });
    await row.getByRole("button").first().click();
    for (let i = 0; i < 13; i++) {
      row = library.panel.getByRole("treeitem").filter({ hasText: `${library.prefix} Level ${i} long folder name` });
      await row.getByRole("button").first().click();
    }
    await openTreeFolder(library.panel, parent.name);
    const nav = library.panel.getByRole("navigation", { name: "Breadcrumb" });
    await expect(nav).toContainText(parent.name);
    expect(await nav.locator("button").count()).toBe(15);
    const geometry = await nav.evaluate((el) => ({ width: el.clientWidth, total: el.scrollWidth, left: el.scrollLeft }));
    expect(geometry.total).toBeGreaterThan(geometry.width); expect(geometry.left).toBeGreaterThan(0);
    await expect(library.panel.getByRole("button", { name: "Current folder actions" })).toBeVisible();
    await nav.evaluate((el) => { el.scrollLeft = 0; });
    expect(await nav.evaluate((el) => el.scrollLeft)).toBe(0);
    await nav.dispatchEvent("wheel", { deltaY: 100, deltaX: 0, shiftKey: true });
    expect(await nav.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await nav.locator("button").last().focus();
    expect(await nav.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await nav.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    expect(await nav.evaluate((el) => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft))).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}

test("creation Escape cancels and a rejected request retains the draft until explicit retry", async ({ page, library }) => {
  await library.navigate("global");
  await library.panel.getByRole("button", { name: "+ New folder" }).click();
  const input = library.panel.getByRole("textbox", { name: "Folder name", exact: true });
  await input.fill(`${library.prefix} Cancelled`); await input.press("Escape");
  expect((await library.db`SELECT id FROM folders WHERE name = ${`${library.prefix} Cancelled`}`).length).toBe(0);
  await library.panel.getByRole("button", { name: "+ New folder" }).click();
  const name = `${library.prefix} Retained`;
  await input.fill(name);
  await page.route("**/api/folders", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 503, json: { error: "Fixture service unavailable" } });
    else await route.continue();
  });
  await input.press("Enter");
  await expect(library.panel.getByRole("alert")).toContainText("Fixture service unavailable");
  await expect(input).toHaveValue(name);
  await page.unroute("**/api/folders");
  await input.press("Enter"); await expect(input).toHaveCount(0);
  expect((await library.db`SELECT id FROM folders WHERE name = ${name}`).length).toBe(1);
});

test("Enter followed by blur during a slow rename issues one request; menu Escape restores focus", async ({ page, library }) => {
  await library.navigate("global");
  const trigger = library.panel.getByRole("button", { name: `Tree folder actions: ${library.globalRoot.name}`, exact: true });
  await trigger.focus(); await trigger.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "New subfolder", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await trigger.click(); await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const input = library.panel.getByRole("textbox", { name: "Rename folder" });
  await input.fill(`${library.prefix} Slow`);
  let count = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/folders", async (route) => {
    if (route.request().method() === "PATCH") { count++; await barrier; }
    await route.continue();
  });
  await input.press("Enter"); await library.panel.getByRole("button", { name: "Global library", exact: true }).click();
  await expect.poll(() => count).toBe(1);
  release(); await expect(input).toHaveCount(0);
  expect(count).toBe(1);
});

const PORTRAIT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2kAAAAASUVORK5CYII=", "base64");

// Ready gallery portraits are seeded directly; their pictures are served by a route so the grid has real tiles.
async function seedPortraits(library, page, count) {
  const now = Date.now();
  const [{ id: creator }] = await library.db`SELECT id FROM users WHERE name = ${library.prefix}`;
  const names = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const name = `${library.prefix} face ${String(i).padStart(2, "0")}`;
    names.push(name);
    await library.db`INSERT INTO managed_portrait_assets (id, content_sha256, source_key, byteplus_asset_id, status, created_by_id, created_at, updated_at, last_used_at, name, origin)
      VALUES (${id}, ${randomUUID()}, ${`browser-portraits/${id}.png`}, ${`asset-${id}`}, 'ACTIVE', ${creator}, ${now + i}, ${now + i}, ${now + i}, ${name}, 'upload')`;
  }
  await page.route("**/api/media/browser-portraits/**", (route) => route.fulfill({ contentType: "image/png", body: PORTRAIT_PNG }));
  return names;
}

async function openPortraitGallery(page) {
  await page.getByRole("button", { name: "material", exact: true }).click();
  await page.getByRole("menuitem", { name: "Portrait Gallery", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "Portrait Gallery", exact: true });
  await expect(gallery).toBeVisible();
  return gallery;
}

test("Portrait Gallery is one shared flat grid with drag-to-select, bulk toolbar and no groups", async ({ page, library }, testInfo) => {
  await seedPortraits(library, page, 12);
  const gallery = await openPortraitGallery(page);
  const cards = gallery.locator("article[data-portrait-id]");
  await gallery.getByRole("textbox", { name: "Search portraits", exact: true }).fill(library.prefix);
  await expect(cards).toHaveCount(12);
  await expect(gallery).not.toContainText(/byteplus|group|slot|capacity/i);
  await expect(gallery.getByRole("navigation")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-grid.png") });
  const scroller = gallery.getByTestId("portrait-grid-scroller");
  await expect(scroller).toBeVisible();
  // Start in the grid's left padding, beside the first card, and drag across the first row.
  const bounds = await scroller.boundingBox();
  const first = await cards.first().boundingBox();
  const third = await cards.nth(2).boundingBox();
  const start = { x: bounds.x + 6, y: first.y + first.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height - 24, { steps: 12 });
  await expect(gallery.getByTestId("portrait-grid-marquee")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-marquee.png") });
  await page.mouse.up();
  await expect(gallery.getByTestId("portrait-grid-marquee")).toHaveCount(0);
  await expect(gallery.locator('article[data-selected="true"]')).toHaveCount(3);
  await expect(gallery.getByTestId("portrait-selection-toolbar")).toContainText("3 selected");
  await expect(gallery.getByRole("button", { name: "Add 3 to prompt", exact: true })).toBeVisible();
  await expect(gallery.getByRole("button", { name: "Delete 3", exact: true })).toBeVisible();
  // A drag back through fewer cards shrinks the selection; a click on the background clears it.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(gallery.locator('article[data-selected="true"]')).toHaveCount(1);
  await page.mouse.click(start.x, start.y);
  await expect(gallery.locator('article[data-selected="true"]')).toHaveCount(0);
  // The card's own menu offers the single-portrait actions.
  await cards.first().click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["Add to prompt", "View full size", "Rename", "Download", "Delete"]);
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-card-menu.png") });
  await page.keyboard.press("Escape");
  await cards.first().dblclick();
  const viewer = page.getByRole("complementary", { name: "Portrait Full View", exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer).not.toContainText(/byteplus|asset id|role:/i);
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-viewer.png") });
});

test("a multi-file drop uploads three at a time and registers the portraits in drop order", async ({ page, library }, testInfo) => {
  test.setTimeout(120000);
  const bytes = portraitPng(`${library.prefix} shared`).toString("base64");
  const names = [1, 2, 3, 4].map((n) => `${library.prefix} drop ${n}`);
  const ids = new Map();
  let releaseFirst; const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let others = 0;
  await page.route("**/api/uploads/init", async (route) => {
    const filename = route.request().postDataJSON().filename;
    const response = await route.fetch();
    ids.set((await response.json()).uploadId, filename);
    await route.fulfill({ response });
  });
  // The first dropped file finishes last, so registration has to wait for it to keep the order.
  await page.route("**/api/uploads/*/finalize", async (route) => {
    const filename = ids.get(route.request().url().split("/").at(-2));
    if (filename === `${names[0]}.png`) await firstHeld;
    await route.continue();
    if (filename !== `${names[0]}.png` && ++others === 3) releaseFirst();
  });
  const registrations = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/portraits" && request.method() === "POST") registrations.push(request.postDataJSON().uploads.map((u) => u.name));
  });
  const gallery = await openPortraitGallery(page);
  await expect(gallery.getByRole("textbox", { name: "Search portraits", exact: true })).toBeVisible();
  const transfer = await page.evaluateHandle(({ names, bytes }) => {
    const data = new DataTransfer();
    names.forEach((name, i) => {
      const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
      const tail = new TextEncoder().encode(name);
      const merged = new Uint8Array(raw.length + tail.length); merged.set(raw); merged.set(tail, raw.length);
      data.items.add(new File([merged], `${name}.png`, { type: "image/png" }));
    });
    return data;
  }, { names, bytes });
  await gallery.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(gallery.getByTestId("portrait-drop-overlay")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-drop-overlay.png") });
  await gallery.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(gallery.getByTestId("portrait-drop-overlay")).toHaveCount(0);
  await expect(gallery.locator("[data-portrait-upload]")).toHaveCount(4);
  await expect(gallery.locator('[data-portrait-upload="uploading"]').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-uploading.png") });
  await expect(gallery.locator("article[data-portrait-id]")).toHaveCount(4, { timeout: 60000 });
  await expect(gallery.locator("[data-portrait-upload]")).toHaveCount(0);
  // Files 2 and 3 finished before the first, yet nothing was registered ahead of it; file 4 may
  // follow in a later request, but always after the ones before it.
  expect(registrations.flat()).toEqual(names);
  expect(registrations[0].slice(0, 3)).toEqual(names.slice(0, 3));
  const rows = await library.db`SELECT name FROM managed_portrait_assets WHERE name LIKE ${`${library.prefix} drop %`} ORDER BY created_at ASC, id ASC`;
  expect(rows.map((row) => row.name)).toEqual(names);
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-registered.png") });
});

test("Portrait Gallery refuses oversized and non-image drops per file and keeps the rest", async ({ page, library }) => {
  const bytes = portraitPng(`${library.prefix} shared`).toString("base64");
  const good = `${library.prefix} good`;
  const gallery = await openPortraitGallery(page);
  const transfer = await page.evaluateHandle(({ good, bytes }) => {
    const data = new DataTransfer();
    const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
    data.items.add(new File([raw, new TextEncoder().encode(good)], `${good}.png`, { type: "image/png" }));
    data.items.add(new File([new Uint8Array(31 * 1024 * 1024)], "too-big.png", { type: "image/png" }));
    // A real 1x1 PNG: decodable, but far below the 300 px minimum.
    const tiny = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2kAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
    data.items.add(new File([tiny], "tiny.png", { type: "image/png" }));
    data.items.add(new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4" }));
    return data;
  }, { good, bytes });
  await gallery.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(gallery.getByText(/larger than 30 MB/)).toBeVisible();
  await expect(gallery.getByText("Only image files can be portraits.")).toBeVisible();
  await expect(gallery.getByText("tiny.png is 1 x 1 px. Portraits need at least 300 px and at most 6000 px on each side.")).toBeVisible();
  await expect(gallery.getByRole("article", { name: good, exact: true })).toBeVisible({ timeout: 60000 });
  await gallery.getByRole("button", { name: "Dismiss" }).first().click();
  await expect(gallery.locator('[data-portrait-upload="error"]')).toHaveCount(2);
});

test("Portrait Gallery fits a phone: 16px gutters and no horizontal scroll", async ({ page, library }, testInfo) => {
  await seedPortraits(library, page, 6);
  await page.setViewportSize({ width: 375, height: 740 });
  await page.reload();
  await expect(page.getByRole("button", { name: "material", exact: true })).toBeVisible();
  const gallery = await openPortraitGallery(page);
  await gallery.getByRole("textbox", { name: "Search portraits", exact: true }).fill(library.prefix);
  const cards = gallery.locator("article[data-portrait-id]");
  await expect(cards).toHaveCount(6);
  const scroller = gallery.getByTestId("portrait-grid-scroller");
  expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = await scroller.boundingBox();
  const first = await cards.first().boundingBox();
  expect(Math.round(first.x - box.x)).toBe(16);
  await cards.first().click();
  await expect(gallery.getByTestId("portrait-selection-toolbar")).toBeVisible();
  await expect(gallery.getByRole("button", { name: "Delete 1", exact: true })).toBeVisible();
  expect(await gallery.getByTestId("portrait-selection-toolbar").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-mobile.png") });
  await cards.first().dblclick();
  await expect(page.getByRole("complementary", { name: "Portrait Full View", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("portrait-gallery-mobile-viewer.png") });
});

test("switching a project context to Global library creates and selects a global folder", async ({ page, library }) => {
  await library.navigate("project");
  await library.navigate("global");
  await library.panel.getByRole("button", { name: "+ New folder" }).click();
  const input = library.panel.getByRole("textbox", { name: "Folder name", exact: true });
  await input.fill(`${library.prefix} Global from project`); await input.press("Enter");
  await expect(input).toHaveCount(0);
  const nav = library.panel.getByRole("navigation", { name: "Breadcrumb" });
  await expect(nav).toContainText("Global Library");
  await expect(nav).toContainText(`${library.prefix} Global from project`);
  await expect(nav).not.toContainText(library.project.name);
});

