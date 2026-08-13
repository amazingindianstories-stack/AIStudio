import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function run() {
  const { getDb, schema } = await import("../src/lib/db");
  const db = await getDb();
  const folders = await db.select().from(schema.folders);
  console.log(`Folders: ${folders.length}`);
  console.log("Folders:", folders);
  process.exit(0);
}
run().catch(console.error);
