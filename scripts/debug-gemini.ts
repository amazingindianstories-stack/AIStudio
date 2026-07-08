import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function run() {
  try {
    const { generateImageGemini } = await import("../src/lib/providers/gemini");
    console.log("Checking API Key...", process.env.GOOGLE_API_KEY ? "Present" : "Missing");
    if (!process.env.GOOGLE_API_KEY) {
      console.log("Missing key locally too.");
    }
  } catch(e: any) {
    console.error(e.message);
  }
}
run();
