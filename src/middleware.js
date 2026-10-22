import { NextResponse } from "next/server";
import { createClient } from "@vercel/global-config";
import { createMaintenanceReader, maintenanceBlocks, MAINTENANCE_CODE, MAINTENANCE_MESSAGE } from "./lib/maintenance";
import { djangoDestination } from "./lib/backend-routing";

const readMaintenance = createMaintenanceReader(async () => {
  if (!process.env.EDGE_CONFIG) throw new Error("Maintenance source unconfigured");
  return createClient(process.env.EDGE_CONFIG, { staleIfError: false, cache: "no-store", disableDevelopmentCache: true }).get("veevee_maintenance");
});

/** Vercel write freeze works with the old Django backend too. */
export function createMiddleware(readToggle) {
  return async function middleware(req) {
    const { pathname } = req.nextUrl;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const state = await readToggle();
      const responseHeaders = { "Cache-Control": "no-store", "X-Veevee-Maintenance": state.enabled ? "1" : "0" };
      if (pathname === "/api/maintenance" && ["GET", "HEAD"].includes(req.method)) {
        return new NextResponse(req.method === "HEAD" ? null : JSON.stringify(state), {
          headers: { ...responseHeaders, "Content-Type": "application/json" },
        });
      }
      if (state.enabled && maintenanceBlocks(req.method, pathname)) {
        return NextResponse.json({ code: MAINTENANCE_CODE, error: MAINTENANCE_MESSAGE }, { status: 503, headers: responseHeaders });
      }
    }
    try {
      const destination = djangoDestination(req.url, req.method, {
        origin: process.env.DJANGO_API_ORIGIN,
        allowLocal: process.env.DJANGO_API_ALLOW_LOCAL,
      });
      if (destination) {
        // Acceptance-only server credential: overwrite any caller-supplied value.
        const ingressSecret = process.env.GOAL4_PRIVATE_INGRESS_SECRET;
        if (!ingressSecret || ingressSecret.length < 48) throw new Error("Private ingress unavailable");
        const headers = new Headers(req.headers);
        headers.delete("x-vercel-protection-bypass");
        headers.delete("x-vercel-set-bypass-cookie");
        const cookie = headers.get("cookie");
        if (cookie) headers.set("cookie", cookie.split(";").filter((part) => !["_vercel_jwt", "_vercel_protection_bypass"].includes(part.trim().split("=")[0])).join(";"));
        headers.set("x-veevee-g4-ingress", ingressSecret);
        return NextResponse.rewrite(destination, { request: { headers } });
      }
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
  };
}

export const middleware = createMiddleware(readMaintenance);

export const config = {
  matcher: ["/api/:path*", "/((?!api(?:/|$)|_next/static|_next/image|.*\\.).*)"],
};
