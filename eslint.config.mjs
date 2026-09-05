import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".next/**",
      "dist/**",
      "**/.venv/**",
      "backend/**",
      "coverage/**",
      "depth-worker/**",
      "drizzle/**",
      "node_modules/**",
      "public/**",
    ],
  },
  {
    files: ["src/**/*.{js,jsx}", "scripts/**/*.{js,mjs}", "vite.config.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unexpected-multiline": "off",
      "no-useless-escape": "off",
      "react/jsx-uses-react": "error",
      "react/jsx-uses-vars": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
