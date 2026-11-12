// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSessionRequest, resetSessionIdentityCacheForTests } from "../session";

afterEach(() => {
  resetSessionIdentityCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function session(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
  vi.stubEnv("EDP_IDENTITY_MODE", "production");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      id: "employee-1",
      userName: "employee.one@example.gov",
      displayName: "Employee One",
      emails: [{ value: "employee.one@example.gov", primary: true }],
      groups: [],
    }),
  );
  const response = await handleSessionRequest(
    new Request("https://app.example/api/session", {
      headers: { "x-forwarded-access-token": "synthetic-token" },
    }),
  );
  return (await response.json()) as Record<string, unknown>;
}

describe("/api/session manager-directory preview signal", () => {
  it("returns the signal only when both preview guards pass", async () => {
    await expect(
      session({
        EDP_SIMULATED_DIRECTORY_ENABLED: "true",
        EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr348_",
      }),
    ).resolves.toMatchObject({ managerDirectoryPreview: true });
  });

  it.each([
    ["flag absent", { EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr348_" }],
    [
      "flag false",
      { EDP_SIMULATED_DIRECTORY_ENABLED: "false", EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr348_" },
    ],
    [
      "production prefix",
      { EDP_SIMULATED_DIRECTORY_ENABLED: "true", EDP_STORE_SCHEMA_PREFIX: "production_" },
    ],
  ])("omits the signal when %s", async (_label, env) => {
    await expect(session(env)).resolves.not.toHaveProperty("managerDirectoryPreview");
  });
});
