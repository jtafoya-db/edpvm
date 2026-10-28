// @vitest-environment node
/**
 * The onboarding `mine`, `inbox` and `request` reads are set-based: one SQL
 * statement however many requests they return (the 1 + 3×N fan-out queued on
 * the warehouse until it scaled out). Real commands build the store on the
 * SQLite fake warehouse from the provisioning DDL; each read is then compared
 * with the old per-request path, run on the same rows, for the provider, the
 * business office, the CCB and a stranger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardingIntake, OnboardingRequest } from "../../../data/onboarding";
import { COMPLETE_INTAKE_ANSWERS } from "../../../data/onboarding/intake.fixtures";
import { DEFAULT_EFFECTIVE_SLA_CONFIG } from "../../../data/sla-config.ts";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import { stateOnlyOwners } from "../../../data/onboarding/owners.ts";
import { REQUEST_COLUMNS, toRequest } from "../areas/onboarding.ts";
import type { SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import type { SqlStatement } from "../sql-client.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const user = (principalId: string, roles: SessionUser["onboardingReviewerRoles"] = []) => ({
  principalId,
  displayName: principalId,
  email: `${principalId}@example.gov`,
  isAdmin: false,
  onboardingReviewerRoles: roles,
});
const PROVIDER = user("scim-provider");
const OTHER_PROVIDER = user("scim-other-provider");
const BUSINESS_OFFICE = user("scim-bo", ["business-office"]);
const CCB = user("scim-ccb", ["ccb"]);
const STRANGER = user("scim-stranger");

const intake = (n: number): OnboardingIntake => ({
  initiativeName: `Initiative ${n}`,
  businessCase: "Prioritize balance-due cases across treatment streams.",
  annualBenefit: 1_000_000 + n,
  levers: ["taxgap"],
  datasets: [
    {
      name: `Dataset ${n}a`,
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      ingestionMethod: "eftu",
      datasetTag: `dataset_${n}_a`,
      owners: [
        { name: "Olive Owner", email: "olive.owner@example.gov" },
        { name: "Bo Second", email: "bo.second@example.gov" },
      ],
    },
    {
      name: `Dataset ${n}b`,
      sourceSystem: "BMF / Business Master File",
      domain: "enforcement-collections",
      ingestionMethod: "informatica",
      datasetTag: `dataset_${n}_b`,
      owners: [{ name: "Cy Third", email: "cy.third@example.gov" }],
    },
  ],
  workspaceNeeds: { isolation: "shared", teamSize: 4 + n },
  answers: { ...COMPLETE_INTAKE_ANSWERS },
  initiativeOwner: { kind: "self" },
});

let warehouse: SqliteWarehouse;
let deps: DeltaApiDeps;
/** Every statement the API ran, with its parameters. */
let executed: SqlStatement[] = [];
let signedIn: SessionUser = PROVIDER;
let keys = 0;

const names = createStoreNames("edp_vending", "");

async function api<T>(user: SessionUser, method: "GET" | "POST", path: string, body?: unknown) {
  signedIn = user;
  const response = await handleDeltaApiRequest(
    new Request(`https://app.example/api/${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as T };
}

async function command(user: SessionUser, name: string, expectedVersion: number, payload: unknown) {
  const key = `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;
  const res = await api<{ result: OnboardingRequest }>(
    user,
    "POST",
    `commands/onboarding/${name}`,
    {
      idempotencyKey: key,
      expectedVersion,
      payload,
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result;
}

const read = <T>(user: SessionUser, name: string, query = "") =>
  api<T>(user, "GET", `reads/onboarding/${name}${query}`);

/** Statements the warehouse ran while `run` did. */
async function counted<T>(run: () => Promise<T>): Promise<{ value: T; statements: string[] }> {
  const before = warehouse.statements.length;
  const value = await run();
  return { value, statements: warehouse.statements.slice(before) };
}

/**
 * The reads as they were before (main at 0b55f4a): the request rows, then three
 * statements per request for its datasets, owners and actions, assembled the
 * same way, plus the action `payload` #221 resubmissions carry. Run on the same
 * warehouse, so the two paths see the same rows.
 */
async function oldPath(where: string, params: Record<string, string>, orderBy: string) {
  const sql = <T extends object>(statement: string, parameters: Record<string, unknown>) =>
    warehouse.client
      .execute<T>({ statement, parameters: parameters as never }, { readId: "old-path" })
      .then((r) => r.rows);
  const t = (table: string) => names.table("onboarding", table);
  const rows = await sql<Parameters<typeof toRequest>[0]>(
    `SELECT ${REQUEST_COLUMNS} FROM ${t("onboarding_requests")} WHERE ${where} ORDER BY ${orderBy}`,
    params,
  );
  return Promise.all(
    rows.map(async (row) => {
      const [datasets, owners, actions] = await Promise.all([
        sql<Parameters<typeof toRequest>[1][number]>(
          `SELECT id, onboarding_request_id, position, name, source_system, domain, ingestion_method, ingestion_details, dataset_tag FROM ${t("onboarding_intake_datasets")} WHERE onboarding_request_id = :id ORDER BY position`,
          { id: row.uuid },
        ),
        sql<Parameters<typeof toRequest>[2][number]>(
          `SELECT id, intake_dataset_id, position, person_display, person_email, person_principal_id FROM ${t("onboarding_intake_owners")} WHERE onboarding_request_id = :id ORDER BY intake_dataset_id, position`,
          { id: row.uuid },
        ),
        sql<Parameters<typeof toRequest>[3][number]>(
          `SELECT action_id, action, from_stage, to_stage, record_version, actor_principal_id, actor_display, CAST(occurred_at AS STRING) AS occurred_at, note, payload FROM ${t("onboarding_request_actions")} WHERE onboarding_request_id = :id ORDER BY record_version, occurred_at`,
          { id: row.uuid },
        ),
      ]);
      return toRequest(row, datasets, owners, actions, DEFAULT_EFFECTIVE_SLA_CONFIG);
    }),
  );
}

// The provider's reads carry owner match state only (#103, 103-B); the inbox keeps it all.
const oldMine = async (u: SessionUser) =>
  (await oldPath("provider_principal_id = :me", { me: u.principalId }, "submitted_at DESC")).map(
    stateOnlyOwners,
  );
const oldInbox = (stage: string) => oldPath("stage = :stage", { stage }, "stage_entered_at");

/** Submit `n` requests as `provider`, spaced a second apart so their order is fixed. */
async function submitMany(provider: SessionUser, n: number, from = 1) {
  const created: OnboardingRequest[] = [];
  for (let i = from; i < from + n; i++) {
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 9, 0, i)));
    created.push(await command(provider, "submit", 0, { intake: intake(i) }));
  }
  return created;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T09:00:00.000Z"));
  warehouse = createSqliteWarehouse({
    files: ["store-admin.sql", "store-teams.sql", "store-onboarding.sql"],
  });
  executed = [];
  const client = {
    execute: ((statement, tag) => {
      executed.push(statement);
      return warehouse.client.execute(statement, tag);
    }) as typeof warehouse.client.execute,
  };
  deps = {
    registry: createAppRegistry(),
    runner: createTransactionRunner({ client, names, sleep: async () => {} }),
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => signedIn,
    requirePrivacyAcknowledgment: async () => undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onboarding reads are set-based", () => {
  it.each([1, 3, 8])(
    "reads %i requests in one statement, for mine, inbox and request",
    async (n) => {
      const created = await submitMany(PROVIDER, n);

      const mine = await counted(() => read<OnboardingRequest[]>(PROVIDER, "mine"));
      expect(mine.value.body).toHaveLength(n);
      expect(mine.statements).toHaveLength(1);

      const inbox = await counted(() =>
        read<OnboardingRequest[]>(BUSINESS_OFFICE, "inbox", "?role=business-office"),
      );
      expect(inbox.value.body).toHaveLength(n);
      expect(inbox.statements).toHaveLength(1);

      const one = await counted(() =>
        read<OnboardingRequest>(PROVIDER, "request", `?id=${created[0]!.id}`),
      );
      expect(one.value.body.id).toBe(created[0]!.id);
      expect(one.statements).toHaveLength(1);
    },
  );

  it("returns exactly what the old per-request reads did, for every role", async () => {
    // A store with requests at every stage, from two providers.
    const [a1, a2, a3, a4] = await submitMany(PROVIDER, 4);
    const [b1, b2] = await submitMany(OTHER_PROVIDER, 2, 10);
    await command(BUSINESS_OFFICE, "decide", a1!.version, {
      requestId: a1!.id,
      decision: { type: "approve", note: "Strong ROI" },
    });
    const sent = await command(BUSINESS_OFFICE, "decide", a2!.version, {
      requestId: a2!.id,
      decision: { type: "send-back", to: "submitted", note: "Which streams?" },
    });
    await command(PROVIDER, "resubmit", sent.version, {
      requestId: a2!.id,
      resubmission: { answer: "Collections and exam." },
    });
    await command(BUSINESS_OFFICE, "decide", a3!.version, {
      requestId: a3!.id,
      decision: { type: "reject", note: "Duplicate." },
    });
    await command(PROVIDER, "withdraw", a4!.version, { requestId: a4!.id, note: "Not needed." });
    const atCcb = await command(BUSINESS_OFFICE, "decide", b1!.version, {
      requestId: b1!.id,
      decision: { type: "approve" },
    });
    await command(CCB, "decide", atCcb.version, {
      requestId: b1!.id,
      decision: { type: "approve" },
    });
    void b2;

    // The provider's own list, each provider's.
    for (const provider of [PROVIDER, OTHER_PROVIDER]) {
      const mine = await read<OnboardingRequest[]>(provider, "mine");
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual(await oldMine(provider));
    }
    // The business office's and the CCB's inboxes.
    const bo = await read<OnboardingRequest[]>(BUSINESS_OFFICE, "inbox", "?role=business-office");
    expect(bo.body).toEqual(await oldInbox("business-roi-review"));
    expect(bo.body.map((r) => r.id)).toEqual([a2!.id, b2!.id]);
    const ccb = await read<OnboardingRequest[]>(CCB, "inbox", "?role=ccb");
    expect(ccb.body).toEqual(await oldInbox("ccb"));
    expect(ccb.body.map((r) => r.id)).toEqual([a1!.id]);

    // Every request, as each role sees it: the provider or the current-stage reviewer, else not found.
    const all = [...(await oldMine(PROVIDER)), ...(await oldMine(OTHER_PROVIDER))];
    for (const viewer of [PROVIDER, OTHER_PROVIDER, BUSINESS_OFFICE, CCB, STRANGER]) {
      for (const expected of all) {
        const visible =
          expected.providerId === viewer.principalId ||
          (expected.stage === "business-roi-review" &&
            viewer.onboardingReviewerRoles.includes("business-office")) ||
          (expected.stage === "ccb" && viewer.onboardingReviewerRoles.includes("ccb"));
        const got = await read<OnboardingRequest | null>(viewer, "request", `?id=${expected.id}`);
        expect(got.body, `${viewer.principalId} reading ${expected.id}`).toEqual(
          visible ? expected : null,
        );
      }
    }

    // A stranger: no requests of their own, and no inbox.
    expect((await read<OnboardingRequest[]>(STRANGER, "mine")).body).toEqual([]);
    expect((await read(STRANGER, "inbox", "?role=business-office")).status).toBe(403);
    expect((await read(STRANGER, "inbox", "?role=ccb")).status).toBe(403);
    // The intake children came back intact, not just the row.
    expect(bo.body[0]!.intake.datasets.map((d) => d.owners.length)).toEqual([2, 1]);
    expect(bo.body[0]!.decisions.map((d) => d.kind)).toEqual([
      "submit",
      "forward",
      "send-back",
      "resubmit",
    ]);
  });

  it("reads a request with no rows in a child table as empty, not missing", async () => {
    const [created] = await submitMany(PROVIDER, 1);
    warehouse.query(`DELETE FROM "onboarding__onboarding_intake_owners"`);
    const got = await read<OnboardingRequest>(PROVIDER, "request", `?id=${created!.id}`);
    expect(got.body.intake.datasets.map((d) => d.owners)).toEqual([[], []]);
    expect(got.body).toEqual((await oldMine(PROVIDER))[0]);
  });

  it("scopes a single-request read to the caller in its SQL, so an unseen request's children are never read", async () => {
    const [created] = await submitMany(PROVIDER, 1); // at business & ROI review

    /** The one statement a request read runs as `who`, and what it returns. */
    const requestRead = async (who: SessionUser, id: string) => {
      executed = [];
      const response = await read<OnboardingRequest | null>(who, "request", `?id=${id}`);
      expect(executed).toHaveLength(1);
      return { response, statement: executed[0]! };
    };

    // A stranger: their own ID is the only scope, so the statement selects no
    // row, and the correlated child subqueries never run for this request.
    const stranger = await requestRead(STRANGER, created!.id);
    expect(stranger.statement.statement).toContain(
      "WHERE r.display_code = :display AND (r.provider_principal_id = :viewer) ORDER BY",
    );
    expect(stranger.statement.parameters).toMatchObject({ viewer: STRANGER.principalId });
    expect(Object.keys(stranger.statement.parameters ?? {})).not.toContain("viewer_stage_0");
    const direct = await warehouse.client.execute(stranger.statement, { readId: "replay" });
    expect(direct.rows).toEqual([]);
    // Not found, exactly as for an ID that doesn't exist.
    const madeUp = await requestRead(STRANGER, "ONB-9999");
    expect(stranger.response).toEqual({ status: 200, body: null });
    expect(madeUp.response).toEqual(stranger.response);

    // The wrong-stage reviewer (CCB) is scoped to the CCB stage, and sees nothing here either.
    const ccb = await requestRead(CCB, created!.id);
    expect(ccb.statement.statement).toContain(
      "(r.provider_principal_id = :viewer OR r.stage IN (:viewer_stage_0))",
    );
    expect(ccb.statement.parameters).toMatchObject({
      viewer: CCB.principalId,
      viewer_stage_0: "ccb",
    });
    expect((await warehouse.client.execute(ccb.statement, { readId: "replay" })).rows).toEqual([]);
    expect(ccb.response.body).toBeNull();

    // The business office (its stage) and the provider (their own) do read it.
    const bo = await requestRead(BUSINESS_OFFICE, created!.id);
    expect(bo.statement.parameters).toMatchObject({ viewer_stage_0: "business-roi-review" });
    expect(bo.response.body?.id).toBe(created!.id);
    expect((await requestRead(PROVIDER, created!.id)).response.body?.id).toBe(created!.id);
  });
});
