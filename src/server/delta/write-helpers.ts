/**
 * Shared write helpers for the two table patterns in `docs/data-model.md`:
 * current-state tables and action tables.
 *
 * Every helper writes into the command's one {@link AtomicBlock}, fills the
 * shared columns the same way in every area, and records the row it produced
 * as an expected effect, which the runner stores on the lead action
 * (`expected_effects`). An updated row is re-checked before the block
 * commits; an inserted one isn't, because the block is all-or-nothing: if it
 * commits, the insert did.
 *
 * Who acted always comes from {@link WriteContext.actor}, which the router
 * resolves from the server session. No helper accepts an actor from a payload.
 */
import { newDisplayCode } from "../../data/display-codes.ts";
import { DomainError, GUARD_STATE } from "./errors.ts";
import { followOnId } from "./ids.ts";
import type { AtomicBlock, StoreNames } from "./sql-builder.ts";
import { ident } from "./sql-builder.ts";
import type { SqlValue } from "./sql-client.ts";

/** Which identity wrote an action (ADR-0008 decision 5). */
export type ActorApp = "tenant" | "staff" | "job" | "system";

/** Who acted, as written on every action row (ADR-0007 decision 3). */
export interface ActionActor {
  /** Databricks account ID from the session, or `system`. */
  principalId: string;
  /** Name as the app showed it, or `EDP Vending Machine` for `system`. */
  display: string;
  app: ActorApp;
}

export const SYSTEM_ACTOR: ActionActor = {
  principalId: "system",
  display: "EDP Vending Machine",
  app: "system",
};

/** A table in the store: `schema` is unprefixed; {@link StoreNames} adds the prefix. */
export interface TableRef {
  schema: string;
  table: string;
}

/** An action table, and the column naming the record it acts on. */
export interface ActionTableRef extends TableRef {
  recordIdColumn: string;
}

/** One row the command must produce, listed in `expected_effects`. */
export interface Effect {
  table: string;
  id: string;
  /** SQL counting this command's row; checked before commit unless the row was `inserted`. */
  check: string;
  /** Set when this block inserted the row (and nothing else touched it). */
  inserted?: InsertedRow;
}

/** A row as the block's INSERT wrote it. */
export interface InsertedRow {
  /** The full table name, as {@link StoreNames.table} gives it. */
  target: string;
  /** Column → the SQL that filled it (a parameter marker or a block variable). */
  columns: Record<string, string>;
  values: Record<string, ColumnValue>;
  /** Its INSERT's index in {@link AtomicBlock.statements}. */
  statement: number;
}

/** Everything one attempt of one command writes with. */
export interface WriteContext {
  block: AtomicBlock;
  names: StoreNames;
  actor: ActionActor;
  /** The lead action's ID. Every follow-on ID derives from it. */
  actionId: string;
  occurredAt: Date;
  idempotencyKey: string;
  effects: Effect[];
  /** Draws a display code; the runner's, so a test can force a clash. Random by default. */
  newDisplayCode?: (prefix: string) => string;
}

/** A raw SQL expression (a block variable, `current_timestamp()`), not a bound value. */
export interface SqlExpr {
  sql: string;
}

export type ColumnValue = SqlValue | SqlExpr;

function isExpr(value: ColumnValue): value is SqlExpr {
  return value !== null && typeof value === "object" && "sql" in value;
}

function valueSql(block: AtomicBlock, value: ColumnValue): string {
  return isExpr(value) ? value.sql : block.bind(value);
}

/** Bind a timestamp parameter. */
export function timestamp(value: Date): SqlValue {
  return { type: "TIMESTAMP", value: value.toISOString() };
}

/** Bind a JSON document as a `STRING` (ADR-0007: JSON only where the catalogue names it). */
export function json(value: unknown): SqlValue {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Bind a short list of plain values into an `ARRAY<STRING>` column. */
export function stringArray(block: AtomicBlock, values: string[]): SqlExpr {
  return { sql: `from_json(${block.bind(JSON.stringify(values))}, 'ARRAY<STRING>')` };
}

/** The rows each block inserted, so {@link expectRow} can tell an inserted row from an updated one. */
const insertedRows = new WeakMap<AtomicBlock, InsertedRow[]>();

/** `INSERT INTO table (cols) VALUES (…)` into the block. */
export function insertRow(
  ctx: WriteContext,
  table: TableRef,
  columns: Record<string, ColumnValue>,
): void {
  const names = Object.keys(columns);
  const values = names.map((name) => valueSql(ctx.block, columns[name]!));
  const target = ctx.names.table(table.schema, table.table);
  const statement = ctx.block.add(
    `INSERT INTO ${target} (${names.map(ident).join(", ")}) VALUES (${values.join(", ")})`,
  );
  const row: InsertedRow = {
    target,
    columns: Object.fromEntries(names.map((name, i) => [name, values[i]!])),
    values: columns,
    statement,
  };
  insertedRows.set(ctx.block, [...(insertedRows.get(ctx.block) ?? []), row]);
}

/** The follow-on ID for an effect position (UUID v5 of the lead action ID). */
export function followOn(ctx: WriteContext, position: number): Promise<string> {
  return followOnId(ctx.actionId, position);
}

/**
 * Insert a new current-state row at version 1, with the shared columns
 * (`created_*`, `updated_*`, `last_action_id`). Pass `displayCode` from
 * {@link allocateDisplayCode} for records people quote (such a row has no
 * `display_number`), or `displayNumber` from {@link allocateDisplayNumber}
 * for a change-list entry.
 */
export function insertCurrentState(
  ctx: WriteContext,
  table: TableRef,
  id: string,
  columns: Record<string, ColumnValue>,
  options: { displayCode?: SqlExpr; displayNumber?: SqlExpr } = {},
): void {
  insertRow(ctx, table, {
    id,
    ...(options.displayCode
      ? { display_code: options.displayCode, display_number: NO_DISPLAY_NUMBER }
      : {}),
    ...(options.displayNumber ? { display_number: options.displayNumber } : {}),
    ...columns,
    version: 1,
    created_at: timestamp(ctx.occurredAt),
    created_by_principal_id: ctx.actor.principalId,
    updated_at: timestamp(ctx.occurredAt),
    updated_by_principal_id: ctx.actor.principalId,
    last_action_id: ctx.actionId,
  });
  expectRow(ctx, table, "id", id, `last_action_id = ${ctx.block.bind(ctx.actionId)}`);
}

/**
 * Update a current-state row only if it's still at `expectedVersion`, moving
 * it to the next version. Inside the block, a check counts the rows this
 * update actually changed; zero means the record moved on, and the whole
 * block is refused as a version conflict (never a silent success). Returns
 * the new version.
 */
export function updateCurrentState(
  ctx: WriteContext,
  table: TableRef,
  id: string,
  expectedVersion: number,
  set: Record<string, ColumnValue>,
): number {
  const { block } = ctx;
  const target = ctx.names.table(table.schema, table.table);
  const assignments = Object.entries({
    ...set,
    updated_at: timestamp(ctx.occurredAt),
    updated_by_principal_id: ctx.actor.principalId,
    last_action_id: ctx.actionId,
  }).map(([column, value]) => `${ident(column)} = ${valueSql(block, value)}`);
  const idParam = block.bind(id);
  block.add(
    `UPDATE ${target} SET ${[...assignments, "version = version + 1"].join(", ")} WHERE id = ${idParam} AND version = ${block.bind(expectedVersion)}`,
  );
  const newVersion = expectedVersion + 1;
  block.signal(
    `(SELECT count(*) FROM ${target} WHERE id = ${idParam} AND version = ${block.bind(newVersion)} AND last_action_id = ${block.bind(ctx.actionId)}) <> 1`,
    GUARD_STATE.versionConflict,
    `edp:version-conflict`,
  );
  ctx.effects.push({
    table: `${table.schema}.${table.table}`,
    id,
    check: `(SELECT count(*) FROM ${target} WHERE id = ${idParam} AND last_action_id = ${block.bind(ctx.actionId)})`,
  });
  return newVersion;
}

export interface ActionRow {
  /** Defaults to the lead action ID; follow-on actions pass a {@link followOn} ID. */
  actionId?: string;
  recordId: string;
  /** Past-tense verb from the area's list. */
  action: string;
  /** The record's version after this action. */
  recordVersion: number;
  /** `from_<thing>` / `to_<thing>` columns, e.g. `{ stage: ["submitted", "ccb"] }`. */
  change?: Record<string, [string | null, string | null]>;
  note?: string | null;
  payload?: unknown;
  /** Set for follow-on actions: the action that caused this one. */
  causedByActionId?: string;
}

/** The action columns every action table shares, filled from the session actor. */
export function actionColumns(ctx: WriteContext, table: ActionTableRef, row: ActionRow) {
  const changes = Object.entries(row.change ?? {}).flatMap(([thing, [from, to]]) => [
    [`from_${thing}`, from] as const,
    [`to_${thing}`, to] as const,
  ]);
  return {
    action_id: row.actionId ?? ctx.actionId,
    [table.recordIdColumn]: row.recordId,
    action: row.action,
    ...Object.fromEntries(changes),
    record_version: row.recordVersion,
    actor_principal_id: ctx.actor.principalId,
    actor_display: ctx.actor.display,
    actor_app: ctx.actor.app,
    occurred_at: timestamp(ctx.occurredAt),
    idempotency_key: ctx.idempotencyKey,
    caused_by_action_id: row.causedByActionId ?? null,
    note: row.note ?? null,
    payload: json(row.payload),
  } satisfies Record<string, ColumnValue>;
}

/** Insert a follow-on action row (one caused by the lead action, or by another follow-on). */
export function insertAction(ctx: WriteContext, table: ActionTableRef, row: ActionRow): void {
  if (!row.actionId || row.actionId === ctx.actionId) {
    throw new Error("insertAction is for follow-on actions; the runner writes the lead action.");
  }
  insertRow(ctx, table, {
    ...actionColumns(ctx, table, {
      ...row,
      causedByActionId: row.causedByActionId ?? ctx.actionId,
    }),
    command: null,
    command_hash: null,
    expected_effects: null,
  });
  expectRow(ctx, table, "action_id", row.actionId);
}

/** SQL that names its tables at run time, so no text check can tell what it touches. */
const DYNAMIC_SQL = /\bidentifier\s*\(|\bexecute\s+immediate\b/;

/**
 * True when nothing but {@link insertRow}'s own INSERTs touches `target` (a
 * full table name) in this block: no other statement mentions the table's
 * name, matched case-insensitively and however it's quoted or qualified, and
 * none names tables at run time. Fails closed: a statement that merely might
 * touch the table counts as touching it.
 */
export function onlyInsertRowTouches(ctx: WriteContext, target: string): boolean {
  const ours = new Set(
    (insertedRows.get(ctx.block) ?? [])
      .filter((row) => row.target === target)
      .map((row) => row.statement),
  );
  const table = target.split(".").at(-1)!.replace(/[`"]/g, "").toLowerCase();
  const mentions = new RegExp(`(^|[^a-z0-9_])${table}($|[^a-z0-9_])`);
  return ctx.block.statements().every((statement, index) => {
    if (ours.has(index)) return true;
    const text = statement.toLowerCase().replace(/[`"]/g, "");
    return !DYNAMIC_SQL.test(text) && !mentions.test(text);
  });
}

/**
 * Record a row the block must contain before it commits. If this block
 * inserted it, the effect is marked as inserted.
 */
export function expectRow(
  ctx: WriteContext,
  table: TableRef,
  keyColumn: string,
  id: string,
  extraCondition?: string,
): void {
  const target = ctx.names.table(table.schema, table.table);
  const inserted = insertedRows
    .get(ctx.block)
    ?.find((row) => row.target === target && row.values[keyColumn] === id);
  ctx.effects.push({
    table: `${table.schema}.${table.table}`,
    id,
    check: `(SELECT count(*) FROM ${target} WHERE ${ident(keyColumn)} = ${ctx.block.bind(id)}${extraCondition ? ` AND ${extraCondition}` : ""})`,
    ...(inserted ? { inserted } : {}),
  });
}

/**
 * `display_number` on a row with a display code: a typed NULL, so a create's
 * response row (built from the inserted values) still has the column.
 */
export const NO_DISPLAY_NUMBER: SqlExpr = { sql: "CAST(NULL AS BIGINT)" };

/**
 * A display code for a new row in `table` (ADR-0007 decision 2, amended
 * 2026-10-10): `prefix` and six random characters (`ONB-7K3QFD`, see
 * `src/data/display-codes.ts`), bound as a parameter. A read inside the block
 * refuses the code if `table` already has it in `display_code`; like the
 * key-race guard, that read also makes a concurrent insert of the same code
 * conflict at commit. Either way the runner retries, and the retry plans
 * again with a fresh code. No counter row is written.
 */
export function allocateDisplayCode(ctx: WriteContext, prefix: string, table: TableRef): SqlExpr {
  const { block } = ctx;
  const code = block.bind((ctx.newDisplayCode ?? newDisplayCode)(prefix));
  block.signal(
    `EXISTS (SELECT 1 FROM ${ctx.names.table(table.schema, table.table)} WHERE display_code = ${code})`,
    GUARD_STATE.displayCodeTaken,
    "edp:display-code-taken",
  );
  return { sql: code };
}

/** The display-counter table (`admin.display_counters`, ADR-0007 decision 2). */
export const DISPLAY_COUNTERS: TableRef = { schema: "admin", table: "display_counters" };

/**
 * Take the next display number for `prefix` by moving its counter row up by
 * one, in the same block. Only change-list entries (`CL`) use it: they show
 * listing order. Everything else people quote takes {@link allocateDisplayCode}.
 * Two creations at once both update that row, so Delta fails one at commit
 * and the runner retries it; no number is handed out twice. Returns the block
 * variable holding the number.
 */
export function allocateDisplayNumber(ctx: WriteContext, prefix: string): SqlExpr {
  const { block } = ctx;
  const counters = ctx.names.table(DISPLAY_COUNTERS.schema, DISPLAY_COUNTERS.table);
  const prefixParam = block.bind(prefix);
  block.guard(
    `NOT EXISTS (SELECT 1 FROM ${counters} WHERE prefix = ${prefixParam})`,
    new DomainError(
      "display-counter-missing",
      `No display counter for ${prefix}. Run the store provisioning job.`,
      500,
    ),
  );
  const variable = block.declare(
    "BIGINT",
    `SELECT next_number FROM ${counters} WHERE prefix = ${prefixParam}`,
  );
  block.add(
    `UPDATE ${counters} SET next_number = next_number + 1, updated_at = ${block.bind(timestamp(ctx.occurredAt))} WHERE prefix = ${prefixParam}`,
  );
  return { sql: variable };
}
