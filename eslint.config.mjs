import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import path from "node:path";
import globals from "globals";

const baseDirectory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory });

const config = [
  {
    ignores: [
      ".next/**",
      "**/.venv/**",
      "backend/**",
      "coverage/**",
      "depth-worker/**",
      "drizzle/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "**/browser-artifacts/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "public/**",
    ],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    files: ["src/**/*.{js,jsx}", "scripts/**/*.{js,mjs}"],
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // These views intentionally render authenticated media-route/object URLs,
    // which next/image cannot optimize. Keep the exception narrow and named.
    files: [
      "src/app/login/page.jsx",
      "src/components/AccountSettings.jsx",
      "src/components/AdminDashboard.jsx",
      "src/components/ConversationPanel.jsx",
      "src/components/PromptComposer.jsx",
      "src/components/TopBar.jsx",
      "src/components/canvas/nodes/ImageNode.jsx",
    ],
    rules: { "@next/next/no-img-element": "off" },
  },
  {
    // A name used without being imported or defined crashes at runtime (2026-10-13 depth upload,
    // 2026-10-14 admin card). Application code only; tests define their own globals.
    files: ["src/**/*.{js,jsx}"],
    ignores: ["src/**/*.test.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { "no-undef": "error" },
  },
];

export default config;
