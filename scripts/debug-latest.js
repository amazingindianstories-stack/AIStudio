import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function run() {
  const { getDb, schema } = await import("../src/lib/db");
  const db = await getDb();
  const { desc } = await import("drizzle-orm");
  const gens = await db.select().from(schema.generations).orderBy(desc(schema.generations.createdAt)).limit(10);
  console.log(JSON.stringify(gens, null, 2));
  process.exit(0);
}
run();
