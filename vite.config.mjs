import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

function exactOrigin(value, name) {
  if (!value) throw new Error(`${name} is required for a production build`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL origin`);
  }
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) {
    throw new Error(`${name} must be an exact HTTPS origin with no path, query, or fragment`);
  }
  return url.origin;
}

const FORBIDDEN_BROWSER_MODULES = [
  "/src/app/",
  "/backend/",
  "/depth-worker/",
  "/scripts/",
  "/src/lib/db.js",
  "/src/lib/storage.js",
  "/src/lib/schema.js",
  "/src/lib/auth.js",
  "/src/lib/password.js",
  "/src/lib/login-throttle.js",
  "/src/lib/cron-auth.js",
  "/src/lib/gcp-auth.js",
  "/src/lib/video-frame-server.js",
  "/src/lib/providers/",
  "/src/lib/agents/llm-provider.js",
  "/src/lib/agents/orchestrator/",
  "/drizzle-orm/",
  "/@aws-sdk/",
  "/@google-cloud/",
  "/postgres/",
  "/pg/",
  "/sharp/",
  "/@ffmpeg-installer/",
  "/@vercel/oidc/",
];

function browserBoundaryGuard() {
  return {
    name: "browser-boundary-guard",
    generateBundle() {
      const violations = [...this.getModuleIds()].filter((id) =>
        FORBIDDEN_BROWSER_MODULES.some((fragment) => id.replaceAll("\\", "/").includes(fragment)),
      );
      if (violations.length) {
        this.error(`Server-only modules reached the browser bundle:\n${violations.join("\n")}`);
      }
    },
  };
}

function exactCsp(apiOrigin, mediaOrigin) {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${apiOrigin} ${mediaOrigin}`,
    `img-src 'self' data: blob: ${apiOrigin} ${mediaOrigin}`,
    `media-src 'self' data: blob: ${apiOrigin} ${mediaOrigin}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  return {
    name: "exact-content-security-policy",
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const djangoOrigin = env.DJANGO_DEV_ORIGIN || "http://127.0.0.1:8000";
  const productionBuild = mode === "production";
  const apiOrigin = productionBuild
    ? exactOrigin(env.VITE_API_URL, "VITE_API_URL")
    : env.VITE_API_URL || djangoOrigin;
  const mediaOrigin = productionBuild
    ? exactOrigin(env.VITE_MEDIA_ORIGIN || "https://storage.googleapis.com", "VITE_MEDIA_ORIGIN")
    : env.VITE_MEDIA_ORIGIN || "https://storage.googleapis.com";

  return {
    plugins: [react(), browserBoundaryGuard(), exactCsp(apiOrigin, mediaOrigin)],
    resolve: {
      alias: { "@": path.resolve(process.cwd(), "src") },
    },
    server: {
      proxy: {
        "/api": {
          target: djangoOrigin,
          changeOrigin: true,
        },
      },
    },
    preview: {
      proxy: {
        "/api": {
          target: djangoOrigin,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.js"],
      exclude: ["src/**/*.integration.js"],
      fileParallelism: false,
      testTimeout: 10_000,
    },
  };
});
