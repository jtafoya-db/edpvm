// @vitest-environment node
import { describe, expect, it } from "vitest";
import { minifyConfigFor } from "../../../vite.config";

describe("Databricks unminified build switch", () => {
  it("keeps normal builds minified by default", async () => {
    expect(minifyConfigFor(undefined)).toEqual({});
  });

  it("disables minification only when explicitly requested", async () => {
    expect(minifyConfigFor("1")).toEqual({ minify: false });
    expect(minifyConfigFor("true")).toEqual({});
  });
});
