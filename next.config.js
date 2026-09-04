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
  // Keep this policy report-only until a full browser pass and a clean
  // observation window prove that it covers the final CDN topology. Inline
  // styles are currently required by React/framer-motion. Browser-side media
  // and URL-reference fetches may use arbitrary HTTPS origins, while known
  // deployment origins are named explicitly to make the intended topology
  // reviewable before the broad HTTPS compatibility source is tightened.
  async headers() {
    const configuredOrigins = [
      process.env.NEXT_PUBLIC_API_URL,
      process.env.GCP_MEDIA_CDN_URL,
    ].flatMap((value) => {
      if (!value) return [];
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? [url.origin] : [];
      } catch {
        return [];
      }
    });
    const browserNetworkSources = [
      "'self'",
      "https://storage.googleapis.com",
      "https://*.storage.googleapis.com",
      "https://*.s3.amazonaws.com",
      ...configuredOrigins,
      "https:",
    ];
    const cspReportOnly = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      `img-src ${browserNetworkSources.join(" ")} data: blob:`,
      `media-src ${browserNetworkSources.join(" ")} blob:`,
      `connect-src ${browserNetworkSources.join(" ")} blob:`,
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "report-uri /api/security/csp-report",
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
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
