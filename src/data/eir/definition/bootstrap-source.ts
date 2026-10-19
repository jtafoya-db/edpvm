import { FALLBACK_BUILT_IN_ID, type BuiltInDefinitionId } from "./identity.ts";

/**
 * A built-in EIR definition's YAML text (`<id>.eir.yaml`, #224), as shipped;
 * the fallback one (`bootstrap-2`, #217) by default. Vite builds (the app, its server, the tests) inline
 * the files; the Node scripts that import the EIR rules directly
 * (`scripts/eir-*.ts`) read them from disk. Undefined when neither can: the
 * definition is then unavailable, never guessed.
 */
export function readBootstrapEirSource(
  name: BuiltInDefinitionId = FALLBACK_BUILT_IN_ID,
): string | undefined {
  try {
    const bundled = import.meta.glob<string>("./bootstrap*.eir.yaml", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const text = bundled[`./${name}.eir.yaml`];
    if (typeof text === "string") return text;
  } catch {
    // Not built by Vite (`import.meta.glob` is Vite's): read it from disk below.
  }
  try {
    const fs = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => unknown };
      }
    ).process?.getBuiltinModule?.("node:fs") as
      { readFileSync: (path: URL, encoding: "utf8") => string } | undefined;
    if (!fs) {
      logUnreadable(name, "neither Vite's bundle nor node:fs is available");
      return undefined;
    }
    return fs.readFileSync(new URL(`./${name}.eir.yaml`, import.meta.url), "utf8");
  } catch (error) {
    logUnreadable(name, readFailureLabel(error));
    return undefined;
  }
}

/**
 * Why a read failed, for the log: the error's name and code (`ENOENT`) when
 * they look like identifiers, never its message, which can carry paths,
 * usernames or environment details.
 */
export function readFailureLabel(cause: unknown): string {
  const safe = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) ? value : undefined;
  const name = cause instanceof Error ? safe(cause.name) : undefined;
  const code = safe((cause as { code?: unknown } | null)?.code);
  return [name, code].filter(Boolean).join(" ") || "unknown error";
}

/** On the server, why the file couldn't be read: a bounded label, never file content or paths. */
function logUnreadable(name: BuiltInDefinitionId, detail: string): void {
  if (typeof window !== "undefined") return;
  console.error(`[eir] The bootstrap EIR definition ${name} couldn't be read (${detail}).`);
}
