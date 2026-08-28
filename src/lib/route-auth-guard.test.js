/**
 * Guard: every API route handler must perform its own authentication.
 *
 * WHY THIS EXISTS
 * `src/middleware.js` runs on the edge, where it can reach neither Node's
 * crypto nor the database. All it can do is check that a session cookie is
 * *present* — it cannot verify the signature. Its own header says so. Real
 * enforcement is `getSession()` / `requireUser()` / `requireAdmin()` /
 * `adminOrNull()` inside each route handler.
 *
 * That split is fine as long as every handler actually does it, and nothing
 * enforced that. `GET /api/media/[...path]` shipped with no handler-level
 * check at all: middleware waved through any request carrying a garbage
 * cookie value, and the route read any object in the bucket. It was a
 * CRITICAL finding on 2026-07-15 and it was invisible from the outside,
 * because from the outside the route looked protected.
 *
 * This test makes that class of mistake fail the suite instead of shipping.
 * It is deliberately a crude textual check rather than anything clever: the
 * property being defended is "somebody remembered to think about auth in this
 * file", and a grep expresses that honestly. A route that genuinely must be
 * reachable without a session goes in EXEMPT below, with a reason — which
 * turns "I forgot" into "I decided", and puts the decision in review.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = "src/app/api";

/** Any one of these, appearing anywhere in the file, counts as "this route
 *  authenticates itself". They are the four session helpers plus the two
 *  bearer-token verifiers used by the deliberately session-free callers. */
const AUTH_MARKERS = [
  "getSession",
  "requireUser",
  "requireAdmin",
  "adminOrNull",
  "verifySessionToken",
  "verifyWorkerToken",
  "verifyMediaGrant",
  "verifyCronSecret",
];

/**
 * Routes that legitimately have no session check, each with the reason.
 * Adding to this list is a deliberate act; a reviewer should ask why.
 */
const EXEMPT = new Map([
  [
    "auth/login",
    "The credential exchange itself — it MINTS the session, so requiring one " +
      "would be circular. Its own protections are checkLoginThrottle() before " +
      "any hashing, verifyPassword(), and the is_active check.",
  ],
  [
    "generate/video",
    "Enqueue-only. Reads getSession() but deliberately never 401s on its " +
      "absence — matched exactly by the Django port's permission_classes([]). " +
      "Documented in CLAUDE.md; changing it is a product decision, not a fix.",
  ],
  [
    "generate/video/status",
    "Polled by the client for a row it already knows the id of; has no auth " +
      "check by design, same as its Django twin.",
  ],
]);

/** Walk `src/app/api` and yield every route file with its route path. */
function routeFiles(dir = API_DIR, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...routeFiles(full, prefix ? `${prefix}/${entry}` : entry));
    } else if (entry === "route.js") {
      out.push({ route: prefix, file: full });
    }
  }
  return out;
}

test("every API route authenticates itself, or is explicitly exempt", () => {
  const routes = routeFiles();

  // Sanity: if the walk finds nothing the assertions below are vacuous and
  // this test would "pass" while checking nothing at all.
  assert.ok(
    routes.length > 30,
    `expected to find the API surface, found ${routes.length} route files`
  );

  const unguarded = [];
  for (const { route, file } of routes) {
    if (EXEMPT.has(route)) continue;
    const src = readFileSync(file, "utf8");
    if (!AUTH_MARKERS.some((marker) => src.includes(marker))) {
      unguarded.push(route);
    }
  }

  assert.deepEqual(
    unguarded,
    [],
    `these API routes perform no authentication of their own:\n` +
      unguarded.map((r) => `  /api/${r}`).join("\n") +
      `\n\nsrc/middleware.js only checks that a cookie is PRESENT — it cannot ` +
      `verify the signature (edge runtime, no crypto, no DB). A route without ` +
      `one of [${AUTH_MARKERS.join(", ")}] is readable by anyone sending any ` +
      `cookie value at all. Add a real check, or add the route to EXEMPT in ` +
      `this file with the reason it must be reachable without a session.`
  );
});

test("the exempt list does not name routes that no longer exist", () => {
  const routes = new Set(routeFiles().map((r) => r.route));
  const stale = [...EXEMPT.keys()].filter((r) => !routes.has(r));
  assert.deepEqual(
    stale,
    [],
    `EXEMPT names routes that are gone: ${stale.join(", ")}. An exemption ` +
      `that outlives its route silently pre-approves the next file created ` +
      `at that path.`
  );
});
