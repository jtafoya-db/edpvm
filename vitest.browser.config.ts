import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Vitest config for the `*.browser.test.tsx` suite: tests that need a real
// browser because jsdom can't reproduce the behavior. For example, a number box
// holding a partial token ("-", "1e") that the browser can't parse yet. They run
// in headless Google Chrome (the `chrome` channel, so Chrome must be installed)
// with real keystrokes. `npm test` runs this suite after the jsdom one.
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { channel: "chrome" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
