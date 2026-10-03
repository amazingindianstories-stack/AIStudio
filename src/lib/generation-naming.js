import { eq, inArray, sql } from "drizzle-orm";
import { generationNaming } from "./schema.js";

/**
 * Computes the canonical namespace string for a generation's location.
 * - folder:<uuid> when inside a folder (global or project-scoped)
 * - project_unsorted:<uuid> when in a project but not in a folder
 * - global_unsorted when in the library root with no project or folder
 */
export function namespaceFor({ folderId = null, projectId = null } = {}) {
  if (folderId) return `folder:${folderId}`;
  if (projectId) return `project_unsorted:${projectId}`;
  return "global_unsorted";
}

export const getNamingNamespace = namespaceFor;

/**
 * Atomically allocates `count` sequential numbers in a given namespace.
 * Uses ON CONFLICT DO UPDATE RETURNING to ensure strict serialization and avoid gaps or races.
 * Returns the starting sequence (as a Number).
 */
export async function allocateNextSequence(tx, namespace, count = 1, now = Date.now()) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const res = await tx.execute(sql`
    INSERT INTO naming_counters (namespace, next_sequence, updated_at)
    VALUES (${namespace}, ${1 + n}, ${now})
    ON CONFLICT (namespace) DO UPDATE
    SET next_sequence = naming_counters.next_sequence + ${n},
        updated_at = ${now}
    RETURNING (naming_counters.next_sequence - ${n})::bigint AS start_sequence;
  `);

  const rows = res.rows ?? res;
  const startSeq = Number(rows[0]?.start_sequence);
  if (!Number.isSafeInteger(startSeq) || startSeq <= 0) {
    throw new Error(`Failed to allocate sequence for namespace ${namespace}`);
  }
  return startSeq;
}

/**
 * Assigns a sequence number for a new generation.
 * Idempotent: if a generation already has a naming assignment (e.g. from retry or upsert),
 * the existing record is returned without allocating a new sequence.
 */
export async function assignGenerationNaming(tx, { generationId, folderId = null, projectId = null, now = Date.now() }) {
  if (!generationId) throw new Error("generationId is required for naming assignment");

  const [existing] = await tx
    .select()
    .from(generationNaming)
    .where(eq(generationNaming.generationId, generationId))
    .limit(1);

  if (existing) {
    return existing;
  }

  const namespace = namespaceFor({ folderId, projectId });
  const startSeq = await allocateNextSequence(tx, namespace, 1, now);

  const [inserted] = await tx
    .insert(generationNaming)
    .values({
      generationId,
      namespace,
      sequence: startSeq,
      assignedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    const [raced] = await tx
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.generationId, generationId))
      .limit(1);
    return raced;
  }

  return inserted;
}

/**
 * Reassigns naming records for generations being moved into a target namespace.
 * - Same-namespace moves (e.g. moving within same folder or moving to where it already is)
 *   are no-ops for naming; existing sequences are preserved.
 * - Cross-namespace moves reallocate fresh sequential numbers in the target namespace.
 * - Generations lacking naming records are backfilled in the target namespace.
 */
export async function reassignNamingForMove(tx, generationRows, targetNamespace, now = Date.now()) {
  if (!Array.isArray(generationRows) || generationRows.length === 0) {
    return { reallocatedCount: 0, preservedCount: 0, assignments: [] };
  }

  const sortedRows = [...generationRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ids = sortedRows.map((r) => r.id);

  const existingAssignments = await tx
    .select()
    .from(generationNaming)
    .where(inArray(generationNaming.generationId, ids));

  const assignmentByGenId = new Map(existingAssignments.map((a) => [a.generationId, a]));

  const rowsToReallocate = [];
  let preservedCount = 0;

  for (const row of sortedRows) {
    const assignment = assignmentByGenId.get(row.id);
    if (assignment && assignment.namespace === targetNamespace) {
      preservedCount += 1;
    } else {
      rowsToReallocate.push(row);
    }
  }

  if (rowsToReallocate.length === 0) {
    return { reallocatedCount: 0, preservedCount, assignments: [] };
  }

  const startSeq = await allocateNextSequence(tx, targetNamespace, rowsToReallocate.length, now);
  const assignments = [];

  for (let i = 0; i < rowsToReallocate.length; i++) {
    const row = rowsToReallocate[i];
    const sequence = startSeq + i;
    const assignment = {
      generationId: row.id,
      namespace: targetNamespace,
      sequence,
      assignedAt: now,
    };
    assignments.push(assignment);

    await tx
      .insert(generationNaming)
      .values(assignment)
      .onConflictDoUpdate({
        target: generationNaming.generationId,
        set: {
          namespace: targetNamespace,
          sequence,
          assignedAt: now,
        },
      });
  }

  return {
    reallocatedCount: rowsToReallocate.length,
    preservedCount,
    assignments,
  };
}

/**
 * Batch fetches naming assignments for generation IDs.
 */
export async function getGenerationNamingMap(dbOrTx, generationIds) {
  if (!Array.isArray(generationIds) || generationIds.length === 0) return new Map();
  const rows = await dbOrTx
    .select()
    .from(generationNaming)
    .where(inArray(generationNaming.generationId, generationIds));
  return new Map(rows.map((r) => [r.generationId, r]));
}
