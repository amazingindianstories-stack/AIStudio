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
  // @ffmpeg-installer/ffmpeg resolves its platform binary with a dynamic
  // require() (`require(path.join(__dirname, ..., process.platform + "-" +
  // process.arch))`) that webpack can't statically analyze — bundling it
  // anyway ("Critical dependency: the request of a dependency is an
  // expression") mangles that require's runtime path and the build fails at
  // "Collecting page data" for /api/generate/video/status with a
  // MODULE_NOT_FOUND for the platform package, even though the package is
  // genuinely installed. Excluding it from the server bundle lets it resolve
  // normally against the real node_modules at runtime instead.
  serverExternalPackages: ["@ffmpeg-installer/ffmpeg"],
  // Browser policy for the cross-origin API and signed media hosts. Keep the
  // allow-list below in sync with Railway and the configured media origin.
  async headers() {
    const apiOrigin = (() => {
      try { return new URL(process.env.NEXT_PUBLIC_API_URL || "").origin; } catch { return ""; }
    })();
    const mediaOrigin = (() => {
      try { return new URL(process.env.NEXT_PUBLIC_MEDIA_URL || process.env.GCP_MEDIA_CDN_URL || "").origin; } catch { return ""; }
    })();
    const connectSources = ["'self'", apiOrigin, "https://storage.googleapis.com"].filter(Boolean).join(" ");
    const mediaSources = ["'self'", "data:", "blob:", apiOrigin, mediaOrigin, "https://storage.googleapis.com"].filter(Boolean).join(" ");
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src ${connectSources}`,
      `img-src ${mediaSources}`,
      `media-src ${mediaSources}`,
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
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
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
