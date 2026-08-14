import { NextResponse } from "next/server";

/**
 * Lightweight gate (runs on the edge — can't touch the DB/Node crypto).
 * It does a cheap session-cookie presence check for UX:
 *  - no cookie + protected page → redirect to /login
 *  - no cookie + protected API → 401
 *  - has cookie + /login → redirect to /
 * Real enforcement (signature + DB + role) happens server-side in the route
 * handlers/pages via getSession()/requireUser()/requireAdmin().
 */
const SESSION_COOKIE = "veevee_session";

export function middleware(req) {
  const { pathname } = req.nextUrl;

  // Always allow auth endpoints and Next internals/static assets.
  // /api/admin/set-token is also exempt: it accepts either an admin session
  // OR an x-setup-secret header (token re-seeding from a script with no
  // cookie), and enforces both itself.
  // /api/media-grant is exempt because its whole purpose is to be fetched by an
  // external provider that has no session — BytePlus reading a reference clip.
  // It is NOT unauthenticated: the request carries a short-lived HMAC-signed
  // grant naming exactly one object, which the route verifies itself, and the
  // object path comes out of the signature rather than the querystring. Without
  // this exemption the 401 below would fire before the route ever ran.
  // /api/worker/depth/* is exempt for the same reason — the caller is the
  // depth-map worker Python process (see depth-worker-auth.js), which has no
  // browser and no session cookie. It is NOT unauthenticated: every request
  // carries its own DEPTH_WORKER_TOKEN bearer auth, verified by the route.
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/api/admin/set-token" ||
    pathname === "/api/media-grant" ||
    pathname.startsWith("/api/worker/depth/") ||
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
