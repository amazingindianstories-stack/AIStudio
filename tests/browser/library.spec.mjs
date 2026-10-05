import { test as base, expect } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";

// This suite creates disposable records. Never infer a remote/production target.
const test = base.extend({
  library: async ({ page, context, baseURL }, provideFixture) => {
    const databaseUrl = process.env.E2E_DATABASE_URL;
    if (!databaseUrl || !process.env.AUTH_SECRET) throw new Error("E2E_DATABASE_URL and AUTH_SECRET are required.");
    const target = new URL(databaseUrl);
    if (!["127.0.0.1", "localhost"].includes(target.hostname) || !target.pathname.includes("codex_regression")) {
      throw new Error("Browser fixtures require the disposable local codex_regression database.");
    }
    if (!["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname)) throw new Error("Browser fixtures cannot target deployed services.");
    const db = postgres(databaseUrl, { max: 1 });
    const userId = randomUUID();
    const prefix = `Browser ${randomUUID().slice(0, 8)}`;
    const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString("base64url");
    const signature = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
    await db`INSERT INTO users (id, email, password_hash, password_salt, name, role, created_at)
      VALUES (${userId}, ${`${userId}@example.test`}, 'fixture', 'fixture', ${prefix}, 'admin', ${Date.now()})`;
    await context.addCookies([{ name: "veevee_session", value: `${payload}.${signature}`, url: baseURL }]);
    const projectIds = [];
    const createProject = async (suffix) => {
      const response = await context.request.post("/api/projects", { data: { op: "createProject", name: `${prefix} ${suffix}` } });
      expect(response.ok()).toBeTruthy(); const { project } = await response.json(); projectIds.push(project.id); return project;
    };
    const project = await createProject("A");
    const otherProject = await createProject("B");
    const folderIds = [];
    const createFolder = async (name, projectId = null, parentId = null) => {
      const response = await context.request.post("/api/folders", { data: { name: `${prefix} ${name}`, projectId, parentId, idempotencyKey: randomUUID() } });
      expect(response.ok()).toBeTruthy(); const { folder } = await response.json(); folderIds.push(folder.id); return folder;
    };
    const globalRoot = await createFolder("Global Root");
    const projectRoot = await createFolder("Project Root", project.id);
    const globalChild = await createFolder("Global Child", null, globalRoot.id);
    const projectChild = await createFolder("Project Child", project.id, projectRoot.id);
    const navigate = async (scope) => {
      const panel = page.locator("#desktop-history-panel");
      if (scope === "global") await panel.getByText("All Global", { exact: true }).click();
      else {
        await panel.getByRole("button", { name: "Select library project" }).click();
        await page.getByRole("menuitem", { name: scope === "other" ? otherProject.name : project.name, exact: true }).click();
      }
      await expect(panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText(scope === "global" ? "Global Library" : scope === "other" ? otherProject.name : project.name);
    };
    await page.goto("/");
    const panel = page.locator("#desktop-history-panel");
    if (await page.getByRole("button", { name: "Show assets panel", exact: true }).count()) await page.getByRole("button", { name: "Show assets panel", exact: true }).first().click();
    await panel.locator(".scope-tabs button").first().click();
    await expect(panel.getByRole("button", { name: "New global folder" })).toBeVisible();
    try { await provideFixture({ db, prefix, project, otherProject, globalRoot, projectRoot, globalChild, projectChild, createFolder, navigate, panel }); }
    finally {
      // Delete only this fixture's records, including folders created through real UI buttons.
      await db`DELETE FROM portrait_groups WHERE name LIKE ${`${prefix}%`}`;
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
  await library.panel.getByText("All Global", { exact: true }).click();
  release();
  await expect.poll(() => delivered).toBeGreaterThan(0);
  await expect(library.panel.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Global Library");
  await expect(library.panel.getByRole("button", { name: `Card folder actions: ${library.globalRoot.name}`, exact: true })).toBeVisible();
});

for (const scope of ["global", "project"]) {
  for (const entry of ["tree", "card", "breadcrumb"]) {
    for (const depth of ["root", "subfolder"]) {
    test(`${scope} ${entry} ${depth} rename retains focus and Enter commits exactly once`, async ({ page, library }) => {
      await library.navigate(scope);
      const parent = scope === "global" ? library.globalRoot : library.projectRoot;
      const root = depth === "root" ? parent : scope === "global" ? library.globalChild : library.projectChild;
      if (depth === "subfolder") {
        await library.panel.getByRole("treeitem").filter({ hasText: parent.name }).getByRole("button").first().click();
        if (entry === "card") await library.panel.getByRole("treeitem").filter({ hasText: parent.name }).click();
      }
      if (entry === "breadcrumb") {
        await library.panel.getByRole("treeitem").filter({ hasText: root.name }).click();
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
      await library.panel.getByText("All Global", { exact: true }).click();
      expect(mutations).toHaveLength(1);
      const [row] = await library.db`SELECT name FROM folders WHERE id = ${root.id}`;
      expect(row.name).toBe(name);
    });
  }
  }
  for (const entry of ["root", "tree", "breadcrumb", "card-list"]) {
    test(`${scope} ${entry} creation focuses, commits once and uses the correct parent`, async ({ page, library }) => {
      await library.navigate(scope);
      const root = scope === "global" ? library.globalRoot : library.projectRoot;
      if (entry === "root") await library.panel.getByRole("button", { name: `New ${scope} folder`, exact: true }).click();
      else if (entry === "tree") {
        await library.panel.getByRole("button", { name: `Tree folder actions: ${root.name}`, exact: true }).click();
        await page.getByRole("menuitem", { name: "New subfolder", exact: true }).click();
      } else {
        await library.panel.getByRole("treeitem").filter({ hasText: root.name }).click();
        if (entry === "breadcrumb") await library.panel.getByRole("button", { name: "New subfolder", exact: true }).click();
        else await library.panel.getByTestId("child-folder-list").getByRole("button", { name: "New", exact: true }).click();
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
  await open(); await input.fill(`${library.prefix} Blur`); await library.panel.getByText("All Global", { exact: true }).click();
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
    if (await page.getByRole("button", { name: "Show assets panel", exact: true }).count()) await page.getByRole("button", { name: "Show assets panel", exact: true }).first().click();
    await library.panel.locator(".scope-tabs button").first().click(); await library.navigate("global");
    let row = library.panel.getByRole("treeitem").filter({ hasText: library.globalRoot.name });
    await row.getByRole("button").first().click();
    for (let i = 0; i < 13; i++) {
      row = library.panel.getByRole("treeitem").filter({ hasText: `${library.prefix} Level ${i} long folder name` });
      await row.getByRole("button").first().click();
    }
    await library.panel.getByRole("treeitem").filter({ hasText: parent.name }).click();
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
  await library.panel.getByRole("button", { name: "New global folder" }).click();
  const input = library.panel.getByRole("textbox", { name: "Folder name", exact: true });
  await input.fill(`${library.prefix} Cancelled`); await input.press("Escape");
  expect((await library.db`SELECT id FROM folders WHERE name = ${`${library.prefix} Cancelled`}`).length).toBe(0);
  await library.panel.getByRole("button", { name: "New global folder" }).click();
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
  await input.press("Enter"); await library.panel.getByText("All Global", { exact: true }).click();
  await expect.poll(() => count).toBe(1);
  release(); await expect(input).toHaveCount(0);
  expect(count).toBe(1);
});

test("Portrait Gallery shares legacy portraits, isolates project groups and clears a stale selection", async ({ page, library }) => {
  const groupIds = [randomUUID(), randomUUID(), randomUUID()];
  const names = ["Global character", "A character", "B character"].map((name) => `${library.prefix} ${name}`);
  for (let i = 0; i < 3; i++) {
    await library.db`INSERT INTO portrait_groups (id, name, project_id, created_at, updated_at)
      VALUES (${groupIds[i]}, ${names[i]}, ${i === 0 ? null : i === 1 ? library.project.id : library.otherProject.id}, ${Date.now()}, ${Date.now()})`;
    await library.db`INSERT INTO portrait_assets (id, group_id, name, image_url, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${groupIds[i]}, ${`${library.prefix} portrait ${i}`}, '/api/media/browser-portrait.png', 'Active', ${Date.now()}, ${Date.now()})`;
  }
  await page.route("**/api/media/browser-portrait.png*", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2kAAAAASUVORK5CYII=", "base64") }));
  const openGallery = async () => {
    await page.getByRole("button", { name: "material", exact: true }).click();
    await page.getByRole("menuitem", { name: "Portrait Gallery", exact: true }).click();
    await expect(page.getByText(names[0], { exact: true })).toBeVisible();
  };
  await library.navigate("project"); await openGallery();
  await expect(page.getByText(names[1], { exact: true })).toBeVisible();
  await expect(page.getByText(names[2], { exact: true })).toHaveCount(0);
  await page.getByText(names[1], { exact: true }).click();
  await page.keyboard.press("Escape"); await library.navigate("other"); await openGallery();
  await expect(page.getByText(names[2], { exact: true })).toBeVisible();
  await expect(page.getByText(names[1], { exact: true })).toHaveCount(0);
  await expect(page.getByText(`${library.prefix} portrait 0`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${library.prefix} portrait 2`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(page.getByText(`${library.prefix} portrait 0`, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await library.navigate("global"); await openGallery();
  await expect(page.getByText(names[1], { exact: true })).toBeVisible();
  await expect(page.getByText(names[2], { exact: true })).toBeVisible();
});

test("global creation from a project context switches to the returned global folder", async ({ page, library }) => {
  await library.navigate("project");
  await library.panel.getByRole("button", { name: "New global folder" }).click();
  const input = library.panel.getByRole("textbox", { name: "Folder name", exact: true });
  await input.fill(`${library.prefix} Global from project`); await input.press("Enter");
  await expect(input).toHaveCount(0);
  const nav = library.panel.getByRole("navigation", { name: "Breadcrumb" });
  await expect(nav).toContainText("Global Library");
  await expect(nav).toContainText(`${library.prefix} Global from project`);
  await expect(nav).not.toContainText(library.project.name);
});

test("a delayed portrait response from the previous project cannot overwrite the new scope", async ({ page, library }) => {
  const names = ["Race A", "Race B"].map((name) => `${library.prefix} ${name}`);
  for (let i = 0; i < 2; i++) await library.db`INSERT INTO portrait_groups (id,name,project_id,created_at,updated_at)
    VALUES (${randomUUID()},${names[i]},${i ? library.otherProject.id : library.project.id},${Date.now()},${Date.now()})`;
  const open = async () => {
    await page.getByRole("button", { name: "material", exact: true }).click();
    await page.getByRole("menuitem", { name: "Portrait Gallery", exact: true }).click();
  };
  await library.navigate("project"); await open(); await expect(page.getByText(names[0], { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  let release; let held = 0; let delivered = 0;
  const barrier = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/assets/portraits?projectId=*", async (route) => {
    if (route.request().url().includes(library.project.id)) {
      const response = await route.fetch(); held++; await barrier; await route.fulfill({ response }); delivered++;
    } else await route.continue();
  });
  await open(); await expect.poll(() => held).toBeGreaterThan(0);
  await page.keyboard.press("Escape"); await library.navigate("other"); await open();
  await expect(page.getByText(names[1], { exact: true })).toBeVisible();
  release(); await expect.poll(() => delivered).toBeGreaterThan(0);
  await expect(page.getByText(names[1], { exact: true })).toBeVisible();
  await expect(page.getByText(names[0], { exact: true })).toHaveCount(0);
});
