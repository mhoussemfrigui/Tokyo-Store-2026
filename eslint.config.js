import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import nextPlugin from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * ESLint config — flat config style.
 *
 * The `react`, `react-hooks`, `@next/next` and `jsx-a11y` plugins ship via
 * `eslint-config-next` (already a project dep). Loading them here registers the
 * rule definitions so `// eslint-disable-next-line react/no-danger` /
 * `react-hooks/exhaustive-deps` / `@next/next/no-img-element` /
 * `jsx-a11y/media-has-caption` comments don't fail with "Definition for rule …
 * was not found" errors. Only the react-hooks recommended set (+ react/no-danger)
 * is ENABLED; the next / jsx-a11y plugins are registered with no rules on.
 *
 * Ignores: build output, deps, and local tooling dirs — `.claude/**` holds agent
 * worktrees (full repo copies incl. their own `.next`) and `.tmp/**` scratch
 * files; linting them buried the repo's own problems under ~18k false errors.
 */
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "src/components/ui/**",
      ".claude/**",
      ".tmp/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Register the React + React Hooks rule definitions and apply the hooks
  // recommended set. From the react plugin only `no-danger` is enabled (as a
  // warning) — loading the plugin also keeps `react/*` rule names
  // referenceable in disable comments.
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      // Registered for their rule DEFINITIONS only (disable comments) — none of
      // their recommended rules are enabled.
      "@next/next": nextPlugin,
      "jsx-a11y": jsxA11y,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react/no-danger": "warn",
      // The new React 19 rule flags any setState() inside useEffect as an
      // error. Most existing media-query / window-resize hooks in the
      // codebase follow that exact pattern intentionally — we treat it as a
      // warning until the hooks get refactored to useSyncExternalStore.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  prettierConfig,
  {
    // French copy uses non-breaking spaces (« 10 % », « € ») on purpose, and a
    // comment may quote a BOM — only flag irregular whitespace in real code.
    rules: {
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipTemplates: true, skipComments: true, skipRegExps: true, skipJSXText: true },
      ],
    },
  },
  {
    // Node build scripts (the catalog generators): Node globals, and their
    // intentional `// @ts-nocheck` (they are plain .mjs, not type-checked).
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "@typescript-eslint/ban-ts-comment": "off" },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
