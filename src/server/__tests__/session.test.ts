import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSessionRequest, resetSessionIdentityCacheForTests } from "../session";
import { DEFAULT_EFFECTIVE_SLA_CONFIG, setConfiguredSlaConfigForTests } from "../sla-config";

const SECRET_TOKEN = "obo-SUPER-SECRET-TOKEN-do-not-leak";

function scimResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A GET /api/session request carrying the forwarded OBO token. */
function sessionRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example/api/session", { method: "GET", headers });
}

describe("handleSessionRequest — server-side identity resolution", () => {
  afterEach(() => {
    resetSessionIdentityCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setConfiguredSlaConfigForTests(DEFAULT_EFFECTIVE_SLA_CONFIG);
  });

  it("resolves the real principal and NEVER leaks the OBO token in the response", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      scimResponse({
        id: "scim-42",
        userName: "real.user@example.test",
        displayName: "Real User",
        emails: [{ value: "real.user@example.test", primary: true }],
        groups: [{ value: "grp-admin" }],
      }),
    );

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    // Token redaction: the sanitized profile must not contain the OBO token.
    expect(text).not.toContain(SECRET_TOKEN);

    const profile = JSON.parse(text);
    expect(profile.principalId).toBe("scim-42");
    expect(profile.isAdmin).toBe(true);
    expect(profile.isSafeguardsValidator).toBe(true);
    expect(profile.slaConfig.stages["eir-validation"]).toBe(3);
    expect(profile).not.toHaveProperty("accessToken");

    // SCIM /Me was called with the OBO token as the bearer credential.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ws.example.databricks.com/api/2.0/preview/scim/v2/Me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${SECRET_TOKEN}` }),
      }),
    );
  });

  it("returns the effective deploy-time SLA config from the server", async () => {
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    setConfiguredSlaConfigForTests({
      ...DEFAULT_EFFECTIVE_SLA_CONFIG,
      stages: { ...DEFAULT_EFFECTIVE_SLA_CONFIG.stages, "eir-validation": 4 },
      holidays: ["2026-10-12"],
    });

    const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

    expect(profile.slaConfig).toMatchObject({
      stages: { "eir-validation": 4 },
      holidays: ["2026-10-12"],
    });
  });

  it("returns a configured EIR support mailbox and omits the none placeholder", async () => {
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_EIR_SUPPORT_EMAIL", "edp-help@agency.gov");

    const configured = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());
    expect(configured.supportEmail).toBe("edp-help@agency.gov");

    vi.stubEnv("EDP_EIR_SUPPORT_EMAIL", "none");
    const absent = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());
    expect(absent).not.toHaveProperty("supportEmail");
  });

  it("omits a malformed EIR support mailbox", async () => {
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_EIR_SUPPORT_EMAIL", "not-an-email");

    const response = await handleSessionRequest(sessionRequest());

    await expect(response.json()).resolves.not.toHaveProperty("supportEmail");
  });

  it("fails closed on a SCIM non-200 (no profile, no token echoed)", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(scimResponse({ detail: "denied" }, 403));

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );
    const text = await response.text();

    expect(response.ok).toBe(false);
    expect(response.status).toBe(401); // 403 from SCIM maps to a 401 identity failure
    expect(text).not.toContain(SECRET_TOKEN);
    expect(JSON.parse(text)).not.toHaveProperty("principalId");
  });

  it("fails closed when the SCIM call errors at the network level", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("ECONNREFUSED"));

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );

    expect(response.status).toBe(502);
    expect(JSON.parse(await response.text())).not.toHaveProperty("principalId");
  });

  it("PRODUCTION + no forwarded headers → 401, never the seed identity", async () => {
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await handleSessionRequest(sessionRequest());

    expect(response.status).toBe(401);
    const body = JSON.parse(await response.text());
    expect(body).not.toHaveProperty("principalId");
    expect(fetchSpy).not.toHaveBeenCalled(); // no SCIM call without a token
  });

  it("DEVELOPMENT + no forwarded headers → 200 dev fallback, isAdmin false, no SCIM call", async () => {
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await handleSessionRequest(sessionRequest());
    const profile = JSON.parse(await response.text());

    expect(response.status).toBe(200);
    expect(profile.isAdmin).toBe(false);
    expect(profile.principalId).toBe("dev-local-user");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives an EDP admin group member every staff role (#226)", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      scimResponse({ id: "scim-7", userName: "admin@example.test", groups: [{ value: "grp-admin" }] }),
    );

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );
    const profile = JSON.parse(await response.text());

    expect(profile).toMatchObject({
      isAdmin: true,
      isSafeguardsValidator: true,
      onboardingReviewerRoles: ["business-office", "ccb"],
    });
  });

  it("grants nothing for the reserved per-role group vars (#226)", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.stubEnv("EDP_SAFEGUARDS_VALIDATOR_GROUP_ID", "grp-validators");
    vi.stubEnv("EDP_BUSINESS_OFFICE_GROUP_ID", "grp-bo");
    vi.stubEnv("EDP_CCB_GROUP_ID", "grp-ccb");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      scimResponse({
        id: "scim-7",
        userName: "bo@example.test",
        groups: [{ value: "grp-validators" }, { value: "grp-bo" }, { value: "grp-ccb" }],
      }),
    );

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );
    const profile = JSON.parse(await response.text());

    expect(profile).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });

  it("makes nobody staff when EDP_ADMIN_GROUP_ID is unset (#226)", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      scimResponse({ id: "scim-7", userName: "admin@example.test", groups: [{ value: "grp-admin" }] }),
    );

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );
    const profile = JSON.parse(await response.text());

    expect(profile).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });

  it("gives the dev fallback no staff roles when no admin group is configured (#226)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_DEV_GROUP_IDS", "grp-admin");
    // Removed by #226: no role source of its own any more.
    vi.stubEnv("EDP_DEV_REVIEWER_ROLES", "business-office,ccb");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

    expect(profile.principalId).toBe("dev-local-user");
    expect(profile).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });

  it("gives the dev fallback every staff role when EDP_DEV_GROUP_IDS names the configured admin group (development only)", async () => {
    vi.stubEnv("NODE_ENV", " Development ");
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.stubEnv("EDP_DEV_GROUP_IDS", " grp-other , grp-admin ");

    const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

    expect(profile.principalId).toBe("dev-local-user");
    expect(profile).toMatchObject({
      isAdmin: true,
      isSafeguardsValidator: true,
      onboardingReviewerRoles: ["business-office", "ccb"],
    });
  });

  it("gives the dev fallback no staff roles when its dev groups don't include the admin group", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.stubEnv("EDP_DEV_GROUP_IDS", "grp-other");

    const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

    expect(profile).toMatchObject({ isAdmin: false, onboardingReviewerRoles: [] });
  });

  it("warns that EDP_DEV_REVIEWER_ROLES was removed and grants nothing for it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.stubEnv("EDP_DEV_REVIEWER_ROLES", "business-office,ccb");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

    expect(profile.onboardingReviewerRoles).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/EDP_DEV_REVIEWER_ROLES.*removed.*EDP_DEV_GROUP_IDS/),
    );
  });

  it("ignores EDP_DEV_GROUP_IDS for a real forwarded identity", async () => {
    vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
    vi.stubEnv("EDP_IDENTITY_MODE", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.stubEnv("EDP_DEV_GROUP_IDS", "grp-admin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      scimResponse({ id: "scim-8", userName: "x@example.test", groups: [] }),
    );

    const response = await handleSessionRequest(
      sessionRequest({ "x-forwarded-access-token": SECRET_TOKEN }),
    );
    expect(JSON.parse(await response.text())).toMatchObject({
      isAdmin: false,
      onboardingReviewerRoles: [],
    });
  });

  it("still refuses to impersonate the seed user in production, whatever EDP_DEV_GROUP_IDS says", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
    vi.stubEnv("EDP_DEV_GROUP_IDS", "grp-admin");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handleSessionRequest(sessionRequest());

    expect(response.status).toBe(401);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["Production", "Production"],
    ["PRODUCTION", "PRODUCTION"],
    ["' production '", " production "],
    ["staging", "staging"],
    ["test", "test"],
  ])(
    "ignores EDP_DEV_GROUP_IDS and warns when NODE_ENV is %s, even in development identity mode",
    async (_label, nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("EDP_IDENTITY_MODE", "development");
      vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");
      vi.stubEnv("EDP_DEV_GROUP_IDS", "grp-admin");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

      expect(profile.principalId).toBe("dev-local-user");
      expect(profile).toMatchObject({ isAdmin: false, onboardingReviewerRoles: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/EDP_DEV_GROUP_IDS.*ignored/));
    },
  );

  it("gives the dev fallback no staff roles when EDP_DEV_GROUP_IDS is unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EDP_IDENTITY_MODE", "development");
    vi.stubEnv("EDP_ADMIN_GROUP_ID", "grp-admin");

    const profile = JSON.parse(await (await handleSessionRequest(sessionRequest())).text());

    expect(profile).toMatchObject({ isAdmin: false, onboardingReviewerRoles: [] });
  });
});
