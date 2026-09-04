import { NextResponse } from "next/server";
import {
  acceptedCspContentType,
  MAX_CSP_REPORT_BYTES,
  parseCspReports,
} from "@/lib/csp-report";

export const runtime = "nodejs";

export async function POST(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!acceptedCspContentType(contentType)) {
    return NextResponse.json({ error: "Unsupported content type." }, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CSP_REPORT_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  try {
    const reports = parseCspReports(await request.text(), contentType);
    for (const report of reports) console.warn(JSON.stringify(report));
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = [400, 413, 415].includes(error?.status) ? error.status : 400;
    return NextResponse.json({ error: "Invalid CSP report." }, { status });
  }
}
