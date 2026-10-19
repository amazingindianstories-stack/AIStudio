// Headless check of the admin Errors tab on the local stack, in Chrome: desktop and phone, collapsed and expanded,
// filters, copy; screenshots + page errors.
//   node local/errors_check.mjs <out-dir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] || "/tmp/veevee-errors";
fs.mkdirSync(out, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(new URL("./.env", import.meta.url), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const base = "http://localhost:3000";
const errors = [];
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
const shot = async (name, options = {}) => { await page.screenshot({ path: path.join(out, name + ".png"), ...options }); console.log("screenshot", name); };
try {
  await page.goto(base + "/login");
  await page.fill("input[type=email], input[name=email]", env.LOCAL_ADMIN_EMAIL);
  await page.fill("input[type=password]", env.LOCAL_ADMIN_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60000 });
  // The artist's view: a failed card states the exact provider detail.
  await page.waitForTimeout(5000);
  await shot("00-home-failed-cards");
  await page.goto(base + "/admin");
  await page.getByRole("button", { name: "Errors" }).click();
  await page.getByText(/Showing \d+ of \d+ errors/).waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await shot("01-desktop-errors");
  // Only rows this check created (the local database is a copy of real data): filter to the fixture project's code.
  await page.getByLabel("Error code").fill("fixture");
  await page.waitForTimeout(1200);
  await shot("02-desktop-filtered");
  const first = page.locator("tbody > tr").first();
  await first.getByRole("button", { name: "Show error details" }).click();
  await page.waitForTimeout(400);
  await shot("03-desktop-expanded");
  await first.getByRole("button", { name: "Copy support details" }).click();
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  fs.writeFileSync(path.join(out, "copied.txt"), copied);
  console.log("copied:\n" + copied);
  await shot("04-desktop-copied");
  await page.getByLabel("Provider").selectOption("seedance");
  await page.waitForTimeout(1000);
  await shot("05-desktop-provider-filter");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot("06-phone-errors", { fullPage: true });
  await page.locator(".scroll-thin.overflow-x-auto").first().evaluate((node) => { node.scrollLeft = node.scrollWidth; });
  await page.waitForTimeout(300);
  await shot("07-phone-scrolled", { fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log("page horizontal overflow at 390px:", overflow);
} catch (error) {
  errors.push("check: " + error.message);
  await shot("99-failure").catch(() => {});
} finally {
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
  await browser.close();
}
