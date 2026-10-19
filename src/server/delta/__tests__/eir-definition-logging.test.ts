// @vitest-environment node
/**
 * A refused bootstrap EIR definition (#200) is logged on the server with its
 * diagnostic codes and line numbers only: never a key, value or path segment
 * written in the YAML, which could carry anything. The person only sees the
 * generic unavailable message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const original = console.error;
  // Replaced before the definition loads (at import), restored after each test.
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return { calls, original };
});

afterEach(() => {
  console.error = logged.original;
});

// A YAML-authored key and value that must never reach the log.
vi.mock("../../../data/eir/definition/bootstrap-source.ts", () => ({
  readBootstrapEirSource: () =>
    "definitionVersion: bootstrap-1\nSENTINEL_PII_123: ${SENTINEL_PII_123}\n",
}));

describe("logging a refused bootstrap EIR definition", () => {
  it("logs why the bootstrap EIR definition was refused, without its content", async () => {
    const { EIR_FORM_UNAVAILABLE } = await import("../../../data/eir/config.ts");
    expect(EIR_FORM_UNAVAILABLE).toBeDefined();
    const text = logged.calls.map((call) => call.map(String).join(" ")).join("\n");
    // Each built-in definition (#217, #224: bootstrap and bootstrap-2) is loaded and logged by identity.
    expect(text).toBe(
      [
        "[eir] The bootstrap EIR definition bootstrap was refused: unsafe-yaml (line 2)",
        "[eir] The bootstrap EIR definition bootstrap-2 was refused: unsafe-yaml (line 2)",
      ].join("\n"),
    );
    expect(text).not.toContain("SENTINEL_PII_123");
  });
});

describe("logging an unreadable bootstrap EIR definition", () => {
  it("labels a read failure by its error name and code, never its message", async () => {
    // The real module (this file mocks its YAML read above).
    const { readFailureLabel } = await vi.importActual<
      typeof import("../../../data/eir/definition/bootstrap-source.ts")
    >("../../../data/eir/definition/bootstrap-source.ts");
    const failure = Object.assign(
      new Error("ENOENT: no such file, open '/home/SENTINEL_PII_123/bootstrap.eir.yaml'"),
      { code: "ENOENT" },
    );
    expect(readFailureLabel(failure)).toBe("Error ENOENT");
    expect(
      readFailureLabel(Object.assign(new Error("x"), { code: "/home/SENTINEL_PII_123" })),
    ).toBe("Error");
    expect(readFailureLabel("SENTINEL_PII_123 thrown as a string")).toBe("unknown error");
  });
});
