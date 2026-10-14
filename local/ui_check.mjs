// Headless UI check of the local stack: login, Portrait Gallery, admin Limits; screenshots + page errors.
//   node local/ui_check.mjs <out-dir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] || "/tmp/veevee-ui";
fs.mkdirSync(out, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const base = "http://localhost:3000";
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
const shot = async (name) => { await page.screenshot({ path: path.join(out, name + ".png") }); console.log("screenshot", name); };
try {
  await page.goto(base + "/login");
  await page.fill("input[type=email], input[name=email]", env.LOCAL_ADMIN_EMAIL);
  await page.fill("input[type=password]", env.LOCAL_ADMIN_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 });
  await page.waitForTimeout(4000);
  await shot("01-home");
  const menuButtons = page.locator("button", { hasText: /material/i });
  if (await menuButtons.count()) { await menuButtons.first().click(); await page.waitForTimeout(800); }
  const galleryItem = page.getByText("Portrait Gallery", { exact: false }).first();
  if (await galleryItem.count()) {
    await galleryItem.click();
    await page.waitForTimeout(2500);
    await shot("02-portrait-gallery");
    const managed = await page.locator("[aria-label='Portraits']").count();
    const cards = await page.locator("[data-managed-portrait]").count();
    const uploads = await page.locator("[aria-label='Portraits'] input[type=file]").count();
    console.log(JSON.stringify({ managedGallery: managed === 1, cards, uploadInputs: uploads }));
    await page.keyboard.press("Escape");
  } else {
    console.log("Portrait Gallery entry not found");
    await shot("02-menu-missing");
  }
  await page.goto(base + "/admin");
  await page.waitForTimeout(3000);
  const limits = page.getByRole("button", { name: /Limits/ }).first();
  if (await limits.count()) await limits.click();
  await page.waitForTimeout(2000);
  await shot("03-admin-limits");
  console.log(JSON.stringify({ portraitStorageCard: await page.locator("[data-portrait-storage-card]").count() === 1 }));
} finally {
  console.log(JSON.stringify({ errors }));
  await browser.close();
}
