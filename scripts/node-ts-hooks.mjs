// Lets plain Node (24+, with its built-in type stripping) run scripts that
// import the app's TypeScript modules, which import each other the way Vite
// resolves them: without extensions, through the `@/` alias, and JSON
// without an import attribute. No build step and no extra dependency.
//
//   node --import ./scripts/node-ts-hooks.mjs scripts/delta-teams-live-check.ts …
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = pathToFileURL(fileURLToPath(new URL("../src/", import.meta.url))).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const spec = specifier.startsWith("@/") ? SRC + specifier.slice(2) : specifier;
    const relative = spec.startsWith(".") || spec.startsWith("file:");
    const attempt = (candidate) => {
      const resolved = nextResolve(candidate, context);
      return resolved.url.endsWith(".json")
        ? { ...resolved, importAttributes: { ...context.importAttributes, type: "json" } }
        : resolved;
    };
    if (!relative) return attempt(spec);
    for (const candidate of [spec, `${spec}.ts`, `${spec}.tsx`, `${spec}/index.ts`]) {
      try {
        return attempt(candidate);
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT")
          throw error;
      }
    }
    return attempt(spec);
  },
});
