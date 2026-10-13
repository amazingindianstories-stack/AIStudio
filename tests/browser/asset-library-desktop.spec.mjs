import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

function getAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  throw new Error('The isolated browser runner must provide its synthetic AUTH_SECRET.');
}

const USER_ID = "e33e1832-9e29-427f-af61-796b842a4b37";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function signSession(userId, authVersion = 0) {
  const secret = getAuthSecret();
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, ver: authVersion, exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

async function setupPage(page, context, baseURL) {
  if (process.env.MIGRATION_TEST_ISOLATED !== '1' || !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
    throw new Error('Desktop browser tests require the disposable local Django harness.');
  }
  const sessionCookie = signSession(USER_ID, 0);
  await context.addCookies([
    {
      name: "veevee_session",
      value: sessionCookie,
      url: baseURL,
    },
  ]);

  // Initial hydration can load Global Library before the scope click. Track
  // that successful feed as well as a later fetch; cached scope selection
  // does not have to issue a duplicate request.
  let globalFeedLoaded = false;
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/history' && url.searchParams.get('projectId') === 'none'
        && response.request().method() === 'GET' && response.ok()) globalFeedLoaded = true;
  });
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: /Desktop fixture/ })).toBeVisible();
  // Wait for hydration before toggling the initially collapsed desktop panel.
  const toggleBtn = page.locator('button[aria-controls="desktop-history-panel"]');
  await expect(toggleBtn).toBeVisible();
  if (await toggleBtn.getAttribute("aria-expanded") !== "true") await toggleBtn.click();
  const panel = page.locator("#desktop-history-panel");
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await panel.getByRole('button', { name: 'Global library', exact: true }).click();
  await expect.poll(() => globalFeedLoaded).toBeTruthy();
  await expect(panel.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Global Library');

  // Wait for asset grid and cards
  const grid = page.locator('[data-testid="asset-grid"]').first();
  await expect(grid).toBeVisible({ timeout: 30000 });
  await page.waitForSelector('[data-asset-card-id]', { timeout: 30000 });
  // The prior scope can remain visible while the new feed loads. Keyboard
  // interaction starts only after this feed has its one roving tab stop.
  await expect(panel.locator('[data-asset-card-id][tabindex="0"]')).toHaveCount(1);
  return { panel, grid };
}

test.describe("Asset Library Desktop Interactions", () => {
  test("1. Tab into Asset Library from a clean state enters roving focus", async ({ page, context, baseURL }) => {
    const { panel, grid } = await setupPage(page, context, baseURL);

    // Click search or panel background to establish initial focus outside the cards
    const searchInput = panel.locator('input[aria-label="Search prompts"]').first();
    await searchInput.focus();
    await expect(searchInput).toBeFocused();

    // Tab forwards until activeElement enters the asset grid
    let entersGrid = false;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const isCardFocused = await page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active && active.hasAttribute("data-asset-card-id"));
      });
      if (isCardFocused) {
        entersGrid = true;
        break;
      }
    }

    expect(entersGrid).toBeTruthy();
  });

  test("2. Arrow keys navigate spatially through the asset grid", async ({ page, context, baseURL }) => {
    const { panel, grid } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(1);

    // Focus the first card
    await cards.first().focus();
    const firstId = await cards.first().getAttribute("data-asset-card-id");

    // Press ArrowRight
    await page.keyboard.press("ArrowRight");

    const focusedId = await page.evaluate(() => {
      return document.activeElement?.getAttribute("data-asset-card-id") || null;
    });

    expect(focusedId).not.toBeNull();
    expect(focusedId).not.toBe(firstId);
  });

  test("3. Space key toggles selection of focused asset", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const firstCard = panel.locator('[data-asset-card-id]').first();
    await firstCard.focus();

    // Clear any prior selection
    await page.keyboard.press("Escape");
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(0);

    // Press Space to select
    await page.keyboard.press("Space");
    await expect(firstCard).toHaveAttribute("data-selected", "true");

    // Press Space to deselect
    await page.keyboard.press("Space");
    await expect(firstCard).not.toHaveAttribute("data-selected", "true");
  });

  test("4. Shift range selection selects a continuous range from anchor", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    expect(await cards.count()).toBeGreaterThanOrEqual(3);

    // Clear selection
    await page.keyboard.press("Escape");

    // Click first card to establish anchor
    await cards.nth(0).click();
    await expect(cards.nth(0)).toHaveAttribute("data-selected", "true");

    // Shift-click third card
    await cards.nth(2).click({ modifiers: ["Shift"] });

    // Range of cards should now be selected
    const selectedCards = panel.locator('[data-selected="true"]');
    expect(await selectedCards.count()).toBeGreaterThanOrEqual(3);

    // Contextual selection toolbar should show count
    const toolbar = panel.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toContainText("selected");
  });

  test("5. Cmd/Ctrl click toggles individual items without clearing", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    expect(await cards.count()).toBeGreaterThanOrEqual(3);

    await page.keyboard.press("Escape");

    // Single click card 0
    await cards.nth(0).click();
    await expect(cards.nth(0)).toHaveAttribute("data-selected", "true");

    // Cmd/Ctrl-click card 2
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await cards.nth(2).click({ modifiers: [modifier] });

    await expect(cards.nth(0)).toHaveAttribute("data-selected", "true");
    await expect(cards.nth(2)).toHaveAttribute("data-selected", "true");
    await expect(cards.nth(1)).not.toHaveAttribute("data-selected", "true");

    // Cmd/Ctrl-click card 0 to untoggle it
    await cards.nth(0).click({ modifiers: [modifier] });
    await expect(cards.nth(0)).not.toHaveAttribute("data-selected", "true");
    await expect(cards.nth(2)).toHaveAttribute("data-selected", "true");
  });

  test("6. Cmd/Ctrl+A selects all assets and Escape clears selection", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    const totalVisible = await cards.count();
    expect(totalVisible).toBeGreaterThan(0);

    // Focus into library
    await cards.first().focus();

    // Press Cmd/Ctrl+A
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+a`);

    const selectedCards = panel.locator('[data-selected="true"]');
    await expect(selectedCards).toHaveCount(totalVisible);

    const toolbar = panel.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible();

    // Press Escape to clear
    await page.keyboard.press("Escape");
    await expect(selectedCards).toHaveCount(0);
    await expect(toolbar).not.toBeVisible();
  });

  test("7. Marquee selection works in multiple drag directions", async ({ page, context, baseURL }) => {
    const { panel, grid } = await setupPage(page, context, baseURL);

    await page.keyboard.press("Escape");
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(0);

    const cards = panel.locator('[data-asset-card-id]');
    expect(await cards.count()).toBeGreaterThanOrEqual(1);

    const firstCard = cards.first();
    const cardBox = await firstCard.boundingBox();
    expect(cardBox).not.toBeNull();

    // Start outside the first card and drag across it
    const startX = cardBox.x - 5;
    const startY = cardBox.y - 5;
    const endX = cardBox.x + cardBox.width + 10;
    const endY = cardBox.y + cardBox.height + 10;

    // Direction 1: Drag Top-Left to Bottom-Right across cards
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();

    const selectedCountAfterDownRight = await panel.locator('[data-selected="true"]').count();
    expect(selectedCountAfterDownRight).toBeGreaterThan(0);

    // Clear
    await page.keyboard.press("Escape");
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(0);

    // Direction 2: Drag Bottom-Right to Top-Left
    await page.mouse.move(endX, endY);
    await page.mouse.down();
    await page.mouse.move(startX, startY, { steps: 5 });
    await page.mouse.up();

    const selectedCountAfterUpLeft = await panel.locator('[data-selected="true"]').count();
    expect(selectedCountAfterUpLeft).toBeGreaterThan(0);
  });

  test("8. Selection reconciles cleanly when library scope changes", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    expect(await cards.count()).toBeGreaterThan(0);

    // Select first card
    await cards.first().click();
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(1);

    // Switch scope by clicking All assets tab
    const allAssetsTab = panel.locator('button[title*="All assets"], button:has-text("All assets")').first();
    await allAssetsTab.click();
    await page.waitForTimeout(400);

    // Selection must be cleared for the new scope!
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid="selection-toolbar"]')).not.toBeVisible();
  });

  test("9. HTML5 drag payload contracts for single and multi-selection", async ({ page, context, baseURL }) => {
    await setupPage(page, context, baseURL);

    // Test single drag payload
    const singleDragPayload = await page.evaluate(() => {
      const { setAssetDragData, getAssetDragData } = window.__DRAG_CONTRACT__;
      const dt = new DataTransfer();
      const mockItem = { id: "test-single-1", kind: "image", prompt: "A test prompt" };
      setAssetDragData(dt, [mockItem], mockItem);
      return getAssetDragData(dt);
    });

    expect(singleDragPayload.count).toBe(1);
    expect(singleDragPayload.ids).toEqual(["test-single-1"]);

    // Test multi drag payload
    const multiDragPayload = await page.evaluate(() => {
      const { setAssetDragData, getAssetDragData } = window.__DRAG_CONTRACT__;
      const dt = new DataTransfer();
      const items = [
        { id: "test-m-1", kind: "image", prompt: "First" },
        { id: "test-m-2", kind: "video", prompt: "Second" },
      ];
      setAssetDragData(dt, items, items[0]);
      return getAssetDragData(dt);
    });

    expect(multiDragPayload.count).toBe(2);
    expect(multiDragPayload.ids).toEqual(["test-m-1", "test-m-2"]);
    expect(multiDragPayload.primaryItem.id).toBe("test-m-1");
  });

  test("10. Upscaler accepts image drag and explicitly rejects video drag", async ({ page, context, baseURL }) => {
    await setupPage(page, context, baseURL);

    const validationResults = await page.evaluate(() => {
      const { validateUpscalerDrop } = window.__DRAG_CONTRACT__;
      const VEEVEE_ASSET_MIME = "application/x-veevee-assets";

      // Image payload
      const imgDt = new DataTransfer();
      imgDt.setData(VEEVEE_ASSET_MIME, JSON.stringify({
        ids: ["img-1"],
        items: [{ id: "img-1", kind: "image" }],
        primaryId: "img-1",
        count: 1,
      }));
      const imgResult = validateUpscalerDrop({ dataTransfer: imgDt });

      // Video payload
      const vidDt = new DataTransfer();
      vidDt.setData(VEEVEE_ASSET_MIME, JSON.stringify({
        ids: ["vid-1"],
        items: [{ id: "vid-1", kind: "video" }],
        primaryId: "vid-1",
        count: 1,
      }));
      const vidResult = validateUpscalerDrop({ dataTransfer: vidDt });

      return { imgResult, vidResult };
    });

    expect(validationResults.imgResult.valid).toBe(true);
    expect(validationResults.vidResult.valid).toBe(false);
    expect(validationResults.vidResult.reason).toContain("Upscaler only accepts images");
  });

  test("11. Depth composer accepts OS video files and rejects Asset Library generation drag", async ({ page, context, baseURL }) => {
    await setupPage(page, context, baseURL);

    const validationResults = await page.evaluate(() => {
      const { validateDepthDrop } = window.__DRAG_CONTRACT__;
      const VEEVEE_ASSET_MIME = "application/x-veevee-assets";

      // Asset Library drag
      const assetDt = new DataTransfer();
      assetDt.setData(VEEVEE_ASSET_MIME, JSON.stringify({
        ids: ["gen-vid-1"],
        items: [{ id: "gen-vid-1", kind: "video" }],
        primaryId: "gen-vid-1",
        count: 1,
      }));
      const assetResult = validateDepthDrop({ dataTransfer: assetDt });

      // OS File drag
      const fileDt = new DataTransfer();
      Object.defineProperty(fileDt, "types", { value: ["Files"] });
      const fileResult = validateDepthDrop({ dataTransfer: fileDt });

      return { assetResult, fileResult };
    });

    expect(validationResults.assetResult.valid).toBe(false);
    expect(validationResults.assetResult.reason).toContain("Direct video file uploads only");
    expect(validationResults.fileResult.valid).toBe(true);
  });

  test("12. Portrait Gallery accepts images and rejects video-only payloads", async ({ page, context, baseURL }) => {
    await setupPage(page, context, baseURL);

    const validationResults = await page.evaluate(() => {
      const { validatePortraitDrop } = window.__DRAG_CONTRACT__;
      const VEEVEE_ASSET_MIME = "application/x-veevee-assets";

      // Video-only payload
      const vidDt = new DataTransfer();
      vidDt.setData(VEEVEE_ASSET_MIME, JSON.stringify({
        ids: ["vid-1"],
        items: [{ id: "vid-1", kind: "video" }],
        primaryId: "vid-1",
        count: 1,
      }));
      const vidResult = validatePortraitDrop({ dataTransfer: vidDt });

      // Image payload
      const imgDt = new DataTransfer();
      imgDt.setData(VEEVEE_ASSET_MIME, JSON.stringify({
        ids: ["img-1"],
        items: [{ id: "img-1", kind: "image" }],
        primaryId: "img-1",
        count: 1,
      }));
      const imgResult = validatePortraitDrop({ dataTransfer: imgDt });

      return { vidResult, imgResult };
    });

    expect(validationResults.vidResult.valid).toBe(false);
    expect(validationResults.vidResult.reason).toContain("Portrait Gallery only accepts images");
    expect(validationResults.imgResult.valid).toBe(true);
  });

  test("13. Folder cycle prevention blocks dropping a folder into itself or subfolders", async ({ page, context, baseURL }) => {
    await setupPage(page, context, baseURL);

    const cycleResults = await page.evaluate(() => {
      const { isFolderDescendant } = window.__DRAG_CONTRACT__;
      const folderTree = [
        {
          id: "folder-a",
          children: [
            {
              id: "folder-b",
              children: [{ id: "folder-c", children: [] }],
            },
          ],
        },
        { id: "folder-x", children: [] },
      ];

      return {
        self: isFolderDescendant(folderTree, "folder-a", "folder-a"),
        child: isFolderDescendant(folderTree, "folder-a", "folder-b"),
        grandchild: isFolderDescendant(folderTree, "folder-a", "folder-c"),
        other: isFolderDescendant(folderTree, "folder-a", "folder-x"),
      };
    });

    expect(cycleResults.self).toBe(true);
    expect(cycleResults.child).toBe(true);
    expect(cycleResults.grandchild).toBe(true);
    expect(cycleResults.other).toBe(false);
  });

  test("14. Flicker guard maintains active drag state across nested child transitions", async ({ page, context, baseURL }) => {
    await setupPage(page, context, baseURL);

    const flickerTest = await page.evaluate(() => {
      const { createDropzoneFlickerGuard } = window.__DRAG_CONTRACT__;

      const stateHistory = [];
      const guard = createDropzoneFlickerGuard((active) => {
        stateHistory.push(active);
      });

      // 1. Enter dropzone container
      guard.enter({});
      // 2. Enter nested icon (counter = 2)
      guard.enter({});
      // 3. Leave container to icon (counter = 1) - must NOT trigger onStateChange(false)
      guard.leave({});
      // 4. Leave icon to outside (counter = 0) - triggers onStateChange(false)
      guard.leave({});

      return {
        history: stateHistory,
        finalCount: guard.count,
      };
    });

    // Should transition to true exactly once, and to false exactly once at the end
    expect(flickerTest.history).toEqual([true, false]);
    expect(flickerTest.finalCount).toBe(0);
  });

  test("15. Escape clears selection when focus is anywhere within library controls", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    await cards.first().click();
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(1);

    // Move focus into a control in the contextual selection toolbar
    const toolbar = panel.locator('[data-testid="selection-toolbar"]');
    await expect(toolbar).toBeVisible();
    const toolbarBtn = toolbar.locator("button").first();
    await toolbarBtn.focus();
    await expect(toolbarBtn).toBeFocused();

    // Press Escape
    await page.keyboard.press("Escape");

    // Selection should be cleared!
    await expect(panel.locator('[data-selected="true"]')).toHaveCount(0);
    await expect(toolbar).not.toBeVisible();
  });

  test("16. Keyboard shortcut / or Cmd/Ctrl+F focuses Search input", async ({ page, context, baseURL }) => {
    const { panel } = await setupPage(page, context, baseURL);

    const cards = panel.locator('[data-asset-card-id]');
    await cards.first().focus();

    const searchInput = panel.locator('input[aria-label="Search prompts"]').first();

    // Press '/'
    await page.keyboard.press("/");
    await expect(searchInput).toBeFocused();

    // Blur search
    await cards.first().focus();

    // Press Cmd/Ctrl+F
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+f`);
    await expect(searchInput).toBeFocused();
  });
});
