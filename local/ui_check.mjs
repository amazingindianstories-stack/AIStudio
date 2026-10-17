// Headless UI check of the local stack: login, Portrait Gallery (upload, select, menu, phone), admin Limits;
// screenshots + page errors.
//   node local/ui_check.mjs <out-dir> [image files to upload into the gallery...]
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] || "/tmp/veevee-ui";
const uploads = process.argv.slice(3);
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
const openGallery = async () => {
  await page.getByRole("button", { name: "material" }).first().click();
  await page.getByRole("menuitem", { name: /Portrait Gallery/ }).click();
  await page.getByRole("dialog", { name: "Portrait Gallery" }).waitFor();
  await page.waitForTimeout(1500);
};
try {
  await page.goto(base + "/login");
  await page.fill("input[type=email], input[name=email]", env.LOCAL_ADMIN_EMAIL);
  await page.fill("input[type=password]", env.LOCAL_ADMIN_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 });
  await page.waitForTimeout(4000);
  await shot("01-home");
  await openGallery();
  const gallery = page.getByRole("dialog", { name: "Portrait Gallery" });
  await shot("02-gallery");
  if (uploads.length) {
    await gallery.locator("input[type=file]").setInputFiles(uploads);
    await page.waitForTimeout(1200);
    await shot("03-uploading");
    await page.waitForFunction(() => !document.querySelector("[data-portrait-upload]") &&
      ![...document.querySelectorAll("[data-portrait-chip]")].some((n) => /Preparing|Waiting/.test(n.textContent)), null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(800);
    await shot("04-uploaded");
  }
  const cards = gallery.locator("[data-portrait-id]");
  const count = await cards.count();
  if (count) {
    await cards.first().hover();
    await page.waitForTimeout(300);
    await shot("05-hover");
    const scroller = gallery.getByTestId("portrait-grid-scroller");
    const box = await scroller.boundingBox();
    const last = await cards.nth(Math.min(count, 4) - 1).boundingBox();
    await page.mouse.move(box.x + 6, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 12 });
    await shot("06-marquee");
    await page.mouse.up();
    await page.waitForTimeout(300);
    await shot("07-selected");
    await cards.first().click({ button: "right" });
    await page.waitForTimeout(300);
    await shot("08-menu");
    await page.keyboard.press("Escape");
  }
  console.log(JSON.stringify({ portraitCards: count }));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await openGallery();
  await shot("09-gallery-phone");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "/admin");
  await page.waitForTimeout(3000);
  const limits = page.getByRole("button", { name: /Limits/ }).first();
  if (await limits.count()) await limits.click();
  await page.waitForTimeout(2000);
  await shot("10-admin-limits");
  console.log(JSON.stringify({ portraitStorageCard: await page.locator("[data-portrait-storage-card]").count() === 1 }));
} finally {
  console.log(JSON.stringify({ errors }));
  await browser.close();
}
