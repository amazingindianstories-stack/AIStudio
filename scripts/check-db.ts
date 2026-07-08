import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function run() {
  const { db, schema } = await import("../src/lib/db");
  const folders = await db.select().from(schema.folders);
  console.log(`Folders: ${folders.length}`);
  console.log("Folders:", folders);
  process.exit(0);
}
run().catch(console.error);
