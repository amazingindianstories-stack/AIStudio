import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export async function POST(req: NextRequest) {
  try {
    const s3 = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
    const body = await req.text();
    const cmd = new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME || "aistudio-media-bucket",
      Key: "settings/higgsfield-mcp-token.json",
      Body: body,
      ContentType: "application/json",
    });
    await s3.send(cmd);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
