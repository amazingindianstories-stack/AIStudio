import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings } from "./schema";
import { MAX_PROMPT_LENGTH_KEY, parseMaxPromptLength } from "./settings";

/** DB-backed settings access (kept separate so settings.ts stays client-safe,
 *  mirroring pricing.ts / pricing-db.ts). */

export async function readMaxPromptLength(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MAX_PROMPT_LENGTH_KEY))
    .limit(1);
  return parseMaxPromptLength(rows[0]?.value);
}

export async function updateMaxPromptLength(value: number): Promise<void> {
  const db = await getDb();
  await db
    .insert(settings)
    .values({ key: MAX_PROMPT_LENGTH_KEY, value: String(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(value), updatedAt: Date.now() },
    });
}
