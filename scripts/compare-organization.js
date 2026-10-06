import { readFile } from "node:fs/promises";
import { compareOrganizationSnapshots } from "./snapshot-organization.js";

try {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) throw new Error("Usage: npm run db:compare:organization -- before.json after.json");
  const [before, after] = await Promise.all([beforePath, afterPath].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const verdict = compareOrganizationSnapshots(before, after);
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.isPreserved) process.exitCode = 1;
} catch {
  console.error("Snapshot comparison failed: supply two valid snapshot JSON files.");
  process.exitCode = 1;
}
