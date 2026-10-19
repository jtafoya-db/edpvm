/**
 * A fake {@link SqlClient} for unit tests. It records every statement with its
 * tag, and answers each one from a scripted responder, so a test can play the
 * warehouse: return rows, report affected rows, or fail like Delta does.
 */
import { vi } from "vitest";

import { SqlError } from "../errors.ts";
import {
  tagComment,
  type SqlClient,
  type SqlResult,
  type SqlStatement,
  type SqlTag,
} from "../sql-client.ts";

export interface RecordedStatement {
  statement: string;
  parameters: Record<string, unknown>;
  tag: SqlTag;
  /** The statement as the real client would send it, comment first. */
  sent: string;
}

export type Responder = (
  call: RecordedStatement,
  index: number,
) =>
  | Partial<SqlResult<Record<string, unknown>>>
  | void
  | Promise<Partial<SqlResult<Record<string, unknown>>> | void>;

export function fakeSqlClient(responder: Responder = () => undefined) {
  const calls: RecordedStatement[] = [];
  const client: SqlClient = {
    execute: vi.fn(async (statement: SqlStatement, tag: SqlTag) => {
      const call: RecordedStatement = {
        statement: statement.statement,
        parameters: { ...(statement.parameters ?? {}) },
        tag,
        sent: `${tagComment(tag)}\n${statement.statement}`,
      };
      calls.push(call);
      const result = (await responder(call, calls.length - 1)) ?? {};
      return { rows: result.rows ?? [], numAffectedRows: result.numAffectedRows ?? null };
    }) as SqlClient["execute"],
  };
  return {
    client,
    calls,
    blocks: () => calls.filter((call) => call.statement.startsWith("BEGIN ATOMIC")),
    lookups: () => calls.filter((call) => call.statement.includes("WHERE idempotency_key = :key")),
  };
}

/**
 * A block's success: the final SELECT reports every planned row as affected
 * (a create's has no count), and returns `resultRow` as the response row the
 * block stored (as JSON, the way `to_json` gives it back).
 */
export function committed(
  call: RecordedStatement,
  resultRow: Record<string, unknown> = {},
): { rows: Array<{ action_id: string; num_affected_rows?: number; result: string }> } {
  const counted = /SELECT :p\d+ AS action_id, (.*) AS num_affected_rows, edp_v\d+ AS result;/.exec(
    call.statement,
  );
  const result = JSON.stringify(resultRow);
  if (!counted) return { rows: [{ action_id: "x", result }] };
  const checks = counted[1]!.split(" + ").filter(Boolean).length;
  return { rows: [{ action_id: "x", num_affected_rows: checks, result }] };
}

/** The error a Delta write-write or phantom-read conflict comes back as. */
export function deltaConflict(): SqlError {
  return new SqlError(
    "[DELTA_CONCURRENT_APPEND.ROW_LEVEL_CHANGES] ConcurrentAppendException: Files were added to the root of the table by a concurrent update. Please try the operation again.",
    { sqlState: "2D521", errorCode: "BAD_REQUEST" },
  );
}

/** What a `SIGNAL` inside the block comes back as. */
export function signalled(sqlState: string, message: string): SqlError {
  return new SqlError(`[USER_RAISED_EXCEPTION] ${message} SQLSTATE: ${sqlState}`, {
    sqlState,
    errorCode: "BAD_REQUEST",
  });
}

/** The bound value of the parameter that fills `column` in an INSERT. */
export function insertedValue(call: RecordedStatement, table: string, column: string): unknown {
  const insert = call.statement
    .split("\n")
    .find((line) => line.startsWith("INSERT INTO") && line.includes(`\`${table}\``));
  if (!insert) return undefined;
  const match = /\(([^)]*)\) VALUES \((.*)\);$/.exec(insert);
  if (!match) return undefined;
  const columns = match[1]!.split(", ").map((c) => c.replace(/`/g, ""));
  const values = match[2]!.split(/, (?![^(]*\))/);
  const marker = values[columns.indexOf(column)]?.trim();
  if (!marker?.startsWith(":")) return marker;
  const value = call.parameters[marker.slice(1)];
  return value !== null && typeof value === "object" && "value" in value
    ? (value as { value: unknown }).value
    : value;
}
