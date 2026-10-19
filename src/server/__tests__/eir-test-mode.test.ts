// @vitest-environment node
/**
 * A PR preview's EIR self-decision test mode (human decision 2026-10-07):
 * on only when the flag, trimmed, is exactly `true` AND the store is a PR
 * preview's (`edp_vm_pr<N>_`). Anything else is today's behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSelfDecisionTestMode } from "../delta/areas/eir.ts";
import { createStoreNames } from "../delta/sql-builder.ts";
import { eirSelfValidationAllowed, eirSelfValidationFromEnv } from "../eir-test-mode.ts";
import { handleSessionRequest, resetSessionIdentityCacheForTests } from "../session";

afterEach(() => {
  resetSessionIdentityCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("eirSelfValidationAllowed: both guards, fail closed", () => {
  it.each([
    [undefined, "edp_vm_pr134_", false],
    ["", "edp_vm_pr134_", false],
    ["false", "edp_vm_pr134_", false],
    ["TRUE", "edp_vm_pr134_", false],
    ["True", "edp_vm_pr134_", false],
    ["yes", "edp_vm_pr134_", false],
    ["1", "edp_vm_pr134_", false],
    ["true", "", false],
    ["true", undefined, false],
    ["true", "edp_vm_pr_", false],
    ["true", "edp_vm_preview_", false],
    ["true", "edp_vm_pr134", false],
    ["true", "xedp_vm_pr134_", false],
    ["true", "edp_vm_pr134_x_", false],
    ["true", "edp_vm_pr134_", true],
    [" true ", "edp_vm_pr7_", true],
    ["true\n", "edp_vm_pr1000_", true],
  ])("flag %j with prefix %j → %s", (flag, prefix, on) => {
    expect(eirSelfValidationAllowed(flag, prefix, () => undefined)).toBe(on);
  });

  it("warns about an unexpected flag value, but not about unset, empty or false", () => {
    const warn = vi.fn();
    for (const flag of [undefined, "", "false"])
      eirSelfValidationAllowed(flag, "edp_vm_pr1_", warn);
    expect(warn).not.toHaveBeenCalled();
    eirSelfValidationAllowed("TRUE ", "edp_vm_pr1_", warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only "true" turns on'));
    eirSelfValidationAllowed("true", "", warn);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("isn't a PR preview's"));
  });

  it("checks the prefix of the store the app writes to, with the flag from env", () => {
    const preview = createStoreNames("edp_vending", "edp_vm_pr134_");
    const production = createStoreNames("edp_vending", "");
    expect(defaultSelfDecisionTestMode(preview)).toBe(false);
    vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", "true");
    expect(defaultSelfDecisionTestMode(preview)).toBe(true);
    expect(defaultSelfDecisionTestMode(production)).toBe(false);
    vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", "false");
    expect(defaultSelfDecisionTestMode(preview)).toBe(false);
  });

  it("reads both guards from env for the session", () => {
    vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", "true");
    expect(eirSelfValidationFromEnv()).toBe(false);
    vi.stubEnv("EDP_STORE_SCHEMA_PREFIX", "edp_vm_pr134_");
    expect(eirSelfValidationFromEnv()).toBe(true);
  });
});

describe("/api/session tells the screen only when the mode is on", () => {
  const session = async (groups: string[]) => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-validators");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "7700000000000701",
          userName: "test.person@example.gov",
          displayName: "Test Person",
          emails: [{ value: "test.person@example.gov", primary: true }],
          groups: groups.map((value) => ({ value })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await handleSessionRequest(
      new Request("https://app.example/api/session", {
        headers: { "x-forwarded-access-token": "synthetic-token" },
      }),
    );
    return (await response.json()) as Record<string, unknown>;
  };

  it("sets it for a validator on a PR preview with the flag on", async () => {
    vi.stubEnv("EDP_EIR_ALLOW_SELF_VALIDATION", "true");
    vi.stubEnv("EDP_STORE_SCHEMA_PREFIX", "edp_vm_pr134_");
    expect(await session(["grp-validators"])).toMatchObject({ eirSelfDecisionTestMode: true });
  });

  it.each([
    ["the flag unset", {}, ["grp-validators"]],
    ["the flag false", { EDP_EIR_ALLOW_SELF_VALIDATION: "false" }, ["grp-validators"]],
    ["a production store", { EDP_EIR_ALLOW_SELF_VALIDATION: "true" }, ["grp-validators"]],
    [
      "someone who isn't a validator",
      { EDP_EIR_ALLOW_SELF_VALIDATION: "true", EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr134_" },
      [],
    ],
  ] as [string, Record<string, string>, string[]][])(
    "leaves no trace of it with %s",
    async (_label, env, groups) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      expect(await session(groups)).not.toHaveProperty("eirSelfDecisionTestMode");
    },
  );
});
