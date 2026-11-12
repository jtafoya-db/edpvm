// @vitest-environment node
/**
 * The staged-tree manifest (seam: src/deploy/appManifest.ts).
 *
 * A GovCloud `bundle deploy` from Windows uploaded databricks-app/ without
 * server/_ssr/ssr.mjs and server/_chunks/ssr-renderer.mjs. serve.mjs started,
 * and every request then failed inside Nitro. deploy.sh now records what it
 * staged and compares the workspace copy against it after the upload.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildManifest,
  compareManifest,
  formatManifestDiff,
  manifestDiffIsClean,
  notebookConvertiblePaths,
  scopedAppSourcePath,
} from "../appManifest.ts";

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "edp-manifest-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const STAGED = {
  "app.yaml": "command: []\n",
  "serve.mjs": "x",
  "server/index.mjs": "export {}",
  "server/_ssr/ssr.mjs": "ssr",
  "server/_chunks/ssr-renderer.mjs": "renderer",
  "server/_libs/@tanstack/react-router+[...].mjs": "router",
};

describe("buildManifest", () => {
  it("lists every file by forward-slash relative path, sorted, with size and sha256", () => {
    const manifest = buildManifest(tree(STAGED));
    expect(manifest.map((entry) => entry.path)).toEqual([
      "app.yaml",
      "serve.mjs",
      "server/_chunks/ssr-renderer.mjs",
      "server/_libs/@tanstack/react-router+[...].mjs",
      "server/_ssr/ssr.mjs",
      "server/index.mjs",
    ]);
    expect(manifest.find((entry) => entry.path === "server/_ssr/ssr.mjs")).toEqual({
      path: "server/_ssr/ssr.mjs",
      size: 3,
      // sha256("ssr")
      sha256: "2e2501506595f7563fc802ab2ffe252678cc8e4376765b5946034177b80d0c5f",
    });
  });
});

describe("compareManifest", () => {
  it("finds nothing wrong with an identical copy", () => {
    const expected = buildManifest(tree(STAGED));
    expect(compareManifest(expected, buildManifest(tree(STAGED)))).toEqual({
      missing: [],
      changed: [],
      unexpected: [],
    });
  });

  it("names the files the upload dropped, and those whose content differs", () => {
    const expected = buildManifest(tree(STAGED));
    const {
      "server/_ssr/ssr.mjs": _ssr,
      "server/_chunks/ssr-renderer.mjs": _renderer,
      ...uploaded
    } = STAGED;
    const actual = buildManifest(
      tree({ ...uploaded, "app.yaml": "command: [stale]\n", "server/old-abc.mjs": "old" }),
    );
    const diff = compareManifest(expected, actual);
    expect(diff).toEqual({
      missing: ["server/_chunks/ssr-renderer.mjs", "server/_ssr/ssr.mjs"],
      changed: ["app.yaml"],
      unexpected: ["server/old-abc.mjs"],
    });
    const text = formatManifestDiff(diff);
    expect(text).toContain("missing: server/_ssr/ssr.mjs");
    expect(text).toContain("differs: app.yaml");
    expect(text).toContain("extra: server/old-abc.mjs");
  });

  it("treats a workspace copy with only extra files as a mismatch", () => {
    const expected = buildManifest(tree(STAGED));
    const diff = compareManifest(expected, buildManifest(tree({ ...STAGED, "stale.mjs": "x" })));
    expect(diff.unexpected).toEqual(["stale.mjs"]);
    expect(manifestDiffIsClean(diff)).toBe(false);
    expect(manifestDiffIsClean(compareManifest(expected, expected))).toBe(true);
  });
});

describe("notebookConvertiblePaths", () => {
  it("names staged files the workspace would turn into notebooks", () => {
    const manifest = buildManifest(
      tree({
        ...STAGED,
        "public/a.py": "",
        "server/b.SQL": "",
        "c.scala": "",
        "d.r": "",
        "e.ipynb": "",
        "server/f.mjs": "",
      }),
    );
    expect(notebookConvertiblePaths(manifest)).toEqual([
      "c.scala",
      "d.r",
      "e.ipynb",
      "public/a.py",
      "server/b.SQL",
    ]);
    expect(notebookConvertiblePaths(buildManifest(tree(STAGED)))).toEqual([]);
  });
});

describe("scopedAppSourcePath", () => {
  const FILES = "/Workspace/Users/me@x.gov/.bundle/edp-vending-machine/edp-vm-test/files";

  it("returns the app source path when it is exactly <files>/databricks-app", () => {
    expect(scopedAppSourcePath(`${FILES}/databricks-app`, FILES)).toBe(`${FILES}/databricks-app`);
  });

  it.each([
    ["the files root itself", FILES, FILES],
    ["a sibling of the files root", `${FILES}-other/databricks-app`, FILES],
    ["another folder under files", `${FILES}/resources`, FILES],
    ["a traversal", `${FILES}/databricks-app/../..`, FILES],
    ["a nested path", `${FILES}/databricks-app/server`, FILES],
    ["an empty files root", "/databricks-app", ""],
    ["a files root outside /Workspace", "/Shared/x/databricks-app", "/Shared/x"],
    ["/Workspace itself", "/Workspace/databricks-app", "/Workspace"],
  ])("refuses %s", (_label, source, files) => {
    expect(() => scopedAppSourcePath(source, files)).toThrow(/refusing/);
  });

  it.each([
    ["an internal // in the files path", FILES.replace("/.bundle/", "//.bundle/")],
    ["a backslash", FILES.replace("/.bundle/", "\\.bundle/")],
    ["a control character", FILES.replace("/files", "/fi\u0000les")],
    ["a newline", FILES.replace("/files", "/files\n")],
    ["a . segment", FILES.replace("/files", "/./files")],
    ["a .. segment", FILES.replace("/files", "/x/../files")],
    ["a percent-encoded segment", FILES.replace("/files", "/%2e%2e/files")],
    ["a trailing space", `${FILES} `],
    ["a leading space", ` ${FILES}`],
    ["a trailing slash", `${FILES}/`],
  ])("refuses a non-canonical files path: %s", (_label, files) => {
    expect(() => scopedAppSourcePath(`${files}/databricks-app`, files)).toThrow(/refusing/);
  });

  it.each([
    ["a trailing space", `${FILES}/databricks-app `],
    ["a trailing tab", `${FILES}/databricks-app\t`],
    ["a trailing slash", `${FILES}/databricks-app/`],
    ["a percent-encoded name", `${FILES}/databricks%2Dapp`],
    ["a backslash", `${FILES}\\databricks-app`],
  ])("refuses a non-canonical app source path: %s", (_label, source) => {
    expect(() => scopedAppSourcePath(source, FILES)).toThrow(/refusing/);
  });
});
