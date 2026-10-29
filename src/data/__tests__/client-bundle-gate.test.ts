import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { scanClientBundle } from "../../../scripts/client-bundle-gate.mjs";

describe("built client JavaScript gate", () => {
  it("applies the allowlist to Windows paths without widening it", () => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    mkdirSync(join(root, "assets"));
    const reactPrefix = "contextType !== getDerivedStateFromProps ";
    const reactSuffix = " workInProgress.flags |= 1024), nextProps = !1);";
    const reactLine = `${reactPrefix}${"x".repeat(2_042 - reactPrefix.length - reactSuffix.length)}${reactSuffix}`;
    const exportLine = `export { ${Array.from({ length: 240 }, (_, index) => `binding${index}`).join(", ")} };`;
    writeFileSync(join(root, "assets", "index-windows.js"), `${reactLine}\r\n`);
    writeFileSync(join(root, "assets", "routes-windows.js"), `${exportLine}\n`);

    const allowed = scanClientBundle(root, { path: win32 });

    expect(allowed.violations).toEqual([]);
    expect(allowed.allowlistUses).toEqual([
      expect.objectContaining({ file: "assets/index-windows.js", length: 2_042 }),
      expect.objectContaining({ file: "assets/routes-windows.js", length: exportLine.length }),
    ]);

    mkdirSync(join(root, "assets", "nested"));
    writeFileSync(join(root, "assets", "nested", "other.js"), `${"x".repeat(2_001)}\r\n`);

    expect(scanClientBundle(root, { path: win32 }).violations).toEqual([
      "assets/nested/other.js:1: line length 2001 exceeds 2000",
    ]);
  });

  it("rejects executable-string constructors and reports overlong lines", () => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "routes.js"), `new Function("")\n${"x".repeat(2_001)}\n`);

    expect(scanClientBundle(root).violations).toEqual([
      "assets/routes.js:1: contains banned new Function(",
      "assets/routes.js:2: line length 2001 exceeds 2000",
    ]);
  });

  it.each([
    ["direct Function constructor", 'Function("return 1")', "Function("],
    ["global Function constructor", 'globalThis.Function("return 1")', "Function("],
    ["aliased Function constructor", "const F = Function; new F('return 1')", "= Function"],
    ["minified Function alias", "let e=Function;e('return 1')", "= Function"],
    ["indirect eval", '(0,eval)("1 + 1")', "(0, eval)"],
    ["bracket eval", 'window["eval"]("1 + 1")', '[\"eval\"]'],
    ["string timeout", 'setTimeout("run()", 1)', "string setTimeout"],
    ["string interval", "setInterval(`run()`, 1)", "string setInterval"],
  ])("rejects %s", (_name, source, label) => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    writeFileSync(join(root, "entry.js"), `${source}\n`);

    expect(scanClientBundle(root).violations).toEqual([
      expect.stringContaining(`contains banned ${label}`),
    ]);
  });

  it("scans emitted .mjs files", () => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    writeFileSync(join(root, "entry.mjs"), 'new Function("return 1")\n');

    expect(scanClientBundle(root).violations).toEqual([
      "entry.mjs:1: contains banned new Function(",
    ]);
  });

  it("rejects an unrelated long line in an index chunk", () => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "index-probe.js"), `${"x".repeat(3_000)}\n`);

    expect(scanClientBundle(root).violations).toEqual([
      "assets/index-probe.js:1: line length 3000 exceeds 2000",
    ]);
  });

  it("rejects code smuggled inside an export-shaped long line", () => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    mkdirSync(join(root, "assets"));
    const probe = `export { safe as ${"x".repeat(2_100)} = run() };`;
    writeFileSync(join(root, "assets", "routes-probe.js"), `${probe}\n`);

    expect(scanClientBundle(root).violations).toEqual([
      `assets/routes-probe.js:1: line length ${probe.length} exceeds 2000`,
    ]);
  });

  it("accepts readable client JavaScript without dynamic evaluation", () => {
    const root = mkdtempSync(join(tmpdir(), "edp-client-gate-"));
    writeFileSync(join(root, "entry.js"), "export const answer = 42;\n");

    expect(scanClientBundle(root).violations).toEqual([]);
  });
});
