import { NextResponse } from "next/server";
import { djangoDestination } from "./lib/backend-routing";

/** Same-origin transport only: all API authorization happens in Django. */
export function middleware(req) {
  const { pathname } = req.nextUrl;
  try {
    const destination = djangoDestination(req.url, req.method, {
      origin: process.env.DJANGO_API_ORIGIN,
      allowLocal: process.env.DJANGO_API_ALLOW_LOCAL,
    });
    if (destination) return NextResponse.rewrite(destination);
  } catch {
    return NextResponse.json({ error: "BACKEND_ROUTING_UNAVAILABLE" }, { status: 503 });
  }

  // This presence check is only a page-navigation convenience. Django verifies
  // the session when the page loads data, including disabled/revoked users.
  if (!req.cookies.get("veevee_session")?.value && pathname !== "/login") {
    const url = new URL(req.url);
    // next.config preserves the incoming URL so the redirect keeps its origin.
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  // A stale cookie must be allowed to reach login; its presence cannot prove
  // authentication and must never bounce /login back to an authenticated page.
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/((?!api(?:/|$)|_next/static|_next/image|.*\\.).*)"],
};
