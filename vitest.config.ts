import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Vitest config for the merged suite. It runs, in one pass, every unit test
// from both merged lineages:
//   - #14's data-access seam + TanStack Query hook tests (data/__tests__/*),
//     which render React (hence the react() plugin) and need a DOM.
//   - #8's feature-gate component + registry tests (features/*).
//   - #9's pure schema helper tests (schema/*).
//   - #11's SchemaForm component + onboarding parity tests
//     (components/SchemaForm/*), which need TS/TSX + JSON support and a DOM.
//
// The react() plugin transforms JSX/TSX; tsconfigPaths resolves the `@/*` ->
// `./src/*` alias from tsconfig. Vite handles `.json` imports natively.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // The `@/*` -> `./src/*` alias is resolved by tsconfigPaths above, but we also
  // pin it here explicitly so tests keep resolving `@/...` regardless of how the
  // plugin picks up tsconfig. The feature-gate tests import via `@/mock`, and
  // the onboarding entrypoint pulls ds.jsx -> `@/design-system/...`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // jsdom for the component/hook tests; the `npm test` script also passes
    // `--environment jsdom` so the default holds either way.
    environment: "jsdom",
    // Cover both `.test`/`.spec` and `.ts`/`.tsx` (schema helpers + seam +
    // feature-gate + SchemaForm/parity + Query hook tests) so no PR's suite is
    // silently dropped after the merge. Each file matches exactly once.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Real-browser tests run under vitest.browser.config.ts instead.
    exclude: ["**/node_modules/**", "src/**/*.browser.test.{ts,tsx}"],
  },
});
