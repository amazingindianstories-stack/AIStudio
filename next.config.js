/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
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
