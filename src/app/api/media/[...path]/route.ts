import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const getBucket = () => process.env.AWS_S3_BUCKET_NAME || "aistudio-media-bucket";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const resolvedParams = await params;
    const key = resolvedParams.path.join("/");
    
    const command = new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    });

    try {
      const response = await s3.send(command);
      
      const contentType = response.ContentType || "application/octet-stream";
      
      // AWS SDK v3 stream to Web ReadableStream
      // We can use response.Body?.transformToWebStream()
      const stream = response.Body?.transformToWebStream();

      if (!stream) {
        return new NextResponse("Empty Body", { status: 500 });
      }

      return new NextResponse(stream, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch (s3Error: any) {
      if (s3Error.name === 'NoSuchKey') {
        return new NextResponse("Not Found", { status: 404 });
      }
      throw s3Error;
    }
  } catch (error) {
    console.error("Error serving media:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
