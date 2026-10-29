/**
 * The `initiatives`, `teams` and `change-list` areas (#123) through the
 * transaction runner, over the SQLite fake warehouse (sqlite-warehouse.ts)
 * built from `resources/store-teams.sql`.
 *
 * The behaviour screens see is covered on both backends by the contract
 * tests (src/data/__tests__/dataset-team*.test.ts). These cover what only
 * the Delta path has: races between two sessions, the transactions behind
 * one action, the rows and action rows it leaves, refusals recorded in
 * their own commit, version conflicts, the configured-dataset loader, and
 * the change list's derived stage (ADR-0008).
 */
import { describe, expect, it } from "vitest";

import {
  DATASET_ID,
  OWNER,
  STAFF,
  STRANGER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "../../../data/__tests__/dataset-fixture";
import { createDeltaHarness } from "../../../data/__tests__/team-backends";
import type { UserProfile } from "../../../data/types";
import { registerTeamsArea } from "../areas/teams.ts";
import { loadConfiguredDatasets } from "../areas/teams-seed.ts";
import { createRegistry, type CommandDefinition, type SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { createSqliteWarehouse, type SqliteWarehouse } from "./sqlite-warehouse.ts";

const TESS = { datasetId: DATASET_ID, name: "Tess Tester", email: "tess.tester@example.gov" };
/** A second seeded owner of the dataset. */
const QUINN: UserProfile = {
  ...OWNER,
  principalId: "scim-owner-2",
  name: "Quinn Second",
  email: "quinn@example.gov",
};

function twoOwnerSeed() {
  const seed = makeDatasetSeed();
  seed.datasets[0]!.owners.push({ principalId: QUINN.principalId, displayName: QUINN.name });
  return seed;
}

/** Two browser sessions on one store. */
function twoSessions(first: UserProfile, second: UserProfile) {
  const clock = makeClock();
  const common = {
    now: clock.now,
    datasetSeed: twoOwnerSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  };
  const a = createDeltaHarness({ ...common, currentUser: async () => first });
  const b = createDeltaHarness({
    ...common,
    currentUser: async () => second,
    warehouse: a.warehouse,
  });
  return { a: a.store, b: b.store, warehouse: a.warehouse, clock };
}

const count = (warehouse: SqliteWarehouse, table: string, where = "TRUE") =>
  Number(
    warehouse.query<{ n: number }>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`)[0]!.n,
  );

const atomicBlockCount = (warehouse: SqliteWarehouse) =>
  warehouse.statements.filter((s) => s.startsWith("BEGIN ATOMIC")).length;

async function waitForAtomicBlocks(warehouse: SqliteWarehouse, count: number) {
  const start = Date.now();
  while (atomicBlockCount(warehouse) < count) {
    if (Date.now() - start > 1_000) throw new Error(`Timed out waiting for ${count} blocks.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("races between two sessions", () => {
  it("two owners adding the same person at once give one member and one change-list entry", async () => {
    const { a, b, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasets.listDatasets(); // the configured datasets are loaded

    const beforeBlocks = atomicBlockCount(warehouse);
    const release = warehouse.hold();
    const both = Promise.all([
      a.datasetRoles.addMember({ ...TESS, role: "tester" }),
      b.datasetRoles.addMember({ ...TESS, role: "tester" }),
    ]);
    // Both blocks were planned from the same state before either committed.
    await waitForAtomicBlocks(warehouse, beforeBlocks + 2);
    release();
    const results = await both;

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results.flatMap((r) => r.entries)).toHaveLength(1);
    expect(count(warehouse, "teams__dataset_members", "person_email = 'tess.tester@example.gov'")).toBe(
      1,
    );
    expect(count(warehouse, "change_list__change_list_entries")).toBe(1);
    expect(
      count(
        warehouse,
        "teams__dataset_member_actions",
        "action = 'added' AND actor_app = 'tenant'",
      ),
    ).toBe(1);
    // The loser was refused by Delta's conflict, and retried from a fresh read.
    expect(warehouse.conflicts).toBeGreaterThanOrEqual(1);
  });

  it("two owners adding the same person with different roles converge to one member and one entry", async () => {
    const { a, b, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasets.listDatasets(); // the configured datasets are loaded

    const beforeBlocks = atomicBlockCount(warehouse);
    const release = warehouse.hold();
    const both = Promise.allSettled([
      a.datasetRoles.addMember({ ...TESS, role: "tester" }),
      b.datasetRoles.addMember({ ...TESS, role: "developer" }),
    ]);
    await waitForAtomicBlocks(warehouse, beforeBlocks + 2);
    release();
    const results = await both;

    // One add wins; the loser re-reads, sees the role the winner wrote, and is
    // refused as a duplicate (one role per person per dataset, ADR-0007 d.11).
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason.code).toBe("duplicate");
    expect(count(warehouse, "teams__dataset_members", "person_email = 'tess.tester@example.gov'")).toBe(
      1,
    );
    expect(count(warehouse, "change_list__change_list_entries")).toBe(1);
  });

  it("an add made in one session is visible from another, which acts on what it reads", async () => {
    const { a, b } = twoSessions(OWNER, QUINN);
    await a.datasetRoles.addMember({ ...TESS, role: "tester" });

    // The second session reads the member (version 1); the first then changes it.
    expect((await b.datasetRoles.listMembers(DATASET_ID)).map((m) => m.person.email)).toContain(
      TESS.email,
    );
    await a.datasetTeam.changeMemberRole({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
      newRole: "developer",
    });

    await expect(
      b.datasetTeam.removeMember({ datasetId: DATASET_ID, email: TESS.email, role: "developer" }),
    ).resolves.toBeDefined(); // no screen read of the new role: a fresh read, then the write
    expect(await a.datasetRoles.listMembers(DATASET_ID)).toHaveLength(2); // the two owners' managers
  });

  it("refuses a role change sent with the version a screen read before someone else changed it", async () => {
    const { a, b } = twoSessions(OWNER, QUINN);
    await a.datasetRoles.addMember({ ...TESS, role: "tester" });
    await b.datasetRoles.listMembers(DATASET_ID); // b's screen shows the tester role at version 1
    await a.datasetTeam.changeMemberRole({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
      newRole: "developer",
    });
    await a.datasetTeam.changeMemberRole({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "developer",
      newRole: "tester",
    });

    await expect(
      b.datasetTeam.changeMemberRole({
        datasetId: DATASET_ID,
        email: TESS.email,
        role: "tester",
        newRole: "manager",
      }),
    ).rejects.toMatchObject({
      code: "version-conflict",
      message: expect.stringMatching(/Reload to see the latest/),
    });
  });

  it("two staff marking one entry applied at once record one application", async () => {
    const { a, b, warehouse } = twoSessions(STAFF, { ...STAFF, principalId: "scim-staff-2" });
    const owner = createDeltaHarness({
      currentUser: async () => OWNER,
      warehouse,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    const { entries } = await owner.store.datasetRoles.addMember({ ...TESS, role: "tester" });
    await a.changeList.listEntries();
    await b.changeList.listEntries();

    const beforeBlocks = atomicBlockCount(warehouse);
    const release = warehouse.hold();
    const both = Promise.allSettled([
      a.changeList.markApplied(entries[0]!.id),
      b.changeList.markApplied(entries[0]!.id),
    ]);
    await waitForAtomicBlocks(warehouse, beforeBlocks + 2);
    release();
    const outcomes = await both;

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(["already-applied", "version-conflict"]).toContain(refused.reason.code);
    expect(count(warehouse, "change_list__change_list_applications")).toBe(1);
  });
});

describe("what one action writes", () => {
  it("adds the member, its action, the entry with a CL number and its listed action in one transaction", async () => {
    const { a, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasetRoles.addMember({ ...TESS, role: "tester" });

    const [action] = warehouse.query<Record<string, unknown>>(
      `SELECT * FROM "teams__dataset_member_actions" WHERE actor_app = 'tenant'`,
    );
    expect(action).toMatchObject({
      action: "added",
      to_role: "tester",
      record_version: 1,
      actor_principal_id: OWNER.principalId,
      actor_display: OWNER.name,
      caused_by_action_id: null,
    });
    expect(JSON.parse(String(action!["command"]))).toMatchObject({
      area: "teams",
      command: "add-member",
      actor: OWNER.principalId,
    });
    const [entry] = warehouse.query<Record<string, unknown>>(
      `SELECT * FROM "change_list__change_list_entries"`,
    );
    expect(entry).toMatchObject({
      display_number: 1,
      kind: "add-member",
      reason: "dataset-role-added",
      caused_by_action_id: action!["action_id"],
      group_name: "edp-refund_anomalies-tester",
    });
    const [listed] = warehouse.query<Record<string, unknown>>(
      `SELECT * FROM "change_list__change_list_entry_actions"`,
    );
    expect(listed).toMatchObject({
      action: "listed",
      to_stage: "pending",
      caused_by_action_id: action!["action_id"],
      idempotency_key: action!["idempotency_key"],
    });
    expect(JSON.parse(String(action!["expected_effects"]))).toHaveLength(3);
  });

  it("numbers change-list entries in order from the counter (ADR-0007 decision 2: CL stays sequential)", async () => {
    const { a, warehouse } = twoSessions(OWNER, QUINN);
    const first = await a.datasetRoles.addMember({ ...TESS, role: "tester" });
    const second = await a.datasetRoles.addMember({
      ...TESS,
      name: "Uma Second",
      email: "uma.second@example.gov",
      role: "tester",
    });
    expect([...first.entries, ...second.entries].map((entry) => entry.id)).toEqual([
      "CL-0001",
      "CL-0002",
    ]);
    expect(
      warehouse.query(`SELECT next_number FROM "admin__display_counters" WHERE prefix = 'CL'`),
    ).toEqual([{ next_number: 3 }]);
  });

  it("rolls the whole block back when a rule fails inside it", async () => {
    const { a, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasets.listDatasets();
    const before = warehouse.query(
      `SELECT next_number FROM "admin__display_counters" WHERE prefix = 'CL'`,
    );
    await expect(
      a.datasetRoles.addMember({ ...TESS, datasetId: "ds-payroll-events", role: "tester" }),
    ).rejects.toMatchObject({ code: "not-active" });
    expect(
      warehouse.query(`SELECT next_number FROM "admin__display_counters" WHERE prefix = 'CL'`),
    ).toEqual(before);
    expect(count(warehouse, "teams__dataset_member_actions", "actor_app = 'tenant'")).toBe(0);
  });

  it("records an ADR-0006 refusal in its own commit, moving the owner's version, though the action is refused", async () => {
    const { a, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasetTeam.addOwner({ datasetId: DATASET_ID, name: "Drew", email: "drew@example.gov" });
    const drew = createDeltaHarness({
      currentUser: async () => ({ ...STRANGER, principalId: "scim-drew", email: "drew@example.gov" }),
      warehouse,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    await drew.store.datasetRoles.addMember({ ...TESS, role: "tester" }); // binds drew@example.gov
    expect(
      count(
        warehouse,
        "teams__email_bindings",
        "email = 'drew@example.gov' AND principal_id = 'scim-drew'",
      ),
    ).toBe(1);
    expect(count(warehouse, "teams__dataset_owner_actions", "action = 'bound'")).toBe(1);

    const impostor = createDeltaHarness({
      currentUser: async () => ({
        ...STRANGER,
        principalId: "scim-impostor",
        email: "drew@example.gov",
      }),
      warehouse,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    await expect(
      impostor.store.datasetRoles.addMember({ ...TESS, role: "developer" }),
    ).rejects.toMatchObject({ code: "owner-mismatch" });

    const [refusal] = warehouse.query<Record<string, unknown>>(
      `SELECT * FROM "teams__dataset_owner_actions" WHERE action = 'access-refused'`,
    );
    expect(JSON.parse(String(refusal!["payload"]))).toMatchObject({
      refusedPrincipalId: "scim-impostor",
    });
    expect(refusal!["actor_principal_id"]).toBe("scim-impostor");
    const [owner] = warehouse.query<{ version: number; last_action_id: string }>(
      `SELECT version, last_action_id FROM "teams__dataset_owners" WHERE person_email = 'drew@example.gov'`,
    );
    expect(owner).toEqual({ version: 3, last_action_id: refusal!["action_id"] }); // added, bound, refused
    expect(count(warehouse, "teams__dataset_members", "role = 'developer'")).toBe(0);
  });

  it("refuses an owner-protected command whose claim wasn't made first, and names the actor from the session only", async () => {
    const { a, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasetTeam.addOwner({ datasetId: DATASET_ID, name: "Drew", email: "drew@example.gov" });
    const names = createStoreNames("edp_test", "");
    const runner = createTransactionRunner({
      client: warehouse.client,
      names,
      sleep: async () => undefined,
    });
    const registry = createRegistry();
    registerTeamsArea(registry, {
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    const add = registry.findWrite("teams", "add-member") as CommandDefinition<unknown, unknown>;
    const drew: SessionUser = {
      principalId: "scim-drew",
      displayName: "Drew",
      email: "drew@example.gov",
      isAdmin: false,
      onboardingReviewerRoles: [],
    };

    await expect(
      runner.runCommand(add, {
        user: drew,
        actor: { principalId: drew.principalId, display: drew.displayName, app: "tenant" },
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 0,
        payload: { ...TESS, role: "tester" },
      }),
    ).rejects.toMatchObject({ code: "claim-required" });
  });

  it("records an access-refused row when a non-cooperating client calls a protected command directly on a mismatch", async () => {
    const { a, warehouse } = twoSessions(OWNER, QUINN);
    await a.datasetTeam.addOwner({ datasetId: DATASET_ID, name: "Drew", email: "drew@example.gov" });
    const drew = createDeltaHarness({
      currentUser: async () => ({ ...STRANGER, principalId: "scim-drew", email: "drew@example.gov" }),
      warehouse,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    await drew.store.datasetRoles.addMember({ ...TESS, role: "tester" }); // binds drew@example.gov

    // A client that skips the ownership read and its refusal call, and sends
    // the protected command straight to the runner.
    const names = createStoreNames("edp_test", "");
    const registry = createRegistry();
    registerTeamsArea(registry, {
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    const runner = createTransactionRunner({
      client: warehouse.client,
      names,
      sleep: async () => undefined,
      refusalCommand: () =>
        registry.findWrite("teams", "record-ownership-refusal") as
          CommandDefinition<{ datasetId: string }, unknown> | undefined,
    });
    const add = registry.findWrite("teams", "add-member") as CommandDefinition<unknown, unknown>;
    const impostor: SessionUser = {
      principalId: "scim-impostor",
      displayName: "Imposter",
      email: "drew@example.gov",
      isAdmin: false,
      onboardingReviewerRoles: [],
    };

    await expect(
      runner.runCommand(add, {
        user: impostor,
        actor: { principalId: impostor.principalId, display: impostor.displayName, app: "tenant" },
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 0,
        payload: {
          datasetId: DATASET_ID,
          name: "New Member",
          email: "new.member@example.gov",
          role: "developer",
        },
      }),
    ).rejects.toMatchObject({ code: "owner-mismatch" });

    // The refusal is audited in its own commit, though the client never called
    // record-ownership-refusal, and the add wrote no member.
    const [refusal] = warehouse.query<Record<string, unknown>>(
      `SELECT * FROM "teams__dataset_owner_actions" WHERE action = 'access-refused'`,
    );
    expect(refusal).toBeDefined();
    expect(JSON.parse(String(refusal!["payload"]))).toMatchObject({
      refusedPrincipalId: "scim-impostor",
    });
    expect(refusal!["actor_principal_id"]).toBe("scim-impostor");
    expect(count(warehouse, "teams__dataset_members", "person_email = 'new.member@example.gov'")).toBe(
      0,
    );
  });
});

describe("the change list's stage is derived (ADR-0008)", () => {
  it("marks applied by inserting an application by hand, and the entry's description never changes", async () => {
    const { a, warehouse, clock } = twoSessions(OWNER, QUINN);
    const staff = createDeltaHarness({
      currentUser: async () => STAFF,
      warehouse,
      now: clock.now,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    const { entries } = await a.datasetRoles.addMember({ ...TESS, role: "tester" });
    const before = warehouse.query(
      `SELECT kind, reason, group_name, role, person_email, grants FROM "change_list__change_list_entries"`,
    );

    const applied = await staff.store.changeList.markApplied(entries[0]!.id);

    expect(applied.applied).toEqual({ by: STAFF.principalId, at: "2026-10-01T12:00:00.000Z" });
    expect(
      warehouse.query(
        `SELECT method, run_id, created_by_principal_id FROM "change_list__change_list_applications"`,
      ),
    ).toEqual([{ method: "by-hand", run_id: null, created_by_principal_id: STAFF.principalId }]);
    expect(
      warehouse.query(
        `SELECT kind, reason, group_name, role, person_email, grants FROM "change_list__change_list_entries"`,
      ),
    ).toEqual(before);
    expect(
      warehouse.query(
        `SELECT action, from_stage, to_stage, actor_app FROM "change_list__change_list_entry_actions" ORDER BY rowid`,
      ),
    ).toEqual([
      { action: "listed", from_stage: null, to_stage: "pending", actor_app: "tenant" },
      { action: "applied", from_stage: "pending", to_stage: "applied", actor_app: "staff" },
    ]);
  });

  it("refuses with 409 when a matching removal reaches the store after the apply plan read", async () => {
    const { a, warehouse, clock } = twoSessions(OWNER, QUINN);
    const staff = createDeltaHarness({
      currentUser: async () => STAFF,
      warehouse,
      now: clock.now,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    await a.datasetRoles.addMember({ ...TESS, role: "tester" });
    const entry = warehouse.query<{ id: string; version: number }>(
      `SELECT id, version FROM "change_list__change_list_entries"`,
    )[0]!;
    const { id, version } = entry;
    const execute = warehouse.client.execute.bind(warehouse.client);
    let injected = false;
    warehouse.client.execute = async (statement, tag) => {
      if (
        !injected &&
        statement.statement.startsWith("BEGIN ATOMIC") &&
        statement.statement.includes("change_list_applications")
      ) {
        injected = true;
        await a.datasetTeam.removeMember({ ...TESS, role: "tester" });
      }
      return execute(statement, tag);
    };

    const response = await staff.fetch("http://edp.test/api/commands/change-list/mark-applied", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "00000000-0000-4000-8000-000000000311",
        expectedVersion: version,
        payload: { entryId: id },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "superseded", message: "This change is no longer pending." },
    });
    expect(count(warehouse, "change_list__change_list_applications")).toBe(0);
  });

  it("does not let a matching email override differing principal IDs in the commit guard", async () => {
    const { a, warehouse, clock } = twoSessions(OWNER, QUINN);
    const staff = createDeltaHarness({
      currentUser: async () => STAFF,
      warehouse,
      now: clock.now,
      datasetSeed: twoOwnerSeed(),
      groupNaming: TEST_GROUP_NAMING,
      roleDescriptions: TEST_ROLE_DESCRIPTIONS,
    });
    await a.datasetRoles.addMember({ ...TESS, role: "tester" });
    warehouse.query(
      `UPDATE "change_list__change_list_entries" SET person_principal_id = 'scim-tess-old'`,
    );
    const entry = warehouse.query<{ id: string; version: number }>(
      `SELECT id, version FROM "change_list__change_list_entries"`,
    )[0]!;
    const { id, version } = entry;
    const execute = warehouse.client.execute.bind(warehouse.client);
    let injected = false;
    warehouse.client.execute = async (statement, tag) => {
      if (
        !injected &&
        statement.statement.startsWith("BEGIN ATOMIC") &&
        statement.statement.includes("change_list_applications")
      ) {
        injected = true;
        await a.datasetTeam.removeMember({ ...TESS, role: "tester" });
        warehouse.query(
          `UPDATE "change_list__change_list_entries" SET person_principal_id = 'scim-tess-new' WHERE id <> :id`,
          { id },
        );
      }
      return execute(statement, tag);
    };

    const response = await staff.fetch("http://edp.test/api/commands/change-list/mark-applied", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "00000000-0000-4000-8000-000000000312",
        expectedVersion: version,
        payload: { entryId: id },
      }),
    });

    expect(response.status).toBe(200);
    expect(count(warehouse, "change_list__change_list_applications")).toBe(1);
  });
});

describe("change-list membership observation uses the real server reader", () => {
  it("rebuilds cached applications and owner visibility before adding snapshot verification", async () => {
    const registry = createRegistry();
    registerTeamsArea(registry, {
      now: () => new Date("2026-10-01T12:00:00.000Z"),
      groupMembershipReader: {
        latestRun: async () => ({
          runId: "run-88",
          startedAt: "2026-10-01T11:58:00.000Z",
          endedAt: "2026-10-01T11:59:00.000Z",
          status: "succeeded",
          groupsExpected: ["g88"],
          groupsRead: ["g88"],
          complete: true,
        }),
        listMemberships: async () => [
          {
            groupName: "edp-refund_anomalies-tester",
            groupId: "g88",
            kind: "dataset",
            domain: "individual-filing",
            datasetTag: "refund_anomalies",
            managedBy: "manual",
            userId: "scim-tess-1",
            email: "tess.tester@example.gov",
            displayName: "Tess Tester",
            firstSeen: "2026-10-01T11:58:00.000Z",
            lastSeen: "2026-10-01T11:59:00.000Z",
          },
        ],
        listHistory: async () => ({ rows: [], nextCursor: null }),
      },
    });
    const tables = new Map<string, Record<string, unknown>[]>([
      [
        "change_list.change_list_entries",
        [
          {
            id: "entry-1",
            display_number: 1,
            kind: "add-member",
            reason: "dataset-role-added",
            dataset_id: DATASET_ID,
            group_name: "edp-refund_anomalies-tester",
            role: "tester",
            target_payload: null,
            person_display: "Tess Tester",
            person_email: "tess.tester@example.gov",
            person_principal_id: null,
            grants: ["SELECT"],
            version: 1,
            created_at: "2026-10-01T11:00:00.000Z",
            created_by_principal_id: OWNER.principalId,
            caused_by_action_id: null,
          },
        ],
      ],
      [
        "change_list.change_list_applications",
        [
          {
            change_list_entry_id: "entry-1",
            created_at: "2026-10-01T11:30:00.000Z",
            created_by_principal_id: STAFF.principalId,
          },
        ],
      ],
      [
        "initiatives.datasets",
        [
          {
            id: DATASET_ID,
            initiative_id: "INI-001",
            name: "Refund anomaly scores",
            domain_tag: "individual-filing",
            dataset_tag: "refund_anomalies",
            version: 1,
          },
        ],
      ],
      [
        "teams.dataset_owners",
        [
          {
            id: "owner-1",
            dataset_id: DATASET_ID,
            source: "seed",
            person_display: OWNER.name,
            person_email: OWNER.email,
            person_principal_id: OWNER.principalId,
            bound_at: null,
            version: 1,
            created_at: "2026-09-01T00:00:00.000Z",
            created_by_principal_id: "system",
            last_action_id: null,
          },
        ],
      ],
      ["teams.dataset_owner_actions", []],
      ["teams.dataset_member_actions", []],
    ]);
    const snapshot = {
      table: <T>(schema: string, table: string) =>
        structuredClone(tables.get(`${schema}.${table}`) ?? []) as T[],
      stats: () => ({ loadedAt: 0, elapsedMs: 0, rowCounts: {}, approxBytes: 0 }),
    };
    const definition = registry.findRead("change-list", "entries")!;
    const context = (user: SessionUser) => ({
      query: {},
      user,
      names: createStoreNames("catalog"),
      snapshot,
    });
    const owner = {
      principalId: OWNER.principalId,
      displayName: OWNER.name,
      email: OWNER.email!,
      isAdmin: false,
      onboardingReviewerRoles: [],
    };

    expect(await definition.snapshot!(context(owner))).toEqual([
      expect.objectContaining({
        id: "CL-0001",
        applied: { by: STAFF.principalId, at: "2026-10-01T11:30:00.000Z" },
        verified: { runId: "run-88", at: "2026-10-01T11:59:00.000Z" },
      }),
    ]);
    expect(
      await definition.snapshot!(
        context({ ...owner, principalId: STRANGER.principalId, email: STRANGER.email! }),
      ),
    ).toEqual([]);
  });

  it("reads snapshot metadata and rows through membershipReaderFor", async () => {
    const registry = createRegistry();
    registerTeamsArea(registry, {
      membership: { catalog: "membership_catalog", schema: "membership" },
      now: () => new Date("2026-10-01T12:00:00.000Z"),
    });
    const read = async <T extends object>({ statement }: { statement: string }): Promise<T[]> => {
      if (statement.includes("change_list_entries")) {
        return [
          {
            id: "entry-1",
            display_number: 1,
            kind: "add-member",
            reason: "dataset-role-added",
            dataset_id: DATASET_ID,
            group_name: "edp-refund_anomalies-tester",
            role: "tester",
            target_payload: null,
            person_display: "Tess Tester",
            person_email: "tess.tester@example.gov",
            person_principal_id: null,
            grants: '["SELECT"]',
            version: 1,
            created_at: "2026-10-01T11:00:00.000Z",
            created_by_principal_id: OWNER.principalId,
            from_role: null,
            to_role: null,
            applied_at: null,
            applied_by_principal_id: null,
          },
        ] as T[];
      }
      if (statement.includes("initiatives`.`datasets")) {
        return [
          {
            id: DATASET_ID,
            initiative_id: "INI-001",
            name: "Refund anomaly scores",
            domain_tag: "individual-filing",
            dataset_tag: "refund_anomalies",
            version: 1,
          },
        ] as T[];
      }
      if (statement.includes("snapshot_runs")) {
        return [
          {
            run_id: "run-88",
            started_at: "2026-10-01T11:58:00.000Z",
            ended_at: "2026-10-01T11:59:00.000Z",
            status: "succeeded",
            groups_expected: ["g88"],
            groups_read: ["g88"],
          },
        ] as T[];
      }
      if (statement.includes("group_members")) {
        return [
          {
            group_name: "edp-refund_anomalies-tester",
            group_id: "g88",
            kind: "dataset",
            domain: "individual-filing",
            dataset_tag: "refund_anomalies",
            managed_by: "manual",
            user_id: "scim-tess-1",
            email: "tess.tester@example.gov",
            display_name: "Tess Tester",
            first_seen: "2026-10-01T11:58:00.000Z",
            last_seen: "2026-10-01T11:59:00.000Z",
            removed_at: null,
          },
        ] as T[];
      }
      return [];
    };

    const result = await registry.findRead("change-list", "entries")!.run({
      query: {},
      user: {
        principalId: STAFF.principalId,
        displayName: STAFF.name,
        email: STAFF.email!,
        isAdmin: true,
        onboardingReviewerRoles: [],
      },
      names: createStoreNames("catalog"),
      read: read as never,
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: "CL-0001",
        applied: null,
        verified: { runId: "run-88", at: "2026-10-01T11:59:00.000Z" },
      }),
    ]);
  });
});

describe("the datasets and owners from deployment configuration", () => {
  function setup() {
    const warehouse = createSqliteWarehouse();
    const names = createStoreNames("edp_test", "");
    const runner = createTransactionRunner({
      client: warehouse.client,
      names,
      sleep: async () => undefined,
    });
    return { warehouse, names, runner };
  }

  it("load once, as created and added actions by system, with no change-list entries", async () => {
    const { warehouse, names, runner } = setup();
    await loadConfiguredDatasets(twoOwnerSeed(), { runner, names, groupNaming: TEST_GROUP_NAMING });
    await loadConfiguredDatasets(twoOwnerSeed(), { runner, names, groupNaming: TEST_GROUP_NAMING });

    expect(count(warehouse, "initiatives__initiatives")).toBe(2);
    expect(count(warehouse, "initiatives__datasets")).toBe(2);
    expect(count(warehouse, "teams__dataset_owners")).toBe(3);
    expect(
      count(warehouse, "teams__dataset_members", "role = 'manager' AND source = 'configuration'"),
    ).toBe(3);
    expect(count(warehouse, "change_list__change_list_entries")).toBe(0);
    for (const table of [
      "initiatives__initiative_actions",
      "initiatives__dataset_actions",
      "teams__dataset_owner_actions",
      "teams__dataset_member_actions",
    ]) {
      expect(
        count(warehouse, table, "actor_principal_id <> 'system' OR actor_app <> 'system'"),
        table,
      ).toBe(0);
    }
    expect(warehouse.query(`SELECT action FROM "initiatives__initiative_actions"`)).toEqual([
      { action: "created" },
      { action: "created" },
    ]);
  });

  it("two servers loading at once write each initiative once", async () => {
    const { warehouse, names, runner } = setup();
    const beforeBlocks = atomicBlockCount(warehouse);
    const release = warehouse.hold();
    const both = Promise.all([
      loadConfiguredDatasets(makeDatasetSeed(), { runner, names, groupNaming: TEST_GROUP_NAMING }),
      loadConfiguredDatasets(makeDatasetSeed(), { runner, names, groupNaming: TEST_GROUP_NAMING }),
    ]);
    await waitForAtomicBlocks(warehouse, beforeBlocks + 2);
    release();
    await both;

    expect(count(warehouse, "initiatives__initiatives")).toBe(2);
    expect(count(warehouse, "teams__dataset_owners")).toBe(2);
  });

  it("leaves Delta as it is when the configured owners change after the first load", async () => {
    const { warehouse, names, runner } = setup();
    await loadConfiguredDatasets(makeDatasetSeed(), {
      runner,
      names,
      groupNaming: TEST_GROUP_NAMING,
    });
    await loadConfiguredDatasets(twoOwnerSeed(), { runner, names, groupNaming: TEST_GROUP_NAMING });
    expect(count(warehouse, "teams__dataset_owners")).toBe(2);
  });

  it("refuses configuration whose group names would be ambiguous, and writes nothing", async () => {
    const { warehouse, names, runner } = setup();
    const seed = makeDatasetSeed();
    seed.datasets[1]!.datasetTag = seed.datasets[0]!.datasetTag;
    await expect(
      loadConfiguredDatasets(seed, { runner, names, groupNaming: TEST_GROUP_NAMING }),
    ).rejects.toMatchObject({
      code: "configuration-invalid",
      message: expect.stringMatching(/same group name/),
    });
    expect(count(warehouse, "initiatives__initiatives")).toBe(0);
  });

  it("refuses a group-name template that doesn't name the dataset and role, as the memory store does", () => {
    expect(() =>
      registerTeamsArea(createRegistry(), {
        groupNaming: { datasetGroup: "edp-{datasetTag}", overrides: {} },
      }),
    ).toThrow(/\{role\}/);
    const { manager: _omitted, ...twoRoles } = TEST_ROLE_DESCRIPTIONS.roles;
    expect(() =>
      registerTeamsArea(createRegistry(), {
        roleDescriptions: { ...TEST_ROLE_DESCRIPTIONS, roles: twoRoles as never },
      }),
    ).toThrow(/manager/);
  });
});
