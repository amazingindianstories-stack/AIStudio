import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  ...(process.env.E2E_START_SERVER === "1" ? { webServer: {
    command: "npm run dev -- --port 3100", url: "http://127.0.0.1:3100/login", reuseExistingServer: false,
    env: { DATABASE_BACKEND: "postgres", DATABASE_URL: process.env.E2E_DATABASE_URL,
      MOCK_GENERATION: "1", MOCK_ASSET_PROVIDER: "1" },
  } } : {}),
});
