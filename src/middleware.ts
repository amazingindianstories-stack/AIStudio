import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight gate (runs on the edge — can't touch the DB/Node crypto).
 * It does a cheap session-cookie presence check for UX:
 *  - no cookie + protected page → redirect to /login
 *  - no cookie + protected API → 401
 *  - has cookie + /login → redirect to /
 * Real enforcement (signature + DB + role) happens server-side in the route
 * handlers/pages via getSession()/requireUser()/requireAdmin().
 */
const SESSION_COOKIE = "lumina_session";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow auth endpoints and Next internals/static assets.
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/api/admin/set-token" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value;
  const isLogin = pathname === "/login";

  if (!hasSession && !isLogin) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  if (hasSession && isLogin) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except static files (which contain a dot, e.g. .png).
  matcher: ["/((?!_next/static|_next/image|.*\\.).*)"],
};
