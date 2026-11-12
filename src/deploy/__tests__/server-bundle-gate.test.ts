// @vitest-environment node
/**
 * The server bundle gate (seam: scripts/server-bundle-gate.mjs), run by
 * `npm run build:databricks` after the client gate.
 *
 * A stale GovCloud build bundled Zod 3 internals (`objectType(`, `stringType(`)
 * and rewrote `z.iso` at the access-matrix schema to `(void 0).date()`, which
 * crashed _ssr/ssr.mjs at module load. The gate fails such a build before it
 * can be staged.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkZodVersion, scanServerBundle } from "../../../scripts/server-bundle-gate.mjs";

function serverTree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "edp-server-gate-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe("scanServerBundle", () => {
  it("passes a Zod 4 server bundle", () => {
    const root = serverTree({
      "index.mjs": "import './_ssr/ssr.mjs';\n",
      "_ssr/ssr.mjs": "const at = z.iso.date();\nconst o = z.object({ a: z.string() });\n",
      "_libs/zod.mjs":
        "function $constructor(name) {}\nconst v = void 0;\n" +
        "isOptional() { return this.safeParse(void 0).success; }\n" +
        "const r = schema.safeParse(void 0).data;\n",
    });
    const result = scanServerBundle(root);
    expect(result.violations).toEqual([]);
    expect(result.files).toHaveLength(3);
  });

  it.each([
    ["Zod 3", "const schema = objectType({ a: stringType() });"],
    ["Zod 3", "const o = objectType({}), s = stringType();"],
    ["(void 0).", "const grantedAt = (void 0).date();"],
    ["(void 0).", "schema:(void 0).datetime({ offset: true })"],
    ["(void 0).", "function f(){return(void 0).date()}"],
    ["(void 0).", "x=(void 0).date()"],
    ["(void 0).", "const s = { at: (void 0).date() };"],
    ["(void 0).", "a ? (void 0).date() : b"],
  ])("fails a bundle containing %s, naming file and line: %s", (marker, line) => {
    const root = serverTree({ "_ssr/ok.mjs": "ok\n", "_ssr/ssr.mjs": `// x\n${line}\n` });
    const { violations } = scanServerBundle(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("_ssr/ssr.mjs:2");
    expect(violations.join("\n")).toContain(marker);
  });

  it.each([
    ["Zod 4's own safeParse(void 0) property access", "return this.safeParse(void 0).success;"],
    ["a lone objectType( in unrelated code", "const t = objectType(node);"],
    ["a lone stringType( in unrelated code", "if (stringType(x)) return;"],
  ])("passes %s", (_label, line) => {
    const root = serverTree({ "_ssr/ssr.mjs": `${line}\n` });
    expect(scanServerBundle(root).violations).toEqual([]);
  });

  it("flags Zod 3 when objectType( and stringType( appear in the same file on different lines", () => {
    const root = serverTree({
      "_libs/zod.mjs": "const a = objectType({});\nconst b = 1;\nconst c = stringType();\n",
    });
    const { violations } = scanServerBundle(root);
    expect(violations).toEqual([
      "_libs/zod.mjs:1: contains Zod 3 internals (objectType( and stringType( calls)",
    ]);
  });

  it.each([
    ["a newline after the dot", "const at = schema ?? 1;\nconst x = (void 0).\n  date();\n", 2],
    ["a newline after the closing paren", "a;\nb;\nconst x = (void 0)\n  .date();\n", 3],
    ["newlines inside the parens", "const x = (\n  void\n  0\n).date();\n", 1],
    ["a newline before the call paren", "\nreturn(void 0).date\n();\n", 2],
    ["CRLF line endings", "a;\r\nconst x = (void 0)\r\n  .date();\r\n", 2],
  ])("fails a multiline (void 0).member( call: %s, at the line it starts", (_label, body, line) => {
    const root = serverTree({ "_ssr/ssr.mjs": body });
    expect(scanServerBundle(root).violations).toEqual([
      `_ssr/ssr.mjs:${line}: contains a (void 0).member( call`,
    ]);
  });

  it("passes safeParse(void 0) property access across lines too", () => {
    const root = serverTree({
      "_libs/zod.mjs":
        "return this.safeParse(void 0)\n  .success;\nconst d = f(void 0).\n  data;\n",
    });
    expect(scanServerBundle(root).violations).toEqual([]);
  });

  it.each([
    [
      "unminified",
      "x;\nconst s = new ZodString({ typeName: ZodFirstPartyTypeKind.ZodString, ...p });\n",
    ],
    ["minified", "x;\nreturn new t({checks:[],typeName:e.ZodString,coerce:!1})"],
  ])(
    "flags a %s Zod 3 bundle by its schema-def typeName, even without objectType(",
    (_label, body) => {
      const root = serverTree({ "_libs/zod.mjs": body });
      expect(scanServerBundle(root).violations).toEqual([
        "_libs/zod.mjs:2: contains Zod 3 internals (typeName: <kind>.Zod... schema defs)",
      ]);
    },
  );

  it("passes Zod 4's own ZodFirstPartyTypeKind compatibility enum", () => {
    const root = serverTree({
      "_libs/zod.mjs":
        'var ZodFirstPartyTypeKind;\n(function (k) {})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));\nconst def = { type: "string" };\n',
    });
    expect(scanServerBundle(root).violations).toEqual([]);
  });

  it("scans only JavaScript", () => {
    const root = serverTree({ "notes.txt": "objectType(", "a.mjs": "ok" });
    expect(scanServerBundle(root).violations).toEqual([]);
  });
});

describe("checkZodVersion", () => {
  it.each(["4.0.0", "4.6.7"])("accepts zod %s", (version) => {
    expect(checkZodVersion(version)).toEqual([]);
  });

  it.each(["3.25.76", "", undefined])("refuses zod %s", (version) => {
    expect(checkZodVersion(version)).toEqual([expect.stringMatching(/zod 4\.x/)]);
  });
});
