import { timingSafeEqual } from "node:crypto";

/**
 * Auth for the `/api/worker/depth/*` routes — a single shared bearer token
 * (`DEPTH_WORKER_TOKEN`), not a user session. The caller is a Python process
 * on a machine with no browser and no login flow, so the session cookie
 * system (auth.js) doesn't apply here; this mirrors how media-grant.js and
 * the admin token card each have their own narrow, non-session auth for a
 * non-browser caller.
 *
 * One token for every worker is a deliberate simplification, not a
 * limitation to design around later: a worker still identifies itself by its
 * own `workerId` in every request body (see depth-jobs-db.js), so a second
 * machine can join under the same token with no auth change — the token
 * proves "this caller may act as a depth worker," not "this caller is worker
 * X."
 *
 * Unset DEPTH_WORKER_TOKEN refuses every request rather than allowing them
 * through — the fail-safe direction for a route that can claim jobs and
 * write into the media bucket.
 */
export function verifyWorkerToken(req) {
  const configured = process.env.DEPTH_WORKER_TOKEN;
  if (!configured) return false;

  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;

  const given = Buffer.from(match[1]);
  const expected = Buffer.from(configured);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
