import { timingSafeEqual } from "node:crypto";

/** Authenticate a Vercel Cron request without leaking secret length/content. */
export function verifyCronSecret(request, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const authorization = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const actualBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

