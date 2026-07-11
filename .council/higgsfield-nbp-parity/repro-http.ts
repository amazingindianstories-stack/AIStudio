/** Drive the real HTTP route on the local dev server (port 3005) exactly like
 *  the browser does: enqueue via /api/generate/image, run via
 *  /api/queue/execute, print RAW response details. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { promises as fs } from "node:fs";
import { createHmac } from "node:crypto";

const BASE = "http://localhost:3005";

function cookie(uid: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid, exp: Date.now() + 3600_000 })
  ).toString("base64url");
  const sig = createHmac("sha256", process.env.AUTH_SECRET || "dev-insecure-secret-change-me")
    .update(payload)
    .digest("base64url");
  return `lumina_session=${payload}.${sig}`;
}

async function main() {
  const { db } = await import("../../src/lib/db");
  const { users } = await import("../../src/lib/schema");
  const [admin] = await db.select().from(users).limit(1);
  if (!admin) throw new Error("no user row");
  const jar = cookie(admin.id);
  console.log("using user:", admin.email);

  const buf = await fs.readFile(".council/higgsfield-nbp-parity/ref-1.jpg");
  const upload = `data:image/jpeg;base64,${buf.toString("base64")}`;

  const enq = await fetch(`${BASE}/api/generate/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({
      prompt:
        "THIS EXACT FACE and identity from the reference image: @img1 Cinematic portrait of this woman seated in a director's chair backstage at a late-night talk show.",
      aspectRatio: "21:9",
      resolution: "2K",
      model: "Nano Banana Pro",
      referenceImages: [upload],
    }),
  });
  const enqText = await enq.text();
  console.log("enqueue:", enq.status, enqText.slice(0, 200));
  const item = JSON.parse(enqText);

  const t = Date.now();
  const ex = await fetch(`${BASE}/api/queue/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar },
    body: JSON.stringify({ id: item.id }),
  });
  const exText = await ex.text();
  console.log(
    `execute: HTTP ${ex.status} after ${((Date.now() - t) / 1000).toFixed(1)}s, ` +
      `bytes=${exText.length}, content-type=${ex.headers.get("content-type")}`
  );
  console.log("body head:", exText.slice(0, 300) || "(EMPTY BODY)");
  process.exit(0);
}
main().catch((e) => {
  console.error("DRIVER FAILED:", e?.cause?.code || "", e?.message || e);
  process.exit(1);
});
