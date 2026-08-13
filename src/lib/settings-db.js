import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings, users } from "./schema";
import { MAX_PROMPT_LENGTH_KEY, parseMaxPromptLength } from "./settings";

/** DB-backed settings access (kept separate so settings.ts stays client-safe,
 *  mirroring pricing.ts / pricing-db.ts). */

export async function readMaxPromptLength() {
  const db = await getDb();
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MAX_PROMPT_LENGTH_KEY))
    .limit(1);
  return parseMaxPromptLength(rows[0]?.value);
}

export async function updateMaxPromptLength(value) {
  const db = await getDb();
  await db
    .insert(settings)
    .values({ key: MAX_PROMPT_LENGTH_KEY, value: String(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(value), updatedAt: Date.now() },
    });
}

/** The limit that actually applies to a request: the signed-in user's
 *  personal override (users.maxPromptLength) if an admin set one, else the
 *  global default. `userId` is optional because generate/video allows
 *  anonymous requests (see that route) — an anonymous request has no user
 *  row to look an override up on, so it always gets the global default. */
export async function readEffectiveMaxPromptLength(
  userId
) {
  if (userId) {
    const db = await getDb();
    const [row] = await db
      .select({ maxPromptLength: users.maxPromptLength })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (row?.maxPromptLength != null) return row.maxPromptLength;
  }
  return readMaxPromptLength();
}
