import { config } from "dotenv";
config({ path: ".env.local" });
async function main() {
  const { db } = await import("/Users/ais4/Desktop/Rohit Chavda/Dev/image-video-project/src/lib/db");
  const { generations } = await import("/Users/ais4/Desktop/Rohit Chavda/Dev/image-video-project/src/lib/schema");
  const { desc, eq } = await import("drizzle-orm");
  const rows = await db.select().from(generations).where(eq(generations.kind, "image")).orderBy(desc(generations.createdAt)).limit(6);
  for (const r of rows) {
    const secs = ((r.updatedAt - r.createdAt) / 1000).toFixed(0);
    console.log(`${new Date(r.createdAt).toISOString().slice(5, 16)} ${r.model} ${r.aspectRatio}/${r.resolution} status=${r.status} cost=${r.costCents}¢ took=${secs}s prompt="${(r.prompt || "").slice(0, 60)}..."`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
