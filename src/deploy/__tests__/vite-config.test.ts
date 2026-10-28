// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  eirYamlSource,
  minifyConfigFor,
  UNMINIFIED_BUILD_ENV,
  zodJitlessBuild,
} from "../../../vite.config";

describe("Databricks unminified build switch", () => {
  it("uses a build-only environment name that Vite does not expose to the client", () => {
    expect(UNMINIFIED_BUILD_ENV).toBe("EDP_UNMINIFIED_BUILD");
    expect(UNMINIFIED_BUILD_ENV).not.toMatch(/^VITE_/);
  });

  it("keeps normal builds minified by default", () => {
    expect(minifyConfigFor(undefined)).toEqual({});
  });

  it.each(["1", "true", "yes", "on"])(
    "disables minification when explicitly set to truthy value %s",
    (flag) => {
      expect(minifyConfigFor(flag)).toEqual({ minify: false });
    },
  );

  it.each([undefined, "", " ", " 1 ", "0", "false", "no", "off", "unexpected"])(
    "leaves the default build configuration byte-for-byte unchanged for %s",
    (flag) => {
      expect(JSON.stringify(minifyConfigFor(flag))).toBe("{}");
    },
  );
});

describe("client-code hardening transforms", () => {
  it("replaces Zod's eval probe with the object shape its consumers read", () => {
    const path = resolve("node_modules/zod/v4/core/util.js");
    const transformed = zodJitlessBuild().transform(readFileSync(path, "utf8"), path);

    expect(transformed).toContain("export const allowsEval = { value: false };");
    expect(transformed).not.toMatch(/\bnew\s+Function\s*\(|=\s*Function\b/);
  });

  it("replaces Zod Doc.compile with a throwing jitless stub", () => {
    const path = resolve("node_modules/zod/v4/core/doc.js");
    const transformed = zodJitlessBuild().transform(readFileSync(path, "utf8"), path);

    expect(transformed).toContain(
      'throw new Error("Zod JIT compilation is disabled by the build")',
    );
    expect(transformed).not.toMatch(/\bnew\s+Function\s*\(|=\s*Function\b/);
  });

  it("the split YAML module reconstructs the pinned source bytes", async () => {
    const path = resolve("src/data/eir/definition/bootstrap-2.eir.yaml");
    const moduleSource = eirYamlSource().load(`${path}?raw`);
    expect(moduleSource).toBeTypeOf("string");
    const encoded = Buffer.from(moduleSource!).toString("base64");
    const splitSource = (await import(`data:text/javascript;base64,${encoded}`)).default as string;

    expect(createHash("sha256").update(splitSource).digest("hex")).toBe(
      "35d2aac1e3e5134d67886de746e9ae67e803195b33e8be09c2185b7a01fc2b8c",
    );
  });
});
