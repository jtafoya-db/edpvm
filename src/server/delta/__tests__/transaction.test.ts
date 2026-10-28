/**
 * The transaction runner at its seam: an injected SqlClient (here a fake that
 * plays the warehouse). Covers the issue #76 test list: idempotency hit,
 * reused key, version conflict, retry then success, retry exhaustion with the
 * exact attempt count, domain errors not retried, and the actor coming from
 * the session.
 */
import { describe, expect, it, vi } from "vitest";

import { WRITE_CHECKS, registerAdminArea } from "../areas/admin.ts";
import {
  BusyError,
  CONFLICT_MESSAGE,
  DomainError,
  GUARD_STATE,
  IdempotencyKeyReusedError,
  OutcomeUnknownError,
  StatementAbandonedError,
  VersionConflictError,
} from "../errors.ts";
import { createRegistry, type CommandDefinition, type SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import {
  MAX_ATTEMPTS,
  backoffDelay,
  createTransactionRunner,
  type AttemptInfo,
} from "../transaction.ts";
import type { ActionActor } from "../write-helpers.ts";
import {
  committed,
  deltaConflict,
  fakeSqlClient,
  insertedValue,
  signalled,
  type RecordedStatement,
  type Responder,
} from "./fake-sql-client.ts";

const STAFF: SessionUser = {
  principalId: "4055694201057157",
  displayName: "Sam Staff",
  email: "sam.staff@example.gov",
  isAdmin: true,
  onboardingReviewerRoles: [],
};
const ACTOR: ActionActor = {
  principalId: STAFF.principalId,
  display: STAFF.displayName,
  app: "staff",
};
const KEY = "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69";
const CHECK_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const names = createStoreNames("edp_vending", "");

function adminCommands() {
  const registry = createRegistry();
  registerAdminArea(registry);
  const record = registry.findWrite("admin", "record-write-check") as CommandDefinition<
    { name: string },
    unknown
  >;
  const confirm = registry.findWrite("admin", "confirm-write-check") as CommandDefinition<
    { writeCheckId: string; note?: string },
    unknown
  >;
  return { record, confirm };
}

const writeCheckRow = (version: number, stage = "recorded") => ({
  id: CHECK_ID,
  display_number: 1001,
  label: "smoke",
  stage,
  version,
  created_at: "2026-10-05T12:00:00.000Z",
  created_by_principal_id: STAFF.principalId,
  updated_at: "2026-10-05T12:00:00.000Z",
  last_action_id: "a",
});

/** Plays the warehouse: no prior key, the write check exists, and `block` decides each attempt. */
function warehouse(
  block: (call: RecordedStatement, attempt: number) => ReturnType<Responder>,
  prior: unknown[] = [],
) {
  let attempts = 0;
  return fakeSqlClient((call) => {
    if (call.statement.includes("WHERE idempotency_key = :key"))
      return { rows: prior as Record<string, unknown>[] };
    if (call.statement.startsWith("BEGIN ATOMIC")) return block(call, ++attempts);
    if (call.statement.includes("`write_checks` WHERE id = :id"))
      return { rows: [writeCheckRow(2)] };
    return undefined;
  });
}

function runner(
  client: ReturnType<typeof fakeSqlClient>["client"],
  extra: { onAttempt?: (i: AttemptInfo) => void } = {},
) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  return {
    sleep,
    runner: createTransactionRunner({ client, names, sleep, random: () => 0, ...extra }),
  };
}

describe("transaction runner: one atomic block per command", () => {
  it("writes the lead action with the command, its hash and expected effects, all in one BEGIN ATOMIC block", async () => {
    const fake = warehouse((call) => committed(call));
    const { runner: run } = runner(fake.client);
    const { record } = adminCommands();
    const outcome = await run.runCommand(record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    });

    expect(outcome).toMatchObject({
      replayed: false,
      attempts: 1,
      recordVersion: 1,
      affectedAreas: ["admin"],
    });
    const [block] = fake.blocks();
    expect(fake.blocks()).toHaveLength(1);
    expect(block!.statement).toMatch(/^BEGIN ATOMIC\n[\s\S]*\nEND;$/);
    // A write check has no display number, so no counter (ADR-0007 decision 2, amended 2026-10-10).
    expect(block!.statement).not.toContain("display_counters");
    expect(block!.statement).not.toContain("read_cache_versions");
    expect(insertedValue(block!, "write_check_actions", "action")).toBe("recorded");
    expect(insertedValue(block!, "write_check_actions", "idempotency_key")).toBe(KEY);
    expect(insertedValue(block!, "write_check_actions", "record_version")).toBe(1);
    const command = JSON.parse(insertedValue(block!, "write_check_actions", "command") as string);
    expect(command).toEqual({
      actor: STAFF.principalId,
      area: "admin",
      command: "record-write-check",
      expectedVersion: 0,
      payload: { name: "smoke" },
    });
    expect(insertedValue(block!, "write_check_actions", "command_hash")).toMatch(/^[0-9a-f]{64}$/);
    expect(
      JSON.parse(insertedValue(block!, "write_check_actions", "expected_effects") as string),
    ).toEqual([{ table: "admin.write_checks", id: outcome.recordId }]);
    // The new record's ID derives from the lead action's (UUID v5), so a retry names the same row.
    expect(outcome.recordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
    // The response row is built inside the block from the inserted values
    // (a create, #173) and stored on the lead action.
    const stored = insertedValue(block!, "write_check_actions", "result") as string;
    expect(stored).toMatch(/^edp_v\d+$/);
    expect(block!.statement).toMatch(
      new RegExp(
        `SET ${stored} = \\(SELECT to_json\\(struct\\(\\*\\)\\) FROM \\(SELECT id, label, .* FROM \\(SELECT :p\\d+ AS \`id\`, .*\\) WHERE id = :p\\d+\\) AS edp_result_row\\);`,
      ),
    );
    expect(block!.statement).toContain(`IF (${stored} IS NULL) THEN`);
  });

  it("tags every statement it runs with the lead action's ID", async () => {
    const fake = warehouse((call) => committed(call));
    const { runner: run } = runner(fake.client);
    const outcome = await run.runCommand(adminCommands().record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    });
    // The key lookup and the block (the response row comes back from the block).
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fake.calls) {
      expect(call.tag).toEqual({ actionId: outcome.actionId });
      expect(call.sent.startsWith(`/* edp_action_id=${outcome.actionId} */\n`)).toBe(true);
    }
  });
});

describe("transaction runner: idempotency", () => {
  it("returns the stored result for a known key with the same command, and writes nothing", async () => {
    const first = warehouse((call) => committed(call, writeCheckRow(1)));
    const { record } = adminCommands();
    const input = {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    };
    const original = await runner(first.client).runner.runCommand(record, input);
    const storedHash = insertedValue(first.blocks()[0]!, "write_check_actions", "command_hash");

    const second = warehouse(() => {
      throw new Error("must not write");
    }, [
      {
        action_id: original.actionId,
        command_hash: storedHash,
        record_id: original.recordId,
        record_version: 1,
        result: JSON.stringify(writeCheckRow(1)),
      },
    ]);
    const replay = await runner(second.client).runner.runCommand(record, input);
    expect(replay).toMatchObject({
      replayed: true,
      actionId: original.actionId,
      recordId: original.recordId,
      recordVersion: 1,
    });
    expect(replay.result).toEqual(original.result);
    expect(second.blocks()).toHaveLength(0);
  });

  it("returns the original response for a key after the record moved on, not today's state", async () => {
    // A small warehouse: the write check's current row, and each lead action
    // by key with the response row its block stored.
    let current: Record<string, unknown> | undefined;
    const leads = new Map<string, Record<string, unknown>>();
    const fake = fakeSqlClient((call) => {
      const sql = call.statement;
      if (sql.includes("WHERE idempotency_key = :key")) {
        const lead = leads.get(String(call.parameters["key"]));
        return { rows: lead ? [lead] : [] };
      }
      if (sql.includes("`write_checks` WHERE id = :id")) return { rows: current ? [current] : [] };
      if (!sql.startsWith("BEGIN ATOMIC")) return undefined;
      const actionId = insertedValue(call, "write_check_actions", "action_id");
      current = sql.includes("UPDATE `edp_vending`.`admin`.`write_checks`")
        ? {
            ...current!,
            stage: "confirmed",
            version: 2,
            updated_at: "2026-10-06T09:30:00.000Z",
            last_action_id: actionId,
          }
        : {
            ...writeCheckRow(1),
            id: insertedValue(call, "write_checks", "id"),
            last_action_id: actionId,
          };
      leads.set(String(insertedValue(call, "write_check_actions", "idempotency_key")), {
        action_id: actionId,
        command_hash: insertedValue(call, "write_check_actions", "command_hash"),
        record_id: current["id"],
        record_version: current["version"],
        result: JSON.stringify(current),
      });
      return committed(call, current);
    });
    const { runner: run } = runner(fake.client);
    const { record, confirm } = adminCommands();
    const create = {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    };

    const v1 = await run.runCommand(record, create);
    const v2 = await run.runCommand(confirm, {
      ...create,
      idempotencyKey: "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      expectedVersion: 1,
      payload: { writeCheckId: v1.recordId },
    });
    expect(v2.result).toMatchObject({ stage: "confirmed", version: 2 });

    const readsBefore = fake.calls.filter((c) => c.statement.includes("`write_checks` WHERE id"));
    const replay = await run.runCommand(record, create);
    expect(replay).toEqual({ ...v1, affectedAreas: [], actionWatermarks: {}, replayed: true });
    expect(replay.result).toEqual({
      id: v1.recordId,
      name: "smoke",
      stage: "recorded",
      version: 1,
      createdAt: "2026-10-05T12:00:00.000Z",
      createdByPrincipalId: STAFF.principalId,
      updatedAt: "2026-10-05T12:00:00.000Z",
      lastActionId: v1.actionId,
    });
    // Built from the stored row alone: the replay didn't read current state.
    expect(fake.calls.filter((c) => c.statement.includes("`write_checks` WHERE id"))).toEqual(
      readsBefore,
    );
  });

  it("says so, rather than guess, for a lead action stored without its response", async () => {
    const first = warehouse((call) => committed(call));
    const { record } = adminCommands();
    const input = {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    };
    await runner(first.client).runner.runCommand(record, input);
    const hash = insertedValue(first.blocks()[0]!, "write_check_actions", "command_hash");
    const second = warehouse(() => {
      throw new Error("must not write");
    }, [
      { action_id: "a", command_hash: hash, record_id: CHECK_ID, record_version: 1, result: null },
    ]);
    await expect(runner(second.client).runner.runCommand(record, input)).rejects.toMatchObject({
      code: "replay-unavailable",
      status: 409,
    });
  });

  it("refuses a known key with a different command as a reused key, without retrying", async () => {
    const fake = warehouse(() => {
      throw new Error("must not write");
    }, [{ action_id: "a", command_hash: "0".repeat(64), record_id: CHECK_ID, record_version: 1 }]);
    await expect(
      runner(fake.client).runner.runCommand(adminCommands().record, {
        user: STAFF,
        actor: ACTOR,
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "a different change" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(fake.lookups()).toHaveLength(1);
    expect(fake.blocks()).toHaveLength(0);
  });

  it("guards the key inside the block, and retries into a replay when another writer committed it first", async () => {
    let lookups = 0;
    let storedHash: unknown;
    const fake = fakeSqlClient((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) {
        lookups++;
        return {
          rows:
            lookups === 1
              ? []
              : [
                  {
                    action_id: "winner",
                    command_hash: storedHash,
                    record_id: CHECK_ID,
                    record_version: 1,
                    result: JSON.stringify(writeCheckRow(1)),
                  },
                ],
        };
      }
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        expect(call.statement).toContain("SIGNAL SQLSTATE 'ED002'");
        storedHash = insertedValue(call, "write_check_actions", "command_hash");
        throw signalled(GUARD_STATE.idempotencyRace, "edp:idempotency-race");
      }
      if (call.statement.includes("`write_checks` WHERE id = :id"))
        return { rows: [writeCheckRow(1)] };
      return undefined;
    });
    const { runner: run, sleep } = runner(fake.client);
    const outcome = await run.runCommand(adminCommands().record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    });
    expect(outcome).toMatchObject({ replayed: true, actionId: "winner", attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("transaction runner: version checks", () => {
  const confirmInput = {
    user: STAFF,
    actor: ACTOR,
    idempotencyKey: KEY,
    expectedVersion: 1,
    payload: { writeCheckId: CHECK_ID },
  };

  it("checks the read version in the UPDATE and counts the rows it changed inside the block", async () => {
    const fake = warehouse((call) => committed(call));
    const outcome = await runner(fake.client).runner.runCommand(
      adminCommands().confirm,
      confirmInput,
    );
    const block = fake.blocks()[0]!.statement;
    expect(block).toMatch(
      /UPDATE `edp_vending`\.`admin`\.`write_checks` SET .*version = version \+ 1 WHERE id = :p\d+ AND version = :p\d+/,
    );
    expect(block).toMatch(
      /IF \(\(SELECT count\(\*\) FROM `edp_vending`\.`admin`\.`write_checks` WHERE id = :p\d+ AND version = :p\d+ AND last_action_id = :p\d+\) <> 1\) THEN\n  SIGNAL SQLSTATE 'ED001'/,
    );
    expect(outcome.recordVersion).toBe(2);
  });

  it("treats a version-checked update that changed 0 rows as a conflict, never a success, and doesn't retry", async () => {
    const fake = warehouse((call) => ({
      rows: [
        {
          action_id: "x",
          num_affected_rows: Number(committed(call).rows[0]!.num_affected_rows) - 1,
        },
      ],
    }));
    const { runner: run, sleep } = runner(fake.client);
    const error = await run
      .runCommand(adminCommands().confirm, confirmInput)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VersionConflictError);
    expect((error as Error).message).toBe(CONFLICT_MESSAGE);
    expect(fake.blocks()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps the block's version guard to a conflict, and doesn't retry it", async () => {
    const fake = warehouse(() => {
      throw signalled(GUARD_STATE.versionConflict, "edp:version-conflict");
    });
    const { runner: run, sleep } = runner(fake.client);
    await expect(run.runCommand(adminCommands().confirm, confirmInput)).rejects.toMatchObject({
      code: "version-conflict",
      status: 409,
      message: CONFLICT_MESSAGE,
    });
    expect(fake.blocks()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("transaction runner: retries", () => {
  it("retries a Delta conflict, re-reading everything, then succeeds", async () => {
    const fake = warehouse((call, attempt) => {
      if (attempt < 3) throw deltaConflict();
      return committed(call);
    });
    const attempts: AttemptInfo[] = [];
    const { runner: run, sleep } = runner(fake.client, {
      onAttempt: (info) => attempts.push(info),
    });
    const outcome = await run.runCommand(adminCommands().record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    });
    expect(outcome.attempts).toBe(3);
    expect(fake.blocks()).toHaveLength(3);
    // Every attempt starts again from the idempotency lookup.
    expect(fake.lookups()).toHaveLength(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
    expect(attempts.map((a) => a.outcome)).toEqual(["retry", "retry", "committed"]);
    // The same lead action ID across attempts, so the SQL comments join them up.
    expect(new Set(fake.calls.map((c) => JSON.stringify(c.tag))).size).toBe(1);
  });

  it(`gives up after exactly ${MAX_ATTEMPTS} attempts with the reload message`, async () => {
    const fake = warehouse(() => {
      throw deltaConflict();
    });
    const { runner: run, sleep } = runner(fake.client);
    const error = await run
      .runCommand(adminCommands().record, {
        user: STAFF,
        actor: ACTOR,
        idempotencyKey: KEY,
        expectedVersion: 0,
        payload: { name: "smoke" },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BusyError);
    expect(error).toMatchObject({ attempts: 10, message: CONFLICT_MESSAGE, status: 503 });
    expect(fake.blocks()).toHaveLength(10);
    expect(sleep).toHaveBeenCalledTimes(9);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      250, 500, 1000, 2000, 2000, 2000, 2000, 2000, 2000,
    ]);
  });

  it("jitters the backoff upward from 250 ms, doubling, capped at 2 s", () => {
    expect(backoffDelay(1, () => 0)).toBe(250);
    expect(backoffDelay(1, () => 0.999)).toBe(375);
    expect(backoffDelay(2, () => 0)).toBe(500);
    expect(backoffDelay(4, () => 0)).toBe(2000);
    expect(backoffDelay(9, () => 0.5)).toBe(2500);
  });

  it("never retries a domain error raised by a guard inside the block, and maps it to the handler's error", async () => {
    const fake = warehouse(() => {
      throw signalled(GUARD_STATE.domain, "edp:guard:1");
    });
    const { runner: run, sleep } = runner(fake.client);
    await expect(
      run.runCommand(adminCommands().confirm, {
        user: STAFF,
        actor: ACTOR,
        idempotencyKey: KEY,
        expectedVersion: 2,
        payload: { writeCheckId: CHECK_ID },
      }),
    ).rejects.toMatchObject({ code: "already-confirmed", status: 409 });
    expect(fake.blocks()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("guards missing records inside the block without a pre-read", async () => {
    const fake = warehouse(() => {
      throw signalled(GUARD_STATE.domain, "edp:guard:0");
    });
    const { runner: run, sleep } = runner(fake.client);
    await expect(
      run.runCommand(adminCommands().confirm, {
        user: STAFF,
        actor: ACTOR,
        idempotencyKey: KEY,
        expectedVersion: 1,
        payload: { writeCheckId: CHECK_ID },
      }),
    ).rejects.toMatchObject({ code: "not-found", status: 404 });
    expect(fake.lookups()).toHaveLength(1);
    expect(
      fake.calls.filter((call) => call.statement.includes("`write_checks` WHERE id = :id")),
    ).toHaveLength(0);
    expect(fake.blocks()).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("transaction runner: the actor", () => {
  it("writes the actor columns from the session actor it's given", async () => {
    const fake = warehouse((call) => committed(call));
    await runner(fake.client).runner.runCommand(adminCommands().record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "4242 pretending to be someone" },
    });
    const block = fake.blocks()[0]!;
    expect(insertedValue(block, "write_check_actions", "actor_principal_id")).toBe(
      STAFF.principalId,
    );
    expect(insertedValue(block, "write_check_actions", "actor_display")).toBe("Sam Staff");
    expect(insertedValue(block, "write_check_actions", "actor_app")).toBe("staff");
    expect(insertedValue(block, WRITE_CHECKS.table, "created_by_principal_id")).toBe(
      STAFF.principalId,
    );
  });
});

describe("transaction runner: statements abandoned at the client deadline", () => {
  it("retries an abandoned block, finds it committed through the idempotency key, and doesn't write it twice", async () => {
    let committedHash: unknown;
    let committedRecord: unknown;
    const fake = fakeSqlClient((call) => {
      if (call.statement.includes("WHERE idempotency_key = :key")) {
        // After the abandoned attempt, the warehouse shows it committed after all.
        return {
          rows: committedHash
            ? [
                {
                  action_id: call.tag && "actionId" in call.tag ? call.tag.actionId : "",
                  command_hash: committedHash,
                  record_id: committedRecord,
                  record_version: 1,
                  result: JSON.stringify(writeCheckRow(1)),
                },
              ]
            : [],
        };
      }
      if (call.statement.startsWith("BEGIN ATOMIC")) {
        committedHash = insertedValue(call, "write_check_actions", "command_hash");
        committedRecord = insertedValue(call, WRITE_CHECKS.table, "id");
        throw new StatementAbandonedError(45_000, "RUNNING", "s1");
      }
      if (call.statement.includes("`write_checks` WHERE id = :id"))
        return { rows: [writeCheckRow(1)] };
      return undefined;
    });
    const seen: AttemptInfo[] = [];
    const { runner: run } = runner(fake.client, { onAttempt: (info) => seen.push(info) });
    const outcome = await run.runCommand(adminCommands().record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    });
    expect(outcome).toMatchObject({ replayed: true, attempts: 2, recordId: committedRecord });
    expect(fake.blocks()).toHaveLength(1);
    expect(seen.map((s) => s.outcome)).toEqual(["abandoned", "replayed"]);
  });

  it("writes an abandoned block once more when the key shows it never committed", async () => {
    const fake = warehouse((call, attempt) => {
      if (attempt === 1) throw new StatementAbandonedError(45_000, "RUNNING", "s1");
      return committed(call);
    });
    const outcome = await runner(fake.client).runner.runCommand(adminCommands().record, {
      user: STAFF,
      actor: ACTOR,
      idempotencyKey: KEY,
      expectedVersion: 0,
      payload: { name: "smoke" },
    });
    expect(outcome).toMatchObject({ replayed: false, attempts: 2 });
    expect(fake.lookups()).toHaveLength(2);
  });

  it("doesn't retry an abandoned legacy statement, which has no key to check", async () => {
    const fake = fakeSqlClient(() => {
      throw new StatementAbandonedError(45_000, "RUNNING", "s1");
    });
    const { runner: run, sleep } = runner(fake.client);
    await expect(
      run.standalone(KEY, { statement: "INSERT INTO t VALUES (1)" }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fake.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
