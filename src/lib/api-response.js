import { NextResponse } from "next/server";

/** Build the canonical success envelope while preserving NextResponse features. */
export function successResponse(data = null, init) {
  return NextResponse.json({ ok: true, data }, init);
}

/** Build the canonical failure envelope with a stable, machine-readable code. */
export function errorResponse(code, message, init) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    init
  );
}
