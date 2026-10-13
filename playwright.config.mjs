import { defineConfig } from "@playwright/test";

if (process.env.MIGRATION_TEST_ISOLATED !== "1" || !process.env.E2E_BASE_URL ||
    !["127.0.0.1", "localhost"].includes(new URL(process.env.E2E_BASE_URL).hostname)) {
  throw new Error("Run browser tests with the isolated Django browser-harness.py.");
}

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: process.env.E2E_BASE_URL,
    viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
