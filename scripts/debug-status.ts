import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function run() {
  const { mcpJobStatus } = await import("../src/lib/providers/higgsfield-mcp");
  const taskId = "dfb686a6-6b20-49ed-bb76-61fd9edb552c";
  console.log("Fetching status for taskId:", taskId);
  try {
    const res = await mcpJobStatus(taskId);
    console.log("Result:", JSON.stringify(res, null, 2));
    if (res.status === "succeeded" && res.url) {
      console.log("Trying to download:", res.url);
      const { uploadFromUrl } = await import("../src/lib/storage");
      const localUrl = await uploadFromUrl(res.url, `generations/test-download.mp4`, "mp4");
      console.log("Downloaded to:", localUrl);
    }
  } catch (e: any) {
    console.error("Error:", e.message);
  }
  process.exit(0);
}
run();
