/**
 * The server-only `SqlClient` (issue #76, ADR-0007 decision 6).
 *
 * It runs one parameterised statement at a time through the Databricks SQL
 * Statement Execution API, as the app's service principal (OAuth M2M, from
 * server env only; ADR-0004). It returns the rows and, for DML, the
 * `num_affected_rows` the API reports.
 *
 * Every statement is prefixed with a SQL comment naming the lead action
 * (`/* edp_action_id=<uuid> *\/`) or, for a read, the read's ID, so it can be
 * joined to Databricks' query history and audit log. The client writes the
 * comment itself from a validated UUID, so callers can't leave it out or
 * inject into it.
 *
 * This module never reaches the browser bundle: only `src/server/**` imports it.
 */
import { SqlError, StatementAbandonedError } from "./errors.ts";
import { isUuid } from "./ids.ts";

/** SQL types the API accepts for a parameter. */
export type SqlParamType =
  "STRING" | "BIGINT" | "INT" | "DOUBLE" | "DECIMAL" | "BOOLEAN" | "TIMESTAMP" | "DATE";

/** A parameter with an explicit SQL type, e.g. `{ type: "TIMESTAMP", value: iso }`. */
export interface TypedSqlValue {
  type: SqlParamType;
  value: string | number | boolean | null;
}

export type SqlValue = string | number | boolean | null | TypedSqlValue;

export interface SqlStatement {
  statement: string;
  parameters?: Record<string, SqlValue>;
}

/** Which action (or read) a statement belongs to; written as the leading SQL comment. */
export type SqlTag = { actionId: string } | { readId: string };

export interface SqlResult<T> {
  rows: T[];
  /** `num_affected_rows` for a standalone DML statement; `null` for anything else. */
  numAffectedRows: number | null;
}

export interface SqlClient {
  execute<T extends object = Record<string, unknown>>(
    statement: SqlStatement,
    tag: SqlTag,
  ): Promise<SqlResult<T>>;
}

/** The comment every statement starts with. Throws on a malformed ID. */
export function tagComment(tag: SqlTag): string {
  if ("actionId" in tag) {
    if (!isUuid(tag.actionId)) throw new Error(`Invalid action id for SQL tag: ${tag.actionId}`);
    return `/* edp_action_id=${tag.actionId} */`;
  }
  if (!isUuid(tag.readId)) throw new Error(`Invalid read id for SQL tag: ${tag.readId}`);
  return `/* edp_read_id=${tag.readId} */`;
}

/**
 * Map a JS value to the API's `{ name, value, type }` parameter shape.
 * Plain integer numbers deliberately bind as BIGINT. SQL grammar positions
 * that require INT, notably parameterized LIMIT/OFFSET, must pass
 * `{ type: "INT", value }` explicitly.
 */
export function toApiParameter(
  name: string,
  input: SqlValue,
): { name: string; value?: string; type: SqlParamType } {
  const typed: TypedSqlValue =
    input !== null && typeof input === "object"
      ? input
      : typeof input === "number"
        ? { type: Number.isInteger(input) ? "BIGINT" : "DOUBLE", value: input }
        : typeof input === "boolean"
          ? { type: "BOOLEAN", value: input }
          : { type: "STRING", value: input };
  return typed.value === null
    ? { name, type: typed.type }
    : { name, value: String(typed.value), type: typed.type };
}

interface ApiColumn {
  name: string;
  type_name?: string;
}
interface ApiResponse {
  statement_id?: string;
  status?: {
    state?: string;
    sql_state?: string;
    error?: { error_code?: string; message?: string };
  };
  manifest?: { schema?: { columns?: ApiColumn[] } };
  result?: { data_array?: Array<Array<string | null>>; next_chunk_internal_link?: string };
}

function convert(value: string | null, typeName: string | undefined): unknown {
  if (value === null) return null;
  switch (typeName) {
    case "BYTE":
    case "SHORT":
    case "INT":
    case "LONG":
    case "FLOAT":
    case "DOUBLE":
    case "DECIMAL":
      return Number(value);
    case "BOOLEAN":
      return value === "true";
    case "ARRAY":
    case "MAP":
    case "STRUCT":
      return JSON.parse(value);
    default:
      return value;
  }
}

/** Turn the API's column-ordered arrays into row objects with JS types. */
export function rowsFromApi(
  columns: ApiColumn[],
  data: Array<Array<string | null>>,
): Array<Record<string, unknown>> {
  return data.map((cells) =>
    Object.fromEntries(
      columns.map((column, index) => [
        column.name,
        convert(cells[index] ?? null, column.type_name),
      ]),
    ),
  );
}

export interface StatementExecutionClientOptions {
  /** Workspace origin, e.g. `https://myworkspace.cloud.databricks.com`. */
  host: string;
  warehouseId: string;
  /** Returns a bearer token for the app's service principal. */
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (message: string) => void;
  /**
   * The client-side deadline for one statement, from submission. Past it the
   * client cancels the statement and throws {@link StatementAbandonedError}:
   * the statement may still have committed, so a caller with an idempotency
   * key re-reads before writing again. Default 45 s.
   */
  deadlineMs?: number;
  /** How long the first call blocks server-side before polling takes over. Default 10 s. */
  waitTimeoutSeconds?: number;
  /** Command/action statements may use a different server-side wait than reads. */
  commandWaitTimeoutSeconds?: number;
  /** Read statements may use a different server-side wait than commands. */
  readWaitTimeoutSeconds?: number;
  /** Delay between status polls. Default 500 ms. */
  pollIntervalMs?: number;
  /** Delay between status polls for command/action statements. */
  commandPollIntervalMs?: number;
  /** Delay between status polls for read statements. */
  readPollIntervalMs?: number;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]);
const DEFAULT_WAIT_TIMEOUT_SECONDS = 10;
const MIN_WAIT_TIMEOUT_SECONDS = 5;
const MAX_WAIT_TIMEOUT_SECONDS = 45;
const MIN_POLL_INTERVAL_MS = 100;
const MAX_POLL_INTERVAL_MS = 5_000;

function wholeNumber(value: number, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
  return value;
}

function waitTimeoutSeconds(
  value: number | undefined,
  fallback: number | undefined,
  deadlineMs: number,
  warn: (message: string) => void,
  label: string,
): number {
  const defaultValue = DEFAULT_WAIT_TIMEOUT_SECONDS;
  const requested = wholeNumber(value ?? fallback ?? defaultValue, "wait_timeout seconds");
  const max = Math.max(
    MIN_WAIT_TIMEOUT_SECONDS,
    Math.min(MAX_WAIT_TIMEOUT_SECONDS, Math.floor(deadlineMs / 1000)),
  );
  if (requested < MIN_WAIT_TIMEOUT_SECONDS) {
    warn(
      `${label} wait_timeout ${requested}s is outside the Statement Execution API's supported range; using the default ${defaultValue}s.`,
    );
    return Math.min(max, defaultValue);
  }
  return Math.min(max, requested);
}

function pollIntervalMs(value: number | undefined, fallback: number | undefined): number {
  const requested = wholeNumber(value ?? fallback ?? 500, "poll interval milliseconds");
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, requested));
}

/** A {@link SqlClient} over the Statement Execution API (`/api/2.0/sql/statements`). */
export function createStatementExecutionClient(
  options: StatementExecutionClientOptions,
): SqlClient {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const warn = options.warn ?? console.warn;
  const deadlineMs = options.deadlineMs ?? 45_000;
  const commandWaitTimeout = waitTimeoutSeconds(
    options.commandWaitTimeoutSeconds,
    options.waitTimeoutSeconds,
    deadlineMs,
    warn,
    "Command",
  );
  const readWaitTimeout = waitTimeoutSeconds(
    options.readWaitTimeoutSeconds,
    options.waitTimeoutSeconds,
    deadlineMs,
    warn,
    "Read",
  );
  const commandPollInterval = pollIntervalMs(options.commandPollIntervalMs, options.pollIntervalMs);
  const readPollInterval = pollIntervalMs(options.readPollIntervalMs, options.pollIntervalMs);
  const host = options.host.replace(/\/+$/, "");

  async function call(path: string, init: RequestInit = {}): Promise<ApiResponse> {
    const token = await options.getToken();
    const response = await request(`${host}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new SqlError(`Statement Execution API ${response.status}: ${text.slice(0, 500)}`, {
        errorCode: `HTTP_${response.status}`,
      });
    }
    return (text ? JSON.parse(text) : {}) as ApiResponse;
  }

  return {
    async execute<T extends object>(statement: SqlStatement, tag: SqlTag): Promise<SqlResult<T>> {
      const body = {
        warehouse_id: options.warehouseId,
        statement: `${tagComment(tag)}\n${statement.statement}`,
        parameters: Object.entries(statement.parameters ?? {}).map(([name, value]) =>
          toApiParameter(name, value),
        ),
        // Async execution: block at most the configured wait timeout on the
        // first call, then poll. The 45 s client deadline stays explicit.
        wait_timeout: `${"actionId" in tag ? commandWaitTimeout : readWaitTimeout}s`,
        on_wait_timeout: "CONTINUE",
        format: "JSON_ARRAY",
        disposition: "INLINE",
      };
      const started = now();
      let response = await call("/api/2.0/sql/statements", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const id = response.statement_id;
      while (!TERMINAL.has(response.status?.state ?? "")) {
        if (now() - started >= deadlineMs) {
          // Abandon it: cancel, then look once more, because the statement may
          // have finished (even committed) before the cancel landed.
          if (id) {
            await call(`/api/2.0/sql/statements/${id}/cancel`, { method: "POST" }).catch(
              () => undefined,
            );
            response = await call(`/api/2.0/sql/statements/${id}`).catch(() => response);
          }
          if (response.status?.state === "SUCCEEDED") break;
          throw new StatementAbandonedError(deadlineMs, response.status?.state, id);
        }
        await sleep("actionId" in tag ? commandPollInterval : readPollInterval);
        response = await call(`/api/2.0/sql/statements/${id}`);
      }
      const state = response.status?.state;
      if (state !== "SUCCEEDED") {
        const error = response.status?.error;
        throw new SqlError(error?.message ?? `Statement ${state?.toLowerCase()}.`, {
          ...(response.status?.sql_state ? { sqlState: response.status.sql_state } : {}),
          ...(error?.error_code ? { errorCode: error.error_code } : {}),
          ...(response.statement_id ? { statementId: response.statement_id } : {}),
        });
      }
      const columns = response.manifest?.schema?.columns ?? [];
      const data = [...(response.result?.data_array ?? [])];
      let next = response.result?.next_chunk_internal_link;
      while (next) {
        const chunk = (await call(next)) as ApiResponse["result"] & {};
        data.push(...(chunk.data_array ?? []));
        next = chunk.next_chunk_internal_link;
      }
      const rows = rowsFromApi(columns, data) as T[];
      const affected =
        columns[0]?.name === "num_affected_rows" && data.length === 1 ? Number(data[0]![0]) : null;
      return { rows, numAffectedRows: affected };
    },
  };
}

export interface TokenSourceOptions {
  host: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * OAuth M2M (client credentials) for the app's service principal, cached
 * until a minute before it expires. Databricks Apps inject
 * `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` into the app's server
 * environment; they're never sent to the browser.
 */
export function createServicePrincipalTokenSource(
  options: TokenSourceOptions,
): () => Promise<string> {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const host = options.host.replace(/\/+$/, "");
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const response = await request(`${host}/oidc/v1/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=all-apis",
    });
    if (!response.ok)
      throw new Error(`Databricks OAuth token request failed (${response.status}).`);
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token)
      throw new Error("Databricks OAuth response contained no access token.");
    const expiresIn =
      typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
    cached = { token: payload.access_token, expiresAt: now() + expiresIn * 1000 };
    return payload.access_token;
  }

  return async () => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}
