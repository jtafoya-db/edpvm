/**
 * The transaction runner: "How a write works" in `docs/data-model.md`, and
 * ADR-0007 decision 6 (option c, Delta multi-statement transactions).
 *
 * For every command it:
 *
 * 1. builds the command JSON (area, command, actor, expected version and the
 *    validated payload) and its SHA-256;
 * 2. looks up the lead action by idempotency key: the same hash returns the
 *    stored result (the response row the original block saved, so a replay
 *    returns exactly the original response even after the record moved on),
 *    a different hash is refused as a reused key;
 * 3. has the handler plan its rows into one `BEGIN ATOMIC … END` block, with
 *    guards that refuse inside the transaction (a guard on the key, the
 *    version checks, the domain rules, and a final check that every expected
 *    row exists);
 * 4. writes the lead action with `command`, `command_hash`, `expected_effects`
 *    and `result` (the command's response row, read inside the block);
 * 5. on a Delta conflict, re-runs the whole thing from step 2 with jittered
 *    exponential backoff from 250 ms, for up to 10 attempts, then gives up
 *    with "This changed since you opened it. Reload to see the latest.";
 * 6. never retries a domain error or a version conflict;
 * 7. when the block refuses a new record's display code as taken (another
 *    record has it), retries with a fresh one (ADR-0007 decision 2, amended
 *    2026-10-10);
 * 8. when the SqlClient abandons a statement at its deadline (cancelled, but
 *    it may have committed first), treats that like a conflict: the retry's
 *    idempotency lookup replays it if it committed, or writes it once if not.
 *    Legacy writes have no key, so there it's `OutcomeUnknownError`.
 *
 * A **create** (every expected effect is a row `insertRow` inserted, and no
 * other statement in the block touches or might touch those tables) skips two
 * things: the final row checks, since an all-or-nothing block that commits
 * has committed its inserts; and the re-read of the response row, which it
 * builds from the values it inserted instead. Anything else keeps both
 * (ADR-0007; #173).
 *
 * The Statement Execution API doesn't report `num_affected_rows` for the
 * statements inside a `BEGIN ATOMIC` block (checked on example-workspace), so
 * the block counts what it changed itself: every version-checked update is
 * followed by a count of the rows now carrying this action's ID, and zero
 * signals a version conflict that rolls the block back. The block's final
 * SELECT returns the total as `num_affected_rows`, and the runner refuses
 * anything short of the plan.
 */
import {
  BusyError,
  DomainError,
  GUARD_STATE,
  IdempotencyKeyReusedError,
  OutcomeUnknownError,
  SqlError,
  StatementAbandonedError,
  VersionConflictError,
  guardIndex,
  isRetryableConflict,
} from "./errors.ts";
import { canonicalJson, newId as defaultNewId, sha256Hex } from "./ids.ts";
import { AtomicBlock, ident, type StoreNames } from "./sql-builder.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { CommandDefinition, ReadFn, ResultRowContext, SessionUser } from "./registry.ts";
import {
  actionColumns,
  insertRow,
  json,
  type ActionActor,
  onlyInsertRowTouches,
  type InsertedRow,
  type WriteContext,
} from "./write-helpers.ts";

export const MAX_ATTEMPTS = 10;
export const BASE_DELAY_MS = 250;
export const MAX_DELAY_MS = 2_000;

/**
 * The wait before the next attempt, after `failures` failed attempts:
 * 250 ms × 2^(failures-1), capped at 2 s, plus up to half as much again at
 * random so racing writers spread out. The first wait is 250–375 ms; the nine
 * waits between ten attempts add up to at most about 24 s.
 */
export function backoffDelay(
  failures: number,
  random: () => number = Math.random,
  baseMs = BASE_DELAY_MS,
  maxMs = MAX_DELAY_MS,
): number {
  const delay = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(delay + random() * (delay / 2));
}

export interface AttemptInfo {
  actionId: string;
  attempt: number;
  /** `abandoned`: the statement hit the client deadline and was cancelled; the next attempt re-reads the key. */
  outcome: "committed" | "retry" | "abandoned" | "replayed" | "refused" | "failed";
  elapsedMs: number;
  error?: unknown;
}

export interface TransactionRunnerOptions {
  client: SqlClient;
  names: StoreNames;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  newId?: () => string;
  /** Draws a new record's display code (`ONB-7K3QFD`); tests script it to force a clash. */
  newDisplayCode?: (prefix: string) => string;
  /** Observes each attempt (the live script records attempts and latency with it). */
  onAttempt?: (info: AttemptInfo) => void;
  /**
   * The command that records an ADR-0006 `access-refused` row
   * (`teams/record-ownership-refusal`). When a protected command refuses an
   * ownership mismatch, the runner runs this in its own commit so the refusal
   * is audited even if the client never called it first. A lazy getter, so it
   * can be looked up on the registry built after the runner.
   */
  refusalCommand?: () => CommandDefinition<{ datasetId: string }, unknown> | undefined;
}

export interface CommandInput<P> {
  user: SessionUser;
  actor: ActionActor;
  idempotencyKey: string;
  expectedVersion: number;
  payload: P;
}

export interface CommandOutcome<R> {
  actionId: string;
  recordId: string;
  recordVersion: number;
  /** Snapshot areas touched by this command, for same-instance read-your-own-write reload. */
  affectedAreas: string[];
  /** Committed action rows already known from the transaction, for cross-instance freshness. */
  actionWatermarks: Record<string, string[]>;
  /** True when the key had already been used for this command: nothing new was written. */
  replayed: boolean;
  attempts: number;
  result: R;
}

export interface TransactionRunner {
  /**
   * One standalone statement (no transaction), for legacy writes: retried on
   * a Delta conflict, which means it didn't commit; `OutcomeUnknownError` if
   * it was abandoned at the deadline. Returns `num_affected_rows`.
   */
  standalone(actionId: string, statement: SqlStatement): Promise<number | null>;
  runCommand<P, R>(
    definition: CommandDefinition<P, R>,
    input: CommandInput<P>,
  ): Promise<CommandOutcome<R>>;
  /** A read tagged with an action or read ID. */
  reader(tag: { actionId: string } | { readId: string }): ReadFn;
}

interface LeadActionRow {
  action_id: string;
  command_hash: string | null;
  record_id: string;
  record_version: number;
  result: string | null;
}

/** The stored response row, as JSON. */
function storedRow(json: unknown): Record<string, unknown> {
  if (typeof json !== "string") {
    // A lead action written before `result` was stored (none in production).
    // Unreachable for a fresh commit: the block refuses a missing row.
    throw new DomainError(
      "replay-unavailable",
      "This was already saved, but its original response wasn't kept. Reload to see the latest.",
      409,
    );
  }
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Whether the command is a create: its record and every other effect are rows
 * `insertRow` inserted, and no other statement in the block touches (or might
 * touch) any of their tables or the lead action table.
 */
function isCreate(ctx: WriteContext, recordId: string, leadTable: string): boolean {
  return (
    ctx.effects.some((effect) => effect.id === recordId && effect.inserted) &&
    onlyInsertRowTouches(ctx, leadTable) &&
    ctx.effects.every(
      (effect) => effect.inserted && onlyInsertRowTouches(ctx, effect.inserted.target),
    )
  );
}

/**
 * For a create whose response is just the created row (`SELECT <columns> FROM
 * <its table> WHERE id = <recordId>`, nothing else), that row as the block
 * inserted it. Anything else (a join, a subquery, other rows of the same
 * table) gets `undefined`, and the response is read inside the block instead.
 */
function insertedResultRow(
  definition: CommandDefinition<unknown, unknown>,
  ctx: WriteContext,
  rowContext: Omit<ResultRowContext, "block">,
): InsertedRow | undefined {
  const { recordId } = rowContext;
  const created = ctx.effects.find((effect) => effect.id === recordId)?.inserted;
  if (!created) return undefined;
  // A dry run on a scratch block, so its parameters stay out of the real one.
  const probe = new AtomicBlock();
  const sql = definition.resultRow({ ...rowContext, block: probe }).trim();
  const target = created.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = new RegExp(`^SELECT [\\w\\s,\`]+ FROM ${target} WHERE id = :(p\\d+)$`).exec(sql);
  return shape && probe.params.values[shape[1]!] === recordId ? created : undefined;
}

/**
 * `names`, except that the created row's table reads as that one row, built
 * from the values the block inserted, so the response needs no table read.
 */
function resultNames(names: StoreNames, created: InsertedRow | undefined): StoreNames {
  if (!created) return names;
  const row = Object.entries(created.columns)
    .map(([column, sql]) => `${sql} AS ${ident(column)}`)
    .join(", ");
  return {
    ...names,
    table: (schema, table) => {
      const target = names.table(schema, table);
      return target === created.target ? `(SELECT ${row})` : target;
    },
  };
}

function sqlStateOf(error: SqlError): string | undefined {
  return error.sqlState ?? /SQLSTATE: ([A-Z0-9]{5})/.exec(error.message)?.[1];
}

function snapshotAreaFor(table: string): string {
  const schema = table.split(".")[0] ?? table;
  if (schema === "change_list") return "change-list";
  if (schema === "eir") return "eir";
  if (schema === "teams") return "teams";
  if (schema === "initiatives") return "initiatives";
  if (schema === "admin") return "admin";
  if (schema === "requests") return "requests";
  if (schema === "access") return "access";
  if (schema === "catalog") return "catalog";
  return schema;
}

function isSnapshotActionTable(table: string): boolean {
  const [, name = ""] = table.split(".");
  return name.endsWith("_actions") || table === "eir.eir_draft_saves";
}

export function createTransactionRunner(options: TransactionRunnerOptions): TransactionRunner {
  const { client, names } = options;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const makeId = options.newId ?? defaultNewId;
  const report = options.onAttempt ?? (() => undefined);

  const reader =
    (tag: { actionId: string } | { readId: string }): ReadFn =>
    async <T extends object>(statement: SqlStatement) =>
      (await client.execute<T>(statement, tag)).rows;

  /**
   * Map a failed attempt to the error the caller sees; `undefined` means retry.
   * `keyed` is true for commands, whose idempotency key lets a retry find out
   * whether an abandoned statement committed after all.
   */
  function classify(error: unknown, block: AtomicBlock, keyed: boolean): Error | undefined {
    if (error instanceof StatementAbandonedError)
      return keyed ? undefined : new OutcomeUnknownError(error);
    if (!(error instanceof SqlError))
      return error instanceof Error ? error : new Error(String(error));
    const state = sqlStateOf(error);
    if (state === GUARD_STATE.versionConflict) return new VersionConflictError(error.message);
    if (state === GUARD_STATE.domain) {
      const index = guardIndex(error);
      return (index !== undefined && block.guardError(index)) || error;
    }
    if (state === GUARD_STATE.incompleteWrite) return error;
    // The retry plans again, so it draws a fresh code.
    if (state === GUARD_STATE.displayCodeTaken) return undefined;
    return isRetryableConflict(error) ? undefined : error;
  }

  /**
   * The retry loop shared by commands and legacy statements. `attempt`
   * runs one full try; it returns the outcome, or throws.
   */
  async function withRetries<T>(
    actionId: string,
    keyed: boolean,
    attempt: (n: number) => Promise<{ value: T; block?: AtomicBlock; outcome?: "replayed" }>,
  ): Promise<{ value: T; attempts: number }> {
    let lastConflict: unknown;
    for (let n = 1; n <= maxAttempts; n++) {
      const started = Date.now();
      try {
        const done = await attempt(n);
        report({
          actionId,
          attempt: n,
          outcome: done.outcome ?? "committed",
          elapsedMs: Date.now() - started,
        });
        return { value: done.value, attempts: n };
      } catch (error) {
        const failure =
          error instanceof AttemptError
            ? classify(error.cause, error.block, keyed)
            : classify(error, new AtomicBlock(), keyed);
        if (failure) {
          report({
            actionId,
            attempt: n,
            outcome: failure instanceof SqlError ? "failed" : "refused",
            elapsedMs: Date.now() - started,
            error: failure,
          });
          throw failure;
        }
        lastConflict = error instanceof AttemptError ? error.cause : error;
        report({
          actionId,
          attempt: n,
          outcome: lastConflict instanceof StatementAbandonedError ? "abandoned" : "retry",
          elapsedMs: Date.now() - started,
          error: lastConflict,
        });
        if (n < maxAttempts)
          await sleep(backoffDelay(n, random, options.baseDelayMs, options.maxDelayMs));
      }
    }
    throw new BusyError(maxAttempts, lastConflict);
  }

  async function executeBlock(block: AtomicBlock, actionId: string) {
    try {
      return await client.execute(block.toStatement(), { actionId });
    } catch (error) {
      throw new AttemptError(error, block);
    }
  }

  const runner: TransactionRunner = {
    reader,

    async standalone(actionId, statement) {
      const { value } = await withRetries(actionId, false, async () => ({
        value: (await client.execute(statement, { actionId })).numAffectedRows,
      }));
      return value;
    },

    async runCommand<P, R>(definition: CommandDefinition<P, R>, input: CommandInput<P>) {
      const lead = definition.leadActionTable;
      const leadTable = names.table(lead.schema, lead.table);
      const commandJson = canonicalJson({
        area: definition.area,
        command: definition.name,
        actor: input.actor.principalId,
        expectedVersion: input.expectedVersion,
        payload: input.payload,
      });
      const commandHash = await sha256Hex(commandJson);
      const actionId = makeId();
      const read = reader({ actionId });
      // Record an ADR-0006 refusal in its own commit, before a protected
      // command refuses a mismatch (the command's own block rolls back). The
      // key is derived from this command's, so a resend of the same intent
      // replays the one refusal rather than writing another.
      const recordRefusal = async (datasetId: string): Promise<void> => {
        const refusal = options.refusalCommand?.();
        if (!refusal) return;
        try {
          await runner.runCommand(refusal, {
            user: input.user,
            actor: input.actor,
            idempotencyKey: `${input.idempotencyKey}:owner-refusal`,
            expectedVersion: 0,
            payload: { datasetId },
          });
        } catch (error) {
          // Nothing to record (the mismatch cleared between reads): still refuse.
          if (error instanceof DomainError && error.code === "nothing-to-record") return;
          throw error;
        }
      };

      const { value, attempts } = await withRetries(actionId, true, async () => {
        // Step 4.1: has this intent already been written?
        const prior = await read<LeadActionRow>({
          statement: `SELECT action_id, command_hash, ${lead.recordIdColumn} AS record_id, record_version, result FROM ${leadTable} WHERE idempotency_key = :key AND caused_by_action_id IS NULL LIMIT 2`,
          parameters: { key: input.idempotencyKey },
        });
        if (prior[0]) {
          if (prior[0].command_hash !== commandHash) throw new IdempotencyKeyReusedError();
          const stored = {
            actionId: prior[0].action_id,
            recordId: prior[0].record_id,
            recordVersion: Number(prior[0].record_version),
            affectedAreas: [],
            actionWatermarks: {},
          };
          // The original response, from the row its block stored: not today's state
          // except compatibility fallback for old stored result shapes.
          const result = await definition.result(storedRow(prior[0].result), {
            names,
            read,
            recordId: stored.recordId,
            recordVersion: stored.recordVersion,
            user: input.user,
          });
          return { value: { ...stored, replayed: true, result }, outcome: "replayed" as const };
        }

        const block = new AtomicBlock();
        const ctx: WriteContext & {
          payload: P;
          expectedVersion: number;
          user: SessionUser;
          read: ReadFn;
          recordRefusal: (datasetId: string) => Promise<void>;
        } = {
          block,
          names,
          actor: input.actor,
          actionId,
          occurredAt: now(),
          idempotencyKey: input.idempotencyKey,
          effects: [],
          ...(options.newDisplayCode ? { newDisplayCode: options.newDisplayCode } : {}),
          payload: input.payload,
          expectedVersion: input.expectedVersion,
          user: input.user,
          read,
          recordRefusal,
        };
        // A writer that committed this key after our pre-read: retry, and the re-read replays it.
        block.signal(
          `EXISTS (SELECT 1 FROM ${leadTable} WHERE idempotency_key = ${block.bind(input.idempotencyKey)} AND caused_by_action_id IS NULL)`,
          GUARD_STATE.idempotencyRace,
          "edp:idempotency-race",
        );
        const plan = await definition.plan(ctx);
        const rowContext: Omit<ResultRowContext, "block"> = {
          recordId: plan.recordId,
          recordVersion: plan.recordVersion,
          actionId,
          occurredAt: ctx.occurredAt,
          actor: input.actor,
          user: input.user,
          leadAction: plan.leadAction,
          names,
        };
        const create = isCreate(ctx, plan.recordId, leadTable);
        const created = create
          ? insertedResultRow(definition as CommandDefinition<unknown, unknown>, ctx, rowContext)
          : undefined;
        // The response row as the plan's writes leave it (for a create, from
        // the inserted values), stored with the lead action and committed with it.
        const resultRow = block.declare(
          "STRING",
          `SELECT to_json(struct(*)) FROM (${definition.resultRow({
            ...rowContext,
            names: resultNames(names, created),
            block,
          })}) AS edp_result_row`,
        );
        block.signal(`${resultRow} IS NULL`, GUARD_STATE.incompleteWrite, "edp:incomplete-write");

        const { columns: leadColumns, ...leadAction } = plan.leadAction;
        insertRow(ctx, lead, {
          ...leadColumns,
          ...actionColumns(ctx, lead, {
            recordId: plan.recordId,
            recordVersion: plan.recordVersion,
            ...leadAction,
          }),
          command: commandJson,
          command_hash: commandHash,
          expected_effects: json(ctx.effects.map(({ table, id }) => ({ table, id }))),
          result: { sql: resultRow },
        });
        const affectedAreas = [
          definition.area,
          ...ctx.effects.map((effect) => snapshotAreaFor(effect.table)),
        ];
        const actionWatermarks: Record<string, string[]> = { [definition.area]: [actionId] };
        for (const effect of ctx.effects) {
          if (!isSnapshotActionTable(effect.table)) continue;
          const area = snapshotAreaFor(effect.table);
          actionWatermarks[area] = [...(actionWatermarks[area] ?? []), effect.id];
        }
        // A create's rows are all inserts, committed together or not at all.
        const checks = create
          ? []
          : [
              ...ctx.effects.map((effect) => effect.check),
              `(SELECT count(*) FROM ${leadTable} WHERE action_id = ${block.bind(actionId)})`,
            ];
        for (const check of checks) {
          block.signal(`${check} <> 1`, GUARD_STATE.incompleteWrite, "edp:incomplete-write");
        }
        block.select(
          `SELECT ${block.bind(actionId)} AS action_id, ${checks.length ? `${checks.join(" + ")} AS num_affected_rows, ` : ""}${resultRow} AS result`,
        );

        const { rows } = await executeBlock(block, actionId);
        if (!rows[0]) throw new Error("The command's block returned no row.");
        const affected = checks.length ? Number(rows[0]["num_affected_rows"] ?? 0) : 0;
        if (affected !== checks.length) {
          // Unreachable on a real warehouse (the guards above refuse first);
          // kept so a short count can never pass as a success.
          throw new VersionConflictError(
            `expected ${checks.length} affected rows, got ${affected}`,
          );
        }
        const stored = { actionId, recordId: plan.recordId, recordVersion: plan.recordVersion };
        // Built from the same stored row a replay uses, so the two always match.
        const result = await definition.result(storedRow(rows[0]?.["result"]), {
          names,
          read,
          recordId: plan.recordId,
          recordVersion: plan.recordVersion,
          user: input.user,
        });
        return {
          value: {
            ...stored,
            affectedAreas: [...new Set(affectedAreas)].sort(),
            actionWatermarks: Object.fromEntries(
              Object.entries(actionWatermarks).map(([area, ids]) => [area, [...new Set(ids)]]),
            ),
            replayed: false,
            result,
          },
          block,
        };
      });
      return { ...value, attempts };
    },
  };
  return runner;
}

/** Carries the block a failure came from, so a guard's index maps back to its error. */
class AttemptError extends Error {
  readonly block: AtomicBlock;
  constructor(cause: unknown, block: AtomicBlock) {
    super("attempt failed");
    this.cause = cause;
    this.block = block;
  }
}
