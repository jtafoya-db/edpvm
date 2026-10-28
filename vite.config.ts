import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export const UNMINIFIED_BUILD_ENV = "EDP_UNMINIFIED_BUILD";

export const minifyConfigFor = (flag: string | undefined) =>
  flag && ["1", "true", "yes", "on"].includes(flag.toLowerCase())
    ? ({ minify: false } as const)
    : {};

export const eirYamlSource = () => ({
  name: "eir-yaml-source",
  enforce: "pre" as const,
  load(id: string) {
    const [path, query] = id.split("?", 2);
    if (!path || !query?.split("&").includes("raw") || !path.endsWith(".eir.yaml")) return null;
    const source = readFileSync(path, "utf8");
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    return `export default [\n${lines.map((line) => `  ${JSON.stringify(line)},`).join("\n")}\n].join("");`;
  },
});

export const zodJitlessBuild = () => ({
  name: "zod-jitless-build",
  enforce: "pre" as const,
  transform(source: string, id: string) {
    // Vite uses the same transform for client and server chunks. Both artifacts
    // are deliberately jitless so neither can acquire an executable-string seam.
    if (id.endsWith("/zod/v4/core/util.js")) {
      const start = source.indexOf("export const allowsEval =");
      const end = source.indexOf("\nexport function isPlainObject", start);
      if (start < 0 || end < 0) throw new Error("Zod's allowsEval implementation changed");
      return `${source.slice(0, start)}export const allowsEval = { value: false };${source.slice(end)}`;
    }
    if (id.endsWith("/zod/v4/core/doc.js")) {
      const original = `    compile() {
        const F = Function;
        const content = this?.content ?? [\`\`];
        const factory = new F(...Object.keys(this.closed), \`return function (\${this.args.join(", ")}) {\\n\${content.join("\\n")}\\n};\`);
        return factory(...Object.values(this.closed));
    }`;
      if (!source.includes(original)) throw new Error("Zod's Doc.compile implementation changed");
      return source.replace(
        original,
        `    compile() {
        throw new Error("Zod JIT compilation is disabled by the build");
    }`,
      );
    }
    return null;
  },
});

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const envDefine = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );

  return {
    define: envDefine,
    css: { transformer: "lightningcss" },
    server: { host: "::", port: 8080 },
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      ignoreOutdatedRequests: true,
    },
    plugins: [
      eirYamlSource(),
      zodJitlessBuild(),
      tailwindcss(),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
        server: { entry: "server" },
      }),
      ...(command === "build" ? [nitro({ defaultPreset: "cloudflare-module" })] : []),
      react(),
    ],
    build: {
      // Some managed networks block minified JavaScript through content
      // inspection. Keep optimized builds as the default, but allow an
      // operator to produce an equivalent readable artifact explicitly.
      ...minifyConfigFor(process.env[UNMINIFIED_BUILD_ENV]),
      // The ported prototype modules register their screens and primitives on
      // `window` as import side effects. Rolldown's production tree-shaker was
      // incorrectly reducing those chunks to empty React imports, leaving
      // window.AdminScreen, window.Page, etc. undefined at runtime.
      rollupOptions: { treeshake: false },
    },
  };
});
