// @vitest-environment node
/**
 * One EDP admin group holds every staff function in the MVP (#226, ADR-0008's
 * 2026-10-18 amendment). Everyone here signs in through the real session
 * resolver over a stubbed SCIM `/Me`, with the reserved per-role group vars
 * pointed at other groups, so the group-to-role mapping is inside every test.
 * Each staff surface then lets an admin group member act, and refuses a
 * non-member the way it does today.
 *
 * Each decision is on its own record: whether one person may take two
 * decisions on one record is #148's to decide, not this slice's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DATASET_ID,
  OWNER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeDatasetSeed,
} from "../../../data/__tests__/dataset-fixture";
import { createDeltaHarness } from "../../../data/__tests__/team-backends";
import type { OnboardingIntake, OnboardingRequest } from "../../../data/onboarding";
import { completeIntake } from "../../../data/onboarding/intake.fixtures";
import type { UserProfile } from "../../../data/types";
import {
  resetSessionIdentityCacheForTests,
  resolveSessionIdentity,
  resolveSessionProfile,
  toSessionUser,
} from "../../session";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import type { SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { BOOTSTRAP_YAML, definitionImplementation } from "./eir-definition-harness.ts";
import { deltaImplementation, pdf, VALUES, type DeltaImplementation } from "./eir-harness.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const ADMIN_GROUP = "11111111111111";
/** Groups the reserved per-role vars name. Membership in them grants nothing. */
const RESERVED = { validator: "1101", businessOffice: "1102", ccb: "1103" };

interface SignedIn {
  user: SessionUser;
  profile: UserProfile;
}

const directory = new Map<string, { id: string; displayName: string; groups: string[] }>();

async function signIn(id: string, displayName: string, groups: string[]): Promise<SignedIn> {
  directory.set(`token-${id}`, { id, displayName, groups });
  const request = () =>
    new Request("https://app.example/api/session", {
      headers: { "x-forwarded-access-token": `token-${id}` },
    });
  return {
    user: toSessionUser(await resolveSessionIdentity(request())),
    profile: await resolveSessionProfile(request()),
  };
}

let MEMBER: SignedIn;
let SECOND_MEMBER: SignedIn;
let NON_MEMBER: SignedIn;
let APPLICANT: SignedIn;
let OTHER_APPLICANT: SignedIn;

beforeAll(async () => {
  vi.stubEnv("DATABRICKS_HOST", "https://ws.example.databricks.com");
  vi.stubEnv("EDP_IDENTITY_MODE", "production");
  vi.stubEnv("EDP_IDENTITY_CACHE_TTL_MS", "0");
  vi.stubEnv("EDP_ADMIN_GROUP_ID", ADMIN_GROUP);
  vi.stubEnv("EDP_SAFEGUARDS_VALIDATOR_GROUP_ID", RESERVED.validator);
  vi.stubEnv("EDP_BUSINESS_OFFICE_GROUP_ID", RESERVED.businessOffice);
  vi.stubEnv("EDP_CCB_GROUP_ID", RESERVED.ccb);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    const me = directory.get(token);
    if (!me) return new Response("{}", { status: 401 });
    return new Response(
      JSON.stringify({
        id: me.id,
        userName: `${me.id}@example.gov`,
        displayName: me.displayName,
        emails: [{ value: `${me.id}@example.gov`, primary: true }],
        groups: me.groups.map((value) => ({ value, type: "direct" })),
      }),
      { status: 200 },
    );
  });
  MEMBER = await signIn("3001", "Ada Admin", [ADMIN_GROUP]);
  SECOND_MEMBER = await signIn("3002", "Abe Admin", [ADMIN_GROUP, "2200"]);
  NON_MEMBER = await signIn("7001", "Nell Nonmember", [
    RESERVED.validator,
    RESERVED.businessOffice,
    RESERVED.ccb,
    "2200",
  ]);
  APPLICANT = await signIn("1001", "Test Person", []);
  OTHER_APPLICANT = await signIn("1002", "Sample Applicant", ["2200"]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSessionIdentityCacheForTests();
});

describe("who holds which staff role", () => {
  it("gives an EDP admin group member every staff role, on the session and the API", () => {
    const roles = {
      isAdmin: true,
      isSafeguardsValidator: true,
      onboardingReviewerRoles: ["business-office", "ccb"],
    };
    expect(MEMBER.user).toMatchObject(roles);
    expect(MEMBER.profile).toMatchObject(roles);
  });

  it("gives a non-member none, though they are in every reserved per-role group", () => {
    const none = { isAdmin: false, isSafeguardsValidator: false, onboardingReviewerRoles: [] };
    expect(NON_MEMBER.user).toMatchObject(none);
    expect(NON_MEMBER.profile).toMatchObject(none);
  });
});

// --- onboarding review (both stages) -----------------------------------------

describe("onboarding review", () => {
  let warehouse: SqliteWarehouse;
  let deps: DeltaApiDeps;
  let signedIn: SessionUser;
  let keys = 0;
  const names = createStoreNames("edp_vending", "");

  const intake = (n: number): OnboardingIntake =>
    completeIntake({
      initiativeName: `Initiative ${n}`,
      annualBenefit: 1_000_000 + n,
      datasets: [
        {
          name: `Dataset ${n}`,
          sourceSystem: "IMF / Individual Master File",
          domain: "individual-filing",
          ingestionMethod: "eftu",
          datasetTag: `dataset_${n}`,
          owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
        },
      ],
    });

  async function api(user: SessionUser, method: "GET" | "POST", path: string, body?: unknown) {
    signedIn = user;
    const response = await handleDeltaApiRequest(
      new Request(`https://app.example/api/${path}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      deps,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const decide = (user: SessionUser, request: OnboardingRequest) =>
    api(user, "POST", "commands/onboarding/decide", {
      idempotencyKey: `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`,
      expectedVersion: request.version,
      payload: { requestId: request.id, decision: { type: "approve" } },
    });

  async function submit(n: number): Promise<OnboardingRequest> {
    const res = await api(APPLICANT.user, "POST", "commands/onboarding/submit", {
      idempotencyKey: `00000000-0000-4000-9000-${String(++keys).padStart(12, "0")}`,
      expectedVersion: 0,
      payload: { intake: intake(n) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body["result"] as OnboardingRequest;
  }

  beforeEach(() => {
    warehouse = createSqliteWarehouse({
      files: ["store-admin.sql", "store-teams.sql", "store-onboarding.sql"],
    });
    deps = {
      registry: createAppRegistry(),
      runner: createTransactionRunner({ client: warehouse.client, names, sleep: async () => {} }),
      names,
      serves: ["tenant", "staff"],
      resolveUser: async () => signedIn,
      requirePrivacyAcknowledgment: async () => undefined,
    };
  });

  it("lets a member read the business & ROI inbox and approve a request there", async () => {
    const requestA = await submit(1);
    expect(requestA.stage).toBe("business-roi-review");

    const inbox = await api(MEMBER.user, "GET", "reads/onboarding/inbox?role=business-office");
    expect(inbox.status).toBe(200);
    expect((inbox.body as unknown as OnboardingRequest[]).map((r) => r.id)).toEqual([requestA.id]);

    const approved = await decide(MEMBER.user, requestA);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body["result"] as OnboardingRequest).stage).toBe("ccb");
  });

  it("lets a member read the CCB inbox and approve a request someone else advanced", async () => {
    const requestB = await submit(2);
    const advanced = await decide(SECOND_MEMBER.user, requestB);
    expect(advanced.status).toBe(200);
    const atCcb = advanced.body["result"] as OnboardingRequest;

    const inbox = await api(MEMBER.user, "GET", "reads/onboarding/inbox?role=ccb");
    expect(inbox.status).toBe(200);
    expect((inbox.body as unknown as OnboardingRequest[]).map((r) => r.id)).toEqual([requestB.id]);

    const approved = await decide(MEMBER.user, atCcb);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((approved.body["result"] as OnboardingRequest).stage).not.toBe("ccb");
  });

  it("refuses a non-member each inbox (forbidden) and the decision (not-found)", async () => {
    const request = await submit(3);
    const before = warehouse.statements.length;
    for (const role of ["business-office", "ccb"]) {
      const inbox = await api(NON_MEMBER.user, "GET", `reads/onboarding/inbox?role=${role}`);
      expect(inbox.status, role).toBe(403);
      expect(inbox.body["error"], role).toMatchObject({
        message: "Nell Nonmember is not a direct member of the EDP admin group.",
      });
    }
    const wrongRole = await api(
      { ...NON_MEMBER.user, onboardingReviewerRoles: ["business-office"] },
      "GET",
      "reads/onboarding/inbox?role=ccb",
    );
    expect(wrongRole.body["error"]).toMatchObject({
      message: "Nell Nonmember is not a direct member of the EDP admin group.",
    });
    const decided = await decide(NON_MEMBER.user, request);
    expect(decided.status).toBe(404);
    expect(decided.body["error"]).toMatchObject({ code: "not-found" });
    expect(warehouse.statements.slice(before)).toEqual([]);
  });
});

// --- EIR validation ----------------------------------------------------------

describe("EIR validation", () => {
  const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";
  const post = (path: string, body: unknown) =>
    new Request(`https://app${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (path: string) => new Request(`https://app${path}`);

  async function submitted(impl: DeltaImplementation, user: SessionUser) {
    await impl.as(user).saveDraft(user.principalId, VALUES);
    await impl.as(user).evaluateDraft(user.principalId);
    return impl.as(user).submitWithFile({
      principalId: user.principalId,
      personName: user.displayName,
      file: pdf(),
      values: VALUES,
    });
  }

  it("lets a member read the inbox and the record, and validate someone else's EIR", async () => {
    const impl = deltaImplementation();
    await submitted(impl, APPLICANT.user);
    const member = impl.as(MEMBER.user);

    expect((await member.listValidatorInbox()).map((item) => item.principalId)).toEqual([
      APPLICANT.user.principalId,
    ]);
    expect((await member.get(APPLICANT.user.principalId)).stage).toBe("submitted");
    const decided = await member.decide(
      APPLICANT.user.principalId,
      "valid",
      MEMBER.user.principalId,
      undefined,
      MEMBER.user.displayName,
    );
    expect(decided.stage).toBe("valid");
  });

  it("lets a member revoke a valid EIR someone else validated", async () => {
    const impl = deltaImplementation();
    await submitted(impl, OTHER_APPLICANT.user);
    await impl
      .as(SECOND_MEMBER.user)
      .decide(
        OTHER_APPLICANT.user.principalId,
        "valid",
        SECOND_MEMBER.user.principalId,
        undefined,
        SECOND_MEMBER.user.displayName,
      );

    const revoked = await impl
      .as(MEMBER.user)
      .decide(
        OTHER_APPLICANT.user.principalId,
        "revoked",
        MEMBER.user.principalId,
        "Left the team",
        MEMBER.user.displayName,
      );
    expect(revoked.stage).toBe("revoked");
  });

  it("still refuses a member deciding their own EIR", async () => {
    const impl = deltaImplementation();
    await submitted(impl, MEMBER.user);
    const response = await impl.request(
      MEMBER.user,
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: MEMBER.user.principalId, decision: "valid" },
      }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("own-eir");
  });

  it("refuses a non-member the inbox, the record and the decision, before any SQL", async () => {
    const impl = deltaImplementation();
    const requests = [
      get("/api/reads/eir/inbox"),
      get(`/api/reads/eir/record?principalId=${APPLICANT.user.principalId}`),
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: APPLICANT.user.principalId, decision: "valid" },
      }),
    ];
    for (const request of requests) {
      const response = await impl.request(NON_MEMBER.user, request);
      expect(response.status, request.url).toBe(403);
    }
    expect(impl.warehouse.statements).toHaveLength(0);
  });
});

// --- EIR definitions, and the definition check -------------------------------

describe("EIR definitions", () => {
  it("lets a member check, publish, activate and read a definition", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(MEMBER.user);
    expect(await repo.check(BOOTSTRAP_YAML)).toMatchObject({ ok: true, publishable: true });
    await repo.publish({ sourceYaml: BOOTSTRAP_YAML, expectedVersion: 0 });
    await repo.activate({ versionNumber: 1, expectedVersion: 1 });
    expect((await repo.history()).active).toEqual({ source: "published", versionNumber: 1 });
  });

  it("refuses a non-member the check, publishing, activating and reading", async () => {
    const impl = definitionImplementation();
    const repo = impl.as(NON_MEMBER.user);
    await expect(repo.check(BOOTSTRAP_YAML)).rejects.toMatchObject({ status: 403 });
    await expect(
      repo.publish({ sourceYaml: BOOTSTRAP_YAML, expectedVersion: 0 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(repo.activate({ versionNumber: 1, expectedVersion: 0 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(repo.history()).rejects.toMatchObject({ status: 403 });
  });
});

// --- change list and owner reassignment --------------------------------------

describe("change list and owner reassignment", () => {
  const TESS = { datasetId: DATASET_ID, name: "Tess Tester", email: "tess.tester@example.gov" };

  function sessions() {
    const common = {
      datasetSeed: makeDatasetSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    };
    const owner = createDeltaHarness({ ...common, currentUser: async () => OWNER });
    const as = (who: SignedIn) =>
      createDeltaHarness({
        ...common,
        currentUser: async () => who.profile,
        warehouse: owner.warehouse,
      }).store;
    return { owner: owner.store, as };
  }

  it("lets a member list entries, mark one applied, and reassign an owner", async () => {
    const { owner, as } = sessions();
    const { entries } = await owner.datasetRoles.addMember({ ...TESS, role: "tester" });
    const member = as(MEMBER);

    expect((await member.changeList.listEntries()).map((entry) => entry.id)).toEqual([
      entries[0]!.id,
    ]);
    const applied = await member.changeList.markApplied(entries[0]!.id);
    expect(applied.id).toBe(entries[0]!.id);

    const reassigned = await member.datasetTeam.addOwner({
      datasetId: DATASET_ID,
      name: "Nora New",
      email: "nora.new@example.gov",
    });
    expect(reassigned.dataset.owners.map((o) => o.email)).toContain("nora.new@example.gov");
  });

  it("refuses a non-member marking applied and reassigning an owner, and lists them nothing", async () => {
    const { owner, as } = sessions();
    const { entries } = await owner.datasetRoles.addMember({ ...TESS, role: "tester" });
    const outsider = as(NON_MEMBER);

    expect(await outsider.changeList.listEntries()).toEqual([]);
    await expect(outsider.changeList.markApplied(entries[0]!.id)).rejects.toMatchObject({
      code: "not-edp-staff",
    });
    await expect(
      outsider.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: "Nora New",
        email: "nora.new@example.gov",
      }),
    ).rejects.toMatchObject({ code: "not-owner" });
  });
});

// --- the requireEdpStaff surfaces --------------------------------------------

describe("EDP staff endpoints (requireEdpStaff)", () => {
  let warehouse: SqliteWarehouse;
  let deps: DeltaApiDeps;
  let signedIn: SessionUser;
  const names = createStoreNames("edp_vending", "");

  beforeEach(() => {
    warehouse = createSqliteWarehouse({
      files: ["store-schema.sql", "store-admin.sql", "store-audit.sql", "store-privacy.sql"],
    });
    deps = {
      registry: createAppRegistry(),
      runner: createTransactionRunner({ client: warehouse.client, names, sleep: async () => {} }),
      names,
      serves: ["tenant", "staff"],
      resolveUser: async () => signedIn,
      requirePrivacyAcknowledgment: async () => undefined,
    };
  });

  const READS = [
    "reads/admin/write-checks",
    "reads/admin/tenants",
    "reads/requests/pipeline",
    "reads/privacy/audit",
  ];

  const read = async (user: SessionUser, path: string) => {
    signedIn = user;
    return handleDeltaApiRequest(new Request(`https://app.example/api/${path}`), deps);
  };
  const recordWriteCheck = async (user: SessionUser) => {
    signedIn = user;
    return handleDeltaApiRequest(
      new Request("https://app.example/api/commands/admin/record-write-check", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
          expectedVersion: 0,
          payload: { name: "smoke" },
        }),
      }),
      deps,
    );
  };

  const transition = async (user: SessionUser) => {
    signedIn = user;
    return handleDeltaApiRequest(
      new Request("https://app.example/api/legacy-writes/requests/transition-request", {
        method: "POST",
        body: JSON.stringify({
          payload: {
            id: "REQ-1001",
            status: "provisioning",
            overall: "in-progress",
            stageIndex: 2,
            subRequests: [],
          },
        }),
      }),
      deps,
    );
  };

  it.each(READS)("serves a member %s", async (path) => {
    const response = await read(MEMBER.user, path);
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("lets a member record a write check", async () => {
    const response = await recordWriteCheck(MEMBER.user);
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it("lets a member past the request-transition staff check (the request doesn't exist)", async () => {
    const response = await transition(MEMBER.user);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not-found");
  });

  it("refuses a non-member every staff read, the write check and a request transition, before any SQL", async () => {
    for (const path of READS) {
      expect((await read(NON_MEMBER.user, path)).status, path).toBe(403);
    }
    expect((await recordWriteCheck(NON_MEMBER.user)).status).toBe(403);
    expect((await transition(NON_MEMBER.user)).status).toBe(403);
    expect(warehouse.statements).toEqual([]);
  });
});

afterAll(() => {
  directory.clear();
});
