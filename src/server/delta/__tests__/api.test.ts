/**
 * The command and read API: routing, the strict command envelope, the actor
 * from the session, authorization, error mapping, and that no endpoint takes SQL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { IdentityResolutionError } from "../../identity";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import {
  deltaApiFromEnv,
  handleDeltaApi,
  readSurfaces,
  requireConfiguredPrivacyAcknowledgment,
} from "../config.ts";
import { CONFLICT_MESSAGE, GUARD_STATE, StatementAbandonedError } from "../errors.ts";
import { createRegistry, type SessionUser } from "../registry.ts";
import { createDeltaSnapshotCache } from "../snapshot-cache.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import {
  committed,
  deltaConflict,
  fakeSqlClient,
  insertedValue,
  signalled,
  type Responder,
} from "./fake-sql-client.ts";
import { createSqliteWarehouse } from "./sqlite-warehouse.ts";
import {
  GOVCLOUD_CASES,
  govCloudSessionUser,
  leaksIdentifier,
} from "../../__tests__/govcloud-identity.ts";

const STAFF: SessionUser = {
  principalId: "4055694201057157",
  displayName: "Sam Staff",
  email: "sam.staff@example.gov",
  isAdmin: true,
  onboardingReviewerRoles: [],
};
const TENANT: SessionUser = {
  ...STAFF,
  principalId: "7001",
  displayName: "Tia Tenant",
  isAdmin: false,
};
const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";
/** ds1's tester in the parity warehouse: no owner, no staff. */
const TEAM_TESTER: SessionUser = {
  ...TENANT,
  principalId: "9003",
  displayName: "Tess Tester",
  email: "tess@example.test",
};
/** Owns ds2, not ds1. */
const OTHER_OWNER: SessionUser = {
  ...TENANT,
  principalId: "8002",
  displayName: "Other Tenant",
  email: "other@example.test",
};
const TEAM_STRANGER: SessionUser = {
  ...TENANT,
  principalId: "9999",
  displayName: "Stranger",
  email: "stranger@example.test",
};
/** ds1's developer, matched by SCIM id: their session email isn't the one on record. */
const TEAM_SCIM_MEMBER: SessionUser = {
  ...TENANT,
  principalId: "9004",
  displayName: "Dev One",
  email: "dev.one@new.example.test",
};
/** Everyone whose team reads #257 scopes: ds1's owner, EDP staff and four others. */
const TEAM_READERS = [TENANT, STAFF, TEAM_TESTER, TEAM_SCIM_MEMBER, OTHER_OWNER, TEAM_STRANGER];

const VALIDATOR: SessionUser = {
  ...STAFF,
  principalId: "2001",
  displayName: "Val Idator",
  isSafeguardsValidator: true,
};

function deps(
  responder: Responder,
  user: SessionUser | null = STAFF,
  serves: DeltaApiDeps["serves"] = ["tenant", "staff"],
  extra: Partial<DeltaApiDeps> = {},
) {
  const fake = fakeSqlClient(responder);
  const names = createStoreNames("edp_vending", "edp_vm_pr1_");
  const value: DeltaApiDeps = {
    registry: extra.registry ?? createAppRegistry(),
    runner: createTransactionRunner({
      client: fake.client,
      names,
      sleep: async () => undefined,
      random: () => 0,
    }),
    names,
    serves,
    requirePrivacyAcknowledgment: async () => undefined,
    resolveUser: async () => {
      if (!user) throw new IdentityResolutionError("No Databricks App forwarded identity.", 401);
      return user;
    },
    ...extra,
  };
  return { deps: value, fake };
}

const WRITE_CHECK_ROW = {
  id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
  display_number: 1001,
  label: "smoke",
  stage: "recorded",
  version: 1,
  created_at: "2026-10-05T12:00:00.000Z",
  created_by_principal_id: STAFF.principalId,
  updated_at: "2026-10-05T12:00:00.000Z",
  last_action_id: "a",
};

const TEAM_DATASET_ROW = {
  id: "ds1",
  initiative_id: "ini1",
  name: "Dataset One",
  domain_tag: "domain",
  dataset_tag: "dataset-one",
  version: 1,
  initiative_stage: "active",
};
const TEAM_OWNER_ROW = {
  id: "owner1",
  dataset_id: "ds1",
  source: "seed",
  person_display: TENANT.displayName,
  person_email: TENANT.email,
  person_principal_id: TENANT.principalId,
  bound_at: null,
  version: 1,
  created_at: "2026-10-05T12:00:00.000Z",
  created_by_principal_id: "system",
  updated_at: "2026-10-05T12:00:00.000Z",
  updated_by_principal_id: "system",
  last_action_id: "owner-action",
};
const TEAM_MEMBER_ROW = {
  id: "member1",
  dataset_id: "ds1",
  role: "tester",
  source: "app",
  person_display: "Tess Tester",
  person_email: "tess.tester@example.gov",
  person_principal_id: null,
  version: 1,
  created_at: "2026-10-05T12:00:00.000Z",
  created_by_principal_id: TENANT.principalId,
  updated_at: "2026-10-05T12:00:00.000Z",
  updated_by_principal_id: TENANT.principalId,
  last_action_id: "member-action",
};

/** The warehouse for a write check: nothing stored yet, every block commits. */
const happy: Responder = (call) => {
  if (call.statement.startsWith("BEGIN ATOMIC")) return committed(call, WRITE_CHECK_ROW);
  if (call.statement.includes("`write_checks` WHERE id = :id")) {
    return { rows: [{ ...WRITE_CHECK_ROW, id: call.parameters["id"] }] };
  }
  return { rows: [] };
};

const post = (path: string, body: unknown) =>
  new Request(`https://app.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string) => new Request(`https://app.example${path}`);
const isMarkerCheck = (statement: string) =>
  statement.includes(" AS area, concat_ws('|',") && statement.includes(" AS version");
const markerRows = (versions: Record<string, string | number>) => ({
  rows: Object.entries(versions).map(([area, version]) => ({ area, version: String(version) })),
});
const allMarkerRows = () =>
  markerRows({
    access: 1,
    admin: 1,
    audit: 1,
    catalog: 1,
    "change-list": 1,
    eir: 1,
    initiatives: 1,
    onboarding: 1,
    requests: 1,
    teams: 1,
  });

describe("Delta API: no SQL endpoint, only registered handlers", () => {
  it("does not apply the EIR privacy guard to the existing onboarding/mine route", async () => {
    const { deps: d } = deps(happy, TENANT);
    d.requirePrivacyAcknowledgment = async () => {
      throw new Error("EIR-only privacy guard was called");
    };

    const response = await handleDeltaApiRequest(get("/api/reads/onboarding/mine"), d);

    expect(response.status).toBe(200);
  });
  it.each([
    ["/api/data/sql"],
    ["/api/commands/sql/execute"],
    ["/api/reads/sql/query"],
    ["/api/commands/admin"],
    ["/api/reads/admin/write-checks/extra"],
  ])("answers %s with 404 and runs no SQL", async (path) => {
    const { deps: d, fake } = deps(happy);
    const response = await handleDeltaApiRequest(
      post(path, { statement: "SELECT 1", parameters: {} }),
      d,
    );
    expect(response.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses the wrong method", async () => {
    const { deps: d } = deps(happy);
    expect(
      (await handleDeltaApiRequest(get("/api/commands/admin/record-write-check"), d)).status,
    ).toBe(405);
    expect((await handleDeltaApiRequest(post("/api/reads/admin/write-checks", {}), d)).status).toBe(
      405,
    );
  });

  it("mounts only the surfaces this app serves (an ADR-0008 split is configuration)", async () => {
    const { deps: d, fake } = deps(happy, STAFF, ["tenant"]);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "x" },
      }),
      d,
    );
    expect(response.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
    expect(readSurfaces("staff")).toEqual(["staff"]);
    expect(readSurfaces(undefined)).toEqual(["tenant", "staff"]);
  });
});

describe("Delta API: commands", () => {
  it("runs a command and returns the new state, with the actor from the session", async () => {
    const { deps: d, fake } = deps(happy);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "smoke" },
      }),
      d,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      replayed: false,
      recordVersion: 1,
      result: { name: "smoke", stage: "recorded" },
    });
    const block = fake.blocks()[0]!;
    expect(block.statement).toContain("`edp_vending`.`edp_vm_pr1_admin`.`write_check_actions`");
    expect(insertedValue(block, "write_check_actions", "actor_principal_id")).toBe(
      STAFF.principalId,
    );
    expect(insertedValue(block, "write_check_actions", "actor_app")).toBe("staff");
  });

  it.each(GOVCLOUD_CASES)(
    "records a GovCloud no-name actor as %s, never the numeric X-Forwarded-User",
    async (_label, govCloud, expected) => {
      const user = { ...(await govCloudSessionUser(govCloud)), isAdmin: true };
      const { deps: d, fake } = deps(happy, user);
      const response = await handleDeltaApiRequest(
        post("/api/commands/admin/record-write-check", {
          idempotencyKey: KEY,
          expectedVersion: 0,
          payload: { name: "smoke" },
        }),
        d,
      );
      expect(response.status).toBe(200);
      const actorDisplay = insertedValue(fake.blocks()[0]!, "write_check_actions", "actor_display");
      expect(actorDisplay).toBe(expected);
      expect(leaksIdentifier(actorDisplay)).toBe(false);
    },
  );

  it.each([
    [
      "names the actor in the envelope",
      { idempotencyKey: KEY, expectedVersion: 0, payload: { name: "x" }, actorPrincipalId: "1" },
    ],
    [
      "names the actor in the payload",
      { idempotencyKey: KEY, expectedVersion: 0, payload: { name: "x", actor_principal_id: "1" } },
    ],
    ["has no idempotency key", { expectedVersion: 0, payload: { name: "x" } }],
    [
      "has a key that isn't a UUID",
      { idempotencyKey: "abc", expectedVersion: 0, payload: { name: "x" } },
    ],
    [
      "has a negative version",
      { idempotencyKey: KEY, expectedVersion: -1, payload: { name: "x" } },
    ],
    [
      "sends SQL",
      {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "x" },
        statement: "DROP TABLE x",
      },
    ],
  ])("refuses a body that %s, before any SQL", async (_label, body) => {
    const { deps: d, fake } = deps(happy);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", body),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-request");
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps the onboarding submit validation error contract stable", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(
      post("/api/commands/onboarding/submit", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {},
      }),
      d,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid-request",
        message: "The request doesn't match what this endpoint accepts.",
        issues: [{ path: "intake", message: "Required" }],
      },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [
      "a numeric idempotency key",
      { idempotencyKey: 42, expectedVersion: 0, payload: { name: "x" } },
      { path: "idempotencyKey", message: "Expected string, received number" },
    ],
    [
      "a string expected version",
      { idempotencyKey: KEY, expectedVersion: "0", payload: { name: "x" } },
      { path: "expectedVersion", message: "Expected number, received string" },
    ],
    [
      "a fractional expected version",
      { idempotencyKey: KEY, expectedVersion: 1.5, payload: { name: "x" } },
      { path: "expectedVersion", message: "Expected integer, received float" },
    ],
    [
      "a numeric command payload",
      { idempotencyKey: KEY, expectedVersion: 0, payload: 42 },
      { path: "", message: "Expected object, received number" },
    ],
    [
      "a null command payload",
      { idempotencyKey: KEY, expectedVersion: 0, payload: null },
      { path: "", message: "Expected object, received null" },
    ],
    [
      "a negative expected version",
      { idempotencyKey: KEY, expectedVersion: -1, payload: { name: "x" } },
      { path: "expectedVersion", message: "Number must be greater than or equal to 0" },
    ],
    [
      "an empty write-check name",
      { idempotencyKey: KEY, expectedVersion: 0, payload: { name: "" } },
      { path: "name", message: "String must contain at least 1 character(s)" },
    ],
    [
      "an overlong write-check name",
      { idempotencyKey: KEY, expectedVersion: 0, payload: { name: "x".repeat(121) } },
      { path: "name", message: "String must contain at most 120 character(s)" },
    ],
    [
      "a missing payload",
      { idempotencyKey: KEY, expectedVersion: 0 },
      { path: "", message: "Required" },
    ],
    [
      "an unknown envelope key",
      { idempotencyKey: KEY, expectedVersion: 0, payload: { name: "x" }, version: 1 },
      { path: "", message: "Unrecognized key(s) in object: 'version'" },
    ],
    [
      "a malformed UUID",
      { idempotencyKey: "not-a-uuid", expectedVersion: 0, payload: { name: "x" } },
      { path: "idempotencyKey", message: "Invalid uuid" },
    ],
  ] as const)("keeps Zod 3's exact refusal for %s", async (_label, body, issue) => {
    const { deps: d, fake } = deps(happy);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", body),
      d,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid-request",
        message: "The request doesn't match what this endpoint accepts.",
        issues: [issue],
      },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts the non-RFC UUIDs that Zod 3 accepted", async () => {
    const { deps: d } = deps(happy);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: "00000000-0000-0000-0000-000000000001",
        expectedVersion: 0,
        payload: { name: "legacy id" },
      }),
      d,
    );

    expect(response.status).toBe(200);
  });

  it("keeps enum and 4000-character maximum messages at command payload seams", async () => {
    const { deps: d, fake } = deps(happy, VALIDATOR);
    const invalidEnum = await handleDeltaApiRequest(
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: "123", decision: "nickname" },
      }),
      d,
    );
    expect((await invalidEnum.json()).error.issues).toEqual([
      {
        path: "decision",
        message:
          "Invalid enum value. Expected 'valid' | 'questions' | 'rejected' | 'revoked', received 'nickname'",
      },
    ]);

    const wrongEnumType = await handleDeltaApiRequest(
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: "123", decision: 7 },
      }),
      d,
    );
    expect((await wrongEnumType.json()).error.issues).toEqual([
      {
        path: "decision",
        message: "Expected 'valid' | 'questions' | 'rejected' | 'revoked', received number",
      },
    ]);

    const overlong = await handleDeltaApiRequest(
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: "123", decision: "valid", note: "x".repeat(4001) },
      }),
      d,
    );
    expect((await overlong.json()).error.issues).toEqual([
      { path: "note", message: "String must contain at most 4000 character(s)" },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps Zod 3's record wording for an onboarding intake answers array", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(
      post("/api/commands/onboarding/submit", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {
          intake: {
            initiativeName: "Initiative",
            businessCase: "Case",
            annualBenefit: 1,
            levers: [],
            datasets: [],
            workspaceNeeds: { isolation: "shared", teamSize: 1 },
            answers: [],
          },
        },
      }),
      d,
    );
    expect((await response.json()).error.issues).toContainEqual({
      path: "intake.answers",
      message: "Expected object, received array",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps Zod 3's exact literal refusals in onboarding payloads", async () => {
    const { deps: tenantDeps, fake: tenantSql } = deps(happy, TENANT);
    const owner = await handleDeltaApiRequest(
      post("/api/commands/onboarding/submit", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {
          intake: {
            initiativeName: "Initiative",
            businessCase: "Case",
            annualBenefit: 1,
            levers: [],
            datasets: [
              {
                name: "Dataset",
                domain: "domain",
                datasetTag: "dataset",
                owners: [{ self: false, name: "Owner", email: "owner@example.gov" }],
              },
            ],
            workspaceNeeds: { isolation: "shared", teamSize: 1 },
            answers: {},
          },
        },
      }),
      tenantDeps,
    );
    expect((await owner.json()).error.issues).toContainEqual({
      path: "intake.datasets.0.owners.0.self",
      message: "Invalid literal value, expected true",
    });
    expect(tenantSql.calls).toHaveLength(0);

    const reviewer = { ...STAFF, onboardingReviewerRoles: ["business-office" as const] };
    const { deps: reviewerDeps, fake: reviewerSql } = deps(happy, reviewer);
    const sendBack = await handleDeltaApiRequest(
      post("/api/commands/onboarding/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: {
          requestId: "ONB-1",
          decision: { type: "send-back", to: "draft", note: "Clarify" },
        },
      }),
      reviewerDeps,
    );
    expect((await sendBack.json()).error.issues).toEqual([
      { path: "decision.to", message: 'Invalid literal value, expected "submitted"' },
    ]);
    expect(reviewerSql.calls).toHaveLength(0);
  });

  it("keeps Zod 3's NaN query refusal", async () => {
    const registry = createAppRegistry(undefined, { catalog: "catalog", schema: "membership" });
    const { deps: d, fake } = deps(happy, TENANT, ["tenant", "staff"], { registry });
    const response = await handleDeltaApiRequest(get("/api/reads/membership/history?limit=abc"), d);
    expect(response.status).toBe(400);
    expect((await response.json()).error.issues).toEqual([
      { path: "limit", message: "Expected number, received nan" },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps Zod 3's exact membership-query literal refusal", async () => {
    const registry = createAppRegistry(undefined, { catalog: "catalog", schema: "membership" });
    const { deps: d, fake } = deps(happy, TENANT, ["tenant", "staff"], { registry });
    const response = await handleDeltaApiRequest(
      get("/api/reads/membership/memberships?includeRemoved=false"),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.issues).toEqual([
      { path: "includeRemoved", message: 'Invalid literal value, expected "true"' },
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts a non-RFC UUID in a nested admin command payload", async () => {
    const { deps: d } = deps(happy);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/confirm-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { writeCheckId: "00000000-0000-0000-0000-000000000001" },
      }),
      d,
    );
    expect(response.status).not.toBe(400);
  });

  it("keeps a missing legacy payload at the payload schema's root", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(
      post("/api/legacy-writes/requests/append-waiver-attestation", {}),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.issues).toEqual([{ path: "", message: "Required" }]);
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps wrong legacy payload types when rejected input reporting is enabled", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(
      post("/api/legacy-writes/requests/append-waiver-attestation", {
        payload: {
          id: "ATT-1",
          requestId: "REQ-1",
          checklistItemId: "ldw",
          attested: true,
          attestedAt: 5,
          source: "app",
          createdAt: "2026-10-05T12:00:00Z",
        },
      }),
      d,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.issues).toContainEqual({
      path: "attestedAt",
      message: "Expected string, received number",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts a non-RFC UUID in the change-list mark-applied payload", async () => {
    const { deps: d } = deps(happy, STAFF);
    const response = await handleDeltaApiRequest(
      post("/api/commands/change-list/mark-applied", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { entryId: "00000000-0000-0000-0000-000000000001" },
      }),
      d,
    );
    expect(response.status).not.toBe(400);
  });

  it("refuses a body that isn't JSON", async () => {
    const { deps: d } = deps(happy);
    expect(
      (await handleDeltaApiRequest(post("/api/commands/admin/record-write-check", "{nope"), d))
        .status,
    ).toBe(400);
  });

  it("refuses someone outside EDP staff with 403, before any SQL", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "x" },
      }),
      d,
    );
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses with 401 when nobody is signed in", async () => {
    const { deps: d, fake } = deps(happy, null);
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "x" },
      }),
      d,
    );
    expect(response.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("maps a version conflict to 409 with the reload message", async () => {
    const { deps: d } = deps((call) => {
      if (call.statement.startsWith("BEGIN ATOMIC"))
        throw signalled(GUARD_STATE.versionConflict, "edp:version-conflict");
      return happy(call, 0);
    });
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/confirm-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { writeCheckId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a" },
      }),
      d,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "version-conflict", message: CONFLICT_MESSAGE },
    });
  });

  it("maps exhausted retries to 503 with the reload message and the attempt count", async () => {
    const { deps: d } = deps((call) => {
      if (call.statement.startsWith("BEGIN ATOMIC")) throw deltaConflict();
      return happy(call, 0);
    });
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "x" },
      }),
      d,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "busy", message: CONFLICT_MESSAGE, attempts: 10 },
    });
  });

  it("hides unexpected errors behind a generic 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps: d } = deps(() => {
      throw new Error("secret internals");
    });
    const response = await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "x" },
      }),
      d,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret internals");
    vi.restoreAllMocks();
  });
});

describe("Delta API: reads", () => {
  it.each([
    "/api/reads/admin/write-checks?id=00000000-0000-0000-0000-000000000001",
    "/api/reads/audit/record-history?recordId=00000000-0000-0000-0000-000000000001",
  ])("accepts a non-RFC UUID query at %s", async (path) => {
    const { deps: d } = deps(happy, STAFF);
    const response = await handleDeltaApiRequest(get(path), d);
    expect(response.status).not.toBe(400);
  });

  it("serves a warm repeat read from the per-instance full snapshot", async () => {
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    const { deps: d, fake } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) return markerRows({ admin: 1 });
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [WRITE_CHECK_ROW] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000001" }), d.names);

    expect((await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).status).toBe(200);
    expect((await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).status).toBe(200);

    expect(fake.calls.filter((call) => call.statement.includes("`write_checks`"))).toHaveLength(1);
  });

  it("runs dataset-member summary fallback reads concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const delayed = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { rows: [] };
    };
    const { deps: d, fake } = deps((call) => {
      if (call.statement.startsWith("SELECT")) return delayed();
      return { rows: [] };
    }, TENANT);

    const response = await handleDeltaApiRequest(
      get("/api/reads/initiatives/dataset-member-summaries"),
      d,
    );

    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(5);
    expect(maxActive).toBe(5);
  });

  it("runs team command pre-block snapshot reads concurrently before the atomic write", async () => {
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const delayed = async (label: string, rows: Record<string, unknown>[]) => {
      starts.push(label);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { rows };
    };
    const { deps: d } = deps(
      (call) => {
        const sql = call.statement;
        if (sql.includes("WHERE idempotency_key = :key")) return { rows: [] };
        if (sql.startsWith("BEGIN ATOMIC")) {
          starts.push("block");
          return committed(call, {
            member: JSON.stringify({ ...TEAM_MEMBER_ROW, id: "new-member", role: "developer" }),
            entries: "[]",
            from_role: null,
            to_role: null,
          });
        }
        if (sql.includes("FROM `edp_vending`.`edp_vm_pr1_initiatives`.`datasets` d")) {
          return delayed("dataset", [TEAM_DATASET_ROW]);
        }
        if (sql.includes("FROM `edp_vending`.`edp_vm_pr1_teams`.`dataset_owners` o")) {
          return delayed("owners", [TEAM_OWNER_ROW]);
        }
        if (sql.includes("FROM `edp_vending`.`edp_vm_pr1_teams`.`dataset_members` m")) {
          return delayed("members", []);
        }
        if (sql.includes("FROM `edp_vending`.`edp_vm_pr1_change_list`.`change_list_entries` e")) {
          return delayed("entries", []);
        }
        if (sql.includes("FROM `edp_vending`.`edp_vm_pr1_teams`.`email_bindings`")) {
          starts.push("bindings");
          return {
            rows: [
              {
                id: "binding1",
                email: TENANT.email,
                principal_id: TENANT.principalId,
                created_at: "2026-10-05T12:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
      TENANT,
      ["tenant"],
    );

    const response = await handleDeltaApiRequest(
      post("/api/commands/teams/add-member", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: {
          datasetId: "ds1",
          name: "Dev Example",
          email: "dev.example@example.gov",
          role: "developer",
        },
      }),
      d,
    );

    expect(response.status).toBe(200);
    expect(maxActive).toBe(4);
    expect(starts.slice(0, 4).sort()).toEqual(["dataset", "entries", "members", "owners"]);
    expect(starts.indexOf("bindings")).toBeGreaterThan(3);
    expect(starts.indexOf("block")).toBeGreaterThan(starts.indexOf("bindings"));
  });

  it("applies per-principal scoping in server code against the snapshot", async () => {
    let user = TENANT;
    const cache = createDeltaSnapshotCache({
      tables: [
        { area: "access", schema: "access", table: "my_access" },
        { area: "access", schema: "access", table: "my_access_bundles" },
        { area: "access", schema: "access", table: "my_access_workspaces" },
      ],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    const { deps: d, fake } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) return markerRows({ access: 1 });
        if (call.statement.includes("my_access_workspaces"))
          return {
            rows: [
              { principal_id: "7001", name: "Dev", entitlement: "base", since: "2026-01-01" },
              { principal_id: "8002", name: "Prod", entitlement: "base", since: "2026-02-01" },
            ],
          };
        return { rows: [] };
      },
      TENANT,
      ["tenant"],
      {
        snapshotCache: cache,
        resolveUser: async () => user,
      },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000002" }), d.names);

    expect(
      await (await handleDeltaApiRequest(get("/api/reads/access/my-access"), d)).json(),
    ).toMatchObject({
      workspaces: [{ name: "Dev" }],
    });
    user = { ...TENANT, principalId: "8002", displayName: "Tess Tenant" };
    expect(
      await (await handleDeltaApiRequest(get("/api/reads/access/my-access"), d)).json(),
    ).toMatchObject({
      workspaces: [{ name: "Prod" }],
    });
    expect(fake.calls.filter((call) => call.statement.includes("WHERE principal_id"))).toHaveLength(
      0,
    );
  });

  it("still applies the staff gate on every request before consulting cached staff data", async () => {
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    let user: SessionUser = STAFF;
    const { deps: d, fake } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) return markerRows({ admin: 1 });
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [WRITE_CHECK_ROW] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache, resolveUser: async () => user },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000003" }), d.names);

    expect((await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).status).toBe(200);
    user = TENANT;
    const refused = await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);

    expect(refused.status).toBe(403);
    expect(fake.calls.filter((call) => call.statement.includes("`write_checks`"))).toHaveLength(1);
  });

  it("falls back to Delta instead of serving a cache entry beyond its max age after version polling fails", async () => {
    let now = 0;
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 60_000,
      maxStaleMs: 100,
      now: () => now,
    });
    let versionPolls = 0;
    const { deps: d, fake } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) {
          versionPolls += 1;
          if (versionPolls > 1) throw new Error("warehouse asleep");
          return markerRows({ admin: 1 });
        }
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [WRITE_CHECK_ROW] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000004" }), d.names);

    expect((await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).status).toBe(200);
    now = 60_001;
    expect((await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).status).toBe(200);

    expect(fake.calls.filter((call) => call.statement.includes("`write_checks`"))).toHaveLength(2);
  });

  it("reloads an area when its marker changes on another instance", async () => {
    let now = 0;
    let version = 1;
    let label = "before";
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 100,
      maxStaleMs: 60_000,
      now: () => now,
    });
    const { deps: d } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) return markerRows({ admin: version });
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [{ ...WRITE_CHECK_ROW, label }] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000006" }), d.names);

    expect(
      await (await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).json(),
    ).toMatchObject([{ name: "before" }]);
    version = 2;
    label = "after";
    now = 101;
    expect(
      await (await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).json(),
    ).toMatchObject([{ name: "before" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      await (await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).json(),
    ).toMatchObject([{ name: "after" }]);
  });

  it("serves the snapshot immediately while a stale marker check runs in the background", async () => {
    let now = 0;
    let version = 1;
    let label = "before";
    let releaseMarker!: () => void;
    let markerChecks = 0;
    const blockedMarker = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 100,
      maxStaleMs: 60_000,
      now: () => now,
    });
    const { deps: d } = deps(
      async (call) => {
        if (isMarkerCheck(call.statement)) {
          markerChecks += 1;
          if (markerChecks > 1) await blockedMarker;
          return markerRows({ admin: version });
        }
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [{ ...WRITE_CHECK_ROW, label }] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000009" }), d.names);
    version = 2;
    label = "after";
    now = 101;

    const response = await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);

    expect(await response.json()).toMatchObject([{ name: "before" }]);
    expect(markerChecks).toBe(2);
    releaseMarker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      await (await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d)).json(),
    ).toMatchObject([{ name: "after" }]);
  });

  it("falls back to Delta while the startup snapshot load is still in progress", async () => {
    let releaseLoad!: () => void;
    let loadStarted!: () => void;
    const blockedLoad = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    let writeCheckReads = 0;
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    const { deps: d } = deps(
      async (call) => {
        if (isMarkerCheck(call.statement)) return markerRows({ admin: 1 });
        if (call.statement.includes("`write_checks`")) {
          writeCheckReads += 1;
          if (writeCheckReads === 1) {
            loadStarted();
            await blockedLoad;
            return { rows: [{ ...WRITE_CHECK_ROW, label: "snapshot" }] };
          }
          return { rows: [{ ...WRITE_CHECK_ROW, label: "delta fallback" }] };
        }
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );

    void cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000008" }), d.names);
    await loading;
    const response = await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);

    expect(await response.json()).toMatchObject([{ name: "delta fallback" }]);
    expect(writeCheckReads).toBe(2);
    releaseLoad();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("stops polling while the instance is idle, then checks markers on the next read", async () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 100,
      activeWindowMs: 150,
      maxStaleMs: 60_000,
      now: () => now,
      setTimer: (fn) => {
        timers.push(fn);
        return {};
      },
    });
    let markerChecks = 0;
    const { deps: d } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) {
          markerChecks += 1;
          return markerRows({ admin: markerChecks });
        }
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [WRITE_CHECK_ROW] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000007" }), d.names);
    expect(markerChecks).toBe(1);

    await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);
    now = 100;
    timers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markerChecks).toBe(2);

    now = 251;
    timers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markerChecks).toBe(2);

    now = 300;
    await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);
    expect(markerChecks).toBe(3);
  });

  it("invalidates a caller's cached reads after their own command commits", async () => {
    const cache = createDeltaSnapshotCache({
      tables: [{ area: "admin", schema: "admin", table: "write_checks" }],
      pollIntervalMs: 60_000,
      maxStaleMs: 60_000,
    });
    const { deps: d, fake } = deps(
      (call) => {
        if (isMarkerCheck(call.statement)) return markerRows({ admin: 1 });
        if (call.statement.includes("SELECT * FROM") && call.statement.includes("`write_checks`"))
          return { rows: [WRITE_CHECK_ROW] };
        return happy(call, 0);
      },
      STAFF,
      ["tenant", "staff"],
      { snapshotCache: cache },
    );
    await cache.start(d.runner.reader({ readId: "00000000-0000-4000-8000-000000000005" }), d.names);

    await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);
    await handleDeltaApiRequest(
      post("/api/commands/admin/record-write-check", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "smoke" },
      }),
      d,
    );
    await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);

    expect(
      fake.calls.filter((call) => call.statement.includes("`write_checks`")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps registered snapshot reads in parity with the SQL fallback at the store/read seam", async () => {
    const registry = createAppRegistry();
    const names = createStoreNames("edp_vending");
    const makeWarehouse = () => {
      const warehouse = createSqliteWarehouse({
        files: [
          "store-schema.sql",
          "store-admin.sql",
          "store-teams.sql",
          "store-eir.sql",
          "store-eir-definitions.sql",
          "store-privacy.sql",
          "store-onboarding.sql",
        ],
      });
      warehouse.query(`
        CREATE TABLE "audit__actions" (
          area TEXT,
          record_type TEXT,
          record_id TEXT,
          action_id TEXT,
          action TEXT,
          changed TEXT,
          from_value TEXT,
          to_value TEXT,
          record_version INTEGER,
          actor_principal_id TEXT,
          actor_display TEXT,
          actor_app TEXT,
          occurred_at TEXT,
          idempotency_key TEXT,
          caused_by_action_id TEXT,
          note TEXT,
          self_decision_test_mode INTEGER
        )
      `);
      warehouse.query(`
        INSERT INTO "audit__actions" (
          area, record_type, record_id, action_id, action, changed, from_value, to_value,
          record_version, actor_principal_id, actor_display, actor_app, occurred_at,
          idempotency_key, caused_by_action_id, note, self_decision_test_mode
        ) VALUES
          ('admin', 'write_check', '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', 'audit-action-1', 'recorded', 'stage', NULL, 'recorded', 1, '7001', 'Tia Tenant', 'tenant', '2026-10-10T12:00:00.000Z', 'audit-key-1', NULL, NULL, 0),
          ('admin', 'write_check', '6d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a', 'audit-action-2', 'recorded', 'stage', NULL, 'recorded', 1, '8002', 'Other Tenant', 'tenant', '2026-10-11T12:00:00.000Z', 'audit-key-2', NULL, NULL, 0)
      `);
      warehouse.query(`
        INSERT INTO "admin__tenants" (
          id, name, lead, fy_budget, fytd_spend, mtd_spend, forecast_fy,
          dbus_month, storage_tb, users, datasets, open_items
        ) VALUES
          ('raas', 'RAAS', 'Lead A', 1000, 100, 10, 900, 25, 1.5, 10, 2, 1),
          ('appeals', 'Appeals', 'Lead B', 2000, 200, 20, 1800, 40, 2.5, 20, 3, 2)
      `);
      warehouse.query(`
        INSERT INTO "access__my_access" (principal_id, username, domains, recent_assets) VALUES
          ('7001', 'tia@example.test', '["collections"]', '["ds1"]'),
          ('8002', 'other@example.test', '["appeals"]', '["ds2"]')
      `);
      warehouse.query(`
        INSERT INTO "access__my_access_bundles" (principal_id, username, bundle, since, status, expires, domain) VALUES
          ('7001', 'tia@example.test', 'analyst', '2026-10-01T00:00:00.000Z', 'active', NULL, 'collections'),
          ('8002', 'other@example.test', 'reviewer', '2026-10-02T00:00:00.000Z', 'active', NULL, 'appeals')
      `);
      warehouse.query(`
        INSERT INTO "access__my_access_workspaces" (principal_id, username, name, entitlement, since) VALUES
          ('7001', 'tia@example.test', 'Dev', 'CAN_USE', '2026-10-01T00:00:00.000Z'),
          ('8002', 'other@example.test', 'Prod', 'CAN_USE', '2026-10-02T00:00:00.000Z')
      `);
      warehouse.query(`
        INSERT INTO "requests__access_requests" (
          id, title, submitted_at, status, overall, purpose, stage_index,
          requester_principal_id, requester_username
        ) VALUES
          ('REQ-1', 'Tenant request', '2026-10-10T12:00:00.000Z', 'In progress', 'Submitted', 'Analysis', 1, '7001', 'tia@example.test'),
          ('REQ-2', 'Other request', '2026-10-11T12:00:00.000Z', 'Done', 'Complete', 'Operations', 2, '8002', 'other@example.test')
      `);
      warehouse.query(`
        INSERT INTO "requests__request_items" (
          request_id, item_order, kind, ref, dataset_id, bundle_id, label, sub
        ) VALUES
          ('REQ-1', 0, 'dataset', 'ds1', 'ds1', NULL, 'Dataset One', 'Collections'),
          ('REQ-2', 0, 'dataset', 'ds2', 'ds2', NULL, 'Dataset Two', 'Appeals')
      `);
      warehouse.query(`
        INSERT INTO "requests__request_steps" (
          request_id, step_order, system, status, detail, ticket, error
        ) VALUES
          ('REQ-1', 0, 'Access request submitted', 'done', 'Submitted.', NULL, NULL),
          ('REQ-2', 0, 'Access request submitted', 'done', 'Submitted.', NULL, NULL)
      `);
      warehouse.query(`
        INSERT INTO "initiatives__initiatives" (
          id, onboarding_request_id, name, tenant, stage, version, created_at,
          created_by_principal_id, updated_at, updated_by_principal_id, last_action_id
        ) VALUES
          ('ini1', NULL, 'Initiative One', 'RAAS', 'active', 1, '2026-10-01T00:00:00.000Z', 'system', '2026-10-01T00:00:00.000Z', 'system', 'ini-action-1'),
          ('ini2', NULL, 'Initiative Two', 'RAAS', 'active', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', 'system', 'ini-action-2')
      `);
      warehouse.query(`
        INSERT INTO "initiatives__datasets" (
          id, initiative_id, name, domain_tag, dataset_tag, version, created_at,
          created_by_principal_id, updated_at, updated_by_principal_id, last_action_id
        ) VALUES
          ('ds1', 'ini1', 'Dataset One', 'collections', 'dataset-one', 1, '2026-10-01T00:00:00.000Z', 'system', '2026-10-01T00:00:00.000Z', 'system', 'dataset-action-1'),
          ('ds2', 'ini2', 'Dataset Two', 'appeals', 'dataset-two', 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', 'system', 'dataset-action-2')
      `);
      warehouse.query(`
        INSERT INTO "teams__dataset_owners" (
          id, dataset_id, source, person_display, person_email, person_principal_id,
          bound_at, version, created_at, created_by_principal_id, updated_at,
          updated_by_principal_id, last_action_id
        ) VALUES
          ('owner1', 'ds1', 'configuration', 'Tia Tenant', 't@example.gov', '7001', NULL, 1, '2026-10-01T00:00:00.000Z', 'system', '2026-10-01T00:00:00.000Z', 'system', 'owner-action-1'),
          ('owner2', 'ds2', 'configuration', 'Other Tenant', 'other@example.test', '8002', NULL, 1, '2026-10-02T00:00:00.000Z', 'system', '2026-10-02T00:00:00.000Z', 'system', 'owner-action-2')
      `);
      warehouse.query(`
        INSERT INTO "teams__dataset_owner_actions" (
          action_id, dataset_owner_id, action, record_version, actor_principal_id,
          actor_display, actor_app, occurred_at, idempotency_key, caused_by_action_id,
          note, payload, command, command_hash, expected_effects, result
        ) VALUES
          ('owner-action-1', 'owner1', 'added', 1, 'system', 'EDP Vending Machine', 'system', '2026-10-01T00:00:00.000Z', 'owner-key-1', NULL, NULL, '{"datasetId":"ds1"}', NULL, NULL, NULL, NULL),
          ('owner-action-2', 'owner2', 'added', 1, 'system', 'EDP Vending Machine', 'system', '2026-10-02T00:00:00.000Z', 'owner-key-2', NULL, NULL, '{"datasetId":"ds2"}', NULL, NULL, NULL, NULL)
      `);
      warehouse.query(`
        INSERT INTO "teams__dataset_members" (
          id, dataset_id, role, source, person_display, person_email, person_principal_id,
          version, created_at, created_by_principal_id, updated_at, updated_by_principal_id,
          last_action_id
        ) VALUES
          ('member1', 'ds1', 'tester', 'app', 'Tess Tester', 'tess@example.test', NULL, 1, '2026-10-03T00:00:00.000Z', '7001', '2026-10-03T00:00:00.000Z', '7001', 'member-action-1'),
          ('member3', 'ds1', 'developer', 'app', 'Dev One', 'dev1@example.test', '9004', 1, '2026-10-03T00:00:00.000Z', '7001', '2026-10-03T00:00:00.000Z', '7001', 'member-action-3'),
          ('member2', 'ds2', 'developer', 'app', 'Dev Two', 'dev2@example.test', NULL, 1, '2026-10-04T00:00:00.000Z', '8002', '2026-10-04T00:00:00.000Z', '8002', 'member-action-2')
      `);
      warehouse.query(`
        INSERT INTO "change_list__change_list_entries" (
          id, display_number, kind, reason, caused_by_action_id, dataset_id, group_name, role,
          person_display, person_email, person_principal_id, grants, version, created_at,
          created_by_principal_id, updated_at, updated_by_principal_id, last_action_id
        ) VALUES
          ('cl1', 1001, 'add-member', 'dataset-role-added', 'member-action-1', 'ds1', 'grp-ds1-testers', 'tester', 'Tess Tester', 'tess@example.test', NULL, '["SELECT"]', 1, '2026-10-03T00:00:00.000Z', '7001', '2026-10-03T00:00:00.000Z', '7001', 'cl-action-1'),
          ('cl2', 1002, 'add-member', 'dataset-role-added', 'member-action-2', 'ds2', 'grp-ds2-developers', 'developer', 'Dev Two', 'dev2@example.test', NULL, '["SELECT"]', 1, '2026-10-04T00:00:00.000Z', '8002', '2026-10-04T00:00:00.000Z', '8002', 'cl-action-2')
      `);
      warehouse.query(`
        INSERT INTO "change_list__change_list_entry_actions" (
          action_id, change_list_entry_id, action, from_stage, to_stage, record_version,
          actor_principal_id, actor_display, actor_app, occurred_at, idempotency_key,
          caused_by_action_id, note, payload, command, command_hash, expected_effects, result
        ) VALUES
          ('cl-action-1', 'cl1', 'listed', NULL, 'pending', 1, '7001', 'Tia Tenant', 'tenant', '2026-10-03T00:00:00.000Z', 'cl-key-1', 'member-action-1', NULL, NULL, NULL, NULL, NULL, NULL),
          ('cl-action-2', 'cl2', 'listed', NULL, 'pending', 1, '8002', 'Other Tenant', 'tenant', '2026-10-04T00:00:00.000Z', 'cl-key-2', 'member-action-2', NULL, NULL, NULL, NULL, NULL, NULL)
      `);
      warehouse.query(`
        INSERT INTO "eir__eirs" (
          id, display_number, person_principal_id, person_display, stage, stage_entered_at,
          sla_due_at, sla_due_soon_at, expires_at, valid_submission_id, open_submission_id,
          current_submission_id, renewal_submission_id, version, created_at,
          created_by_principal_id, updated_at, updated_by_principal_id, last_action_id
        ) VALUES
          ('9f45c60f-1ef4-5fd7-9b9f-fabd1787b992', 1001, '7001', 'Tia Tenant', 'submitted', '2026-10-05T00:00:00.000Z', NULL, NULL, NULL, NULL, 'sub1', 'sub1', NULL, 2, '2026-10-05T00:00:00.000Z', '7001', '2026-10-05T00:00:00.000Z', '7001', 'eir-action-1'),
          ('57e75d0b-2f8e-5c97-9099-66bc2f0a16c3', 1002, '8002', 'Other Tenant', 'submitted', '2026-10-06T00:00:00.000Z', NULL, NULL, NULL, NULL, 'sub2', 'sub2', NULL, 2, '2026-10-06T00:00:00.000Z', '8002', '2026-10-06T00:00:00.000Z', '8002', 'eir-action-2')
      `);
      warehouse.query(`
        INSERT INTO "eir__eir_submissions" (
          id, eir_id, kind, volume_path, document_sha256, document_size_bytes, form_values,
          form_version, form_started_at, stage, submitted_at, created_at, updated_at
        ) VALUES
          ('sub1', '9f45c60f-1ef4-5fd7-9b9f-fabd1787b992', 'first', '/Volumes/eir/sub1.pdf', 'abc', 3, '{"name":"Tia"}', 'v1', '2026-10-05T00:00:00.000Z', 'submitted', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
          ('sub2', '57e75d0b-2f8e-5c97-9099-66bc2f0a16c3', 'first', '/Volumes/eir/sub2.pdf', 'def', 3, '{"name":"Other"}', 'v1', '2026-10-06T00:00:00.000Z', 'submitted', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')
      `);
      warehouse.query(`
        INSERT INTO "eir__eir_actions" (
          action_id, eir_id, eir_submission_id, action, from_stage, to_stage, record_version,
          actor_principal_id, actor_display, actor_app, occurred_at, idempotency_key,
          caused_by_action_id, note, payload, command, command_hash, expected_effects, result
        ) VALUES
          ('eir-action-1', '9f45c60f-1ef4-5fd7-9b9f-fabd1787b992', 'sub1', 'submitted', 'not-started', 'submitted', 2, '7001', 'Tia Tenant', 'tenant', '2026-10-05T00:00:00.000Z', 'eir-key-1', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('eir-action-2', '57e75d0b-2f8e-5c97-9099-66bc2f0a16c3', 'sub2', 'submitted', 'not-started', 'submitted', 2, '8002', 'Other Tenant', 'tenant', '2026-10-06T00:00:00.000Z', 'eir-key-2', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `);
      warehouse.query(`
        INSERT INTO "eir__eir_drafts" (
          id, eir_id, form_values, form_version, form_started_at, version, created_at,
          created_by_principal_id, updated_at, updated_by_principal_id, last_action_id
        ) VALUES
          (
            '215b0a69-4583-5007-b730-1bbf2062c078', '9f45c60f-1ef4-5fd7-9b9f-fabd1787b992',
            '{"draft":"tenant"}', 'v1', '2026-10-05T00:00:00.000Z', 2,
            '2026-10-05T00:00:00.000Z', '7001', '2026-10-05T00:02:00.000Z', '7001', 'draft-save-1'
          ),
          (
            '315b0a69-4583-5007-b730-1bbf2062c078', '57e75d0b-2f8e-5c97-9099-66bc2f0a16c3',
            '{"draft":"other"}', 'v1', '2026-10-06T00:00:00.000Z', 1,
            '2026-10-06T00:00:00.000Z', '8002', '2026-10-06T00:00:00.000Z', '8002', 'draft-save-2'
          )
      `);
      warehouse.query(`
        INSERT INTO "eir__eir_evaluations" (
          action_id, eir_draft_id, action, record_version, actor_principal_id,
          actor_display, actor_app, occurred_at, idempotency_key, caused_by_action_id,
          note, payload, definition_version, form_version, outcome, rule_outcomes,
          automatic_validity_eligible, evaluator_principal_id, evaluator_display,
          evaluator_app, command, command_hash, expected_effects, result
        ) VALUES
          (
            'evaluation-1', '215b0a69-4583-5007-b730-1bbf2062c078', 'evaluated', 1, 'system',
            'EDP Vending Machine', 'system', '2026-10-05T00:01:00.000Z', 'evaluation-key-1',
            'draft-save-1', NULL, NULL, 'bootstrap-1', 'v1', 'warning',
            '[{"ruleId":"synthetic-warning","field":"mbiExpirationDate","reasonCode":"EIR-SYNTHETIC-WARNING","disposition":"warning","guidance":"Synthetic warning."}]',
            1, 'system', 'EDP Vending Machine', 'system', NULL, NULL, NULL, NULL
          ),
          (
            'evaluation-2', '315b0a69-4583-5007-b730-1bbf2062c078', 'evaluated', 1, 'system',
            'EDP Vending Machine', 'system', '2026-10-06T00:01:00.000Z', 'evaluation-key-2',
            'draft-save-2', NULL, NULL, 'bootstrap-1', 'v1', 'manual-review',
            '[{"ruleId":"synthetic-review","field":"ndaSigned","reasonCode":"EIR-SYNTHETIC-REVIEW","disposition":"manual-review","guidance":"Synthetic review."}]',
            0, 'system', 'EDP Vending Machine', 'system', NULL, NULL, NULL, NULL
          )
      `);
      const insertOnboarding = (
        display: number,
        uuid: string,
        provider: SessionUser,
        stage: "business-roi-review" | "ccb",
      ) => {
        const at = display === 1001 ? "2026-10-10T12:00:00.000Z" : "2026-10-11T12:00:00.000Z";
        warehouse.query(
          `INSERT INTO "onboarding__onboarding_requests" (
            id, display_number, title, initiative_id, provider_principal_id, provider_display,
            submitted_at, stage, stage_entered_at, sla_due_at, sla_due_soon_at,
            initiative_name, business_case, annual_benefit, levers, workspace_isolation,
            workspace_team_size, intake_answers, open_send_back_from_stage,
            open_send_back_action_id, version, created_at, created_by_principal_id,
            updated_at, updated_by_principal_id, last_action_id
          ) VALUES (
            :uuid, :display, :title, :initiative, :providerId, :providerDisplay,
            :at, :stage, :at, NULL, NULL, :title, :businessCase, 42.00, :levers,
            'shared', 7, :answers, NULL, NULL, 2, :at, :providerId, :at, :providerId, :actionId
          )`,
          {
            uuid,
            display,
            title: `Onboarding ${display}`,
            initiative: `initiative-${display}`,
            providerId: provider.principalId,
            providerDisplay: provider.displayName,
            at,
            stage,
            businessCase: `Business case ${display}`,
            levers: JSON.stringify(["taxgap"]),
            answers: JSON.stringify({ summary: `answers ${display}` }),
            actionId: `action-${display}-2`,
          },
        );
        warehouse.query(
          `INSERT INTO "onboarding__onboarding_intake_datasets" (
            id, onboarding_request_id, position, name, domain, dataset_tag
          ) VALUES (:id, :uuid, 0, :name, 'Collections', :tag)`,
          {
            id: `dataset-${display}`,
            uuid,
            name: `Dataset ${display}`,
            tag: `dataset-${display}`,
          },
        );
        warehouse.query(
          `INSERT INTO "onboarding__onboarding_intake_owners" (
            id, intake_dataset_id, onboarding_request_id, position, person_display,
            person_email, person_principal_id
          ) VALUES (:id, :datasetId, :uuid, 0, :owner, :email, :principal)`,
          {
            id: `owner-${display}`,
            datasetId: `dataset-${display}`,
            uuid,
            owner: provider.displayName,
            email: provider.email,
            principal: provider.principalId,
          },
        );
        warehouse.query(
          `INSERT INTO "onboarding__onboarding_request_actions" (
            action_id, onboarding_request_id, action, from_stage, to_stage,
            record_version, actor_principal_id, actor_display, actor_app, occurred_at,
            idempotency_key, caused_by_action_id, note, payload, command, command_hash,
            expected_effects, result
          ) VALUES
            (:submitAction, :uuid, 'submitted', NULL, 'submitted', 1, :providerId,
              :providerDisplay, 'tenant', :at, :submitKey, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            (:forwardAction, :uuid, 'forwarded', 'submitted', :stage, 2, 'system',
              'System', 'system', :at, :forwardKey, :submitAction, NULL, NULL, NULL, NULL, NULL, NULL)`,
          {
            submitAction: `action-${display}-1`,
            forwardAction: `action-${display}-2`,
            uuid,
            providerId: provider.principalId,
            providerDisplay: provider.displayName,
            at,
            stage,
            submitKey: `00000000-0000-4000-8000-00000000${display}`,
            forwardKey: `00000000-0000-4000-8000-00000001${display}`,
          },
        );
      };
      insertOnboarding(1001, "onboarding-uuid-1001", TENANT, "business-roi-review");
      insertOnboarding(
        1002,
        "onboarding-uuid-1002",
        { ...TENANT, principalId: "8002", displayName: "Other Tenant" },
        "ccb",
      );
      return warehouse;
    };
    const apiCache = new Map<string, Promise<(path: string) => Promise<Response>>>();
    const apiFor = (snapshot: boolean, user: SessionUser) => {
      const key = JSON.stringify([snapshot, user]);
      const cached = apiCache.get(key);
      if (cached) return cached;

      const api = (async () => {
        const warehouse = makeWarehouse();
        const runner = createTransactionRunner({
          client: warehouse.client,
          names,
          sleep: async () => undefined,
          random: () => 0,
        });
        const apiRunner = {
          ...runner,
          reader:
            (tag: Parameters<typeof runner.reader>[0]) =>
            async <T extends object>(
              statement: Parameters<ReturnType<typeof runner.reader>>[0],
            ) => {
              if (isMarkerCheck(statement.statement)) return allMarkerRows().rows as T[];
              return runner.reader(tag)<T>(statement);
            },
        };
        const snapshotCache = snapshot
          ? createDeltaSnapshotCache({ pollIntervalMs: 60_000, maxStaleMs: 60_000 })
          : undefined;
        if (snapshotCache)
          await snapshotCache.start(apiRunner.reader({ readId: crypto.randomUUID() }), names);
        const deps: DeltaApiDeps = {
          registry,
          runner: snapshotCache ? apiRunner : runner,
          names,
          serves: ["tenant", "staff"],
          requirePrivacyAcknowledgment: async () => undefined,
          resolveUser: async () => user,
          ...(snapshotCache ? { snapshotCache } : {}),
        };
        return (path: string) => handleDeltaApiRequest(get(path), deps);
      })();
      apiCache.set(key, api);
      return api;
    };

    const cases: Array<{ path: string; user: SessionUser }> = [
      { path: "/api/reads/access/my-access", user: TENANT },
      { path: "/api/reads/admin/tenants", user: STAFF },
      { path: "/api/reads/admin/write-checks", user: STAFF },
      {
        path: "/api/reads/audit/record-history?recordId=5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
        user: STAFF,
      },
      { path: "/api/reads/catalog/bootstrap", user: TENANT },
      { path: "/api/reads/catalog/bootstrap", user: STAFF },
      { path: "/api/reads/catalog/bundles", user: TENANT },
      { path: "/api/reads/catalog/datasets", user: TENANT },
      { path: "/api/reads/catalog/personas", user: TENANT },
      { path: "/api/reads/catalog/systems", user: TENANT },
      { path: "/api/reads/change-list/entries", user: TENANT },
      { path: "/api/reads/change-list/entries", user: STAFF },
      { path: "/api/reads/eir/inbox", user: VALIDATOR },
      { path: "/api/reads/eir/mine", user: TENANT },
      {
        path: "/api/reads/eir/mine",
        user: { ...TENANT, principalId: "8002", displayName: "Other Tenant" },
      },
      { path: "/api/reads/eir/record?principalId=7001", user: VALIDATOR },
      { path: "/api/reads/eir/record?principalId=8002", user: VALIDATOR },
      {
        path: "/api/reads/eir/record?principalId=8002",
        user: {
          ...VALIDATOR,
          principalId: "8002",
          displayName: "Other Tenant",
        },
      },
      ...TEAM_READERS.map((user) => ({
        path: "/api/reads/initiatives/dataset-member-summaries",
        user,
      })),
      { path: "/api/reads/initiatives/datasets", user: TENANT },
      { path: "/api/reads/initiatives/initiatives", user: TENANT },
      { path: "/api/reads/onboarding/mine", user: TENANT },
      {
        path: "/api/reads/onboarding/mine",
        user: { ...TENANT, principalId: "8002", displayName: "Other Tenant" },
      },
      { path: "/api/reads/onboarding/request?id=ONB-1001", user: TENANT },
      {
        path: "/api/reads/onboarding/request?id=ONB-1001",
        user: { ...TENANT, principalId: "8002", displayName: "Other Tenant" },
      },
      {
        path: "/api/reads/onboarding/request?id=ONB-1001",
        user: {
          ...TENANT,
          principalId: "business-office",
          onboardingReviewerRoles: ["business-office"],
        },
      },
      {
        path: "/api/reads/onboarding/request?id=ONB-1002",
        user: { ...TENANT, principalId: "ccb", onboardingReviewerRoles: ["ccb"] },
      },
      {
        path: "/api/reads/onboarding/request?id=ONB-1001",
        user: { ...TENANT, principalId: "stranger", displayName: "Stranger" },
      },
      {
        path: "/api/reads/onboarding/inbox?role=business-office",
        user: {
          ...TENANT,
          principalId: "business-office",
          onboardingReviewerRoles: ["business-office"],
        },
      },
      {
        path: "/api/reads/onboarding/inbox?role=ccb",
        user: { ...TENANT, principalId: "ccb", onboardingReviewerRoles: ["ccb"] },
      },
      {
        path: "/api/reads/onboarding/inbox?role=ccb",
        user: {
          ...TENANT,
          principalId: "business-office",
          onboardingReviewerRoles: ["business-office"],
        },
      },
      {
        path: "/api/reads/onboarding/inbox?role=business-office",
        user: { ...TENANT, principalId: "stranger", displayName: "Stranger" },
      },
      { path: "/api/reads/requests/access-requests", user: TENANT },
      { path: "/api/reads/requests/access-requests?id=REQ-1", user: TENANT },
      { path: "/api/reads/requests/access-requests?id=REQ-2", user: TENANT },
      { path: "/api/reads/requests/pipeline", user: STAFF },
      { path: "/api/reads/requests/statuses", user: TENANT },
      ...TEAM_READERS.flatMap((user) => [
        { path: "/api/reads/teams/events?datasetId=ds1", user },
        { path: "/api/reads/teams/members?datasetId=ds1", user },
      ]),
      { path: "/api/reads/teams/ownership?datasetId=ds1", user: TENANT },
    ];

    for (const { path, user } of cases) {
      const viaSql = await (await apiFor(false, user))(path);
      const viaSnapshot = await (await apiFor(true, user))(path);
      expect(viaSnapshot.status, path).toBe(viaSql.status);
      expect(await viaSnapshot.json(), path).toEqual(await viaSql.json());
    }

    // #257: only ds1's owner (Tia, 7001) and EDP staff read its roster and
    // counts. Its tester reads her own row; ds2's owner and a stranger, nothing.
    const expected: Array<{
      user: SessionUser;
      members: string[];
      events: number;
      ds1Total: number | null;
      ds1ViewerRoles: string[];
      /** The viewer's own identifiers, which their own row may carry. */
      own?: string[];
    }> = [
      {
        user: TENANT,
        members: ["Tess Tester", "Dev One"],
        events: 1,
        ds1Total: 2,
        ds1ViewerRoles: [],
      },
      {
        user: STAFF,
        members: ["Tess Tester", "Dev One"],
        events: 1,
        ds1Total: 2,
        ds1ViewerRoles: [],
      },
      {
        user: TEAM_TESTER,
        members: ["Tess Tester"],
        events: 0,
        ds1Total: null,
        ds1ViewerRoles: ["tester"],
        own: ["tess@example.test"],
      },
      {
        user: TEAM_SCIM_MEMBER,
        members: ["Dev One"],
        events: 0,
        ds1Total: null,
        ds1ViewerRoles: ["developer"],
        own: ["dev1@example.test", "9004"],
      },
      { user: OTHER_OWNER, members: [], events: 0, ds1Total: null, ds1ViewerRoles: [] },
      { user: TEAM_STRANGER, members: [], events: 0, ds1Total: null, ds1ViewerRoles: [] },
    ];
    for (const row of expected) {
      for (const snapshot of [false, true]) {
        const api = await apiFor(snapshot, row.user);
        const label = `${row.user.displayName} (${snapshot ? "snapshot" : "SQL"})`;
        const members = (await (await api("/api/reads/teams/members?datasetId=ds1")).json()) as {
          person: { name: string; email: string };
        }[];
        expect(
          members.map((m) => m.person.name),
          label,
        ).toEqual(row.members);
        const events = (await (await api("/api/reads/teams/events?datasetId=ds1")).json()) as [];
        expect(events, label).toHaveLength(row.events);
        const summaries = (await (
          await api("/api/reads/initiatives/dataset-member-summaries")
        ).json()) as {
          id: string;
          memberSummary: {
            totalMembers: number | null;
            roleCounts: unknown;
            viewerRoles: string[];
          };
        }[];
        const ds1 = summaries.find((d) => d.id === "ds1")!.memberSummary;
        expect(ds1.totalMembers, label).toBe(row.ds1Total);
        expect(ds1.roleCounts === null, label).toBe(row.ds1Total === null);
        expect(ds1.viewerRoles, label).toEqual(row.ds1ViewerRoles);
        if (row.ds1Total === null) {
          const leaked = JSON.stringify([members, events, ds1]);
          for (const other of ["tess@example.test", "dev1@example.test", "9004"]) {
            if (!row.own?.includes(other)) expect(leaked, label).not.toContain(other);
          }
        }
      }
    }
  }, 30_000);

  it("runs an allow-listed read with a validated query, tagged with a read ID", async () => {
    const { deps: d, fake } = deps(happy);
    const response = await handleDeltaApiRequest(get("/api/reads/admin/write-checks"), d);
    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.tag).toHaveProperty("readId");
    expect(fake.calls[0]!.sent).toMatch(/^\/\* edp_read_id=[0-9a-f-]{36} \*\//);
  });

  it("refuses unknown query parameters", async () => {
    const { deps: d, fake } = deps(happy);
    const response = await handleDeltaApiRequest(
      get("/api/reads/admin/write-checks?sql=SELECT%201"),
      d,
    );
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("reads 'my access' for the session's principal only", async () => {
    const { deps: d, fake } = deps(() => ({ rows: [] }), TENANT);
    const response = await handleDeltaApiRequest(get("/api/reads/access/my-access"), d);
    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) expect(call.parameters).toEqual({ me: TENANT.principalId });
  });

  it("omits staff-only catalog bootstrap parts for a non-staff user", async () => {
    const { deps: d, fake } = deps(() => ({ rows: [] }), TENANT);
    const response = await handleDeltaApiRequest(get("/api/reads/catalog/bootstrap"), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenants: [] });
    expect(fake.calls.some((call) => call.statement.includes("`tenants`"))).toBe(false);
  });

  it("includes staff-only catalog bootstrap parts only for EDP staff", async () => {
    const { deps: d, fake } = deps((call) => {
      if (call.statement.includes("`tenants`")) return { rows: [{ id: "raas", name: "RAAS" }] };
      return { rows: [] };
    }, STAFF);
    const response = await handleDeltaApiRequest(get("/api/reads/catalog/bootstrap"), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenants: [{ id: "raas", name: "RAAS" }] });
    expect(fake.calls.filter((call) => call.statement.includes("`tenants`"))).toHaveLength(1);
  });

  it("reports tenant rollup failure while returning shared catalog bootstrap parts", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps: d } = deps((call) => {
      if (call.statement.includes("`tenants`")) throw new Error("tenant rollup unavailable");
      if (call.statement.includes("`source_systems`"))
        return { rows: [{ id: "imf", name: "IMF", short: "IMF", org: "SP", type: "Master" }] };
      return { rows: [] };
    }, STAFF);
    const response = await handleDeltaApiRequest(get("/api/reads/catalog/bootstrap"), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      systems: [{ id: "imf" }],
      tenants: null,
      tenantsError: {
        code: "tenant-rollup-unavailable",
        message: "Tenant financials are temporarily unavailable.",
      },
    });
    expect(log).toHaveBeenCalledWith(
      "[delta-api] catalog/bootstrap tenant rollup failed; returning shared catalog without staff tenants.",
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain("tenant rollup unavailable");
    log.mockRestore();
  });

  it("returns request lists and statuses through one request/statuses read without detail reads", async () => {
    const { deps: d, fake } = deps((call) => {
      if (call.statement.includes("FROM `edp_vending`.`edp_vm_pr1_requests`.`access_requests`")) {
        return {
          rows: [
            {
              id: "REQ-1",
              title: "Access",
              submitted_at: "2026-10-10T12:00:00.000Z",
              status: "In progress",
              overall: "Submitted",
              purpose: "Analysis",
              stage_index: 1,
              requester_principal_id: TENANT.principalId,
              requester_username: TENANT.email,
            },
          ],
        };
      }
      if (call.statement.includes("UNION ALL")) {
        return {
          rows: [
            {
              row_type: "step",
              request_id: "REQ-1",
              row_order: 0,
              system: "Access request submitted",
              status: "done",
              detail: "Resolved.",
              ticket: null,
              error: null,
            },
          ],
        };
      }
      return { rows: [] };
    }, TENANT);
    const response = await handleDeltaApiRequest(get("/api/reads/requests/statuses"), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requests: [{ id: "REQ-1" }],
      statuses: { "REQ-1": { requestId: "REQ-1", overall: "Submitted" } },
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((call) => call.parameters["me"] === TENANT.principalId)).toBe(true);
  });
});

describe("Delta API: server configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("names what's missing, and answers 503 rather than guessing", async () => {
    vi.stubEnv("DATABRICKS_HOST", "");
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "");
    vi.stubEnv("EDP_STORE_CATALOG", "");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "");
    expect(() => deltaApiFromEnv({})).toThrow(/DATABRICKS_WAREHOUSE_ID/);
    const response = await handleDeltaApi(get("/api/reads/catalog/datasets"), {});
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("backend-not-configured");
  });

  it("the configured EIR privacy guard fails closed when its warehouse is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABRICKS_HOST", "ws.example.com");
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "");
    vi.stubEnv("EDP_STORE_CATALOG", "edp_vending");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "sp-id");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "sp-secret");

    await expect(requireConfiguredPrivacyAcknowledgment(TENANT, {})).rejects.toThrow(
      /DATABRICKS_WAREHOUSE_ID/,
    );
  });

  it("uses the service principal's client credentials in production, never a token from the browser", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABRICKS_HOST", "ws.example.com");
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "wh1");
    vi.stubEnv("EDP_STORE_CATALOG", "edp_vending");
    vi.stubEnv("DATABRICKS_TOKEN", "pat-ignored-in-production");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "");
    expect(() => deltaApiFromEnv({})).toThrow(/DATABRICKS_CLIENT_ID/);
    vi.stubEnv("DATABRICKS_CLIENT_ID", "sp-id");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "sp-secret");
    expect(deltaApiFromEnv({}).names.table("admin", "display_counters")).toBe(
      "`edp_vending`.`admin`.`display_counters`",
    );
  });

  it("requires Statement API wait and poll tuning to be positive whole numbers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("DATABRICKS_HOST", "ws.example.com");
    vi.stubEnv("DATABRICKS_WAREHOUSE_ID", "wh1");
    vi.stubEnv("EDP_STORE_CATALOG", "edp_vending");
    vi.stubEnv("DATABRICKS_TOKEN", "local-token");
    vi.stubEnv("EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS", "10.5");
    expect(() => deltaApiFromEnv({})).toThrow(
      /EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS must be a positive whole number/,
    );
    vi.stubEnv("EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS", "40");
    vi.stubEnv("EDP_SQL_READ_POLL_INTERVAL_MS", "0");
    expect(() => deltaApiFromEnv({})).toThrow(
      /EDP_SQL_READ_POLL_INTERVAL_MS must be a positive whole number/,
    );
    vi.stubEnv("EDP_SQL_READ_POLL_INTERVAL_MS", "500");
    vi.stubEnv("EDP_SQL_COMMAND_WAIT_TIMEOUT_SECONDS", "4");
    expect(() => deltaApiFromEnv({})).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "Command wait_timeout 4s is outside the Statement Execution API's supported range; using the default 10s.",
    );
  });
});

describe("Delta API: staff endpoints fail closed", () => {
  it("refuses a non-staff user the admin pipeline with 403, before any SQL", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(get("/api/reads/requests/pipeline"), d);
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a non-staff user every tenant's financials (admin/tenants) with 403, before any SQL", async () => {
    const { deps: d, fake } = deps(happy, TENANT);
    const response = await handleDeltaApiRequest(get("/api/reads/admin/tenants"), d);
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
    const { deps: staff } = deps(happy, STAFF);
    expect((await handleDeltaApiRequest(get("/api/reads/admin/tenants"), staff)).status).toBe(200);
  });

  it("opens to any signed-in user only reads reviewed as safe for them", () => {
    // The shared discovery catalogue, and reads scoped to the caller by the
    // session. Anything else must be staff-only; adding a read here is a
    // review decision, not a default.
    const tenantReads = createAppRegistry()
      .list()
      .reads.filter((r) => r.app === "tenant")
      .map((r) => `${r.area}/${r.name}`)
      .sort();
    expect(tenantReads).toEqual([
      "access/my-access", // WHERE principal_id = the session's
      "catalog/bootstrap", // shared catalog plus tenants only when the session is staff
      "catalog/bundles",
      "catalog/datasets",
      "catalog/personas",
      "catalog/systems",
      "change-list/entries", // non-staff: only entries on datasets the session owns
      "eir-definitions/forms", // EIR form definitions (labels, help, rules): no one's answers
      "eir/generated-pdf", // exact current evaluated draft for the session; takes no query
      "eir/mine", // eirs.id = UUID v5 of the session's principal ID; takes no query
      "initiatives/dataset-member-summaries", // dataset list plus aggregate member facts, no member emails
      "initiatives/datasets", // the shared catalogue: datasets and their owners
      "initiatives/initiatives", // the shared catalogue
      "onboarding/mine", // WHERE provider_principal_id = the session's
      "onboarding/request", // provider or current-stage reviewer, otherwise not found
      "privacy/current", // active notice acknowledgment for the session
      "privacy/history", // prior notice acknowledgments for the session
      "requests/access-requests", // non-staff: WHERE requester_principal_id = the session's
      "requests/statuses", // same request scope as access-requests, projected for the first load
      "teams/events", // a dataset's team history: the read-only team page (#110)
      "teams/members", // a dataset's team: the read-only team page (#110)
      "teams/ownership", // the session's own standing with one dataset's owners
    ]);
  });

  it("refuses a non-staff user every registered staff command and read, before any SQL", async () => {
    const { writes, reads } = createAppRegistry().list();
    const staffWrites = writes.filter((w) => w.app === "staff");
    const staffReads = reads.filter((r) => r.app === "staff");
    expect(staffWrites.length + staffReads.length).toBeGreaterThanOrEqual(6);
    // Staff owner matching (#103, 103-B) is EDP staff only.
    expect(staffWrites.map((w) => `${w.area}/${w.name}`)).toEqual(
      expect.arrayContaining(["onboarding/match-owner", "onboarding/request-owner-onboarding"]),
    );
    for (const write of staffWrites) {
      const { deps: d, fake } = deps(happy, TENANT);
      const response = await handleDeltaApiRequest(
        write.kind === "command"
          ? post(`/api/commands/${write.area}/${write.name}`, {
              idempotencyKey: KEY,
              expectedVersion: 0,
              payload: {},
            })
          : post(`/api/legacy-writes/${write.area}/${write.name}`, { payload: {} }),
        d,
      );
      // onboarding/decide is record-scoped: a non-reviewer must not learn a
      // request exists or its stage, so it refuses with not-found (404) rather
      // than a distinguishable 403 — but still before any SQL, like the rest.
      const expected = write.area === "onboarding" && write.name === "decide" ? 404 : 403;
      expect(response.status, `${write.area}/${write.name}`).toBe(expected);
      expect(fake.calls, `${write.area}/${write.name}`).toHaveLength(0);
    }
    for (const read of staffReads) {
      const { deps: d, fake } = deps(happy, TENANT);
      const response = await handleDeltaApiRequest(get(`/api/reads/${read.area}/${read.name}`), d);
      expect(response.status, `${read.area}/${read.name}`).toBe(403);
      expect(fake.calls, `${read.area}/${read.name}`).toHaveLength(0);
    }
  });

  it("refuses EDP staff who aren't safeguards validators the EIR validator endpoints, before any SQL", async () => {
    // ADR-0008: EIR decisions and the validator inbox are staff-app endpoints
    // gated on the validator role, not on EDP staff.
    const eirStaff = createAppRegistry()
      .list()
      .writes.filter((w) => w.area === "eir" && w.app === "staff")
      .map((w) => w.name);
    expect(eirStaff).toEqual(["decide"]);
    const requests = [
      post("/api/commands/eir/decide", {
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { principalId: "7001", decision: "valid" },
      }),
      get("/api/reads/eir/inbox"),
      get("/api/reads/eir/record?principalId=7001"),
    ];
    for (const request of requests) {
      const { deps: d, fake } = deps(happy, { ...STAFF, isSafeguardsValidator: false });
      const response = await handleDeltaApiRequest(request, d);
      expect(response.status, request.url).toBe(403);
      expect(fake.calls, request.url).toHaveLength(0);
    }
  });

  it("won't register a staff command or read without an authorize function", () => {
    const registry = createRegistry();
    const base = { area: "x", app: "staff" as const, payload: z.object({}), query: z.object({}) };
    expect(() => registry.read({ ...base, name: "open-read", run: async () => null })).toThrow(
      /must declare authorize/,
    );
    expect(() =>
      registry.legacyWrite({ ...base, name: "open-write", run: async () => null }),
    ).toThrow(/must declare authorize/);
    expect(() =>
      registry.command({
        ...base,
        name: "open-command",
        leadActionTable: { schema: "x", table: "x_actions", recordIdColumn: "x_id" },
        plan: () => ({ recordId: "r", recordVersion: 1, leadAction: { action: "done" } }),
        resultRow: () => "SELECT 1",
        result: () => null,
      }),
    ).toThrow(/must declare authorize/);
    // Tenant endpoints may rely on the session alone.
    expect(() =>
      registry.read({ ...base, app: "tenant", name: "tenant-read", run: async () => null }),
    ).not.toThrow();
  });

  it("maps a legacy write whose outcome is unknown to 503 telling the person to reload first", async () => {
    const { deps: d, fake } = deps((call) => {
      if (call.statement.startsWith("SELECT 1 AS found")) return { rows: [{ found: 1 }] };
      throw new StatementAbandonedError(45_000, "RUNNING", "s1");
    }, TENANT);
    const response = await handleDeltaApiRequest(
      post("/api/legacy-writes/requests/append-waiver-attestation", {
        payload: {
          id: "ATT-1",
          requestId: "REQ-1",
          checklistItemId: "ldw",
          attested: true,
          attestedAt: "2026-10-05T12:00:00Z",
          source: "app",
          createdAt: "2026-10-05T12:00:00Z",
        },
      }),
      d,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "outcome-unknown",
        message: "We couldn't confirm this was saved. Reload to check before trying again.",
      },
    });
    // One standalone write, abandoned and not retried: there's no key to check it by.
    expect(fake.blocks()).toHaveLength(0);
    expect(fake.calls.filter((c) => c.statement.startsWith("UPDATE"))).toHaveLength(1);
    expect(fake.calls.filter((c) => c.statement.startsWith("INSERT"))).toHaveLength(0);
  });
});
