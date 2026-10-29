// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("project branding", () => {
  it("contains no references to the retired prototype vendor", () => {
    const retiredVendor = ["lov", "able"].join("");
    const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => file && file !== "README.original.md");

    const references = trackedFiles.flatMap((file) => {
      const path = join(ROOT, file);
      if (!existsSync(path)) return [];
      if (!statSync(path).isFile()) return [];
      const contents = readFileSync(path);
      if (contents.includes(0)) return [];
      return contents.toString("utf8").toLowerCase().includes(retiredVendor) ? [file] : [];
    });

    expect(references).toEqual([]);
  });

  it("declares a clearly named favicon that exists in public", () => {
    const rootRoute = readFileSync(join(ROOT, "src/routes/__root.tsx"), "utf8");
    const faviconHref = rootRoute.match(/rel: "icon", href: "(\/[^"]+)"/)?.[1];

    expect(faviconHref).toBe("/edp-favicon.svg");
    expect(existsSync(join(ROOT, "public", faviconHref!.slice(1)))).toBe(true);
  });
});
