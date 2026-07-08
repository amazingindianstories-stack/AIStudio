import { promises as fs } from "node:fs";

async function run() {
  const tokenStr = await fs.readFile(".higgsfield-mcp-token.json", "utf8");
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch("https://aistudio-v1.vercel.app/api/admin/set-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: tokenStr,
      });
      if (res.ok) {
        console.log("SUCCESS! Token seeded into S3 via Vercel.");
        process.exit(0);
      }
      console.log(`Attempt ${i + 1} failed: ${res.status}`);
    } catch (e: any) {
      console.log(`Attempt ${i + 1} error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("Failed to seed token.");
}
run();
