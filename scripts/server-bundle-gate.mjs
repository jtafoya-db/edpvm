// Server bundle gate, run by `npm run build:databricks` after the client gate.
//
// A stale GovCloud build bundled Zod 3 internals (`objectType(`, `stringType(`)
// and rewrote `z.iso` at the access-matrix schema to `(void 0).date()`, so
// server/_ssr/ssr.mjs threw at module load and every request returned Nitro's
// `{"error":true,"status":500,"unhandled":true}`. This fails such a build before
// scripts/deploy.sh can stage it, and checks that the zod this build resolves
// is 4.x.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

// Zod 3's schema defs carry `typeName: ZodFirstPartyTypeKind.ZodString` (and
// so on); minified, `typeName:e.ZodString`. The property key and the enum
// member names survive minification, and Zod 4 never writes `typeName:` (it
// still exports a ZodFirstPartyTypeKind enum for compatibility, so that name
// alone proves nothing). zod/v3 has 47 of these, zod/v4 none.
const ZOD3_TYPENAME = /\btypeName\s*:\s*[A-Za-z_$][\w$]*\s*\.\s*Zod[A-Z]\w*/;
// Zod 3's top-level factories, as a bundle that inlined them calls them. Either
// alone could be unrelated code, so a file needs both.
const ZOD3_CALLS = [/\bobjectType\s*\(/, /\bstringType\s*\(/];
// A namespace member the bundler couldn't resolve: `z.iso.date()` became
// `(void 0).date()`. Any `(void 0).<ident>(` call is refused, whatever precedes
// it and however it's split across lines (the whole file is scanned, so
// whitespace includes newlines). Zod 4's own `this.safeParse(void 0).success`
// is a property access, not a call.
const VOID_MEMBER_CALL = /\(\s*void\s+0\s*\)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g;

const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

export function scanServerBundle(serverRoot) {
  const files = javascriptFiles(serverRoot);
  const violations = [];
  for (const file of files) {
    const relativeFile = nodePath.relative(serverRoot, file).split(nodePath.sep).join("/");
    const text = readFileSync(file, "utf8");
    const typeName = ZOD3_TYPENAME.exec(text);
    const calls = ZOD3_CALLS.map((pattern) => pattern.exec(text));
    if (typeName) {
      violations.push(
        `${relativeFile}:${lineAt(text, typeName.index)}: contains Zod 3 internals (typeName: <kind>.Zod... schema defs)`,
      );
    } else if (calls.every(Boolean)) {
      const first = Math.min(...calls.map((match) => match.index));
      violations.push(
        `${relativeFile}:${lineAt(text, first)}: contains Zod 3 internals (objectType( and stringType( calls)`,
      );
    }
    for (const match of text.matchAll(VOID_MEMBER_CALL)) {
      violations.push(
        `${relativeFile}:${lineAt(text, match.index)}: contains a (void 0).member( call`,
      );
    }
  }
  return { files, violations };
}

export function checkZodVersion(version) {
  return /^4\./.test(version ?? "")
    ? []
    : [`resolved zod is ${version || "unknown"}; the server needs zod 4.x (run npm ci).`];
}

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = nodePath.resolve(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(path) : /\.m?js$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = nodePath.resolve(process.argv[2] ?? ".output/server");
  const require = createRequire(nodePath.resolve("package.json"));
  let zodVersion;
  try {
    zodVersion = JSON.parse(readFileSync(require.resolve("zod/package.json"), "utf8")).version;
  } catch {
    zodVersion = undefined;
  }
  const result = scanServerBundle(root);
  const problems = [...checkZodVersion(zodVersion), ...result.violations];
  if (problems.length) {
    console.error(
      `Server bundle gate failed (clean .output and rebuild with npm ci):\n${problems.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Server bundle gate passed: ${result.files.length} JS files, zod ${zodVersion}, no Zod 3 or (void 0). markers.`,
    );
  }
}
