/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // next/image is never imported anywhere in this app (media is served via
  // raw <img> tags, deliberately — see storage.ts/media_grant.py for the
  // signed-URL/CORS reasoning). The wildcard remotePatterns below kept
  // Next's built-in /_next/image optimizer live and reachable with no
  // hostname restriction — i.e. server-side fetch-and-process of an
  // attacker-supplied https URL through Next's bundled (and, at the time
  // of writing, CVE-affected) sharp copy, for a feature nothing here uses.
  // unoptimized:true disables that route entirely rather than trusting a
  // version bump to keep it patched.
  images: {
    unoptimized: true,
  },
  // Baseline security headers. Deliberately NOT including Content-Security-Policy
  // here — this app serves media from S3/GCS signed URLs and a CDN whose exact
  // domains vary by environment, and getting a CSP wrong (missing a domain,
  // blocking an inline style framer-motion needs) breaks real functionality
  // rather than failing loudly. Needs its own pass with live browser
  // verification before it's added.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No camera/mic/geolocation use anywhere in this app.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
