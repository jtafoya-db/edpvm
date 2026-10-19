// @vitest-environment node
/**
 * The slim create block (#173), at the transaction runner's seam.
 *
 * A create (every row it writes is an insert) builds its response from the
 * values it inserted and skips the post-insert row counts: an all-or-nothing
 * block that commits has committed every insert. An update keeps its version
 * and affected-row guards and re-reads its row. Both keep the key-race guard,
 * the display counter and the lead action with its stored command and result.
 *
 * Shapes are checked on the SQL the runner sends; the stored responses run
 * for real on the SQLite fake warehouse built from the provisioning DDL.
 */
import { describe, expect, it } from "vitest";

import { WRITE_CHECKS, WRITE_CHECK_ACTIONS, registerAdminArea } from "../areas/admin.ts";
import { createRegistry, type CommandDefinition, type SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner } from "../transaction.ts";
import { followOn, insertAction, insertCurrentState, type ActionActor } from "../write-helpers.ts";
import { APPLICANT, VAL, VALUES, deltaImplementation, pdf } from "./eir-harness.ts";
import { createSqliteWarehouse } from "./eir-sqlite-warehouse.ts";
import { committed, fakeSqlClient, insertedValue } from "./fake-sql-client.ts";

const STAFF: SessionUser = {
  principalId: "4055694201057157",
  displayName: "Sam Staff",
  email: "sam.staff@example.test",
  isAdmin: true,
  onboardingReviewerRoles: [],
};
const ACTOR: ActionActor = { principalId: STAFF.principalId, display: "Sam Staff", app: "staff" };
const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";
const CHECK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const names = createStoreNames("edp_vending", "");

function adminCommands() {
  const registry = createRegistry();
  registerAdminArea(registry);
  return {
    record: registry.findWrite("admin", "record-write-check") as CommandDefinition<
      { name: string },
      Record<string, unknown>
    >,
    confirm: registry.findWrite("admin", "confirm-write-check") as CommandDefinition<
      { writeCheckId: string },
      Record<string, unknown>
    >,
  };
}

const create = { user: STAFF, actor: ACTOR, idempotencyKey: KEY, expectedVersion: 0 };

/** The post-insert row count guards the runner adds to a non-create block. */
const COUNT_GUARD = /IF \(\(SELECT count\(\*\) FROM [^)]*\) <> 1\) THEN/;

/** The SQL the response row is read with: `SET edp_vN = (SELECT to_json(struct(*)) FROM (…))`. */
function resultSql(block: string): string {
  return /SET edp_v\d+ = \(SELECT to_json\(struct\(\*\)\) FROM \(([\s\S]*?)\) AS edp_result_row\);/.exec(
    block,
  )![1]!;
}

/** Plays the warehouse for the admin commands: no prior key, the write check exists at version 1. */
function adminWarehouse() {
  return fakeSqlClient((call) => {
    if (call.statement.includes("WHERE idempotency_key = :key")) return { rows: [] };
    if (call.statement.startsWith("BEGIN ATOMIC")) return committed(call, {});
    if (call.statement.includes("`write_checks` WHERE id = :id")) {
      return { rows: [{ id: CHECK_ID, display_number: 1001, stage: "recorded", version: 1 }] };
    }
    return undefined;
  });
}

describe("the create block (#173)", () => {
  it("record-write-check: no row re-read for the response and no post-insert count guards", async () => {
    const fake = adminWarehouse();
    const run = createTransactionRunner({ client: fake.client, names });
    const outcome = await run.runCommand(adminCommands().record, {
      ...create,
      payload: { name: "smoke" },
    });
    const block = fake.blocks()[0]!.statement;

    // Dropped: the re-read and the counts.
    expect(resultSql(block)).not.toContain("`write_checks`");
    expect(resultSql(block)).toMatch(/^SELECT id, label, .* FROM \(SELECT :p\d+ AS `id`/);
    expect(block).not.toMatch(COUNT_GUARD);
    expect(block).not.toContain("count(*)");
    expect(block).not.toContain("num_affected_rows");
    expect(block).toMatch(/\nSELECT :p\d+ AS action_id, edp_v\d+ AS result;\nEND;$/);

    // Kept: the key race, the state insert and the lead action with command,
    // hash, effects and result. A write check has no display number, so no
    // counter (ADR-0007 decision 2, amended 2026-10-10).
    expect(block).not.toContain("display_counters");
    expect(block).toMatch(
      /IF \(EXISTS \(SELECT 1 FROM `edp_vending`\.`admin`\.`write_check_actions` WHERE idempotency_key = :p\d+ AND caused_by_action_id IS NULL\)\) THEN\n  SIGNAL SQLSTATE 'ED002'/,
    );
    expect(block).toContain("INSERT INTO `edp_vending`.`admin`.`write_checks`");
    expect(insertedValue(fake.blocks()[0]!, "write_check_actions", "command_hash")).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(insertedValue(fake.blocks()[0]!, "write_check_actions", "result")).toMatch(/^edp_v\d+$/);
    expect(
      JSON.parse(
        insertedValue(fake.blocks()[0]!, "write_check_actions", "expected_effects") as string,
      ),
    ).toEqual([{ table: "admin.write_checks", id: outcome.recordId }]);
  });

  it("confirm-write-check (an update) keeps its version guard, its row counts and its re-read", async () => {
    const fake = adminWarehouse();
    const run = createTransactionRunner({ client: fake.client, names });
    await run.runCommand(adminCommands().confirm, {
      ...create,
      expectedVersion: 1,
      payload: { writeCheckId: CHECK_ID },
    });
    const block = fake.blocks()[0]!.statement;
    expect(block).toMatch(
      /IF \(\(SELECT count\(\*\) FROM `edp_vending`\.`admin`\.`write_checks` WHERE id = :p\d+ AND version = :p\d+ AND last_action_id = :p\d+\) <> 1\) THEN\n  SIGNAL SQLSTATE 'ED001'/,
    );
    expect(block).toMatch(
      /IF \(\(SELECT count\(\*\) FROM `edp_vending`\.`admin`\.`write_checks` WHERE id = :p\d+ AND last_action_id = :p\d+\) <> 1\) THEN\n  SIGNAL SQLSTATE 'ED003'/,
    );
    expect(block).toMatch(
      /IF \(\(SELECT count\(\*\) FROM `edp_vending`\.`admin`\.`write_check_actions` WHERE action_id = :p\d+\) <> 1\) THEN\n  SIGNAL SQLSTATE 'ED003'/,
    );
    expect(block).toMatch(/AS num_affected_rows, edp_v\d+ AS result;\nEND;$/);
    expect(resultSql(block)).toMatch(
      /FROM `edp_vending`\.`admin`\.`write_checks` WHERE id = :p\d+$/,
    );
  });

  it("stores the response a re-read would have given, and a replay returns exactly it", async () => {
    const warehouse = createSqliteWarehouse({ now: () => new Date("2026-10-10T12:00:00.000Z") });
    const run = createTransactionRunner({
      client: warehouse.client,
      names,
      now: () => new Date("2026-10-10T12:00:00.000Z"),
    });
    const { record, confirm } = adminCommands();
    const first = await run.runCommand(record, { ...create, payload: { name: "smoke" } });

    const [stored] = warehouse.query<{ result: string }>(
      "SELECT result FROM admin__write_check_actions WHERE caused_by_action_id IS NULL",
    );
    const [row] = warehouse.query(
      "SELECT id, label, stage, version, created_at, created_by_principal_id, updated_at, last_action_id FROM admin__write_checks",
    );
    expect(JSON.parse(stored!.result)).toEqual(row);
    // The admin result builds from the row alone (no reads).
    expect(first.result).toEqual(await record.result(row!, {} as never));
    expect(first.result).toMatchObject({ name: "smoke", version: 1, stage: "recorded" });

    // The record moves on; the replay still answers with the stored row.
    await run.runCommand(confirm, {
      ...create,
      idempotencyKey: "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      expectedVersion: 1,
      payload: { writeCheckId: first.recordId },
    });
    const replay = await run.runCommand(record, { ...create, payload: { name: "smoke" } });
    expect(replay).toEqual({ ...first, affectedAreas: [], actionWatermarks: {}, replayed: true });
    expect(JSON.stringify(replay.result)).toBe(JSON.stringify(first.result));
  });
});

/**
 * A command that inserts a write check through the helpers, then runs `raw`
 * through the `ctx.block.add` escape hatch. Only `raw` differs between cases.
 */
function insertThen(raw: string): CommandDefinition<{ name: string }, Record<string, unknown>> {
  const { record } = adminCommands();
  return {
    ...record,
    kind: "command",
    name: "insert-then-raw",
    async plan(ctx) {
      const id = await followOn(ctx, 0);
      insertCurrentState(ctx, WRITE_CHECKS, id, {
        display_number: 1,
        label: ctx.payload.name,
        stage: "recorded",
      });
      ctx.block.add(raw);
      return { recordId: id, recordVersion: 1, leadAction: { action: "recorded" } };
    },
  };
}

describe("the create block fails closed (#173 review)", () => {
  const T = "`edp_vending`.`admin`.`write_checks`";
  const mutations: Array<[string, string]> = [
    [
      "MERGE INTO",
      `MERGE INTO ${T} AS t USING (SELECT 1 AS one) AS s ON t.label = 'x' WHEN MATCHED THEN UPDATE SET t.stage = 'confirmed'`,
    ],
    ["lowercase update", "update edp_vending.admin.write_checks set stage = 'confirmed'"],
    ["DELETE", `DELETE FROM ${T} WHERE label = 'x'`],
    [
      "CTE-wrapped UPDATE, upper-case name",
      "WITH c AS (SELECT 1) UPDATE EDP_VENDING.ADMIN.WRITE_CHECKS SET stage = 'confirmed'",
    ],
    ["raw INSERT … SELECT", `INSERT INTO ${T} SELECT * FROM ${T} WHERE label = 'x'`],
    ["double-quoted name", 'UPDATE "edp_vending"."admin"."write_checks" SET stage = \'x\''],
    ["a name chosen at run time", "UPDATE IDENTIFIER(:p0) SET stage = 'confirmed'"],
    ["EXECUTE IMMEDIATE", "EXECUTE IMMEDIATE 'DELETE FROM somewhere'"],
    [
      "the lead action table",
      "DELETE FROM `edp_vending`.`admin`.`write_check_actions` WHERE note = 'x'",
    ],
  ];

  it.each(mutations)(
    "%s after the insert: keeps every count guard and re-reads the row",
    async (_, raw) => {
      const fake = adminWarehouse();
      const run = createTransactionRunner({ client: fake.client, names });
      await run.runCommand(insertThen(raw), { ...create, payload: { name: "x" } });
      const block = fake.blocks()[0]!.statement;
      expect(block).toMatch(
        /IF \(\(SELECT count\(\*\) FROM `edp_vending`\.`admin`\.`write_checks` WHERE `id` = :p\d+ AND last_action_id = :p\d+\) <> 1\) THEN/,
      );
      expect(block).toMatch(
        /IF \(\(SELECT count\(\*\) FROM `edp_vending`\.`admin`\.`write_check_actions` WHERE action_id = :p\d+\) <> 1\) THEN/,
      );
      expect(block).toContain("AS num_affected_rows");
      expect(resultSql(block)).toMatch(
        /FROM `edp_vending`\.`admin`\.`write_checks` WHERE id = :p\d+$/,
      );
    },
  );

  it("a create whose response reads more than its own row drops the counts but re-reads", async () => {
    const fake = adminWarehouse();
    const run = createTransactionRunner({ client: fake.client, names });
    const definition = {
      ...insertThen("SELECT 1"),
      // Like teams/add-owner: every row of the table for the record's group, not just the new one.
      resultRow: ({ names: n }: { names: typeof names }) =>
        `SELECT count(*) AS n FROM ${n.table("admin", "write_checks")} WHERE stage = 'recorded'`,
    };
    await run.runCommand(definition, { ...create, payload: { name: "x" } });
    const block = fake.blocks()[0]!.statement;
    expect(block).not.toMatch(COUNT_GUARD);
    expect(resultSql(block)).toBe(
      "SELECT count(*) AS n FROM `edp_vending`.`admin`.`write_checks` WHERE stage = 'recorded'",
    );
  });

  it("a command on an existing record whose only rows are inserts isn't a create", async () => {
    // Like teams/remove-member: it deletes (or changes) its record elsewhere and inserts actions.
    const fake = adminWarehouse();
    const run = createTransactionRunner({ client: fake.client, names });
    const { confirm } = adminCommands();
    await run.runCommand(
      {
        ...confirm,
        async plan(ctx) {
          insertAction(ctx, WRITE_CHECK_ACTIONS, {
            actionId: await followOn(ctx, 0),
            recordId: CHECK_ID,
            action: "noted",
            recordVersion: 2,
          });
          return { recordId: CHECK_ID, recordVersion: 2, leadAction: { action: "noted" } };
        },
      },
      { ...create, expectedVersion: 1, payload: { writeCheckId: CHECK_ID } },
    );
    const block = fake.blocks()[0]!.statement;
    expect(block).toMatch(COUNT_GUARD);
    expect(block).toContain("AS num_affected_rows");
    expect(resultSql(block)).toMatch(
      /FROM `edp_vending`\.`admin`\.`write_checks` WHERE id = :p\d+$/,
    );
  });

  it("a raw statement on an unrelated table keeps the fast path", async () => {
    const fake = adminWarehouse();
    const run = createTransactionRunner({ client: fake.client, names });
    await run.runCommand(
      insertThen(
        "UPDATE `edp_vending`.`eir`.`eir_drafts` SET form_values = NULL WHERE eir_id = 'x'",
      ),
      { ...create, payload: { name: "x" } },
    );
    const block = fake.blocks()[0]!.statement;
    expect(block).not.toMatch(COUNT_GUARD);
    expect(resultSql(block)).not.toContain("`write_checks` WHERE");
  });
});

describe("the create block in the EIR area (#173)", () => {
  const post = (path: string, body: unknown) =>
    new Request(`https://app${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const lastBlock = (impl: ReturnType<typeof deltaImplementation>) =>
    impl.warehouse.statements.filter((s) => s.startsWith("BEGIN ATOMIC")).at(-1)!;

  async function send(
    impl: ReturnType<typeof deltaImplementation>,
    user: SessionUser,
    name: string,
    body: unknown,
  ) {
    const response = await impl.request(user, post(`/api/commands/eir/${name}`, body));
    expect(response.status).toBe(200);
    return (await response.json()) as { result: unknown; replayed: boolean; actionId: string };
  }

  // EIR results carry the full record (#174): a join over several tables, so a
  // create drops its counts but reads its result inside the block (the shape
  // check refuses to inline anything but its own row).
  it("start: a create without counts, its full-record result read in the block; a replay returns the same bytes", async () => {
    const impl = deltaImplementation();
    const body = { idempotencyKey: KEY, expectedVersion: 0, payload: {} };
    const first = await send(impl, APPLICANT, "start", body);
    const block = lastBlock(impl);
    expect(block).not.toMatch(COUNT_GUARD);
    expect(resultSql(block)).toContain("`edp_vending`.`eir`.`eirs`");
    // The new EIR's own race guard stays, and its display code's uniqueness read.
    expect(block).toContain("SIGNAL SQLSTATE 'ED001'");
    expect(block).toMatch(
      /IF \(EXISTS \(SELECT 1 FROM `edp_vending`\.`eir`\.`eirs` WHERE display_code = :p\d+\)\) THEN\n  SIGNAL SQLSTATE 'ED004'/,
    );
    expect(block).not.toContain("`display_counters`");

    // The block's result is the record a fresh read gives.
    expect(first.result).toEqual(await impl.as(APPLICANT).get(APPLICANT.principalId));
    expect(first.result).toMatchObject({ stage: "not-started", version: 1 });
    const replay = await send(impl, APPLICANT, "start", body);
    expect(replay).toMatchObject({ replayed: true, actionId: first.actionId });
    expect(JSON.stringify(replay.result)).toBe(JSON.stringify(first.result));
  });

  it("save-draft: a create the first time, an update with its guards after", async () => {
    const impl = deltaImplementation();
    const draft = (expectedVersion: number) => ({
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedVersion,
      payload: { formVersion: "bootstrap-2", values: VALUES },
    });
    const first = await send(impl, APPLICANT, "save-draft", draft(0));
    expect(lastBlock(impl)).not.toMatch(COUNT_GUARD);
    expect(resultSql(lastBlock(impl))).toContain("`eir_drafts`");
    expect(first.result).toEqual(await impl.as(APPLICANT).get(APPLICANT.principalId));
    expect(first.result).toMatchObject({ draftVersion: 1 });

    const second = await send(impl, APPLICANT, "save-draft", draft(1));
    expect(lastBlock(impl)).toMatch(COUNT_GUARD);
    expect(lastBlock(impl)).toContain("SIGNAL SQLSTATE 'ED001'");
    expect(resultSql(lastBlock(impl))).toContain("`eir_drafts`");
    expect(second.result).toEqual(await impl.as(APPLICANT).get(APPLICANT.principalId));
    expect(second.result).toMatchObject({ draftVersion: 2 });
  });

  it("submit: a first submission is a create; a decision on it is an update with its guards", async () => {
    const impl = deltaImplementation();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    const record = await impl.as(APPLICANT).submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: VALUES,
    });
    const submit = impl.warehouse.statements.filter((s) => s.startsWith("BEGIN ATOMIC")).at(-1)!;
    expect(submit).toContain("INSERT INTO `edp_vending`.`eir`.`eir_submissions`");
    expect(submit).not.toMatch(COUNT_GUARD);
    expect(resultSql(submit)).toContain("`eirs`");
    expect(record.stage).toBe("submitted");

    await impl
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, "ok", VAL.displayName);
    const decide = lastBlock(impl);
    expect(decide).toMatch(COUNT_GUARD);
    expect(decide).toContain("SIGNAL SQLSTATE 'ED001'");
    expect(resultSql(decide)).toContain("`eirs`");
    expect(impl.warehouse.query("SELECT stage, version FROM eir__eirs")).toEqual([
      { stage: "valid", version: 2 },
    ]);
  });
});
