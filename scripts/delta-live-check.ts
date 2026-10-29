/**
 * Live integration check for the Delta write path (#76, ADR-0007 decision 6).
 *
 * Runs the real SqlClient, transaction runner and write helpers against a
 * real SQL warehouse, in throwaway schemas, and repeats the ADR's
 * concurrency races through them:
 *
 *   1. writers racing on the same idempotency key   → one lead action, the rest replay
 *   2. a reused key with a different command         → refused
 *   3. writers racing check-then-insert (one open request per person and dataset)
 *                                                    → one succeeds, the rest are refused
 *   4. writers racing for display codes              → all commit, distinct codes, no counter
 *  4b. 10 concurrent onboarding submits and 10 EIR starts → all commit, distinct codes;
 *      total and per-create times (the old counter took 55–88 s for 10)
 *  4c. a display code that's taken                  → refused in the block, retried with a new one
 *   5. writers racing a version-checked update       → one succeeds, the rest conflict;
 *      plus a standalone UPDATE reporting num_affected_rows 1, then 0 when stale
 *   6. a block whose second statement fails          → nothing from the block persists
 *   7. the app's own write-check command, then audit.actions shows its history
 *   8. provisioning refuses an unsafe schema prefix
 *   7c. onboarding mine/inbox/request reads, set-based → one statement each, and
 *      the same result as the old per-request reads, for every role
 *   7d. a CCB send-back resubmits to the CCB, a business & ROI one to business &
 *      ROI review (#221), with fresh SLA deadlines and the changes on the action;
 *      another request's deadlines don't move
 *   7e. a resubmission edits the whole intake (#222): an ROI answer edited, a
 *      dataset added, an owner removed; kept rows keep their IDs, the new ones
 *      get server IDs, the removed one is deleted and logged, the ONB code stays;
 *      a foreign record ID is refused with nothing written; the in-memory copy
 *      (#193, loaded as the snapshot cache loads it) reads the same as SQL
 *   9. replaying a key after the record moved on      → exactly the original response
 *  11. a store provisioned before `result` existed → provisioning adds the column
 *      (twice is a no-op), then a command writes and replays on it
 *  14. a store made before display codes            → provisioning adds display_code and
 *      drops NOT NULL (twice is a no-op); the old ONB-1000 still resolves beside a new code
 *  15. monitoring.invariant_violations             → empty, then reports a duplicated code
 *  10. #72's legacy request writes on store-schema.sql's tables (not
 *      catalog-managed, so BEGIN ATOMIC is refused there): create, re-run,
 *      a re-run over a failed attempt's rows, transitions and attestations,
 *      as standalone statements
 *
 * It provisions with the real DDL files (resources/store-schema.sql,
 * resources/store-admin.sql, resources/store-eir.sql, resources/store-eir-definitions.sql,
 * resources/store-onboarding.sql, resources/store-privacy.sql, resources/store-audit.sql) under a schema prefix, then DROPs every schema
 * it made and confirms they're gone. It authenticates as whoever the CLI
 * profile is (`databricks auth token`); nothing is changed outside the
 * throwaway schemas.
 *
 * Usage (Node 24+, from the repo root):
 *
 *   node --import ./scripts/node-ts-hooks.mjs scripts/delta-live-check.ts --profile example-workspace \
 *     --warehouse 1111111111111111 --catalog example_catalog
 *
 *   # GovCloud (example-gov-demo), run by a human:
 *   node --import ./scripts/node-ts-hooks.mjs scripts/delta-live-check.ts --profile example-gov-workspace \
 *     --warehouse <example-gov-demo warehouse id> --catalog <a catalog you can create schemas in>
 *
 * Options: --prefix <schema prefix> (default edp_delta_foundation_<yyyymmdd>_),
 * --writers <n> (default 5), --keep (don't drop the schemas).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { EIR_VALUES } from "../src/data/__tests__/eir-fixtures.ts";
import { EIR_FORM } from "../src/data/eir/config.ts";
import { eirVolumePath, type EirVolumeConfig } from "../src/server/eir-storage.ts";
import { WRITE_CHECKS, registerAdminArea } from "../src/server/delta/areas/admin.ts";
import { registerEirArea } from "../src/server/delta/areas/eir.ts";
import {
  REQUEST_COLUMNS,
  registerOnboardingArea,
  toRequest,
} from "../src/server/delta/areas/onboarding.ts";
import { DEFAULT_EFFECTIVE_SLA_CONFIG } from "../src/data/sla-config.ts";
import { onboardingSlaDeadlines } from "../src/data/onboarding/lifecycle.ts";
import { COMPLETE_INTAKE_ANSWERS } from "../src/data/onboarding/intake.fixtures.ts";
import { registerRequestsArea } from "../src/server/delta/areas/requests.ts";
import type { OnboardingIntake, OnboardingRequest } from "../src/data/onboarding/types.ts";
import {
  BusyError,
  DomainError,
  IdempotencyKeyReusedError,
  SqlError,
  VersionConflictError,
} from "../src/server/delta/errors.ts";
import { newId } from "../src/server/delta/ids.ts";
import {
  createRegistry,
  type CommandDefinition,
  type LegacyWriteDefinition,
  type SessionUser,
} from "../src/server/delta/registry.ts";
import { createStoreNames } from "../src/server/delta/sql-builder.ts";
import { SNAPSHOT_TABLES, snapshotMarkerStatement } from "../src/server/delta/snapshot-cache.ts";
import { createStatementExecutionClient, type SqlClient } from "../src/server/delta/sql-client.ts";
import { createTransactionRunner, type AttemptInfo } from "../src/server/delta/transaction.ts";
import { newDisplayCode } from "../src/data/display-codes.ts";
import {
  allocateDisplayCode,
  followOn,
  insertCurrentState,
  insertRow,
  updateCurrentState,
  type ActionActor,
  type ActionTableRef,
  type TableRef,
} from "../src/server/delta/write-helpers.ts";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    warehouse: { type: "string" },
    catalog: { type: "string" },
    prefix: { type: "string" },
    writers: { type: "string", default: "5" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.profile || !args.warehouse || !args.catalog) {
  console.error(
    "Usage: node scripts/delta-live-check.ts --profile <p> --warehouse <id> --catalog <catalog>",
  );
  process.exit(2);
}
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const prefix = args.prefix ?? `edp_delta_foundation_${today}_`;
const writers = Number(args.writers);
const catalog = args.catalog;

// ---- Auth through the CLI profile ------------------------------------------

function cli(...command: string[]): string {
  return execFileSync("databricks", [...command, "-p", args.profile!], { encoding: "utf8" });
}
const described = JSON.parse(cli("auth", "describe", "-o", "json")) as {
  host?: string;
  details?: { host?: string };
};
const host = (described.details?.host ?? described.host)!;
let token: { value: string; at: number } | undefined;
const getToken = async () => {
  if (!token || Date.now() - token.at > 10 * 60_000) {
    token = {
      value: (JSON.parse(cli("auth", "token")) as { access_token: string }).access_token,
      at: Date.now(),
    };
  }
  return token.value;
};
const me = JSON.parse(cli("current-user", "me", "-o", "json")) as {
  id: string;
  displayName?: string;
  userName: string;
};

// The app's client and deadline (45 s) for everything the runner does; a
// patient one for setup, checks and cleanup, which aren't on a person's click.
type Phase = "idempotency read" | "pre-read" | "block" | "post-read" | "other";
interface PhaseTiming {
  phase: Phase;
  actionId?: string;
  readId?: string;
  elapsedMs: number;
}
const phaseTimings: PhaseTiming[] = [];
const retrySleeps: number[] = [];

function classify(statement: string, taggedRead: boolean): Phase {
  if (statement.startsWith("BEGIN ATOMIC")) return "block";
  if (statement.includes("WHERE idempotency_key = :key")) return "idempotency read";
  if (taggedRead) return "post-read";
  if (statement.startsWith("SELECT")) return "pre-read";
  return "other";
}

const statementClient: SqlClient = createStatementExecutionClient({
  host,
  warehouseId: args.warehouse,
  getToken,
});
const client: SqlClient = {
  async execute(statement, tag) {
    const started = Date.now();
    try {
      return await statementClient.execute(statement, tag);
    } finally {
      phaseTimings.push({
        phase: classify(statement.statement, "readId" in tag),
        ...("actionId" in tag ? { actionId: tag.actionId } : { readId: tag.readId }),
        elapsedMs: Date.now() - started,
      });
    }
  },
};
const adminClient: SqlClient = createStatementExecutionClient({
  host,
  warehouseId: args.warehouse,
  getToken,
  deadlineMs: 600_000,
});
// Check 5b's own client: the app's polling, with a deadline long enough that
// the answer it checks (num_affected_rows) is never lost to a slow commit.
const diagnosticClient: SqlClient = createStatementExecutionClient({
  host,
  warehouseId: args.warehouse,
  getToken,
  deadlineMs: 300_000,
});
const names = createStoreNames(catalog, prefix);
const attempts: AttemptInfo[] = [];
const runner = createTransactionRunner({
  client,
  names,
  sleep: async (ms) => {
    retrySleeps.push(ms);
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
  onAttempt: (info) => attempts.push(info),
});
const sql = async (statement: string, parameters?: Record<string, string | number | null>) =>
  adminClient.execute({ statement, ...(parameters ? { parameters } : {}) }, { actionId: newId() });

const user: SessionUser = {
  principalId: me.id,
  displayName: me.displayName ?? me.userName,
  email: me.userName,
  isAdmin: true,
  onboardingReviewerRoles: [],
};
const actor: ActionActor = { principalId: me.id, display: user.displayName, app: "staff" };
const eirApplicant: SessionUser = {
  principalId: `live-eir-${me.id}`,
  displayName: `${user.displayName} EIR Live`,
  email: user.email,
  isAdmin: false,
  onboardingReviewerRoles: [],
};
const eirValidator: SessionUser = { ...user, isSafeguardsValidator: true };

// ---- Provisioning with the real DDL files ----------------------------------

/** Split a DDL file into statements: top-level `;`, with `BEGIN … END;` blocks kept whole. */
function statementsOf(text: string): string[] {
  const lines = text.split("\n").filter((line) => !line.trim().startsWith("--"));
  const statements: string[] = [];
  let current: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (!current.length && !line.trim()) continue;
    if (!current.length && /^BEGIN\b/.test(line.trim())) inBlock = true;
    current.push(line);
    const done = inBlock ? line.trim() === "END;" : line.trimEnd().endsWith(";");
    if (done) {
      statements.push(current.join("\n").trim().replace(/;$/, ""));
      current = [];
      inBlock = false;
    }
  }
  return statements;
}

async function runDdl(file: string, schemaPrefix = prefix, text = readFileSync(file, "utf8")) {
  const statements = statementsOf(text);
  const bind = (statement: string) => {
    const parameters: Record<string, string> = {};
    if (statement.includes(":catalog_name")) parameters["catalog_name"] = catalog;
    if (statement.includes(":schema_prefix")) parameters["schema_prefix"] = schemaPrefix;
    return parameters;
  };
  // The job's SQL task runs a file in one session, so session variables carry
  // from one statement to the next. Statement Execution calls don't share a
  // session, so a file that uses them runs here as one compound block, with
  // session variables as block-local ones.
  if (statements.some((s) => s.startsWith("DECLARE OR REPLACE VARIABLE"))) {
    const rest = statements.filter((s) => !s.startsWith("USE CATALOG"));
    const declared = rest.filter((s) => s.startsWith("DECLARE OR REPLACE VARIABLE"));
    // A compound block takes its declarations first.
    const body = [...declared, ...rest.filter((s) => !declared.includes(s))].map((s) =>
      s.replace(/^DECLARE OR REPLACE VARIABLE/, "DECLARE").replace(/^SET VAR /, "SET "),
    );
    const block = `BEGIN\n${body.join(";\n")};\nEND`;
    await sql(block, bind(block)).catch((error: unknown) => {
      throw new Error(`${file} (as one block) failed: ${String(error)}\n${block}`);
    });
    return;
  }
  for (const statement of statements) {
    await sql(statement, bind(statement)).catch((error: unknown) => {
      throw new Error(`${file} failed at: ${statement.slice(0, 200)}\n${String(error)}`);
    });
  }
}

// ---- Test area: live.items (current state) and live.item_actions ----------

const ITEMS: TableRef = { schema: "live", table: "items" };
const ITEM_ACTIONS: ActionTableRef = {
  schema: "live",
  table: "item_actions",
  recordIdColumn: "item_id",
};

async function createLiveTables() {
  const items = names.table(ITEMS.schema, ITEMS.table);
  const actions = names.table(ITEM_ACTIONS.schema, ITEM_ACTIONS.table);
  await sql(`CREATE SCHEMA IF NOT EXISTS \`${catalog}\`.\`${prefix}live\``);
  await sql(
    `CREATE TABLE IF NOT EXISTS ${items} (id STRING NOT NULL, display_number BIGINT, display_code STRING, person STRING NOT NULL, dataset STRING NOT NULL, stage STRING NOT NULL, version BIGINT NOT NULL, created_at TIMESTAMP NOT NULL, created_by_principal_id STRING NOT NULL, updated_at TIMESTAMP NOT NULL, updated_by_principal_id STRING NOT NULL, last_action_id STRING NOT NULL) TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported')`,
  );
  await sql(
    `CREATE TABLE IF NOT EXISTS ${actions} (action_id STRING NOT NULL, item_id STRING NOT NULL, action STRING NOT NULL, from_stage STRING, to_stage STRING, record_version BIGINT NOT NULL, actor_principal_id STRING NOT NULL, actor_display STRING NOT NULL, actor_app STRING NOT NULL, occurred_at TIMESTAMP NOT NULL, idempotency_key STRING NOT NULL, caused_by_action_id STRING, note STRING, payload STRING, command STRING, command_hash STRING, expected_effects STRING, result STRING) TBLPROPERTIES ('delta.feature.catalogManaged' = 'supported', 'delta.enableChangeDataFeed' = 'true')`,
  );
}

const registry = createRegistry();
registerAdminArea(registry);
registerOnboardingArea(registry);
registerRequestsArea(registry);
const eirVolume: EirVolumeConfig = { catalog, schema: `${prefix}docs`, volume: "eir" };
const eirFiles = new Map<string, Uint8Array>();
registerEirArea(registry, {
  volume: () => eirVolume,
  readFile: async (path) => {
    const bytes = eirFiles.get(path);
    if (!bytes) throw new Error(`Live-check EIR file not found: ${path}`);
    return bytes;
  },
  maxUploadBytes: () => 10 * 1024 * 1024,
});
const recordWriteCheck = registry.findWrite("admin", "record-write-check") as CommandDefinition<
  { name: string },
  unknown
>;
const confirmWriteCheck = registry.findWrite("admin", "confirm-write-check") as CommandDefinition<
  { writeCheckId: string },
  unknown
>;
const submitOnboarding = registry.findWrite("onboarding", "submit") as CommandDefinition<
  { intake: OnboardingIntake },
  unknown
>;
const decideOnboarding = registry.findWrite("onboarding", "decide") as CommandDefinition<
  { requestId: string; decision: Record<string, string> },
  OnboardingRequest
>;
const resubmitOnboarding = registry.findWrite("onboarding", "resubmit") as CommandDefinition<
  { requestId: string; resubmission: Record<string, unknown> },
  OnboardingRequest
>;

const openRequest: CommandDefinition<{ person: string; dataset: string }, { id: string }> = {
  kind: "command",
  area: "live",
  name: "open-request",
  app: "tenant",
  payload: undefined as never,
  leadActionTable: ITEM_ACTIONS,
  async plan(ctx) {
    const items = ctx.names.table(ITEMS.schema, ITEMS.table);
    // The uniqueness rule, checked inside the transaction: Delta's
    // phantom-read detection fails a racing writer at commit.
    ctx.block.guard(
      `EXISTS (SELECT 1 FROM ${items} WHERE person = ${ctx.block.bind(ctx.payload.person)} AND dataset = ${ctx.block.bind(ctx.payload.dataset)} AND stage = 'open')`,
      new DomainError(
        "already-open",
        "There's already an open request for this person and dataset.",
        409,
      ),
    );
    const id = await followOn(ctx, 0);
    insertCurrentState(
      ctx,
      ITEMS,
      id,
      { person: ctx.payload.person, dataset: ctx.payload.dataset, stage: "open" },
      { displayCode: allocateDisplayCode(ctx, "LV", ITEMS) },
    );
    return {
      recordId: id,
      recordVersion: 1,
      leadAction: { action: "opened", change: { stage: [null, "open"] } },
    };
  },
  resultRow: ({ recordId, names: n, block }) =>
    `SELECT id FROM ${n.table(ITEMS.schema, ITEMS.table)} WHERE id = ${block.bind(recordId)}`,
  result: (row) => ({ id: String(row["id"]) }),
};

const touch: CommandDefinition<{ id: string }, { id: string }> = {
  kind: "command",
  area: "live",
  name: "touch",
  app: "tenant",
  payload: undefined as never,
  leadActionTable: ITEM_ACTIONS,
  plan(ctx) {
    const recordVersion = updateCurrentState(ctx, ITEMS, ctx.payload.id, ctx.expectedVersion, {
      stage: "open",
    });
    return { recordId: ctx.payload.id, recordVersion, leadAction: { action: "touched" } };
  },
  resultRow: ({ recordId, names: n, block }) =>
    `SELECT id FROM ${n.table(ITEMS.schema, ITEMS.table)} WHERE id = ${block.bind(recordId)}`,
  result: (row) => ({ id: String(row["id"]) }),
};

const failSecond: CommandDefinition<{ id: string }, unknown> = {
  kind: "command",
  area: "live",
  name: "fail-second-statement",
  app: "tenant",
  payload: undefined as never,
  leadActionTable: ITEM_ACTIONS,
  plan(ctx) {
    insertRow(ctx, ITEMS, {
      id: ctx.payload.id,
      display_number: 0,
      person: "rollback",
      dataset: "rollback",
      stage: "open",
      version: 1,
      created_at: { type: "TIMESTAMP", value: ctx.occurredAt.toISOString() },
      created_by_principal_id: actor.principalId,
      updated_at: { type: "TIMESTAMP", value: ctx.occurredAt.toISOString() },
      updated_by_principal_id: actor.principalId,
      last_action_id: ctx.actionId,
    });
    ctx.block.guard(
      "TRUE",
      new DomainError("forced", "The second statement fails on purpose.", 422),
    );
    return { recordId: ctx.payload.id, recordVersion: 1, leadAction: { action: "opened" } };
  },
  resultRow: ({ recordId, names: n, block }) =>
    `SELECT id FROM ${n.table(ITEMS.schema, ITEMS.table)} WHERE id = ${block.bind(recordId)}`,
  result: () => null,
};

/** Run one of #72's legacy request writes the way the API does. */
const legacyWrite = <P, R>(name: string, payload: P, as: SessionUser = user): Promise<R> => {
  const definition = registry.findWrite("requests", name) as LegacyWriteDefinition<P, R>;
  const actionId = newId();
  return definition.run({
    payload: definition.payload.parse(payload),
    user: as,
    names,
    actionId,
    read: runner.reader({ actionId }),
    write: (statement) => runner.standalone(actionId, statement),
  });
};

const run = <P, R>(
  definition: CommandDefinition<P, R>,
  payload: P,
  key = newId(),
  expectedVersion = 0,
) => runner.runCommand(definition, { user, actor, idempotencyKey: key, expectedVersion, payload });
const runAs = <P, R>(
  definition: CommandDefinition<P, R>,
  as: SessionUser,
  payload: P,
  key = newId(),
  expectedVersion = 0,
) =>
  runner.runCommand(definition, {
    user: as,
    actor: { principalId: as.principalId, display: as.displayName, app: definition.app },
    idempotencyKey: key,
    expectedVersion,
    payload,
  });

// ---- Checks -----------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  attempts?: number[];
  latencyMs?: number[];
}
const checks: Check[] = [];

async function check(
  name: string,
  body: () => Promise<{ pass: boolean; detail: string; actionIds?: Set<string> }>,
) {
  const before = attempts.length;
  const started = Date.now();
  try {
    const { pass, detail, actionIds } = await body();
    const mine = attempts.slice(before).filter((a) => !actionIds || actionIds.has(a.actionId));
    const perCommand = new Map<string, AttemptInfo[]>();
    for (const a of mine) perCommand.set(a.actionId, [...(perCommand.get(a.actionId) ?? []), a]);
    checks.push({
      name,
      pass,
      detail: `${detail} (${Date.now() - started} ms)`,
      attempts: [...perCommand.values()].map((list) => list.length),
      latencyMs: [...perCommand.values()].map((list) =>
        list.reduce((sum, a) => sum + a.elapsedMs, 0),
      ),
    });
  } catch (error) {
    checks.push({
      name,
      pass: false,
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const last = checks.at(-1)!;
  console.log(`${last.pass ? "PASS" : "FAIL"}  ${name}: ${last.detail}`);
}

const settle = <T>(promises: Promise<T>[]) => Promise.allSettled(promises);
const reasons = (results: PromiseSettledResult<unknown>[]) =>
  results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason as unknown);
const count = async (statement: string, parameters?: Record<string, string | number>) =>
  Number((await sql(statement, parameters)).rows[0]?.["n"]);

const items = () => names.table(ITEMS.schema, ITEMS.table);
const itemActions = () => names.table(ITEM_ACTIONS.schema, ITEM_ACTIONS.table);

async function main() {
  console.log(
    `Workspace ${host}, warehouse ${args.warehouse}, schemas ${catalog}.${prefix}{${SCHEMAS.join(",")}}, ${writers} writers`,
  );
  const version = (await sql("SELECT version() AS v")).rows[0]?.["v"];
  console.log(`Warehouse version(): ${String(version)}`);

  await runDdl("resources/store-schema.sql");
  console.log("Provisioned resources/store-schema.sql");
  await runDdl("resources/store-admin.sql");
  console.log("Provisioned resources/store-admin.sql");
  await runDdl("resources/store-teams.sql");
  console.log("Provisioned resources/store-teams.sql");
  await runDdl("resources/store-eir.sql");
  console.log("Provisioned resources/store-eir.sql");
  await runDdl("resources/store-eir-definitions.sql");
  console.log("Provisioned resources/store-eir-definitions.sql");
  await runDdl("resources/store-onboarding.sql");
  console.log("Provisioned resources/store-onboarding.sql");
  await runDdl("resources/store-privacy.sql");
  console.log("Provisioned resources/store-privacy.sql");
  await runDdl("resources/store-audit.sql");
  console.log("Provisioned resources/store-audit.sql");
  await createLiveTables();
  console.log("Provisioned live check tables");

  await check(
    "5b. standalone UPDATE reports num_affected_rows 1, then 0 when stale (run first, uncontended)",
    async () => {
      const created = await run(openRequest, { person: "p5b", dataset: "d5" });
      const update = `UPDATE ${items()} SET version = version + 1 WHERE id = :id AND version = :v`;
      // A diagnostic of what the API reports, not of latency: it runs before any
      // race, on its own patient client, so a slow commit can't hide the answer.
      const exec = (v: number) =>
        diagnosticClient.execute(
          { statement: update, parameters: { id: created.recordId, v } },
          { actionId: newId() },
        );
      const first = (await exec(1)).numAffectedRows;
      const stale = (await exec(1)).numAffectedRows;
      return { pass: first === 1 && stale === 0, detail: `first ${first}, stale ${stale}` };
    },
  );

  await check("1. same idempotency key, racing writers", async () => {
    const key = newId();
    const results = await settle(
      Array.from({ length: writers }, () => run(openRequest, { person: "p1", dataset: "d1" }, key)),
    );
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof run>>> => r.status === "fulfilled",
    );
    const leads = await count(
      `SELECT count(*) AS n FROM ${itemActions()} WHERE idempotency_key = :k AND caused_by_action_id IS NULL`,
      { k: key },
    );
    const rows = await count(
      `SELECT count(*) AS n FROM ${items()} WHERE person = 'p1' AND dataset = 'd1'`,
    );
    const actionIds = new Set(ok.map((r) => r.value.actionId));
    const replayed = ok.filter((r) => r.value.replayed).length;
    return {
      pass:
        ok.length === writers &&
        leads === 1 &&
        rows === 1 &&
        actionIds.size === 1 &&
        replayed === writers - 1,
      detail: `${ok.length}/${writers} returned the same action, ${replayed} as replays; lead actions with the key = ${leads}; rows = ${rows}; errors: ${reasons(results).map(String).join("; ") || "none"}`,
    };
  });

  await check("2. reused key with a different command", async () => {
    const key = newId();
    await run(openRequest, { person: "p1b", dataset: "d1" }, key);
    const error = await run(openRequest, { person: "p1b", dataset: "d-other" }, key).catch(
      (e: unknown) => e,
    );
    return {
      pass: error instanceof IdempotencyKeyReusedError,
      detail: `second call → ${error instanceof Error ? `${error.name}: ${error.message}` : "succeeded"}`,
    };
  });

  await check("3. check-then-insert: one open request per person and dataset", async () => {
    const results = await settle(
      Array.from({ length: writers }, () => run(openRequest, { person: "p2", dataset: "d2" })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = reasons(results).filter(
      (e) => e instanceof DomainError && e.code === "already-open",
    ).length;
    const rows = await count(
      `SELECT count(*) AS n FROM ${items()} WHERE person = 'p2' AND dataset = 'd2' AND stage = 'open'`,
    );
    const other = reasons(results).filter(
      (e) => !(e instanceof DomainError && e.code === "already-open"),
    );
    return {
      pass: ok === 1 && refused === writers - 1 && rows === 1,
      detail: `${ok} succeeded, ${refused} refused as already-open; open rows = ${rows}; other errors: ${other.map(String).join("; ") || "none"}`,
    };
  });

  await check("4. display codes: racing creations all commit with distinct codes", async () => {
    const n = writers * 2;
    const counters = () =>
      sql(
        `SELECT prefix, next_number FROM ${names.table("admin", "display_counters")} ORDER BY prefix`,
      ).then((r) => JSON.stringify(r.rows));
    const before = await counters();
    const results = await settle(
      Array.from({ length: n }, (_, i) => run(openRequest, { person: `code-${i}`, dataset: "d4" })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const codes = (
      await sql(`SELECT display_code FROM ${items()} WHERE dataset = 'd4' ORDER BY display_code`)
    ).rows.map((r) => String(r["display_code"]));
    const wellFormed = codes.every((code) => /^LV-[0-9A-HJKMNP-TV-Z]{6}$/.test(code));
    const unchanged = (await counters()) === before;
    return {
      pass: ok === n && codes.length === n && new Set(codes).size === n && wellFormed && unchanged,
      detail: `${ok}/${n} committed; ${new Set(codes).size} distinct codes (${codes.slice(0, 3).join(", ")}…); counters unchanged: ${unchanged}; errors: ${reasons(results).map(String).join("; ") || "none"}`,
    };
  });

  const timed = async <T>(body: () => Promise<T>) => {
    const started = Date.now();
    const value = await body();
    return { value, ms: Date.now() - started };
  };
  const fulfilled = <T>(results: PromiseSettledResult<T>[]) =>
    results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  };
  const liveIntake = (n: number, tag: string): OnboardingIntake => ({
    initiativeName: `Live code ${tag} ${n}`,
    businessCase: "Prioritize balance-due cases across treatment streams.",
    annualBenefit: 1000000 + n,
    levers: ["taxgap"],
    datasets: [
      {
        name: `Code ${tag} ${n}`,
        domain: "individual-filing",
        datasetTag: `code_${tag}_${n}`,
        owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
      },
    ],
    workspaceNeeds: { isolation: "shared", teamSize: 4 },
    answers: {},
  });
  const codeProvider: SessionUser = { ...user, isAdmin: false, onboardingReviewerRoles: [] };
  let concurrentCodes: string[] = [];

  await check(
    "4b. 10 concurrent creates (onboarding submits, then EIR starts) all commit with distinct codes",
    async () => {
      const n = 10;
      const onb = await timed(() =>
        settle(
          Array.from({ length: n }, (_, i) =>
            timed(() => runAs(submitOnboarding, codeProvider, { intake: liveIntake(i, "c") })),
          ),
        ),
      );
      const onbOk = fulfilled(onb.value);
      concurrentCodes = onbOk.map((r) => (r.value.result as OnboardingRequest).id);
      const start = registry.findWrite("eir", "start") as CommandDefinition<
        Record<string, never>,
        { recordId?: string }
      >;
      const eir = await timed(() =>
        settle(
          Array.from({ length: n }, (_, i) =>
            timed(() =>
              runAs(
                start,
                {
                  ...eirApplicant,
                  principalId: `live-code-eir-${i}-${me.id}`,
                  displayName: `Code EIR ${i}`,
                },
                {},
              ),
            ),
          ),
        ),
      );
      const eirOk = fulfilled(eir.value);
      const eirCodes = eirOk.map((r) => String(r.value.result.recordId));
      const pass =
        onbOk.length === n &&
        new Set(concurrentCodes).size === n &&
        concurrentCodes.every((code) => /^ONB-[0-9A-HJKMNP-TV-Z]{6}$/.test(code)) &&
        eirOk.length === n &&
        new Set(eirCodes).size === n &&
        eirCodes.every((code) => /^EIR-[0-9A-HJKMNP-TV-Z]{6}$/.test(code));
      return {
        pass,
        detail:
          `onboarding: ${onbOk.length}/${n} committed, ${new Set(concurrentCodes).size} distinct codes, ` +
          `total ${onb.ms} ms, per-create median ${median(onbOk.map((r) => r.ms))} ms (max ${Math.max(...onbOk.map((r) => r.ms))}); ` +
          `EIR start: ${eirOk.length}/${n} committed, ${new Set(eirCodes).size} distinct codes, ` +
          `total ${eir.ms} ms, per-create median ${median(eirOk.map((r) => r.ms))} ms (max ${Math.max(...eirOk.map((r) => r.ms))}); ` +
          `errors: ${[...reasons(onb.value), ...reasons(eir.value)].map(String).join("; ") || "none"}`,
      };
    },
  );

  await check(
    "4c. a display code that's taken is refused in the block and retried with a fresh one",
    async () => {
      const taken = concurrentCodes[0];
      if (!taken) return { pass: false, detail: "4b left no code to collide with" };
      const scripted = [taken];
      const seen: AttemptInfo[] = [];
      const collidingRunner = createTransactionRunner({
        client,
        names,
        newDisplayCode: (p) => scripted.shift() ?? newDisplayCode(p),
        onAttempt: (info) => seen.push(info),
      });
      const created = await collidingRunner.runCommand(submitOnboarding, {
        user: codeProvider,
        actor: {
          principalId: codeProvider.principalId,
          display: codeProvider.displayName,
          app: "tenant",
        },
        idempotencyKey: newId(),
        expectedVersion: 0,
        payload: { intake: liveIntake(99, "clash") },
      });
      const id = (created.result as OnboardingRequest).id;
      const copies = await count(
        `SELECT count(*) AS n FROM ${names.table("onboarding", "onboarding_requests")} WHERE display_code = :c`,
        { c: taken },
      );
      const outcomes = seen.map((a) => a.outcome).join(",");
      const firstError =
        seen[0]?.error instanceof SqlError ? seen[0].error.sqlState : String(seen[0]?.error);
      return {
        pass:
          outcomes === "retry,committed" && id !== taken && copies === 1 && firstError === "ED004",
        detail: `forced ${taken} → attempts ${outcomes} (first refused with ${firstError}); committed as ${id}; rows with ${taken}: ${copies}`,
      };
    },
  );

  await check("5a. version-checked update: racing writers at the same version", async () => {
    const created = await run(openRequest, { person: "p5", dataset: "d5" });
    const results = await settle(
      Array.from({ length: writers }, () => run(touch, { id: created.recordId }, newId(), 1)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const conflicts = reasons(results).filter((e) => e instanceof VersionConflictError).length;
    const row = (
      await sql(`SELECT version FROM ${items()} WHERE id = :id`, { id: created.recordId })
    ).rows[0];
    const other = reasons(results).filter((e) => !(e instanceof VersionConflictError));
    return {
      pass: ok === 1 && conflicts === writers - 1 && Number(row?.["version"]) === 2,
      detail: `${ok} succeeded, ${conflicts} version conflicts; version now ${String(row?.["version"])}; other errors: ${other.map(String).join("; ") || "none"}`,
    };
  });

  await check("6. a failing second statement rolls back the whole block", async () => {
    const id = newId();
    const error = await run(failSecond, { id }).catch((e: unknown) => e);
    const rows = await count(`SELECT count(*) AS n FROM ${items()} WHERE id = :id`, { id });
    const actionsLeft = await count(
      `SELECT count(*) AS n FROM ${itemActions()} WHERE item_id = :id`,
      { id },
    );
    return {
      pass:
        error instanceof DomainError && error.code === "forced" && rows === 0 && actionsLeft === 0,
      detail: `refused with ${error instanceof DomainError ? error.code : String(error)}; rows left: ${rows} state, ${actionsLeft} actions`,
    };
  });

  await check(
    "8. provisioning refuses an unsafe schema prefix before running anything",
    async () => {
      const hostile = "edp_bad`; DROP SCHEMA x; --";
      const error = await runDdl("resources/store-admin.sql", hostile).catch((e: unknown) => e);
      const created = (
        await sql(
          `SELECT schema_name FROM \`${catalog}\`.information_schema.schemata WHERE startswith(schema_name, 'edp_bad')`,
        )
      ).rows.length;
      const refused =
        error instanceof Error &&
        /schema_prefix must be empty or a plain identifier/.test(error.message);
      return {
        pass: refused && created === 0,
        detail: `${refused ? "refused by the guard" : `not refused: ${String(error)}`}; schemas created: ${created}`,
      };
    },
  );

  await check("7. the app's write-check command end to end, with audit.actions", async () => {
    const recorded = await run(recordWriteCheck, { name: "live check" });
    const confirmed = await run(confirmWriteCheck, { writeCheckId: recorded.recordId }, newId(), 1);
    const stale = await run(
      confirmWriteCheck,
      { writeCheckId: recorded.recordId },
      newId(),
      1,
    ).catch((e: unknown) => e);
    const history = (
      await sql(
        `SELECT action, record_version, actor_principal_id, actor_app FROM ${names.table("audit", "actions")} WHERE record_id = :id ORDER BY record_version`,
        { id: recorded.recordId },
      )
    ).rows;
    const state = (
      await sql(
        `SELECT stage, version FROM ${names.table(WRITE_CHECKS.schema, WRITE_CHECKS.table)} WHERE id = :id`,
        { id: recorded.recordId },
      )
    ).rows[0];
    const pass =
      confirmed.recordVersion === 2 &&
      stale instanceof VersionConflictError &&
      state?.["stage"] === "confirmed" &&
      history.length === 2 &&
      history.every((h) => h["actor_principal_id"] === me.id && h["actor_app"] === "staff");
    return {
      pass,
      detail: `WC record → confirmed at v${confirmed.recordVersion}; stale confirm → ${stale instanceof Error ? stale.name : "succeeded"}; audit.actions: ${history.map((h) => `${String(h["action"])}@v${String(h["record_version"])}`).join(", ")}`,
    };
  });

  await check("13. read snapshot markers: derived from data, no write hotspot", async () => {
    const markerStarted = Date.now();
    const markers = (await sql(snapshotMarkerStatement(names))).rows;
    const markerMs = Date.now() - markerStarted;
    const areas = markers.map((row) => String(row["area"])).sort();

    const sameAreaStarted = Date.now();
    const sameArea = await settle(
      Array.from({ length: writers }, (_, i) =>
        run(openRequest, { person: `marker-race-${i}`, dataset: `marker-race-${i}` }),
      ),
    );
    const sameAreaMs = Date.now() - sameAreaStarted;
    const ok = sameArea.filter((r) => r.status === "fulfilled").length;
    const errors = reasons(sameArea);
    const rows = await count(
      `SELECT count(*) AS n FROM ${items()} WHERE person LIKE 'marker-race-%' AND dataset LIKE 'marker-race-%'`,
    );

    return {
      pass:
        areas.join(",") ===
          "access,admin,audit,catalog,change-list,eir,eir-definitions,initiatives,onboarding,privacy,requests,teams" &&
        ok === writers &&
        rows === writers,
      detail:
        `marker query returned ${areas.length} areas (${areas.join(", ")}) in ${markerMs} ms; ` +
        `same-area independent writes committed ${ok}/${writers} in ${sameAreaMs} ms with ${errors.length} errors; ` +
        `old version-row hotspot measurement was 1/${writers} committed, ${writers - 1} conflicted`,
    };
  });

  await check(
    "7b. onboarding submit reserves intake IDs and appears in audit.actions",
    async () => {
      const provider: SessionUser = {
        ...user,
        isAdmin: false,
        onboardingReviewerRoles: [],
      };
      const intake: OnboardingIntake = {
        initiativeName: `Live onboarding ${Date.now()}`,
        businessCase: "Prioritize balance-due cases across treatment streams.",
        annualBenefit: 1250000,
        levers: ["taxgap"],
        datasets: [
          {
            name: "Case signals",
            domain: "individual-filing",
            datasetTag: `case_signals_${Date.now() % 100000}`,
            owners: [{ name: "Olive Owner", email: "Olive.Owner@example.gov" }],
          },
        ],
        workspaceNeeds: { isolation: "shared", teamSize: 6 },
        answers: { source: "live-check" },
      };
      const key = newId();
      const submitted = await runAs(submitOnboarding, provider, { intake }, key);
      const replay = await runAs(submitOnboarding, provider, { intake }, key);
      const requestId = submitted.recordId;
      const request = (
        await sql(
          `SELECT display_code, version, stage, provider_principal_id, actor_app FROM ${names.table("onboarding", "onboarding_requests")} r JOIN ${names.table("onboarding", "onboarding_request_actions")} a ON r.last_action_id = a.action_id WHERE r.id = :id`,
          { id: requestId },
        )
      ).rows[0];
      const datasets = await count(
        `SELECT count(*) AS n FROM ${names.table("onboarding", "onboarding_intake_datasets")} WHERE onboarding_request_id = :id`,
        { id: requestId },
      );
      const owners = await count(
        `SELECT count(*) AS n FROM ${names.table("onboarding", "onboarding_intake_owners")} WHERE onboarding_request_id = :id AND person_email = 'olive.owner@example.gov'`,
        { id: requestId },
      );
      const actions = (
        await sql(
          `SELECT action, record_version, actor_principal_id, actor_app FROM ${names.table("audit", "actions")} WHERE record_id = :id ORDER BY record_version`,
          { id: requestId },
        )
      ).rows;
      return {
        pass:
          request?.["stage"] === "business-roi-review" &&
          Number(request?.["version"]) === 2 &&
          request?.["provider_principal_id"] === provider.principalId &&
          request?.["actor_app"] === "system" &&
          datasets === 1 &&
          owners === 1 &&
          actions.map((row) => row["action"]).join(",") === "submitted,forwarded" &&
          actions[0]?.["actor_app"] === "tenant" &&
          actions[1]?.["actor_app"] === "system" &&
          replay.replayed &&
          replay.actionId === submitted.actionId &&
          JSON.stringify(replay.result) === JSON.stringify(submitted.result),
        detail: `${String(request?.["display_code"])} stage ${String(request?.["stage"])} v${String(request?.["version"])}; child rows ${datasets} dataset/${owners} owner; audit ${actions.map((row) => `${String(row["action"])}:${String(row["actor_app"])}`).join(", ")}; replay ${replay.replayed ? "same" : "not replayed"}`,
      };
    },
  );

  await check(
    "7c. onboarding mine/inbox/request read in one statement each, same as the old per-request path",
    async () => {
      const as = (id: string, roles: SessionUser["onboardingReviewerRoles"] = []): SessionUser => ({
        ...user,
        principalId: id,
        displayName: id,
        isAdmin: false,
        onboardingReviewerRoles: roles,
      });
      const provider = as(`live-onb-provider-${me.id}`);
      const other = as(`live-onb-other-${me.id}`);
      const bo = as(`live-onb-bo-${me.id}`, ["business-office"]);
      const ccb = as(`live-onb-ccb-${me.id}`, ["ccb"]);
      const stranger = as(`live-onb-stranger-${me.id}`);
      const intakeFor = (n: number): OnboardingIntake => ({
        initiativeName: `Live set read ${n}`,
        businessCase: "Prioritize balance-due cases across treatment streams.",
        annualBenefit: 1000000 + n,
        levers: ["taxgap"],
        datasets: [
          {
            name: `Set read ${n}a`,
            domain: "individual-filing",
            datasetTag: `set_read_${n}_a`,
            owners: [
              { name: "Olive Owner", email: "olive.owner@example.gov" },
              { name: "Bo Second", email: "bo.second@example.gov" },
            ],
          },
          {
            name: `Set read ${n}b`,
            domain: "enforcement-collections",
            datasetTag: `set_read_${n}_b`,
            owners: [{ name: "Cy Third", email: "cy.third@example.gov" }],
          },
        ],
        workspaceNeeds: { isolation: "shared", teamSize: 3 + n },
        answers: {},
      });
      const submit = async (who: SessionUser, n: number) =>
        (await runAs(submitOnboarding, who, { intake: intakeFor(n) })).result as OnboardingRequest;
      const decide = async (
        who: SessionUser,
        req: OnboardingRequest,
        decision: Record<string, string>,
      ) =>
        (await runAs(decideOnboarding, who, { requestId: req.id, decision }, newId(), req.version))
          .result;
      const [p1, p2, p3] = [
        await submit(provider, 1),
        await submit(provider, 2),
        await submit(provider, 3),
      ];
      await submit(other, 4);
      await decide(bo, p1, { type: "approve" });
      await decide(bo, p2, { type: "send-back", to: "submitted", note: "Which streams?" });
      void p3;

      let statements = 0;
      const reader = runner.reader({ readId: newId() });
      const read: typeof reader = (statement) => {
        statements += 1;
        return reader(statement);
      };
      const run = async (name: string, who: SessionUser, query: Record<string, string> = {}) => {
        const definition = registry.findRead("onboarding", name)!;
        statements = 0;
        definition.authorize?.(who);
        const value = await definition.run({ query, user: who, names, read });
        return { value, statements };
      };
      /** The reads as main had them before #131's latency fix: rows, then 3 statements per request. */
      const old = async (where: string, params: Record<string, string>, orderBy: string) => {
        const t = (table: string) => names.table("onboarding", table);
        const rows = (
          await sql(
            `SELECT ${REQUEST_COLUMNS} FROM ${t("onboarding_requests")} WHERE ${where} ORDER BY ${orderBy}`,
            params,
          )
        ).rows as never[];
        return Promise.all(
          rows.map(async (row: { uuid: string }) => {
            const [d, o, a] = await Promise.all([
              sql(
                `SELECT id, onboarding_request_id, position, name, domain, dataset_tag FROM ${t("onboarding_intake_datasets")} WHERE onboarding_request_id = :id ORDER BY position`,
                { id: row.uuid },
              ),
              sql(
                `SELECT id, intake_dataset_id, position, person_display, person_email, person_principal_id FROM ${t("onboarding_intake_owners")} WHERE onboarding_request_id = :id ORDER BY intake_dataset_id, position`,
                { id: row.uuid },
              ),
              sql(
                `SELECT action_id, action, from_stage, to_stage, record_version, actor_principal_id, actor_display, CAST(occurred_at AS STRING) AS occurred_at, note, payload FROM ${t("onboarding_request_actions")} WHERE onboarding_request_id = :id ORDER BY record_version, occurred_at`,
                { id: row.uuid },
              ),
            ]);
            return toRequest(
              row as never,
              d.rows as never,
              o.rows as never,
              a.rows as never,
              DEFAULT_EFFECTIVE_SLA_CONFIG,
            );
          }),
        );
      };
      /** The first path where `a` and `b` differ, or null when they're the same. */
      const firstDiff = (a: unknown, b: unknown, path = "$"): string | null => {
        if (JSON.stringify(a) === JSON.stringify(b)) return null;
        if (a && b && typeof a === "object" && typeof b === "object") {
          const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
          for (const key of keys) {
            const diff = firstDiff(
              (a as Record<string, unknown>)[key],
              (b as Record<string, unknown>)[key],
              `${path}.${key}`,
            );
            if (diff) return diff;
          }
        }
        return `${path}: ${JSON.stringify(a)} vs old ${JSON.stringify(b)}`;
      };
      let lastDiff: string | null = null;
      const same = (a: unknown, b: unknown) => {
        const diff = firstDiff(a, b);
        if (diff) lastDiff = diff;
        return diff === null;
      };
      const results: string[] = [];
      let pass = true;
      const expect = (label: string, ok: boolean) => {
        results.push(`${label} ${ok ? "ok" : `MISMATCH (${lastDiff})`}`);
        pass &&= ok;
      };

      for (const who of [provider, other, stranger]) {
        const mine = await run("mine", who);
        expect(`mine(${who.principalId.split("-")[2]}) 1 stmt`, mine.statements === 1);
        expect(
          `mine(${who.principalId.split("-")[2]}) = old`,
          same(
            mine.value,
            await old("provider_principal_id = :me", { me: who.principalId }, "submitted_at DESC"),
          ),
        );
      }
      for (const [who, role, stage] of [
        [bo, "business-office", "business-roi-review"],
        [ccb, "ccb", "ccb"],
      ] as const) {
        const inbox = await run("inbox", who, { role });
        const expected = (await old(
          "stage = :stage",
          { stage },
          "stage_entered_at",
        )) as OnboardingRequest[];
        expect(`inbox(${role}) 1 stmt`, inbox.statements === 1);
        expect(`inbox(${role}) = old (${expected.length})`, same(inbox.value, expected));
      }
      // Each request, as each role sees it: provider or current-stage reviewer, otherwise null.
      const all = [
        ...((await old(
          "provider_principal_id = :me",
          { me: provider.principalId },
          "submitted_at DESC",
        )) as OnboardingRequest[]),
        ...((await old(
          "provider_principal_id = :me",
          { me: other.principalId },
          "submitted_at DESC",
        )) as OnboardingRequest[]),
      ];
      let visible = 0;
      let hidden = 0;
      let oneStatement = true;
      let matches = true;
      for (const who of [provider, other, bo, ccb, stranger]) {
        for (const expected of all) {
          const sees =
            expected.providerId === who.principalId ||
            (expected.stage === "business-roi-review" &&
              who.onboardingReviewerRoles.includes("business-office")) ||
            (expected.stage === "ccb" && who.onboardingReviewerRoles.includes("ccb"));
          const got = await run("request", who, { id: expected.id });
          oneStatement &&= got.statements === 1;
          matches &&= same(got.value, sees ? expected : null);
          if (sees) visible += 1;
          else hidden += 1;
        }
      }
      expect(
        `request x${visible + hidden} (visible ${visible}, not found ${hidden}) 1 stmt`,
        oneStatement,
      );
      expect("request = old", matches);
      return { pass, detail: results.join("; ") };
    },
  );

  await check(
    "7d. a resubmission returns to the stage that sent it back, with fresh SLA deadlines and its changes (#221)",
    async () => {
      const as = (id: string, roles: SessionUser["onboardingReviewerRoles"] = []): SessionUser => ({
        ...user,
        principalId: id,
        displayName: id,
        isAdmin: false,
        onboardingReviewerRoles: roles,
      });
      const provider = as(`live-rs-provider-${me.id}`);
      const bo = as(`live-rs-bo-${me.id}`, ["business-office"]);
      const ccb = as(`live-rs-ccb-${me.id}`, ["ccb"]);
      const intakeFor = (n: number): OnboardingIntake => ({
        initiativeName: `Live resubmit ${n}`,
        businessCase: "Prioritize balance-due cases across treatment streams.",
        annualBenefit: 1000000 + n,
        levers: ["taxgap"],
        datasets: [
          {
            name: `Resubmit ${n}`,
            domain: "individual-filing",
            datasetTag: `resubmit_${n}`,
            owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
          },
        ],
        workspaceNeeds: { isolation: "shared", teamSize: 4 },
        // Every answer, so the whole intake re-validates on resubmit (#222).
        answers: { ...COMPLETE_INTAKE_ANSWERS },
      });
      const command = async <P>(
        definition: CommandDefinition<P, unknown>,
        who: SessionUser,
        payload: P,
        version: number,
      ) => (await runAs(definition, who, payload, newId(), version)).result as OnboardingRequest;
      const row = async (code: string) =>
        (
          await sql(
            `SELECT id, stage, CAST(stage_entered_at AS STRING) AS entered, CAST(sla_due_at AS STRING) AS due, CAST(sla_due_soon_at AS STRING) AS due_soon, open_send_back_from_stage FROM ${names.table("onboarding", "onboarding_requests")} WHERE display_code = :c`,
            { c: code },
          )
        ).rows[0] as Record<string, string | null>;
      const iso = (value: string | null | undefined) =>
        value
          ? new Date(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z")).toISOString()
          : null;

      const viaCcb = await command(submitOnboarding, provider, { intake: intakeFor(1) }, 0);
      const viaBo = await command(submitOnboarding, provider, { intake: intakeFor(2) }, 0);
      const otherDue = (await row(viaBo.id))["due"];

      // CCB path: approve, CCB send-back, resubmit with a tag and a workspace change.
      const approved = await command(
        decideOnboarding,
        bo,
        { requestId: viaCcb.id, decision: { type: "approve" } },
        viaCcb.version,
      );
      const sentBack = await command(
        decideOnboarding,
        ccb,
        {
          requestId: viaCcb.id,
          decision: { type: "send-back", to: "submitted", note: "Which tag?" },
        },
        approved.version,
      );
      const t0 = Date.now();
      const back = await command(
        resubmitOnboarding,
        provider,
        {
          requestId: viaCcb.id,
          resubmission: {
            answer: "The governed one.",
            intake: {
              ...sentBack.intake,
              datasets: [{ ...sentBack.intake.datasets[0]!, datasetTag: "resubmit_1_gold" }],
              workspaceNeeds: { isolation: "dedicated", teamSize: 4 },
            },
          },
        },
        sentBack.version,
      );
      const resubmitMs = Date.now() - t0;
      const ccbRow = await row(viaCcb.id);
      const expected = onboardingSlaDeadlines(
        "ccb",
        iso(ccbRow["entered"])!,
        DEFAULT_EFFECTIVE_SLA_CONFIG,
      );
      const payload = (
        await sql(
          `SELECT payload FROM ${names.table("onboarding", "onboarding_request_actions")} WHERE onboarding_request_id = :id AND action = 'resubmitted'`,
          { id: ccbRow["id"]! },
        )
      ).rows.map((r) => JSON.parse(String((r as { payload: string }).payload)));
      const readDef = registry.findRead("onboarding", "request")!;
      const inboxDef = registry.findRead("onboarding", "inbox")!;
      const reader = runner.reader({ readId: newId() });
      const seen = (await readDef.run({
        query: { id: viaCcb.id },
        user: ccb,
        names,
        read: reader,
      })) as OnboardingRequest | null;
      const ccbInbox = (await inboxDef.run({
        query: { role: "ccb" },
        user: ccb,
        names,
        read: reader,
      })) as OnboardingRequest[];
      const boInbox = (await inboxDef.run({
        query: { role: "business-office" },
        user: bo,
        names,
        read: reader,
      })) as OnboardingRequest[];
      const otherDueAfter = (await row(viaBo.id))["due"];

      // Business & ROI path: send back from business review, resubmit, back to business review.
      const boSentBack = await command(
        decideOnboarding,
        bo,
        { requestId: viaBo.id, decision: { type: "send-back", to: "submitted", note: "Benefit?" } },
        viaBo.version,
      );
      const boBack = await command(
        resubmitOnboarding,
        provider,
        { requestId: viaBo.id, resubmission: { answer: "Recurring." } },
        boSentBack.version,
      );
      const boRow = await row(viaBo.id);

      const results = {
        ccbStage: back.stage === "ccb" && ccbRow["stage"] === "ccb",
        ccbFreshSla:
          iso(ccbRow["due"]) === expected?.dueAt && iso(ccbRow["due_soon"]) === expected?.dueSoonAt,
        sendBackCleared: ccbRow["open_send_back_from_stage"] === null,
        payload:
          payload.length === 1 &&
          payload[0].answer === "The governed one." &&
          JSON.stringify(payload[0].changes) ===
            JSON.stringify([
              { field: "Dataset 1 dataset tag", before: "resubmit_1", after: "resubmit_1_gold" },
              { field: "Workspace isolation", before: "shared", after: "dedicated" },
            ]),
        reviewerSees:
          seen?.decisions.at(-1)?.resubmission?.changes.length === 2 &&
          ccbInbox.some((r) => r.id === viaCcb.id) &&
          !boInbox.some((r) => r.id === viaCcb.id),
        otherUntouched: otherDue !== null && otherDue === otherDueAfter,
        boStage: boBack.stage === "business-roi-review" && boRow["stage"] === "business-roi-review",
      };
      return {
        pass: Object.values(results).every(Boolean),
        detail:
          `${viaCcb.id} ccb send-back -> ${String(ccbRow["stage"])} due ${String(iso(ccbRow["due"]))} (resubmit ${resubmitMs} ms); ` +
          `${viaBo.id} business send-back -> ${String(boRow["stage"])}; ` +
          Object.entries(results)
            .map(([k, ok]) => `${k} ${ok ? "ok" : "FAIL"}`)
            .join(", "),
      };
    },
  );

  await check(
    "7e. a resubmission edits the whole intake: ROI edited, a dataset added, an owner removed (#222)",
    async () => {
      const as = (id: string, roles: SessionUser["onboardingReviewerRoles"] = []): SessionUser => ({
        ...user,
        principalId: id,
        displayName: id,
        isAdmin: false,
        onboardingReviewerRoles: roles,
      });
      const provider = as(`live-full-provider-${me.id}`);
      const bo = as(`live-full-bo-${me.id}`, ["business-office"]);
      const ccb = as(`live-full-ccb-${me.id}`, ["ccb"]);
      const command = async <P>(
        definition: CommandDefinition<P, unknown>,
        who: SessionUser,
        payload: P,
        version: number,
      ) => (await runAs(definition, who, payload, newId(), version)).result as OnboardingRequest;
      const intake: OnboardingIntake = {
        initiativeName: `Live full resubmit ${Date.now()}`,
        businessCase: "Prioritize balance-due cases across treatment streams.",
        annualBenefit: 1_250_000,
        levers: ["taxgap"],
        datasets: [
          {
            name: "Case signals",
            domain: "individual-filing",
            datasetTag: "full_case_signals",
            owners: [
              { name: "Olive Owner", email: "olive.owner@example.gov" },
              { name: "Otto Second", email: "otto.second@example.gov" },
            ],
          },
        ],
        workspaceNeeds: { isolation: "shared", teamSize: 4 },
        answers: { ...COMPLETE_INTAKE_ANSWERS },
      };
      const created = await command(submitOnboarding, provider, { intake }, 0);
      const approved = await command(
        decideOnboarding,
        bo,
        { requestId: created.id, decision: { type: "approve" } },
        created.version,
      );
      const sentBack = await command(
        decideOnboarding,
        ccb,
        {
          requestId: created.id,
          decision: {
            type: "send-back",
            to: "submitted",
            note: "Restate the ROI; add the ledger.",
          },
        },
        approved.version,
      );
      const [stored] = sentBack.intake.datasets;
      const t = (table: string) => names.table("onboarding", table);
      const rowsOf = async () => ({
        request: (
          await sql(
            `SELECT id, display_code, version FROM ${t("onboarding_requests")} WHERE display_code = :c`,
            {
              c: created.id,
            },
          )
        ).rows[0] as Record<string, unknown>,
        datasets: (
          await sql(
            `SELECT d.id, d.name FROM ${t("onboarding_intake_datasets")} d JOIN ${t("onboarding_requests")} r ON d.onboarding_request_id = r.id WHERE r.display_code = :c ORDER BY d.position`,
            { c: created.id },
          )
        ).rows as Record<string, unknown>[],
        owners: (
          await sql(
            `SELECT o.id, o.person_email FROM ${t("onboarding_intake_owners")} o JOIN ${t("onboarding_requests")} r ON o.onboarding_request_id = r.id WHERE r.display_code = :c ORDER BY o.person_email`,
            { c: created.id },
          )
        ).rows as Record<string, unknown>[],
      });
      const before = await rowsOf();

      // A record ID that isn't this request's is refused, and nothing changes.
      let foreignRefused = false;
      try {
        await command(
          resubmitOnboarding,
          provider,
          {
            requestId: created.id,
            resubmission: {
              answer: "Sneaky.",
              intake: { ...sentBack.intake, datasets: [{ ...stored!, id: newId() }] },
            },
          },
          sentBack.version,
        );
      } catch (error) {
        foreignRefused = error instanceof DomainError && error.code === "invalid-intake";
      }
      const afterRefusal = await rowsOf();

      const t0 = Date.now();
      const back = await command(
        resubmitOnboarding,
        provider,
        {
          requestId: created.id,
          resubmission: {
            answer: "Restated the ROI; added the ledger; Otto has left.",
            intake: {
              ...sentBack.intake,
              annualBenefit: 2_000_000,
              datasets: [
                { ...stored!, owners: [stored!.owners[0]!] },
                {
                  name: "Collections ledger",
                  domain: "enforcement-collections",
                  datasetTag: "full_collections_ledger",
                  owners: [{ name: "Lee Ledger", email: "lee.ledger@example.gov" }],
                },
              ],
            },
          },
        },
        sentBack.version,
      );
      const resubmitMs = Date.now() - t0;
      const after = await rowsOf();

      // The in-memory copy, loaded as the snapshot cache loads it, against the SQL read.
      const reader = runner.reader({ readId: newId() });
      const tables = new Map<string, Record<string, unknown>[]>();
      for (const table of SNAPSHOT_TABLES.filter((x) => x.area === "onboarding")) {
        tables.set(
          `${table.schema}.${table.table}`,
          await reader<Record<string, unknown>>({
            statement:
              `SELECT * FROM ${names.table(table.schema, table.table)}` +
              (table.orderBy ? ` ORDER BY ${table.orderBy}` : ""),
          }),
        );
      }
      const readDef = registry.findRead("onboarding", "request")!;
      const viaSql = (await readDef.run({
        query: { id: created.id },
        user: ccb,
        names,
        read: reader,
      })) as OnboardingRequest | null;
      const viaSnapshot = readDef.snapshot!({
        query: { id: created.id },
        user: ccb,
        names,
        snapshot: {
          table: (schema: string, table: string) => tables.get(`${schema}.${table}`) ?? [],
          stats: () => ({}) as never,
        } as never,
      }) as OnboardingRequest | null;

      const ids = (rows: Record<string, unknown>[]) => rows.map((r) => String(r["id"]));
      const last = back.decisions.at(-1);
      const results = {
        foreignRefused,
        refusalWroteNothing: JSON.stringify(afterRefusal) === JSON.stringify(before),
        backAtCcb: back.stage === "ccb",
        sameCode:
          back.id === created.id &&
          after.request["display_code"] === before.request["display_code"] &&
          after.request["id"] === before.request["id"],
        keptDatasetId: ids(after.datasets)[0] === stored!.id,
        newDatasetId:
          after.datasets.length === 2 && !ids(before.datasets).includes(ids(after.datasets)[1]!),
        keptOwnerId: ids(after.owners).includes(stored!.owners[0]!.id!),
        removedOwnerGone:
          !ids(after.owners).includes(stored!.owners[1]!.id!) &&
          !after.owners.some((o) => o["person_email"] === "otto.second@example.gov"),
        roiEdited: back.intake.annualBenefit === 2_000_000,
        changesRecorded:
          last?.resubmission?.changes.some(
            (c) => c.field === "Estimated annual benefit (USD)" && c.after === "$2,000,000",
          ) === true &&
          last?.resubmission?.changes.some((c) => c.field === "Dataset 2 added") === true &&
          last?.resubmission?.changes.some((c) => c.field === "Dataset 1 owner 2 removed") === true,
        removalLogged: (last?.note ?? "").includes(
          "Removed owner from Case signals: Otto Second (otto.second@example.gov).",
        ),
        snapshotMatchesSql:
          viaSql !== null && JSON.stringify(viaSnapshot) === JSON.stringify(viaSql),
      };
      return {
        pass: Object.values(results).every(Boolean),
        detail:
          `${created.id} resubmitted in ${resubmitMs} ms; ` +
          Object.entries(results)
            .map(([k, ok]) => `${k} ${ok ? "ok" : "FAIL"}`)
            .join(", "),
      };
    },
  );

  await check(
    "9. a replayed key returns the original response, after the record moved on",
    async () => {
      const key = newId();
      const recorded = await run(recordWriteCheck, { name: "replay check" }, key);
      const confirmed = await run(
        confirmWriteCheck,
        { writeCheckId: recorded.recordId },
        newId(),
        1,
      );
      const replay = await run(recordWriteCheck, { name: "replay check" }, key);
      const original = JSON.stringify(recorded.result);
      return {
        pass:
          replay.replayed &&
          replay.actionId === recorded.actionId &&
          replay.recordVersion === 1 &&
          JSON.stringify(replay.result) === original &&
          (recorded.result as { stage?: string }).stage === "recorded" &&
          (confirmed.result as { stage?: string; version?: number }).stage === "confirmed",
        detail: `v1 ${original}; after confirm (v${confirmed.recordVersion}) the v1 key replays ${replay.replayed ? "" : "NOT "}as a replay, response ${JSON.stringify(replay.result) === original ? "identical" : `DIFFERENT: ${JSON.stringify(replay.result)}`}`,
      };
    },
  );

  await check("10. #72's legacy request writes on store-schema.sql's tables", async () => {
    const requests = names.table("requests", "access_requests");
    const itemsTable = names.table("requests", "request_items");
    const stepsTable = names.table("requests", "request_steps");
    const attestations = names.table("requests", "waiver_attestations");
    const rows = async (table: string, id: string, column = "request_id") =>
      count(`SELECT count(*) AS n FROM ${table} WHERE ${column} = :id`, { id });
    const notes: string[] = [];

    // Why these aren't commands: a transaction can't write these tables.
    const atomic = await sql(
      `BEGIN ATOMIC\nINSERT INTO ${requests} (id, requester_principal_id, requester_username) VALUES ('REQ-ATOMIC', 'x', 'x');\nEND`,
    ).catch((e: unknown) => e);
    const refused =
      atomic instanceof Error && /WRITE_NON_CATALOG_MANAGED_TABLE/.test(atomic.message);
    notes.push(
      `BEGIN ATOMIC ${refused ? "refused (WRITE_NON_CATALOG_MANAGED_TABLE)" : `NOT refused: ${String(atomic)}`}`,
    );

    // The cart's own payload shape (cart.jsx), including its date string.
    const cart = (id: string) => ({
      id,
      title: "Live check request",
      submittedAt: "Jun 5, 2026",
      status: "In progress",
      overall: "Submitted — pending domain owner review",
      purpose: "Live check",
      items: [
        { ref: "asset", id: "ds-1", kind: "Dataset" },
        { bundle: "analytics-workspace", kind: "Bundle" },
      ],
      subRequests: [
        { system: "Access request submitted", status: "done", detail: "Resolved." },
        { system: "Domain owner review", status: "active", detail: "Waiting." },
      ],
      stageIndex: 1,
    });
    const id = `REQ-LIVE-${Date.now() % 100_000}`;
    const created = await legacyWrite<unknown, { id: string; requesterPrincipalId?: string }>(
      "create-request",
      cart(id),
    );
    const afterCreate = [
      await rows(requests, id, "id"),
      await rows(itemsTable, id),
      await rows(stepsTable, id),
    ];
    notes.push(
      `create → ${afterCreate.join("/")} request/items/steps, requester ${created.requesterPrincipalId === me.id ? "from session" : "WRONG"}`,
    );

    const again = await legacyWrite("create-request", cart(id)).catch((e: unknown) => e);
    const afterAgain = [
      await rows(requests, id, "id"),
      await rows(itemsTable, id),
      await rows(stepsTable, id),
    ];
    notes.push(
      `same create again → ${again instanceof DomainError ? again.code : "accepted"}, rows ${afterAgain.join("/")}`,
    );

    // A failed earlier attempt left an item row but no request row.
    const id2 = `${id}-B`;
    await sql(`INSERT INTO ${itemsTable} (request_id, item_order, kind) VALUES (:id, 5, 'Stray')`, {
      id: id2,
    });
    await legacyWrite("create-request", cart(id2));
    const afterStray = await rows(itemsTable, id2);
    notes.push(`create over a failed attempt's stray item → items ${afterStray}`);

    const step = (system: string) => ({ system, status: "done", detail: "ok" });
    await legacyWrite("transition-request", {
      id,
      status: "Completed",
      overall: "Access active",
      stageIndex: 5,
      subRequests: [step("a"), step("b"), step("c")],
    });
    const stepsAfter3 = await rows(stepsTable, id);
    await legacyWrite("transition-request", {
      id,
      status: "Completed",
      overall: "Access active",
      stageIndex: 5,
      subRequests: [step("a")],
    });
    const stepsAfter1 = await rows(stepsTable, id);
    const status = (await sql(`SELECT status, stage_index FROM ${requests} WHERE id = :id`, { id }))
      .rows[0];
    notes.push(
      `transitions → steps ${stepsAfter3} then ${stepsAfter1}, status ${String(status?.["status"])}@${String(status?.["stage_index"])}`,
    );

    const attest = (attestationId: string, attested: boolean) => ({
      id: attestationId,
      requestId: id,
      checklistItemId: "ldw",
      attested,
      attestedAt: new Date().toISOString(),
      source: "live-check",
      createdAt: new Date().toISOString(),
    });
    await legacyWrite("append-waiver-attestation", attest(`${id}-ATT-1`, false));
    await legacyWrite("append-waiver-attestation", attest(`${id}-ATT-2`, true));
    const resend = await legacyWrite(
      "append-waiver-attestation",
      attest(`${id}-ATT-2`, true),
    ).catch((e: unknown) => e);
    const attestRows = await rows(attestations, id);
    const current = await count(
      `SELECT count(*) AS n FROM ${attestations} WHERE request_id = :id AND superseded_at IS NULL`,
      { id },
    );
    notes.push(
      `attestations → ${attestRows} rows, ${current} current; resend → ${resend instanceof DomainError ? resend.code : "accepted"}`,
    );

    return {
      pass:
        refused &&
        created.requesterPrincipalId === me.id &&
        afterCreate.join() === "1,2,2" &&
        again instanceof DomainError &&
        again.code === "already-exists" &&
        afterAgain.join() === "1,2,2" &&
        afterStray === 2 &&
        stepsAfter3 === 3 &&
        stepsAfter1 === 1 &&
        status?.["status"] === "Completed" &&
        attestRows === 2 &&
        current === 1 &&
        resend instanceof DomainError &&
        resend.code === "already-exists",
      detail: notes.join("; "),
    };
  });

  await check(
    "11. provisioning migrates a store made before lead actions stored `result`",
    async () => {
      // The old shape: store-admin.sql without the column and without its migration.
      const old = readFileSync("resources/store-admin.sql", "utf8")
        .split("\n")
        .filter((line) => !/^\s*result STRING COMMENT/.test(line))
        .join("\n");
      const oldStatements = statementsOf(old).filter(
        (statement) => !statement.includes("edp_migrate_write_check_actions_result"),
      );
      const migrated = `${prefix}m_`;
      const actionsTable = `\`${catalog}\`.\`${migrated}admin\`.\`write_check_actions\``;
      const hasResult = async () =>
        (await sql(`DESCRIBE TABLE ${actionsTable}`)).rows.filter((r) => r["col_name"] === "result")
          .length;
      await runDdl("old store-admin.sql", migrated, oldStatements.join(";\n") + ";");
      await runDdl("resources/store-audit.sql", migrated);
      const before = await hasResult();
      await runDdl("resources/store-admin.sql", migrated);
      const afterFirst = await hasResult();
      await runDdl("resources/store-admin.sql", migrated);
      const afterSecond = await hasResult();
      // A command write, and its replay, on the migrated store.
      const migratedNames = createStoreNames(catalog, migrated);
      const migratedRunner = createTransactionRunner({ client, names: migratedNames });
      const input = {
        user,
        actor,
        idempotencyKey: newId(),
        expectedVersion: 0,
        payload: { name: "migrated store" },
      };
      const written = await migratedRunner.runCommand(recordWriteCheck, input);
      const replay = await migratedRunner.runCommand(recordWriteCheck, input);
      const stored = (
        await sql(`SELECT result FROM ${actionsTable} WHERE action_id = :id`, {
          id: written.actionId,
        })
      ).rows[0]?.["result"];
      return {
        pass:
          before === 0 &&
          afterFirst === 1 &&
          afterSecond === 1 &&
          typeof stored === "string" &&
          replay.replayed &&
          JSON.stringify(replay.result) === JSON.stringify(written.result),
        detail: `result column: old shape ${before}, after provisioning ${afterFirst}, after re-provisioning ${afterSecond}; command wrote ${(written.result as { name?: string }).name} with result ${typeof stored === "string" ? "stored" : "MISSING"}; replay ${replay.replayed && JSON.stringify(replay.result) === JSON.stringify(written.result) ? "identical" : "DIFFERENT"}`,
      };
    },
  );

  await check("12. EIR commands return stored result rows on the real warehouse", async () => {
    const start = registry.findWrite("eir", "start") as CommandDefinition<
      Record<string, never>,
      any
    >;
    const saveDraft = registry.findWrite("eir", "save-draft") as CommandDefinition<
      { formVersion: string; values: typeof EIR_VALUES },
      any
    >;
    const evaluate = registry.findWrite("eir", "evaluate") as CommandDefinition<
      Record<string, never>,
      any
    >;
    const submit = registry.findWrite("eir", "submit") as CommandDefinition<
      {
        volumePath: string;
        formVersion: string;
        values: typeof EIR_VALUES;
      },
      any
    >;
    const decide = registry.findWrite("eir", "decide") as CommandDefinition<
      { principalId: string; decision: "valid" },
      any
    >;
    const startedAt = Date.now();
    const started = await runAs(start, eirApplicant, {});
    const draftStarted = Date.now();
    const drafted = await runAs(
      saveDraft,
      eirApplicant,
      { formVersion: EIR_FORM.version, values: EIR_VALUES },
      newId(),
      Number((started.result as { draftVersion?: number }).draftVersion ?? 0),
    );
    const saveDraftMs = Date.now() - draftStarted;
    // Upload needs an evaluation of the current draft version (#209).
    await runAs(
      evaluate,
      eirApplicant,
      {},
      newId(),
      Number((drafted.result as { version?: number }).version ?? 0),
    );
    const volumePath = eirVolumePath(
      eirVolume,
      eirApplicant.principalId,
      `${Date.now()}-${newId()}`,
    );
    eirFiles.set(volumePath, new TextEncoder().encode("%PDF-1.7 live EIR result-row check"));
    const submitted = await runAs(
      submit,
      eirApplicant,
      { volumePath, formVersion: EIR_FORM.version, values: EIR_VALUES },
      newId(),
      Number((drafted.result as { version?: number }).version ?? 0),
    );
    const decided = await runAs(
      decide,
      eirValidator,
      { principalId: eirApplicant.principalId, decision: "valid" },
      newId(),
      Number((submitted.result as { version?: number }).version ?? 0),
    );
    const result = decided.result as { stage?: string; version?: number; actions?: unknown[] };
    const actions = await count(
      `SELECT count(*) AS n FROM ${names.table("eir", "eir_actions")} WHERE actor_principal_id IN (:applicant, :validator)`,
      { applicant: eirApplicant.principalId, validator: eirValidator.principalId },
    ).catch(() => -1);
    return {
      pass:
        (started.result as { stage?: string }).stage === "not-started" &&
        (drafted.result as { draftVersion?: number }).draftVersion === 1 &&
        (submitted.result as { stage?: string }).stage === "submitted" &&
        result.stage === "valid" &&
        result.version === 3,
      detail: `start/save/submit/decide completed in ${Date.now() - startedAt} ms; saveDraft wall ${saveDraftMs} ms; final ${result.stage}@v${String(result.version)}; action-count probe ${actions}`,
    };
  });

  await check(
    "14. a store made before display codes: provisioning adds display_code, and ONB-1000 still resolves",
    async () => {
      // The old shape: store-onboarding.sql with display_number NOT NULL, no
      // display_code, and without the migration that adds it.
      const old = readFileSync("resources/store-onboarding.sql", "utf8")
        .split("\n")
        .filter((line) => !/^\s*display_code STRING COMMENT/.test(line))
        .map((line) =>
          /^\s*display_number BIGINT COMMENT/.test(line)
            ? "  display_number BIGINT NOT NULL COMMENT 'Shown as ONB-<n>; never a key',"
            : line,
        )
        .join("\n");
      const oldStatements = statementsOf(old).filter(
        (statement) =>
          !statement.includes("edp_migrate_onboarding_requests_display_code") &&
          !statement.includes("DROP NOT NULL"),
      );
      const upgraded = `${prefix}c_`;
      const upgradedNames = createStoreNames(catalog, upgraded);
      const requests = upgradedNames.table("onboarding", "onboarding_requests");
      const shape = async () => {
        const columns = (
          await sql(
            `SELECT column_name, is_nullable FROM \`${catalog}\`.information_schema.columns WHERE table_schema = :s AND table_name = 'onboarding_requests' AND column_name IN ('display_number', 'display_code') ORDER BY column_name`,
            { s: `${upgraded}onboarding` },
          )
        ).rows;
        return columns
          .map((c) => `${String(c["column_name"])}:${String(c["is_nullable"])}`)
          .join(" ");
      };
      await runDdl("resources/store-admin.sql", upgraded);
      await runDdl("old store-onboarding.sql", upgraded, oldStatements.join(";\n") + ";");
      await sql(
        `INSERT INTO ${requests} (id, display_number, title, initiative_id, provider_principal_id, provider_display, submitted_at, stage, stage_entered_at, sla_due_at, sla_due_soon_at, initiative_name, business_case, annual_benefit, levers, workspace_isolation, workspace_team_size, intake_answers, open_send_back_from_stage, open_send_back_action_id, version, created_at, created_by_principal_id, updated_at, updated_by_principal_id, last_action_id) SELECT uuid(), 1000, 'Legacy request', uuid(), :p, 'Legacy', current_timestamp(), 'business-roi-review', current_timestamp(), NULL, NULL, 'Legacy request', 'Made before display codes.', 1000, array('taxgap'), 'shared', 4, '{}', NULL, NULL, 2, current_timestamp(), :p, current_timestamp(), :p, uuid()`,
        { p: codeProvider.principalId },
      );
      const before = await shape();
      await runDdl("resources/store-onboarding.sql", upgraded);
      const afterFirst = await shape();
      await runDdl("resources/store-onboarding.sql", upgraded);
      const afterSecond = await shape();

      const upgradedRunner = createTransactionRunner({ client, names: upgradedNames });
      const created = await upgradedRunner.runCommand(submitOnboarding, {
        user: codeProvider,
        actor: {
          principalId: codeProvider.principalId,
          display: codeProvider.displayName,
          app: "tenant",
        },
        idempotencyKey: newId(),
        expectedVersion: 0,
        payload: { intake: liveIntake(1, "upgraded") },
      });
      const code = (created.result as OnboardingRequest).id;
      const readAs = async (name: string, query: Record<string, string>) =>
        registry.findRead("onboarding", name)!.run({
          query,
          user: codeProvider,
          names: upgradedNames,
          read: runner.reader({ readId: newId() }),
        });
      const legacy = (await readAs("request", { id: "ONB-1000" })) as OnboardingRequest | null;
      const coded = (await readAs("request", { id: code })) as OnboardingRequest | null;
      const mine = ((await readAs("mine", {})) as OnboardingRequest[]).map((r) => r.id).sort();
      const pass =
        before === "display_number:NO" &&
        afterFirst === "display_code:YES display_number:YES" &&
        afterSecond === afterFirst &&
        /^ONB-[0-9A-HJKMNP-TV-Z]{6}$/.test(code) &&
        legacy?.id === "ONB-1000" &&
        coded?.id === code &&
        mine.join(",") === ["ONB-1000", code].sort().join(",");
      return {
        pass,
        detail: `columns (name:nullable): old ${before}; after provisioning ${afterFirst}; again ${afterSecond}; new submit ${code}; read ONB-1000 → ${legacy?.id ?? "null"}, ${code} → ${coded?.id ?? "null"}; mine ${mine.join(", ")}`,
      };
    },
  );

  await check(
    "15. monitoring.invariant_violations is empty, then reports a duplicated display code",
    async () => {
      const view = names.table("monitoring", "invariant_violations");
      const violations = () =>
        sql(`SELECT rule, record_table, detail FROM ${view} ORDER BY record_id`).then(
          (r) => r.rows,
        );
      const clean = await violations();
      const [first, second] = concurrentCodes;
      if (!first || !second) return { pass: false, detail: "4b left no codes" };
      const requests = names.table("onboarding", "onboarding_requests");
      await sql(`UPDATE ${requests} SET display_code = :a WHERE display_code = :b`, {
        a: first,
        b: second,
      });
      const broken = await violations();
      // Put it back, so the store is consistent again.
      await sql(
        `UPDATE ${requests} SET display_code = :b WHERE display_code = :a AND id = (SELECT max(id) FROM ${requests} WHERE display_code = :a)`,
        { a: first, b: second },
      );
      const restored = await violations();
      const pass =
        clean.length === 0 &&
        broken.length === 2 &&
        broken.every(
          (row) =>
            row["rule"] === "duplicate-display-code" &&
            row["record_table"] === "onboarding_requests" &&
            row["detail"] === first,
        ) &&
        restored.length === 0;
      return {
        pass,
        detail: `before ${clean.length} rows; with ${first} on two requests ${broken.length} rows (${broken.map((r) => `${String(r["rule"])}:${String(r["record_table"])}`).join(", ")}); after restoring ${restored.length}`,
      };
    },
  );
}

/** Every schema this script makes under the prefix. */
const SCHEMAS = [
  "live",
  "audit",
  "monitoring",
  "admin",
  "eir",
  "catalog",
  "requests",
  "access",
  "initiatives",
  "teams",
  "change_list",
  "onboarding",
  "privacy",
  "m_admin",
  "m_audit",
  "m_monitoring",
  "c_admin",
  "c_audit",
  "c_monitoring",
  "c_onboarding",
];

async function cleanup() {
  if (args.keep) {
    console.log(`--keep: leaving ${catalog}.${prefix}{${SCHEMAS.join(",")}}`);
    return;
  }
  for (const schema of SCHEMAS) {
    await sql(`DROP SCHEMA IF EXISTS \`${catalog}\`.\`${prefix}${schema}\` CASCADE`);
  }
  const left = (
    await sql(
      `SELECT schema_name FROM \`${catalog}\`.information_schema.schemata WHERE startswith(schema_name, :p)`,
      { p: prefix },
    )
  ).rows.map((r) => String(r["schema_name"]));
  checks.push({
    name: "cleanup: throwaway schemas dropped",
    pass: left.length === 0,
    detail: left.length
      ? `still there: ${left.join(", ")}`
      : `no ${prefix}* schemas remain in ${catalog}`,
  });
  console.log(`${left.length ? "FAIL" : "PASS"}  cleanup: ${checks.at(-1)!.detail}`);
}

function report() {
  const all = attempts.filter((a) => a.outcome !== "retry");
  const latencies = all.map((a) => a.elapsedMs).sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  const retries = attempts.filter((a) => a.outcome === "retry" || a.outcome === "abandoned");
  const retryErrors = new Map<string, number>();
  for (const r of retries) {
    const text =
      r.error instanceof SqlError
        ? (r.error.message.match(/\[([A-Z_.]+)\]/)?.[1] ?? r.error.sqlState ?? "SqlError")
        : String(r.error);
    retryErrors.set(text, (retryErrors.get(text) ?? 0) + 1);
  }
  console.log("\n| Check | Result | Detail | Attempts per command | Latency per command (ms) |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const c of checks) {
    console.log(
      `| ${c.name} | ${c.pass ? "pass" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} | ${c.attempts?.join(", ") ?? ""} | ${c.latencyMs?.join(", ") ?? ""} |`,
    );
  }
  console.log(
    `\nFinal attempts: ${all.length}; median ${pct(50)} ms, p95 ${pct(95)} ms. Conflict retries: ${retries.length} (${[...retryErrors].map(([k, v]) => `${k} × ${v}`).join(", ") || "none"}). of which abandoned at the 45 s deadline: ${attempts.filter((a) => a.outcome === "abandoned").length}. BusyError: ${attempts.filter((a) => a.error instanceof BusyError).length}.`,
  );
  console.log("\n| Phase | Calls | Total ms | Median ms | p95 ms |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const phase of ["idempotency read", "pre-read", "block", "post-read", "other"] as const) {
    const values = phaseTimings
      .filter((timing) => timing.phase === phase)
      .map((timing) => timing.elapsedMs)
      .sort((a, b) => a - b);
    if (!values.length) continue;
    const phasePct = (p: number) =>
      values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];
    console.log(
      `| ${phase} | ${values.length} | ${values.reduce((sum, value) => sum + value, 0)} | ${phasePct(50)} | ${phasePct(95)} |`,
    );
  }
  const retryTotal = retrySleeps.reduce((sum, value) => sum + value, 0);
  console.log(
    `\nRetry sleep: ${retrySleeps.length} sleeps, ${retryTotal} ms total${retrySleeps.length ? ` (${retrySleeps.join(", ")} ms)` : ""}.`,
  );
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error("Setup failed:", error);
} finally {
  await cleanup().catch((error: unknown) => {
    failed = true;
    console.error("Cleanup failed:", error);
  });
  report();
}
process.exit(failed || checks.some((c) => !c.pass) ? 1 : 0);
