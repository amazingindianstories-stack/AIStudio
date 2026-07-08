/**
 * One-time, idempotent seed: ensures the storage bucket, the admin user, and the
 * pricing rows exist. Run with:  npm run db:seed
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { eq } from "drizzle-orm";

const ADMIN_EMAIL = "amazingindianstories@gmail.com";
const ADMIN_PASSWORD = "1234";

async function main() {
  // Dynamically import to ensure process.env.DATABASE_URL is populated
  // before db.ts is evaluated.
  const { db } = await import("../src/lib/db");
  const { users, pricing } = await import("../src/lib/schema");
  const { hashPassword } = await import("../src/lib/password");
  const { ensureBucket } = await import("../src/lib/storage");
  const { DEFAULT_PRICING } = await import("../src/lib/pricing");

  console.log("Ensuring storage bucket…");
  await ensureBucket();

  console.log("Ensuring admin user…");
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  if (existing.length === 0) {
    const { hash, salt } = hashPassword(ADMIN_PASSWORD);
    await db.insert(users).values({
      email: ADMIN_EMAIL,
      passwordHash: hash,
      passwordSalt: salt,
      name: "Admin",
      role: "admin",
      color: "#34d399",
      isActive: true,
      createdAt: Date.now(),
    });
    console.log(`  created admin ${ADMIN_EMAIL}`);
  } else {
    console.log("  admin already exists");
  }

  console.log("Seeding pricing…");
  for (const p of DEFAULT_PRICING) {
    await db
      .insert(pricing)
      .values({
        model: p.model,
        unitCostCents: p.unitCostCents,
        unit: p.unit,
        notes: p.notes,
      })
      .onConflictDoNothing();
  }

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
