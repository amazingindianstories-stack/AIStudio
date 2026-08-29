/**
 * Free by default: task-list read plus n=99 validation requests only.
 * --generate deliberately performs one billed image and is never used by automation.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { expectedKlingMatrixPass, runKlingValidation } from "../src/lib/kling-validation";
import { generateImageKling } from "../src/lib/providers/kling";

const result = await runKlingValidation();
if (!result.configured) throw new Error("KLING_API is not set");
if (!result.authenticated) throw new Error("Kling authentication failed");
if (!result.noTaskCreated) throw new Error("No-task invariant failed");
if (!expectedKlingMatrixPass(result.matrix)) throw new Error("Kling resolution matrix differs from the registry");

console.log("model routing: ok");
console.log("1K/2K text/reference matrix: ok");
console.log("no task created: yes");

if (process.argv.includes("--generate")) {
  console.warn("Starting one explicitly requested billed generation.");
  const generated = await generateImageKling({
    model: "Kling Image 2.1",
    prompt: "a single red bicycle leaning against a white wall, soft daylight",
    aspectRatio: "1:1",
    resolution: "1K",
  });
  console.log(`billed generation completed; units=${generated.unitDeduction ?? "unreported"}`);
}
