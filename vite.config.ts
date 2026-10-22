// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export const minifyConfigFor = (flag = process.env["VITE_EDP_UNMINIFIED_BUILD"]) =>
  flag === "1" ? ({ minify: false } as const) : {};

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    build: {
      // Some managed networks block minified JavaScript through content
      // inspection. Keep optimized builds as the default, but allow an
      // operator to produce an equivalent readable artifact explicitly.
      ...minifyConfigFor(),
      // The ported prototype modules register their screens and primitives on
      // `window` as import side effects. Rolldown's production tree-shaker was
      // incorrectly reducing those chunks to empty React imports, leaving
      // window.AdminScreen, window.Page, etc. undefined at runtime.
      rollupOptions: { treeshake: false },
    },
  },
});
