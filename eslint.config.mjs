import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
];

export default config;
