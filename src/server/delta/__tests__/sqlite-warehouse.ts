/**
 * A stateful fake warehouse for unit tests: a {@link SqlClient} over an
 * in-memory SQLite database (`node:sqlite`) built from the real provisioning
 * DDL (`resources/store-*.sql`), so an area's commands and reads run their
 * actual SQL against tables with the real columns and CHECK constraints.
 *
 * `fake-sql-client.ts` scripts one answer per statement; this one keeps
 * state, so the dataset-team and change-list contract tests can run the
 * same scenarios against the Delta path that they run against the memory
 * adapter.
 *
 * What it plays:
 *
 * - **`BEGIN ATOMIC … END`** as one SQLite transaction. `DECLARE`/`SET`
 *   variables, `IF … THEN SIGNAL SQLSTATE … END IF` guards (raised the way
 *   the warehouse raises them, so the runner maps them back), and the final
 *   `SELECT`. Any failure rolls the whole block back.
 * - **Delta's conflicts, conservatively.** A block takes its snapshot when it
 *   arrives. If another block committed to any table it touches after that,
 *   it fails with `DELTA_CONCURRENT_APPEND` and the runner retries it.
 *   {@link SqliteWarehouse.hold} queues arriving blocks, so a test can start
 *   two writers from the same state.
 * - **Spark SQL spelled differently in SQLite**, translated textually:
 *   three-part names, `_metadata.row_id` (insertion order: SQLite's `rowid`),
 *   `named_struct`/`collect_list`/`to_json`/`from_json`/`get_json_object`,
 *   and `CAST(… AS STRING)`.
 *
 * It doesn't play everything: the live check (`scripts/delta-live-check.ts`)
 * runs the same commands on a real warehouse.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { SqlError } from "../errors.ts";
import type { SqlClient, SqlResult, SqlStatement, SqlTag, SqlValue } from "../sql-client.ts";
import { deltaConflict, signalled } from "./fake-sql-client.ts";

const RESOURCES = join(process.cwd(), "resources");

/** The DDL files whose tables the fake creates. */
export const DEFAULT_DDL_FILES = ["store-admin.sql", "store-teams.sql"];

export interface SqliteWarehouse {
  client: SqlClient;
  /** Run SQL directly (setup and assertions). Takes `schema__table` names. */
  query<T = Record<string, unknown>>(sql: string, params?: Record<string, SQLInputValue>): T[];
  /** Queue every block that arrives until the returned release is called. */
  hold(): () => void;
  /** Every statement the client was asked to run, as sent. */
  statements: string[];
  /** Blocks that failed with a simulated Delta conflict. */
  conflicts: number;
}

/** Split on `sep` at depth 0, outside quotes. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      current += c;
      if (c === "\\") current += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "`" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === sep && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Replace every call `name(args)` with `wrap(args)`, matching parentheses. */
function rewriteCall(sql: string, name: string, wrap: (args: string) => string): string {
  const pattern = new RegExp(`\\b${name}\\(`, "g");
  let out = "";
  let last = 0;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    if (match.index < last) continue;
    let depth = 1;
    let i = pattern.lastIndex;
    let quote: string | null = null;
    for (; i < sql.length && depth > 0; i++) {
      const c = sql[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const args = sql.slice(pattern.lastIndex, i - 1);
    out += sql.slice(last, match.index) + wrap(rewriteCall(args, name, wrap));
    last = i;
    pattern.lastIndex = i;
  }
  return out + sql.slice(last);
}

/** Spark SQL as the server writes it → the same statement for SQLite. */
export function translate(sql: string): string {
  let out = sql.replace(
    /`[A-Za-z0-9_]+`\.`([A-Za-z0-9_]+)`\.`([A-Za-z0-9_]+)`/g,
    (_m, schema: string, table: string) => `"${schema}__${table}"`,
  );
  out = out
    .replace(/\b(\w+)\._metadata\.row_id\b/g, "$1.rowid")
    .replace(/\b_metadata\.row_id\b/g, "rowid");
  out = out.replace(/from_json\((:\w+), 'ARRAY<STRING>'\)/g, "$1");
  out = out.replace(/CAST\(NULL AS ARRAY<STRING>\)/g, "NULL");
  out = rewriteCall(out, "named_struct", (args) => `json_object(${args})`);
  out = rewriteCall(out, "collect_list", (args) => `json_group_array(${args})`);
  // Arrays are stored as JSON text already, and json_group_array/json_object return text.
  out = rewriteCall(out, "to_json", (args) => `(${args})`);
  out = out.replace(/\bget_json_object\(/g, "json_extract(");
  out = out.replace(/ AS STRING\)/g, " AS TEXT)");
  return out;
}

function sqliteValue(value: SqlValue): SQLInputValue {
  const raw = value !== null && typeof value === "object" ? value.value : value;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  return raw;
}

/** Only the parameters a statement names (SQLite refuses unknown ones). */
function bindingsFor(sql: string, values: Record<string, SQLInputValue>) {
  const unquoted = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const used: Record<string, SQLInputValue> = {};
  for (const match of unquoted.matchAll(/:(\w+)/g)) {
    const name = match[1]!;
    if (name in values) used[name] = values[name]!;
  }
  return used;
}

function plain(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

const TYPE_MAP: Array<[RegExp, string]> = [
  [/^(STRING|TIMESTAMP|DATE)$/, "TEXT"],
  [/^ARRAY</, "TEXT"],
  [/^(BIGINT|INT|INTEGER|SMALLINT)$/, "INTEGER"],
  [/^(DOUBLE|FLOAT)$/, "REAL"],
  [/^DECIMAL/, "NUMERIC"],
  [/^BOOLEAN$/, "INTEGER"],
];

/** `CREATE TABLE` statements for SQLite from one DDL file, with its CHECK constraints. */
export function sqliteSchema(file: string): { creates: string[]; counters: [string, number][] } {
  const text = readFileSync(join(RESOURCES, file), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const checks = new Map<string, string[]>();
  const addConstraint =
    /ALTER TABLE IDENTIFIER\([^)]*'(\w+)\.(\w+)'\) ADD CONSTRAINT \w+ CHECK \((.*)\);/g;
  for (const match of text.matchAll(addConstraint)) {
    const key = `${match[1]}__${match[2]}`;
    checks.set(key, [...(checks.get(key) ?? []), match[3]!]);
  }
  const creates: string[] = [];
  const create = /CREATE TABLE IF NOT EXISTS IDENTIFIER\([^)]*'(\w+)\.(\w+)'\)\s*\(/g;
  for (let match = create.exec(text); match; match = create.exec(text)) {
    let depth = 1;
    let i = create.lastIndex;
    let quote = false;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === "'") quote = false;
      } else if (c === "'") quote = true;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const body = text.slice(create.lastIndex, i - 1);
    const name = `${match[1]}__${match[2]}`;
    const columns: string[] = [];
    for (const part of splitTopLevel(body, ",")) {
      const definition = part.trim().replace(/\s+COMMENT\s+'(?:[^'\\]|\\.)*'/, "");
      const pk = /^CONSTRAINT \w+ PRIMARY KEY \(([^)]*)\)/.exec(definition);
      if (pk) {
        columns.push(`PRIMARY KEY (${pk[1]})`);
        continue;
      }
      const [column, type = "STRING", ...rest] = definition.split(/\s+/);
      const mapped = TYPE_MAP.find(([pattern]) => pattern.test(type))?.[1] ?? "TEXT";
      columns.push(`${column} ${mapped}${rest.join(" ").includes("NOT NULL") ? " NOT NULL" : ""}`);
    }
    for (const check of checks.get(name) ?? []) columns.push(`CHECK (${check})`);
    creates.push(`CREATE TABLE "${name}" (${columns.join(", ")})`);
  }
  const counters: [string, number][] = [];
  for (const m of text.matchAll(/SELECT '([A-Z]+)', (\d+), current_timestamp\(\)/g)) {
    counters.push([m[1]!, Number(m[2])]);
  }
  return { creates, counters };
}

export function createSqliteWarehouse(
  options: { files?: string[]; now?: () => Date } = {},
): SqliteWarehouse {
  const db = new DatabaseSync(":memory:");
  const now = options.now ?? (() => new Date());
  const counters: [string, number][] = [];
  for (const file of options.files ?? DEFAULT_DDL_FILES) {
    const schema = sqliteSchema(file);
    for (const create of schema.creates) db.exec(create);
    counters.push(...schema.counters);
  }
  for (const [prefix, next] of counters) {
    db.prepare(
      `INSERT INTO "admin__display_counters" (prefix, next_number, updated_at) VALUES (?, ?, ?)`,
    ).run(prefix, next, now().toISOString());
  }

  /** Commit sequence per table, for conflict detection. */
  const lastCommit = new Map<string, number>();
  let sequence = 0;
  let gate: Promise<void> | null = null;
  const statements: string[] = [];
  const warehouse: SqliteWarehouse = {
    client: undefined as unknown as SqlClient,
    query: (sql, params = {}) =>
      db
        .prepare(sql)
        .all(params)
        .map((row) => plain(row as Record<string, unknown>)) as never,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    statements,
    conflicts: 0,
  };

  function run(sql: string, values: Record<string, SQLInputValue>) {
    try {
      const prepared = db.prepare(sql);
      const params = bindingsFor(sql, values);
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
        return { rows: prepared.all(params).map((r) => plain(r as Record<string, unknown>)) };
      }
      const info = prepared.run(params);
      return { rows: [], changes: Number(info.changes) };
    } catch (error) {
      if (error instanceof SqlError) throw error;
      throw new SqlError(`[SQLITE_FAKE] ${(error as Error).message}\n${sql}`, {
        errorCode: "BAD_REQUEST",
      });
    }
  }

  const tablesIn = (sql: string) => new Set([...sql.matchAll(/"(\w+__\w+)"/g)].map((m) => m[1]!));
  const writtenIn = (sql: string) =>
    new Set(
      [...sql.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+__\w+)"/g)].map((m) => m[1]!),
    );

  function runBlock(sql: string, values: Record<string, SQLInputValue>) {
    const body = sql.replace(/^BEGIN ATOMIC\n/, "").replace(/\nEND;$/, "");
    const pieces = splitTopLevel(body, ";").map((piece) => piece.trim());
    const steps: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      if (/^IF\b/.test(pieces[i]!)) {
        // `IF (…) THEN SIGNAL …; END IF`: the splitter cut it at the SIGNAL's `;`.
        steps.push(`${pieces[i]}; ${pieces[i + 1]}`);
        i++;
      } else if (pieces[i]) steps.push(pieces[i]!);
    }
    const variables: Record<string, SQLInputValue> = {};
    const withVariables = (text: string) =>
      text.replace(/\bedp_v(\d+)\b/g, (_m, n: string) => `:edp_v${n}`);
    let rows: Record<string, unknown>[] = [];
    db.exec("BEGIN");
    try {
      for (const step of steps) {
        const params = { ...values, ...variables };
        const declare = /^DECLARE (edp_v\d+) \w+$/.exec(step);
        if (declare) {
          variables[declare[1]!] = null;
          continue;
        }
        const set = /^SET (edp_v\d+) = \(([\s\S]*)\)$/.exec(step);
        if (set) {
          // The runner's result row: `to_json(struct(*))` of one row, built here.
          const inner = /^SELECT \(struct\(\*\)\) FROM \(([\s\S]*)\) AS edp_result_row$/.exec(
            set[2]!,
          );
          if (inner) {
            const row = run(withVariables(inner[1]!), params).rows[0];
            variables[set[1]!] = row ? JSON.stringify(row) : null;
          } else {
            const value = run(`SELECT (${withVariables(set[2]!)}) AS v`, params).rows[0]?.["v"];
            variables[set[1]!] = (value ?? null) as SQLInputValue;
          }
          continue;
        }
        const guard =
          /^IF \(([\s\S]*)\) THEN\s+SIGNAL SQLSTATE '(\w+)' SET MESSAGE_TEXT = '([^']*)'; END IF$/.exec(
            step,
          );
        if (guard) {
          const hit = run(
            `SELECT CASE WHEN (${withVariables(guard[1]!)}) THEN 1 ELSE 0 END AS hit`,
            params,
          ).rows[0]?.["hit"];
          if (Number(hit) === 1) throw signalled(guard[2]!, guard[3]!);
          continue;
        }
        rows = run(withVariables(step), params).rows;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return rows;
  }

  warehouse.client = {
    async execute<T extends object>(statement: SqlStatement, _tag: SqlTag): Promise<SqlResult<T>> {
      statements.push(statement.statement);
      const sql = translate(statement.statement);
      const values = Object.fromEntries(
        Object.entries(statement.parameters ?? {}).map(([k, v]) => [k, sqliteValue(v)]),
      );
      if (!sql.startsWith("BEGIN ATOMIC")) {
        const result = run(sql, values);
        if ("changes" in result) {
          for (const table of writtenIn(sql)) lastCommit.set(table, ++sequence);
          return { rows: [], numAffectedRows: result.changes ?? null };
        }
        return { rows: result.rows as T[], numAffectedRows: null };
      }
      const snapshot = sequence;
      while (gate) await gate;
      for (const table of tablesIn(sql)) {
        if ((lastCommit.get(table) ?? 0) > snapshot) {
          warehouse.conflicts++;
          throw deltaConflict();
        }
      }
      const rows = runBlock(sql, values);
      const committed = ++sequence;
      for (const table of writtenIn(sql)) lastCommit.set(table, committed);
      return { rows: rows as T[], numAffectedRows: null };
    },
  };
  return warehouse;
}
