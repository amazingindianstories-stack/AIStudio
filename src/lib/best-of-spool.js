import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "@/lib/queue-execution-deadline";

export const BEST_OF_MAX_BY_SIZE = { "1K": 4, "2K": 3, "4K": 2 };

export function boundedBestOf(configured, imageSize) {
  const requested = Math.min(4, Math.max(1, Number(configured) || 2));
  return Math.min(requested, BEST_OF_MAX_BY_SIZE[imageSize] ?? 2);
}

/** Generate serially and immediately release each base64 response to disk. */
export async function generateAndSpoolCandidates({ count, directory, generate, signal }) {
  const candidates = [];
  const errors = [];
  for (let i = 0; i < count; i++) {
    throwIfAborted(signal);
    try {
      const result = await generate(i);
      const file = path.join(directory, `candidate-${i}.bin`);
      await writeFile(file, result.base64, "base64");
      candidates.push({ file, mimeType: result.mimeType });
    } catch (error) {
      throwIfAborted(signal);
      errors.push(error);
    }
  }
  return { candidates, errors };
}

export async function readSpooledBase64(candidate) {
  return (await readFile(candidate.file)).toString("base64");
}
