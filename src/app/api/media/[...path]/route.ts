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

    // Forward Range requests to S3 (it supports them natively). Browsers
    // REQUIRE ranges to stream/seek MP4s whose moov atom sits at the end of
    // the file (Higgsfield's videos do) — without 206 responses the <video>
    // element can't read the duration and playback dies after ~2s.
    const range = request.headers.get("range") ?? undefined;

    const command = new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Range: range,
    });

    try {
      const response = await s3.send(command);

      const contentType = response.ContentType || "application/octet-stream";
      const stream = response.Body?.transformToWebStream();

      if (!stream) {
        return new NextResponse("Empty Body", { status: 500 });
      }

      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "bytes",
        // Defense in depth alongside the upload-time MIME allowlist in
        // storage.ts: never let a browser sniff a stored object's bytes into
        // executing as a different content type than what was recorded.
        "X-Content-Type-Options": "nosniff",
      };
      if (response.ContentLength != null) {
        headers["Content-Length"] = String(response.ContentLength);
      }
      if (range && response.ContentRange) {
        headers["Content-Range"] = response.ContentRange;
        return new NextResponse(stream, { status: 206, headers });
      }
      return new NextResponse(stream, { headers });
    } catch (s3Error: any) {
      if (s3Error.name === "NoSuchKey") {
        return new NextResponse("Not Found", { status: 404 });
      }
      // An unsatisfiable Range (e.g. stale player state) — not a server fault.
      if (s3Error.name === "InvalidRange") {
        return new NextResponse("Range Not Satisfiable", { status: 416 });
      }
      throw s3Error;
    }
  } catch (error) {
    console.error("Error serving media:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
