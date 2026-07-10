/**
 * Seed the local .higgsfield-mcp-token.json into production S3 via the
 * admin set-token endpoint. Auth: SET_TOKEN_SECRET from .env.local (must
 * match the Vercel env var of the same name); logged-in admins can also
 * paste the token into Admin → Overview → "Higgsfield MCP token" instead.
 * Run: npx tsx scripts/upload-token-vercel.ts
 */
import * as dotenv from "dotenv";
import { promises as fs } from "node:fs";
dotenv.config({ path: ".env.local" });

const URL = process.env.APP_URL || "https://aistudio-v1.vercel.app";

async function run() {
  const secret = process.env.SET_TOKEN_SECRET;
  if (!secret) {
    console.error("SET_TOKEN_SECRET missing from .env.local");
    process.exit(1);
  }
  const tokenStr = await fs.readFile(".higgsfield-mcp-token.json", "utf8");
  const res = await fetch(`${URL}/api/admin/set-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-setup-secret": secret },
    body: tokenStr,
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log("Token seeded into production S3.");
  } else {
    console.error(`Failed: HTTP ${res.status}`, j.error || "");
    process.exit(1);
  }
}
run();
