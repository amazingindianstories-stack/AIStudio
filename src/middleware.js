import { NextResponse } from "next/server";

/** Vercel cannot see Django's host-only session cookie. */
export function middleware() {
  return NextResponse.next();
}

export const config = {
  // Run on everything except static files (which contain a dot, e.g. .png).
  matcher: ["/((?!_next/static|_next/image|.*\\.).*)"],
};
