/** Free Kling seed-schema probe. Every POST uses invalid n=99, so no task can be created. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { runKlingValidation } from "../src/lib/kling-validation";

const result = await runKlingValidation();
if (!result.configured) throw new Error("KLING_API is not set");
if (!result.authenticated) throw new Error("Kling authentication failed");
if (!result.noTaskCreated) throw new Error("No-task invariant failed");
console.log(`seed verdict: ${result.seedVerdict}`);
console.log("no task created: yes");
if (result.seedVerdict === "inconclusive") {
  console.log("Support remains disabled; the validation-only probe did not produce a conclusive signal.");
}
