import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AUTH_HANDLERS = [
  "src/app/api/auth/login/route.js",
  "src/app/api/auth/logout/route.js",
  "src/app/api/auth/me/route.js",
  "src/app/api/auth/password/route.js",
];

const AUTH_CLIENTS = [
  "src/app/login/page.jsx",
  "src/components/AccountSettings.jsx",
  "src/components/AdminDashboard.jsx",
  "src/lib/store.js",
];

test("authentication handlers use canonical response helpers", () => {
  for (const file of AUTH_HANDLERS) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /successResponse\(/, `${file} must use successResponse`);
    assert.doesNotMatch(
      source,
      /NextResponse\.json\(/,
      `${file} must not construct a legacy response envelope`
    );
  }

  for (const file of AUTH_HANDLERS.filter((file) => !file.includes("/logout/"))) {
    assert.match(
      readFileSync(file, "utf8"),
      /errorResponse\(/,
      `${file} must use errorResponse`
    );
  }
});

test("authentication clients use the compatibility parser", () => {
  for (const file of AUTH_CLIENTS) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /parseApiResponse/, `${file} must import the compatibility parser`);

    const authCalls = source.match(/apiFetch\([\s\S]{0,160}?\/api\/auth\/[\s\S]{0,320}?\)/g) ?? [];
    assert.ok(authCalls.length > 0, `${file} must contain an authentication API call`);
  }
});

test("authentication handlers expose the phase-one error codes", () => {
  const source = AUTH_HANDLERS.map((file) => readFileSync(file, "utf8")).join("\n");
  for (const code of [
    "VALIDATION_ERROR",
    "RATE_LIMITED",
    "INVALID_CREDENTIALS",
    "UNAUTHENTICATED",
    "INVALID_CURRENT_PASSWORD",
    "SESSION_CONFLICT",
    "INTERNAL_ERROR",
  ]) {
    assert.match(source, new RegExp(`errorResponse\\(\\s*[\"']${code}[\"']`), `missing ${code}`);
  }
});
