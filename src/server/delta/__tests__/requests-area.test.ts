/**
 * #72's legacy cart requests behind the server. Their tables aren't
 * catalog-managed, so a transaction can't write them: each write is a short
 * run of standalone statements, ordered and written so a re-run converges,
 * on its own endpoint whose envelope refuses an idempotency key or version.
 * Values are bound (never spliced), and the requester and attestor come from
 * the session.
 */
import { describe, expect, it } from "vitest";

import { makeNewRequest } from "../../../data/__tests__/fixture";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import { SqlError, StatementAbandonedError } from "../errors.ts";
import type { SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { deltaConflict, fakeSqlClient, type RecordedStatement } from "./fake-sql-client.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const ANALYST: SessionUser = {
  principalId: "scim-42",
  displayName: "Ana Analyst",
  email: "analyst@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: [],
};
const STAFF: SessionUser = { ...ANALYST, principalId: "scim-7", isAdmin: true };
const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";

const {
  requesterPrincipalId: _a,
  requesterUsername: _b,
  ...REQUEST
} = makeNewRequest() as ReturnType<typeof makeNewRequest> & {
  requesterPrincipalId?: string;
  requesterUsername?: string;
};

/**
 * Plays the warehouse for the legacy tables: whether the request row exists,
 * and what each standalone statement reports. `fail` can make one statement
 * throw.
 */
function warehouse(
  state: { exists: boolean; attestationExists?: boolean } = { exists: false },
  fail?: (call: RecordedStatement) => Error | undefined,
) {
  return fakeSqlClient((call) => {
    const failure = fail?.(call);
    if (failure) throw failure;
    const sql = call.statement;
    if (sql.startsWith("SELECT 1 AS found")) return { rows: state.exists ? [{ found: 1 }] : [] };
    if (sql.startsWith("INSERT INTO `edp_vending`.`requests`.`access_requests`")) {
      const inserted = state.exists ? 0 : 1;
      state.exists = true;
      return { numAffectedRows: inserted };
    }
    if (sql.startsWith("INSERT INTO `edp_vending`.`requests`.`waiver_attestations`"))
      return { numAffectedRows: state.attestationExists ? 0 : 1 };
    if (/^(MERGE|DELETE|UPDATE)/.test(sql)) return { numAffectedRows: 1 };
    if (sql.startsWith("SELECT id, title") && state.exists) {
      return {
        rows: [
          {
            id: REQUEST.id,
            title: REQUEST.title,
            submitted_at: "2026-06-05 00:00:00",
            status: REQUEST.status,
            overall: REQUEST.overall,
            purpose: REQUEST.purpose,
            stage_index: REQUEST.stageIndex,
            requester_principal_id: ANALYST.principalId,
            requester_username: ANALYST.email,
          },
        ],
      };
    }
    return { rows: [] };
  });
}

function api(fake: ReturnType<typeof fakeSqlClient>, user = ANALYST) {
  const names = createStoreNames("edp_vending");
  const deps: DeltaApiDeps = {
    registry: createAppRegistry(),
    runner: createTransactionRunner({
      client: fake.client,
      names,
      sleep: async () => undefined,
      random: () => 0,
    }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => user,
    requirePrivacyAcknowledgment: async () => undefined,
  };
  return (request: Request) => handleDeltaApiRequest(request, deps);
}

function sqliteApi(warehouse: SqliteWarehouse, user = ANALYST) {
  const names = createStoreNames("edp_vending");
  const deps: DeltaApiDeps = {
    registry: createAppRegistry(),
    runner: createTransactionRunner({
      client: warehouse.client,
      names,
      sleep: async () => undefined,
      random: () => 0,
    }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => user,
    requirePrivacyAcknowledgment: async () => undefined,
  };
  return (request: Request) => handleDeltaApiRequest(request, deps);
}

const post = (path: string, body: unknown) =>
  new Request(`https://app.example${path}`, { method: "POST", body: JSON.stringify(body) });
const legacy = (name: string, payload: unknown) =>
  post(`/api/legacy-writes/requests/${name}`, { payload });

/** The statements that wrote, in order: verb and table. */
const writes = (fake: ReturnType<typeof fakeSqlClient>) =>
  fake.calls.flatMap((call) => {
    const match = /^(INSERT INTO|MERGE INTO|DELETE FROM|UPDATE) (\S+)/.exec(call.statement);
    return match ? [`${match[1]} ${match[2]}`] : [];
  });

describe("legacy cart requests on the server", () => {
  it("creates a request with standalone statements, the request row last, requester from the session", async () => {
    const fake = warehouse();
    const response = await api(fake)(legacy("create-request", REQUEST));
    expect(response.status).toBe(200);
    expect((await response.json()).result.requesterPrincipalId).toBe("scim-42");
    expect(fake.blocks()).toHaveLength(0);
    expect(writes(fake)).toEqual([
      "MERGE INTO `edp_vending`.`requests`.`request_items`",
      "MERGE INTO `edp_vending`.`requests`.`request_steps`",
      "INSERT INTO `edp_vending`.`requests`.`access_requests`",
    ]);
    const header = fake.calls.find((c) => c.statement.startsWith("INSERT INTO"))!;
    expect(header.statement).toContain("WHERE NOT EXISTS");
    expect(Object.values(header.parameters)).toContain("scim-42");
    // Values are bound, never spliced into the text.
    expect(header.statement).not.toContain(REQUEST.title);
    // The browser's date is stored as a timestamp.
    expect(Object.values(header.parameters)).toContain(new Date("Jun 5, 2026").toISOString());
  });

  it("re-running a create that failed part-way replaces the rows it left, instead of adding to them", async () => {
    const state = { exists: false };
    let failHeader = true;
    const fake = warehouse(state, (call) => {
      if (failHeader && call.statement.startsWith("INSERT INTO")) {
        failHeader = false;
        return new SqlError("[INTERNAL_ERROR] warehouse restarted", { errorCode: "INTERNAL" });
      }
      return undefined;
    });
    const call = api(fake);
    expect((await call(legacy("create-request", REQUEST))).status).toBe(500);
    expect((await call(legacy("create-request", REQUEST))).status).toBe(200);
    // Items and steps are MERGEs keyed on the request and position, which
    // also delete any row of this request the payload doesn't have.
    const merges = fake.calls.filter((c) => c.statement.startsWith("MERGE"));
    expect(merges).toHaveLength(4);
    for (const merge of merges) {
      expect(merge.statement).toMatch(/ON t\.request_id = s\.request_id AND t\.`\w+_order` = s\./);
      expect(merge.statement).toMatch(
        /WHEN NOT MATCHED BY SOURCE AND t\.request_id = :p0 THEN DELETE$/,
      );
    }
  });

  it("refuses a request that already exists before writing anything", async () => {
    const fake = warehouse({ exists: true });
    const response = await api(fake)(legacy("create-request", REQUEST));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("already-exists");
    expect(writes(fake)).toEqual([]);
  });

  it.each([
    ["an idempotency key", { idempotencyKey: KEY, payload: REQUEST }],
    ["an expected version", { expectedVersion: 0, payload: REQUEST }],
    ["the command envelope", { idempotencyKey: KEY, expectedVersion: 0, payload: REQUEST }],
  ])("refuses %s it can't honour, before any SQL", async (_label, body) => {
    const fake = warehouse();
    const response = await api(fake)(post("/api/legacy-writes/requests/create-request", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-request");
    expect(fake.calls).toHaveLength(0);
  });

  it("isn't reachable as a command, so nothing implies it's idempotent or version-checked", async () => {
    const fake = warehouse();
    const response = await api(fake)(
      post("/api/commands/requests/create-request", {
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: REQUEST,
      }),
    );
    expect(response.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a requester named in the body", async () => {
    const fake = warehouse();
    const response = await api(fake)(
      legacy("create-request", { ...REQUEST, requesterPrincipalId: "scim-other" }),
    );
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("retries a statement Delta refused with a conflict, which didn't commit", async () => {
    let conflicts = 1;
    const fake = warehouse({ exists: false }, (call) =>
      call.statement.startsWith("MERGE") && conflicts-- > 0 ? deltaConflict() : undefined,
    );
    expect((await api(fake)(legacy("create-request", REQUEST))).status).toBe(200);
    expect(writes(fake)).toEqual([
      "MERGE INTO `edp_vending`.`requests`.`request_items`",
      "MERGE INTO `edp_vending`.`requests`.`request_items`",
      "MERGE INTO `edp_vending`.`requests`.`request_steps`",
      "INSERT INTO `edp_vending`.`requests`.`access_requests`",
    ]);
  });

  it("tells the person to reload and check when a statement's outcome is unknown, and doesn't retry it", async () => {
    const fake = warehouse({ exists: false }, (call) =>
      call.statement.startsWith("INSERT")
        ? new StatementAbandonedError(45_000, "RUNNING", "s1")
        : undefined,
    );
    const response = await api(fake)(legacy("create-request", REQUEST));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("outcome-unknown");
    expect(fake.calls.filter((c) => c.statement.startsWith("INSERT"))).toHaveLength(1);
  });

  it("binds stored request ids in child-row IN queries", async () => {
    const hostileId = "a'\\";
    const fake = fakeSqlClient((call) =>
      call.statement.includes("`access_requests`")
        ? {
            rows: [
              {
                id: hostileId,
                title: "t",
                submitted_at: "2026-10-05",
                status: "s",
                overall: "o",
                purpose: "p",
                stage_index: 0,
                requester_principal_id: "scim-42",
                requester_username: "analyst@example.gov",
              },
            ],
          }
        : { rows: [] },
    );
    const response = await api(fake)(
      new Request("https://app.example/api/reads/requests/access-requests"),
    );
    expect((await response.json())[0].id).toBe(hostileId);
    const children = fake.calls.filter((c) => c.statement.includes("request_id IN"));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.statement).not.toContain(hostileId);
      expect(child.statement).toContain(":id0");
      expect(child.parameters).toMatchObject({ id0: hostileId });
    }
    // A tenant sees only their own requests.
    expect(fake.calls[0]!.statement).toContain("requester_principal_id = :me");
    expect(fake.calls[0]!.parameters).toMatchObject({ me: "scim-42" });
  });

  it("scopes request/statuses to the non-staff session in the header and child-row SQL", async () => {
    const warehouse = createSqliteWarehouse({ files: ["store-schema.sql"] });
    const seed = async (id: string, requester: string, step: string) => {
      await warehouse.client.execute(
        {
          statement:
            "INSERT INTO `edp_vending`.`requests`.`access_requests` (id, title, submitted_at, status, overall, purpose, stage_index, requester_principal_id, requester_username) VALUES (:id, :title, :submitted_at, :status, :overall, :purpose, :stage_index, :requester_principal_id, :requester_username)",
          parameters: {
            id,
            title: `Request ${id}`,
            submitted_at: "2026-10-10T12:00:00.000Z",
            status: "In progress",
            overall: `Overall ${id}`,
            purpose: "Analysis",
            stage_index: 1,
            requester_principal_id: requester,
            requester_username: `${requester}@example.gov`,
          },
        },
        { readId: "seed-request" },
      );
      await warehouse.client.execute(
        {
          statement:
            "INSERT INTO `edp_vending`.`requests`.`request_steps` (request_id, step_order, system, status, detail, ticket, error) VALUES (:request_id, :step_order, :system, :status, :detail, :ticket, :error)",
          parameters: {
            request_id: id,
            step_order: 0,
            system: step,
            status: "done",
            detail: "Resolved.",
            ticket: null,
            error: null,
          },
        },
        { readId: "seed-step" },
      );
    };
    await seed("REQ-MINE", ANALYST.principalId, "mine only");
    await seed("REQ-OTHER", "scim-other", "other hidden");

    const response = await sqliteApi(warehouse)(
      new Request("https://app.example/api/reads/requests/statuses"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requests.map((request: { id: string }) => request.id)).toEqual(["REQ-MINE"]);
    expect(Object.keys(body.statuses)).toEqual(["REQ-MINE"]);
    expect(body.statuses["REQ-MINE"].subRequests).toEqual([
      expect.objectContaining({ system: "mine only" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("REQ-OTHER");
    expect(JSON.stringify(body)).not.toContain("other hidden");
    const headerRead = warehouse.statements.find((statement) =>
      statement.includes("FROM `edp_vending`.`requests`.`access_requests`"),
    );
    const childRead = warehouse.statements.find((statement) => statement.includes("UNION ALL"));
    expect(headerRead).toContain("requester_principal_id = :me");
    expect(childRead).toContain("requester_principal_id = :me");
  });

  const TRANSITION = {
    id: REQUEST.id,
    status: "Completed",
    overall: "Access active",
    stageIndex: 5,
    subRequests: [{ system: "Access active", status: "done", detail: "Granted" }],
  };

  it("lets only EDP staff move a request between stages", async () => {
    const fake = warehouse({ exists: true });
    const response = await api(fake)(legacy("transition-request", TRANSITION));
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("moves a request: its steps in one MERGE, then its status", async () => {
    const fake = warehouse({ exists: true });
    const response = await api(fake, STAFF)(legacy("transition-request", TRANSITION));
    expect(response.status).toBe(200);
    expect(fake.blocks()).toHaveLength(0);
    expect(writes(fake)).toEqual([
      "MERGE INTO `edp_vending`.`requests`.`request_steps`",
      "UPDATE `edp_vending`.`requests`.`access_requests`",
    ]);
  });

  it("refuses to move a request that isn't there", async () => {
    const fake = warehouse({ exists: false });
    const response = await api(fake, STAFF)(legacy("transition-request", TRANSITION));
    expect(response.status).toBe(404);
    expect(writes(fake)).toEqual([]);
  });

  const ATTESTATION = {
    id: "ATT-1",
    requestId: REQUEST.id,
    checklistItemId: "ldw",
    attested: true,
    attestedAt: "2026-09-30T12:00:00Z",
    source: "app",
    createdAt: "2026-09-30T12:00:00Z",
  };

  it("records an attestation: supersedes the person's earlier answer, then adds this one once", async () => {
    const fake = warehouse({ exists: true });
    const response = await api(fake)(legacy("append-waiver-attestation", ATTESTATION));
    expect(response.status).toBe(200);
    expect((await response.json()).result.attestorPrincipalId).toBe("scim-42");
    expect(fake.blocks()).toHaveLength(0);
    expect(writes(fake)).toEqual([
      "UPDATE `edp_vending`.`requests`.`waiver_attestations`",
      "INSERT INTO `edp_vending`.`requests`.`waiver_attestations`",
    ]);
    const supersede = fake.calls.find((c) => c.statement.startsWith("UPDATE"))!;
    expect(supersede.statement).toContain("AND id <> ");
    expect(Object.values(supersede.parameters)).toContain("scim-42");
  });

  it("refuses an attestation ID that's already recorded", async () => {
    const fake = warehouse({ exists: true, attestationExists: true });
    const response = await api(fake)(legacy("append-waiver-attestation", ATTESTATION));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("already-exists");
  });

  it("refuses a date that isn't one", async () => {
    const fake = warehouse({ exists: true });
    const response = await api(fake)(
      legacy("append-waiver-attestation", { ...ATTESTATION, attestedAt: "soon" }),
    );
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});
