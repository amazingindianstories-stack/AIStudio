/**
 * Guard: constants that exist in BOTH the TypeScript-turned-JavaScript app
 * and its Python port must hold the same value.
 *
 * WHY THIS EXISTS
 * `backend/` is a strangler-fig port of `src/app/api`. Until one of the two
 * implementations is deleted, a handful of numbers have to agree across a
 * language boundary, and each has a different and unpleasant failure mode:
 *
 *   THUMB_LADDER      a mismatch silently serves full-resolution originals
 *                     for a width the other side has no step for
 *   advisory lock key two concurrent requests, one per app, can each pass the
 *                     "does a default project exist" check and create one
 *   scrypt params     a user created through one app cannot log in through
 *                     the other; scrypt has no interchange format to fall
 *                     back on
 *   spend window      the Gemini admission gate stops matching the estimator
 *                     it was calibrated against
 *   queue constants   the reaper and the concurrency cap disagree about what
 *                     "too long" and "too many" mean
 *   WORKER_STALE_MS   the depth worker's "online" derivation flickers
 *   session cookie    every session across both apps breaks at once
 *
 * Every one of these is documented on both sides with a comment saying it
 * must not drift. None of them was checked. `video_directive.py` falling
 * behind its TS twin on 2026-08-17 is what this class of bug looks like when
 * nothing is watching.
 *
 * These are deliberately textual extractions, not imports: importing the
 * Python side is impossible, and importing the JS side would drag Drizzle and
 * `sharp` into a unit test. Reading the literal out of the source is exactly
 * as strong as the property being defended.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

/** Evaluate a simple arithmetic literal like `10 * 60 * 1000` or `45_000`. */
function num(expr) {
  const cleaned = String(expr).replace(/_/g, "").trim();
  assert.match(cleaned, /^[\d*\s]+$/, `refusing to evaluate "${expr}"`);
  return cleaned.split("*").map((p) => Number(p.trim())).reduce((a, b) => a * b, 1);
}

/** Pull the first capture group out of `src`, failing loudly if the shape
 *  changed — a guard that silently stops matching is worse than no guard. */
function grab(src, re, what) {
  const m = re.exec(src);
  assert.ok(
    m,
    `could not extract ${what}. The declaration's shape changed; fix the ` +
      `pattern in this test rather than deleting the assertion.`
  );
  return m[1];
}

const PAIRS = [
  {
    what: "THUMB_LADDER",
    js: () => grab(read("src/lib/media-derivatives.js"), /THUMB_LADDER\s*=\s*\[([^\]]+)\]/, "JS THUMB_LADDER")
      .split(",").map((n) => Number(n.trim())).join(","),
    py: () => grab(read("backend/apps/media/media_derivatives.py"), /THUMB_LADDER\s*=\s*\(([^)]+)\)/, "PY THUMB_LADDER")
      .split(",").map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n)).join(","),
  },
  {
    what: "default-project advisory lock key",
    js: () => grab(read("src/lib/projects-db.js"), /pg_advisory_xact_lock\((\d+)\)/, "JS advisory lock key"),
    py: () => grab(read("backend/apps/projects/projects_service.py"), /_DEFAULT_PROJECT_LOCK_KEY\s*=\s*(\d+)/, "PY advisory lock key"),
  },
  {
    what: "scrypt key length",
    js: () => grab(read("src/lib/password.js"), /scryptSync\(password,\s*salt,\s*(\d+)\)/, "JS scrypt dklen"),
    py: () => grab(read("backend/apps/common/password.py"), /_KEY_LEN\s*=\s*(\d+)/, "PY scrypt dklen"),
  },
  {
    what: "SPEND_WINDOW_MS",
    js: () => num(grab(read("src/lib/spend-window.js"), /SPEND_WINDOW_MS\s*=\s*([^;]+);/, "JS SPEND_WINDOW_MS")),
    py: () => num(grab(read("backend/apps/generation/spend_window.py"), /^SPEND_WINDOW_MS\s*=\s*(.+)$/m, "PY SPEND_WINDOW_MS")),
  },
  {
    what: "DEFAULT_SPEND_LIMIT_CENTS",
    js: () => num(grab(read("src/lib/spend-window.js"), /DEFAULT_SPEND_LIMIT_CENTS\s*=\s*([^;]+);/, "JS spend limit")),
    py: () => num(grab(read("backend/apps/generation/spend_window.py"), /^DEFAULT_SPEND_LIMIT_CENTS\s*=\s*(.+)$/m, "PY spend limit")),
  },
  {
    what: "STALE_RUNNING_MS",
    js: () => num(grab(read("src/lib/store-db.js"), /STALE_RUNNING_MS\s*=\s*([^;]+);/, "JS STALE_RUNNING_MS")),
    py: () => num(grab(read("backend/apps/generation/queue_service.py"), /^STALE_RUNNING_MS\s*=\s*(.+)$/m, "PY STALE_RUNNING_MS")),
  },
  {
    what: "REAP_INTERVAL_MS",
    js: () => num(grab(read("src/lib/store-db.js"), /REAP_INTERVAL_MS\s*=\s*([^;]+);/, "JS REAP_INTERVAL_MS")),
    py: () => num(grab(read("backend/apps/generation/queue_service.py"), /^REAP_INTERVAL_MS\s*=\s*(.+)$/m, "PY REAP_INTERVAL_MS")),
  },
  {
    what: "MAX_CONCURRENT",
    js: () => {
      const body = grab(read("src/lib/store-db.js"), /MAX_CONCURRENT\s*=\s*\{([^}]+)\}/, "JS MAX_CONCURRENT");
      return body.replace(/["'\s]/g, "");
    },
    py: () => {
      const body = grab(read("backend/apps/generation/queue_service.py"), /MAX_CONCURRENT\s*=\s*\{([^}]+)\}/, "PY MAX_CONCURRENT");
      return body.replace(/["'\s]/g, "");
    },
  },
  {
    what: "WORKER_STALE_MS",
    js: () => num(grab(read("src/lib/depth-jobs-db.js"), /WORKER_STALE_MS\s*=\s*([^;]+);/, "JS WORKER_STALE_MS")),
    py: () => num(grab(read("backend/apps/generation/depth_jobs_service.py"), /^WORKER_STALE_MS\s*=\s*(.+)$/m, "PY WORKER_STALE_MS")),
  },
  ...[
    "STUCK_IMAGE_MS",
    "STUCK_VIDEO_MS",
    "STUCK_DEPTH_GRACE_MS",
    "DEPTH_WORKER_STALE_MS",
  ].map((name) => ({
    what: name,
    js: () => num(grab(read("src/lib/generation-health.js"), new RegExp(`export const ${name}\\s*=\\s*([^;]+);`), `JS ${name}`)),
    py: () => num(grab(read("backend/apps/admin_dashboard/status_checks.py"), new RegExp(`^${name}\\s*=\\s*(.+)$`, "m"), `PY ${name}`)),
  })),
  {
    what: "session cookie name",
    js: () => grab(read("src/lib/auth.js"), /SESSION_COOKIE\s*=\s*"([^"]+)"/, "JS session cookie"),
    py: () => grab(read("backend/config/settings.py"), /VEEVEE_SESSION_COOKIE\s*=\s*env\([^,]+,\s*default="([^"]+)"\)/, "PY session cookie default"),
  },
  {
    what: "session cookie name (edge middleware copy)",
    js: () => grab(read("src/lib/auth.js"), /SESSION_COOKIE\s*=\s*"([^"]+)"/, "JS session cookie"),
    py: () => grab(read("src/middleware.js"), /SESSION_COOKIE\s*=\s*"([^"]+)"/, "middleware session cookie"),
  },
];

// The whole point is cross-language. If `backend/` is ever deleted (a real
// option — see the migration decision gate), this file should go with it
// rather than quietly passing against files that no longer exist.
const BACKEND_PRESENT = existsSync("backend/apps/generation/queue_service.py");

test("backend/ still exists, or this guard should be deleted", () => {
  assert.ok(
    BACKEND_PRESENT,
    "backend/ is gone. If the Django port was deleted deliberately, delete " +
      "this test too — it exists only to keep two implementations in step."
  );
});

test("expected generation index names match between JS and Python", { skip: !BACKEND_PRESENT }, () => {
  const names = (source) => [...source.matchAll(/"(generations_[a-z_]+_idx)"/g)].map((match) => match[1]);
  const js = names(read("src/lib/generation-indexes.js")).slice(0, 10);
  const py = names(read("backend/apps/admin_dashboard/status_checks.py"));
  assert.deepEqual(py, js);
});

for (const { what, js, py } of PAIRS) {
  test(`${what} matches between the JS app and the Python port`, { skip: !BACKEND_PRESENT }, () => {
    const a = js();
    const b = py();
    assert.equal(
      String(a),
      String(b),
      `${what} has drifted: JS side is ${a}, Python side is ${b}. ` +
        `Both sides document this constant as one that must not drift. ` +
        `Change them together, in the same commit.`
    );
  });
}
