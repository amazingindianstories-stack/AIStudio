import * as dotenv from "dotenv";
import { promises as fs } from "node:fs";
dotenv.config({ path: ".env.local" });

async function run() {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  });
  const token = await fs.readFile(".higgsfield-mcp-token.json", "utf8");
  const cmd = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: "settings/higgsfield-mcp-token.json",
    Body: token,
    ContentType: "application/json",
  });
  await s3.send(cmd);
  console.log("Token uploaded to S3!");
}
run();
