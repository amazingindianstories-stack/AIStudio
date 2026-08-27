/** Submit every requested candidate and retain every provider-accepted task. */
export async function submitVideoCandidates({ count, totalCostCents, seed, submit }) {
  if (!Number.isInteger(count) || count < 2) {
    throw new Error("Video best-of candidate count must be an integer of at least 2.");
  }
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, index) =>
      submit(seed != null ? seed + index : undefined, index)
    )
  );
  const acceptedTaskIds = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const rejected = settled.filter((result) => result.status === "rejected");
  if (!acceptedTaskIds.length) {
    const first = rejected[0]?.reason;
    throw new Error(
      `Video candidate submission failed (0/${count} accepted): ` +
        `${first?.message || String(first || "provider rejected every candidate")}`
    );
  }
  return {
    acceptedTaskIds,
    rejectedCount: rejected.length,
    // totalCostCents is the full requested-N estimate. It originates as one
    // integer per-candidate estimate multiplied by count, so this division is
    // exact; round defensively in case historical callers differ.
    costCents: Math.round((Number(totalCostCents) / count) * acceptedTaskIds.length),
  };
}
