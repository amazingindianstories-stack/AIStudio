import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== "get-my-db-url-123") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  return new NextResponse(`DATABASE_URL="${process.env.DATABASE_URL}"`, {
    headers: { "Content-Type": "text/plain" },
  });
}
