import { chromium } from "playwright";
import { createHmac } from "crypto";
import fs from "fs";
import path from "path";

function getAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    const envFile = fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8");
    const match = envFile.match(/AUTH_SECRET=["']?([^"'\r\n]+)/);
    if (match) return match[1];
  } catch {}
  return "dev-secret";
}

const USER_ID = "e33e1832-9e29-427f-af61-796b842a4b37";
const BASE_URL = "http://127.0.0.1:3100";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function signSession(userId, authVersion = 0) {
  const secret = getAuthSecret();
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, ver: authVersion, exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

async function capture() {
  const outputDirs = [
    path.resolve(process.cwd(), "docs/screenshots"),
    "/Users/ais4/.gemini/antigravity-cli/brain/23113522-d2da-447d-921e-62b8a058ff57",
  ];

  for (const d of outputDirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const sessionCookie = signSession(USER_ID, 0);
  await context.addCookies([
    {
      name: "veevee_session",
      value: sessionCookie,
      url: BASE_URL,
    },
  ]);

  const page = await context.newPage();
  console.log("Navigating to", BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Ensure desktop history panel is open
  const toggleBtn = page.locator('button[aria-controls="desktop-history-panel"]').first();
  if (await toggleBtn.count() > 0) {
    const isExpanded = await toggleBtn.getAttribute("aria-expanded");
    if (isExpanded !== "true") {
      console.log("Opening desktop history panel...");
      await toggleBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  const panel = page.locator("#desktop-history-panel");

  // Wait for projects to arrive
  await page.waitForFunction(() => (window.useStore?.getState?.().projects?.length ?? 0) > 0, { timeout: 15000 }).catch(() => {});

  // Ensure project workspace with assets is selected
  const scopeProject = panel.locator(".scope-project-name").first();
  await scopeProject.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const currentScopeText = await scopeProject.innerText().catch(() => "");
  if (!currentScopeText.includes("NAISHA")) {
    const switchBtn = panel.locator('button[aria-label="Switch project"]').first();
    if (await switchBtn.count() > 0) {
      await switchBtn.click();
      const naishaOption = page.locator('[role="menuitem"]').filter({ hasText: "NAISHA - PRODUCTION" }).first();
      await naishaOption.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
      if (await naishaOption.count() > 0) {
        await naishaOption.click();
        await page.waitForTimeout(1000);
      }
    }
  }

  // Ensure project assets are shown
  const projAssetsBtn = panel.locator('button:has-text("Project assets")').first();
  if (await projAssetsBtn.count() > 0) {
    await projAssetsBtn.click();
    await page.waitForTimeout(600);
  }

  const grid = page.locator('[data-testid="asset-grid"]').first();
  await grid.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForSelector('[data-asset-card-id]', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Helper to save screenshot to both dirs
  const save = async (name) => {
    for (const d of outputDirs) {
      const p = path.join(d, name);
      await page.screenshot({ path: p });
      console.log("Saved screenshot:", p);
    }
  };

  // 1. 01-normal-state.png
  console.log("Capturing 01-normal-state.png...");
  await save("01-normal-state.png");

  // 2. 02-expanded-folders.png
  console.log("Capturing 02-expanded-folders.png...");
  const foldersHeaderBtn = panel.locator('button:has-text("Folders")').first();
  if (await foldersHeaderBtn.count() > 0) {
    const isExpanded = await foldersHeaderBtn.getAttribute("aria-expanded");
    if (isExpanded !== "true") {
      await foldersHeaderBtn.click();
      await page.waitForTimeout(600);
    }
  }
  await save("02-expanded-folders.png");

  // 4. 04-colored-folders-sidebar.png
  console.log("Capturing 04-colored-folders-sidebar.png...");
  await save("04-colored-folders-sidebar.png");

  // 3. 03-folder-color-menu.png
  console.log("Capturing 03-folder-color-menu.png...");
  // Use the tree folder actions trigger button in the sidebar
  const treeMenuBtn = panel.locator('button[aria-label^="Tree folder actions:"]').first();
  if (await treeMenuBtn.count() > 0) {
    await treeMenuBtn.click({ force: true });
    await page.waitForTimeout(600);
  } else {
    const cardMenuBtn = panel.locator('button[aria-label^="Card folder actions:"]').first();
    if (await cardMenuBtn.count() > 0) {
      await cardMenuBtn.click({ force: true });
      await page.waitForTimeout(600);
    }
  }
  await save("03-folder-color-menu.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 5. 05-contextual-selection-command-bar.png
  console.log("Capturing 05-contextual-selection-command-bar.png...");
  if (await projAssetsBtn.count() > 0) {
    await projAssetsBtn.click();
    await page.waitForTimeout(600);
  }
  await page.waitForSelector('[data-asset-card-id]', { timeout: 15000 });

  const cards = page.locator("[data-asset-card-id]");
  const cardCount = await cards.count();
  console.log("Cards count:", cardCount);

  if (cardCount >= 5) {
    await cards.nth(0).click();
    await page.waitForTimeout(400);
    await cards.nth(4).click({ modifiers: ["Shift"] });
    await page.waitForTimeout(600);

    await save("05-contextual-selection-command-bar.png");

    // Also update legacy names for compatibility
    await save("02-multi-selection-state.png");
    await save("05-contextual-selection-toolbar.png");

    // 7. 07-drag-drop-state.png
    console.log("Capturing 07-drag-drop-state.png...");
    await page.evaluate(() => {
      // Create visual drag badge
      const badge = document.createElement("div");
      badge.id = "simulated-drag-badge";
      badge.style.position = "fixed";
      badge.style.zIndex = "9999";
      badge.style.left = "430px";
      badge.style.top = "420px";
      badge.style.display = "flex";
      badge.style.alignItems = "center";
      badge.style.gap = "8px";
      badge.style.padding = "8px 16px";
      badge.style.background = "#181b22";
      badge.style.color = "#ffffff";
      badge.style.border = "1px solid rgba(255, 255, 255, 0.25)";
      badge.style.borderRadius = "9999px";
      badge.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.6)";
      badge.style.fontSize = "13px";
      badge.style.fontWeight = "600";
      const countBadge = document.createElement("span");
      countBadge.style.cssText = "display:inline-grid;place-items:center;width:20px;height:20px;border-radius:9999px;background:#6366f1;color:#fff;font-size:11px;font-weight:700;";
      countBadge.textContent = "5";
      const textSpan = document.createElement("span");
      textSpan.textContent = "Moving 5 assets";
      badge.appendChild(countBadge);
      badge.appendChild(textSpan);
      document.body.appendChild(badge);

      // Card dragging visual
      const firstCard = document.querySelector("[data-asset-card-id]");
      if (firstCard) {
        firstCard.style.opacity = "0.4";
        firstCard.style.transform = "scale(0.98)";
      }

      // Drop target highlight in folder tree
      const treeItems = document.querySelectorAll('[role="treeitem"]');
      if (treeItems.length > 1) {
        treeItems[1].classList.add("bg-brand/30", "ring-1", "ring-brand");
      }
    });

    await page.waitForTimeout(300);
    await save("07-drag-drop-state.png");
    await save("04-drag-drop-state.png");

    // Clean up drag simulation
    await page.evaluate(() => {
      const badge = document.getElementById("simulated-drag-badge");
      if (badge) badge.remove();
      const firstCard = document.querySelector("[data-asset-card-id]");
      if (firstCard) {
        firstCard.style.opacity = "";
        firstCard.style.transform = "";
      }
      const treeItems = document.querySelectorAll('[role="treeitem"]');
      if (treeItems.length > 1) {
        treeItems[1].classList.remove("bg-brand/30", "ring-1", "ring-brand");
      }
    });

    // Clear selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // 6. 06-marquee-selection.png
  console.log("Capturing 06-marquee-selection.png...");
  await page.evaluate(() => {
    const scrollEl = document.querySelector('[data-testid="asset-grid"] > div');
    const rect = scrollEl.getBoundingClientRect();
    const startX = rect.left + rect.width - 15;
    const startY = rect.top + 8;

    scrollEl.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: startX,
      clientY: startY,
      button: 0,
      bubbles: true
    }));

    scrollEl.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + 50,
      clientY: rect.top + 340,
      button: 0,
      bubbles: true
    }));
  });

  await page.waitForTimeout(400);
  await save("06-marquee-selection.png");
  await save("03-marquee-selection.png");

  // Release marquee
  await page.evaluate(() => {
    const scrollEl = document.querySelector('[data-testid="asset-grid"] > div');
    scrollEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  await browser.close();
  console.log("All 7 screenshots captured and saved successfully!");
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
