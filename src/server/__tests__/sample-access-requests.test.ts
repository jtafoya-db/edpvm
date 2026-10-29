// @vitest-environment node
/**
 * Sample access requests are a PR preview's test data only (#312): on only
 * when the flag, trimmed, is exactly `true` AND the store is a PR preview's
 * (`edp_vm_pr<N>_`). Anything else, none, and the session says nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStoreNames } from "../delta/sql-builder.ts";
import {
  sampleAccessRequestsAllowed,
  sampleAccessRequestsForStore,
  sampleAccessRequestsFromEnv,
} from "../sample-access-requests.ts";
import { handleSessionRequest, resetSessionIdentityCacheForTests } from "../session";

afterEach(() => {
  resetSessionIdentityCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("sampleAccessRequestsAllowed: both guards, fail closed", () => {
  it.each([
    [undefined, "edp_vm_pr312_", false],
    ["", "edp_vm_pr312_", false],
    ["false", "edp_vm_pr312_", false],
    ["TRUE", "edp_vm_pr312_", false],
    ["yes", "edp_vm_pr312_", false],
    ["1", "edp_vm_pr312_", false],
    ["true", "", false],
    ["true", undefined, false],
    ["true", "edp_vm_preview_", false],
    ["true", "edp_vm_pr312", false],
    // Raw equality: no trimming, no case folding.
    [" true ", "edp_vm_pr7_", false],
    ["true ", "edp_vm_pr7_", false],
    [" true", "edp_vm_pr7_", false],
    ["true\n", "edp_vm_pr7_", false],
    ["\ttrue", "edp_vm_pr7_", false],
    ["True", "edp_vm_pr7_", false],
    ["tRUE", "edp_vm_pr7_", false],
    // A PR preview's prefix names a positive PR number.
    ["true", "edp_vm_pr0_", false],
    ["true", "edp_vm_pr00_", false],
    ["true", "edp_vm_pr01_", false],
    ["true", "EDP_VM_PR312_", false],
    ["true", "edp_vm_pr312_", true],
    ["true", "edp_vm_pr7_", true],
    ["true", "edp_vm_pr10_", true],
  ])("flag %j with prefix %j → %s", (flag, prefix, on) => {
    expect(sampleAccessRequestsAllowed(flag, prefix, () => undefined)).toBe(on);
  });

  it("warns about an unexpected flag value, but not about unset, empty or false", () => {
    const warn = vi.fn();
    for (const flag of [undefined, "", "false"])
      sampleAccessRequestsAllowed(flag, "edp_vm_pr1_", warn);
    expect(warn).not.toHaveBeenCalled();
    sampleAccessRequestsAllowed("on", "edp_vm_pr1_", warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only "true" turns on'));
    sampleAccessRequestsAllowed("true", "", warn);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("isn't a PR preview's"));
  });

  it("warns about a padded flag instead of honouring it", () => {
    const warn = vi.fn();
    expect(sampleAccessRequestsAllowed(" true ", "edp_vm_pr1_", warn)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only "true" turns on'));
  });

  it("checks the prefix of the store the server writes to, with the flag from env", () => {
    const preview = createStoreNames("edp_vending", "edp_vm_pr312_");
    const production = createStoreNames("edp_vending", "");
    expect(sampleAccessRequestsForStore(preview)).toBe(false);
    vi.stubEnv("EDP_SAMPLE_ACCESS_REQUESTS", "true");
    expect(sampleAccessRequestsForStore(preview)).toBe(true);
    expect(sampleAccessRequestsForStore(production)).toBe(false);
    vi.stubEnv("EDP_SAMPLE_ACCESS_REQUESTS", " true");
    expect(sampleAccessRequestsForStore(preview)).toBe(false);
  });

  it("reads both guards from env", () => {
    vi.stubEnv("EDP_SAMPLE_ACCESS_REQUESTS", "true");
    expect(sampleAccessRequestsFromEnv()).toBe(false);
    vi.stubEnv("EDP_STORE_SCHEMA_PREFIX", "edp_vm_pr312_");
    expect(sampleAccessRequestsFromEnv()).toBe(true);
  });
});

describe("/api/session says so only when samples are on", () => {
  const session = async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "7700000000000701",
          userName: "test.person@example.gov",
          displayName: "Test Person",
          emails: [{ value: "test.person@example.gov", primary: true }],
          groups: [],
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

  it("sets it on a PR preview with the flag on", async () => {
    vi.stubEnv("EDP_SAMPLE_ACCESS_REQUESTS", "true");
    vi.stubEnv("EDP_STORE_SCHEMA_PREFIX", "edp_vm_pr312_");
    expect(await session()).toMatchObject({ sampleAccessRequests: true });
  });

  it.each([
    ["the flag unset", { EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr312_" }],
    [
      "the flag false",
      { EDP_SAMPLE_ACCESS_REQUESTS: "false", EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr312_" },
    ],
    [
      "a malformed flag",
      { EDP_SAMPLE_ACCESS_REQUESTS: "True", EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr312_" },
    ],
    ["a production store", { EDP_SAMPLE_ACCESS_REQUESTS: "true" }],
  ] as [string, Record<string, string>][])("leaves no trace of it with %s", async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(await session()).not.toHaveProperty("sampleAccessRequests");
  });
});
