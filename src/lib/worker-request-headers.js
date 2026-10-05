/** Deployment protection is separate from the application's worker authentication. */
export function workerRequestHeaders(secret, env = process.env) {
  return {
    "Content-Type": "application/json",
    "x-generation-worker-secret": secret,
    ...(env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? { "x-vercel-protection-bypass": env.VERCEL_AUTOMATION_BYPASS_SECRET }
      : {}),
  };
}
