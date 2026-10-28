/**
 * Live check for the initiatives, teams and change-list areas (#123), on a
 * real warehouse, in throwaway schemas.
 *
 * It provisions with the real DDL (resources/store-admin.sql,
 * resources/store-teams.sql, resources/store-audit.sql) under its own schema
 * prefix, then drives the areas the way the app does: the Delta adapter's
 * HTTP transport into the server's API router, the transaction runner and
 * the teams area, with the session resolved by the server. It checks:
 *
 *   1. provisioning, and re-provisioning (every statement is idempotent)
 *   2. the configured datasets load once, as `system`, even with two loaders racing
 *   3. two owners adding the same person at once → one member, one CL entry
 *   4. an add is there after a "reload" (a new adapter) and from a second session
 *   5. a role change sent with a stale version → version-conflict, nothing written
 *   6. ADR-0006: the first protected action binds the email; an impostor with
 *      that email is refused and the refusal is recorded, moving the owner's version
 *   7. the change list: tenants can't mark applied; staff can, once, recorded
 *      by hand in change_list_applications; the stage is derived
 *   8. owners: the last owner can't be removed; removing an owner lists their
 *      Maintainer-group removal
 *   9. audit.actions has this area's branches
 *
 * Then it DROPs every schema it made and confirms none is left. It exits
 * non-zero if any check fails or a schema remains. Nothing changes outside
 * the throwaway schemas. SQL runs as the CLI profile's identity; the people
 * acting are synthetic sessions, as the app's sessions would be.
 *
 * Usage (Node 24+, from the repo root):
 *
 *   node scripts/delta-teams-live-check.ts --profile example-workspace \
 *     --warehouse 1111111111111111 --catalog example_catalog
 *
 * Options: --prefix <schema prefix> (default edp_delta_teams_<yyyymmdd>_), --keep.
 * Don't run it against example-gov-demo from an agent; a human runs it there.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createDeltaStore, httpTransport } from "../src/data/adapters/delta.ts";
import type { DatasetSeed } from "../src/data/datasets/types.ts";
import type { DataStore } from "../src/data/store.ts";
import type { UserProfile } from "../src/data/types.ts";
import {
  errorResponse,
  handleDeltaApiRequest,
  type DeltaApiDeps,
} from "../src/server/delta/api.ts";
import { registerTeamsArea } from "../src/server/delta/areas/teams.ts";
import { loadConfiguredDatasets } from "../src/server/delta/areas/teams-seed.ts";
import { newId } from "../src/server/delta/ids.ts";
import { createRegistry } from "../src/server/delta/registry.ts";
import { createStoreNames } from "../src/server/delta/sql-builder.ts";
import { createStatementExecutionClient, type SqlClient } from "../src/server/delta/sql-client.ts";
import { createTransactionRunner, type AttemptInfo } from "../src/server/delta/transaction.ts";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    warehouse: { type: "string" },
    catalog: { type: "string" },
    prefix: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.profile || !args.warehouse || !args.catalog) {
  console.error(
    "Usage: node scripts/delta-teams-live-check.ts --profile <p> --warehouse <id> --catalog <catalog>",
  );
  process.exit(2);
}
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const prefix = args.prefix ?? `edp_delta_teams_${today}_`;
const catalog = args.catalog;
const SCHEMAS = ["admin", "audit", "initiatives", "teams", "change_list"];

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

const client: SqlClient = createStatementExecutionClient({
  host,
  warehouseId: args.warehouse,
  getToken,
});
const adminClient: SqlClient = createStatementExecutionClient({
  host,
  warehouseId: args.warehouse,
  getToken,
  deadlineMs: 600_000,
});
const names = createStoreNames(catalog, prefix);
const attempts: AttemptInfo[] = [];
const runner = createTransactionRunner({ client, names, onAttempt: (info) => attempts.push(info) });
const sql = async (statement: string, parameters?: Record<string, string | number | null>) =>
  (
    await adminClient.execute(
      { statement, ...(parameters ? { parameters } : {}) },
      { actionId: newId() },
    )
  ).rows;
const t = (schema: string, table: string) => names.table(schema, table);

// ---- Provisioning (as scripts/delta-live-check.ts does it) -------------------

/** Split a DDL file into statements on top-level `;` line ends. */
function statementsOf(text: string): string[] {
  const lines = text.split("\n").filter((line) => !line.trim().startsWith("--"));
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (!current.length && !line.trim()) continue;
    current.push(line);
    if (line.trimEnd().endsWith(";")) {
      statements.push(current.join("\n").trim().replace(/;$/, ""));
      current = [];
    }
  }
  return statements;
}

async function runDdl(file: string) {
  const statements = statementsOf(readFileSync(file, "utf8"));
  const bind = (statement: string) => {
    const parameters: Record<string, string> = {};
    if (statement.includes(":catalog_name")) parameters["catalog_name"] = catalog;
    if (statement.includes(":schema_prefix")) parameters["schema_prefix"] = prefix;
    return parameters;
  };
  // The job's SQL task shares one session across a file; Statement Execution
  // calls don't, so a file with session variables runs as one compound block.
  if (statements.some((s) => s.startsWith("DECLARE OR REPLACE VARIABLE"))) {
    const rest = statements.filter((s) => !s.startsWith("USE CATALOG"));
    const declared = rest.filter((s) => s.startsWith("DECLARE OR REPLACE VARIABLE"));
    const body = [...declared, ...rest.filter((s) => !declared.includes(s))].map((s) =>
      s.replace(/^DECLARE OR REPLACE VARIABLE/, "DECLARE").replace(/^SET VAR /, "SET "),
    );
    const block = `BEGIN\n${body.join(";\n")};\nEND`;
    await sql(block, bind(block));
    return;
  }
  for (const statement of statements) {
    await sql(statement, bind(statement)).catch((error: unknown) => {
      throw new Error(`${file} failed at: ${statement.slice(0, 200)}\n${String(error)}`);
    });
  }
}

// ---- The app, in process: adapter → API router → runner → teams area --------

const registry = createRegistry();
registerTeamsArea(registry);

const person = (principalId: string, name: string, isAdmin = false): UserProfile => ({
  principalId,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  title: "Live check",
  tenant: "RAAS",
  email: `${principalId}@live-check.example.gov`,
  isOnboardingLead: false,
  isAdmin,
});
const OWNER_1 = person("live-owner-1", "Olive Live");
const OWNER_2 = person("live-owner-2", "Quinn Live");
const STAFF = person("live-staff-1", "Stella Live", true);
const SEED: DatasetSeed = {
  initiatives: [
    { id: "INI-LIVE-1", name: "Live check initiative", tenant: "RAAS", stage: "active" },
  ],
  datasets: [
    {
      id: "ds-live-check",
      initiativeId: "INI-LIVE-1",
      name: "Live check dataset",
      domainTag: "individual-filing",
      datasetTag: "live_check",
      owners: [
        { principalId: OWNER_1.principalId, displayName: OWNER_1.name },
        { principalId: OWNER_2.principalId, displayName: OWNER_2.name },
      ],
    },
  ],
};
const DATASET = "ds-live-check";

/** One browser session: a fresh adapter whose server session is `user`. */
function session(user: UserProfile): DataStore {
  const deps: DeltaApiDeps = {
    registry,
    runner,
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => ({
      principalId: user.principalId,
      displayName: user.name,
      email: user.email ?? "",
      isAdmin: user.isAdmin,
      onboardingReviewerRoles: [],
    }),
    requirePrivacyAcknowledgment: async () => undefined,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    try {
      return await handleDeltaApiRequest(
        new Request(new URL(url, "http://live.check"), init),
        deps,
      );
    } catch (error) {
      return errorResponse(error, url);
    }
  }) as typeof fetch;
  return createDeltaStore({
    transport: httpTransport(fetchImpl),
    accessStores: { currentUser: async () => user },
  });
}

// ---- Checks -----------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
async function check(name: string, run: () => Promise<string>) {
  const started = Date.now();
  try {
    const detail = await run();
    checks.push({ name, pass: true, detail: `${detail} (${Date.now() - started} ms)` });
    console.log(`PASS  ${name}: ${detail}`);
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error) });
    console.log(`FAIL  ${name}: ${String(error)}`);
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const count = async (
  schema: string,
  table: string,
  where = "TRUE",
  params?: Record<string, string>,
) =>
  Number(
    (await sql(`SELECT count(*) AS n FROM ${t(schema, table)} WHERE ${where}`, params))[0]!["n"],
  );

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return "no refusal";
}

const TESS = { datasetId: DATASET, name: "Tess Live", email: "tess.live@live-check.example.gov" };

async function main() {
  await check("1. provision admin, teams and audit; again", async () => {
    for (const file of [
      "resources/store-admin.sql",
      "resources/store-teams.sql",
      "resources/store-audit.sql",
    ]) {
      await runDdl(file);
    }
    await runDdl("resources/store-teams.sql");
    await runDdl("resources/store-audit.sql");
    const props = await sql(`SHOW TBLPROPERTIES ${t("teams", "dataset_members")}`);
    const tracking = props.find((r) => r["key"] === "delta.enableRowTracking")?.["value"];
    expect(tracking === "true", `row tracking is ${String(tracking)}`);
    return "provisioned twice; row tracking on";
  });

  await check("2. configured datasets load once, as system, with two loaders racing", async () => {
    await Promise.all([
      loadConfiguredDatasets(SEED, { runner, names }),
      loadConfiguredDatasets(SEED, { runner, names }),
    ]);
    await loadConfiguredDatasets(SEED, { runner, names });
    expect((await count("initiatives", "initiatives")) === 1, "initiatives ≠ 1");
    expect((await count("teams", "dataset_owners")) === 2, "owners ≠ 2");
    expect(
      (await count("teams", "dataset_members", "role = 'manager'")) === 2,
      "Maintainers (rows stored as `manager`) ≠ 2",
    );
    expect((await count("change_list", "change_list_entries")) === 0, "entries listed at load");
    const notSystem = await count(
      "teams",
      "dataset_owner_actions",
      "actor_principal_id <> 'system' OR actor_app <> 'system'",
    );
    expect(notSystem === 0, `${notSystem} owner actions not by system`);
    const owners = (await session(OWNER_1).datasets.getDataset(DATASET))?.owners.map(
      (o) => o.principalId,
    );
    expect(
      JSON.stringify(owners) === JSON.stringify([OWNER_1.principalId, OWNER_2.principalId]),
      `owner order ${JSON.stringify(owners)}`,
    );
    return "1 initiative, 1 dataset, 2 owners and Maintainers; every action by system; configured order kept";
  });

  await check("3. two owners adding the same person at once: one member, one entry", async () => {
    const before = attempts.length;
    const results = await Promise.all([
      session(OWNER_1).datasetRoles.addMember({ ...TESS, role: "tester" }),
      session(OWNER_2).datasetRoles.addMember({ ...TESS, role: "tester" }),
    ]);
    const created = results.filter((r) => r.created).length;
    expect(created === 1, `${created} reported created`);
    expect(
      (await count("teams", "dataset_members", "person_email = :e", { e: TESS.email })) === 1,
      "members ≠ 1",
    );
    expect((await count("change_list", "change_list_entries")) === 1, "entries ≠ 1");
    const retries = attempts.slice(before).filter((a) => a.outcome === "retry").length;
    return `one member and CL-0001; the other session got the existing role (${retries} conflict retr${retries === 1 ? "y" : "ies"})`;
  });

  await check("4. the add survives a reload and is visible from a second session", async () => {
    const reloaded = await session(OWNER_1).datasetRoles.listMembers(DATASET);
    const other = await session(OWNER_2).datasetRoles.listMembers(DATASET);
    expect(
      reloaded.some((m) => m.person.email === TESS.email),
      "not there after reload",
    );
    expect(
      other.some((m) => m.person.email === TESS.email),
      "not visible from the second session",
    );
    const entries = await session(STAFF).changeList.listEntries();
    expect(
      entries.map((e) => e.id).join() === "CL-0001",
      `entries ${entries.map((e) => e.id).join()}`,
    );
    return "a fresh adapter and another owner's session both read Tess; staff read CL-0001";
  });

  await check(
    "5. a role change with the version a screen read before someone else changed it",
    async () => {
      const stale = session(OWNER_2);
      await stale.datasetRoles.listMembers(DATASET); // screen reads version 1
      const fresh = session(OWNER_1);
      await fresh.datasetTeam.changeMemberRole({
        datasetId: DATASET,
        email: TESS.email,
        role: "tester",
        newRole: "developer",
      });
      await fresh.datasetTeam.changeMemberRole({
        datasetId: DATASET,
        email: TESS.email,
        role: "developer",
        newRole: "tester",
      });
      const before = await count("teams", "dataset_member_actions");
      const code = await refusal(
        stale.datasetTeam.changeMemberRole({
          datasetId: DATASET,
          email: TESS.email,
          role: "tester",
          newRole: "manager",
        }),
      );
      expect(code === "version-conflict", `got ${code}`);
      expect((await count("teams", "dataset_member_actions")) === before, "something was written");
      return "version-conflict; no action written";
    },
  );

  await check(
    "6. ADR-0006: binding on first action, an impostor refused and the refusal recorded",
    async () => {
      const drew = person("live-drew-1", "Drew Live");
      await session(OWNER_1).datasetTeam.addOwner({
        datasetId: DATASET,
        name: drew.name,
        email: drew.email!,
      });
      await session(drew).datasetRoles.addMember({
        datasetId: DATASET,
        name: "Dev Live",
        email: "dev.live@live-check.example.gov",
        role: "developer",
      });
      expect(
        (await count("teams", "email_bindings", "email = :e AND principal_id = :p", {
          e: drew.email!,
          p: drew.principalId,
        })) === 1,
        "no binding",
      );
      const impostor = { ...drew, principalId: "live-impostor-1" };
      const code = await refusal(
        session(impostor).datasetRoles.addMember({
          datasetId: DATASET,
          name: "X",
          email: "x@live-check.example.gov",
          role: "tester",
        }),
      );
      expect(code === "owner-mismatch", `got ${code}`);
      const [owner] = await sql(
        `SELECT o.version, a.action, a.payload FROM ${t("teams", "dataset_owners")} o JOIN ${t("teams", "dataset_owner_actions")} a ON a.action_id = o.last_action_id WHERE o.person_email = :e`,
        { e: drew.email! },
      );
      expect(owner?.["action"] === "access-refused", `last action ${String(owner?.["action"])}`);
      expect(String(owner?.["payload"]).includes("live-impostor-1"), "refused ID missing");
      expect(Number(owner?.["version"]) === 3, `owner version ${String(owner?.["version"])}`);
      return "bound on Drew's first add; impostor refused; access-refused recorded at owner version 3";
    },
  );

  await check("7. the change list: tenants refused, staff mark applied by hand once", async () => {
    const tenantCode = await refusal(session(OWNER_1).changeList.markApplied("CL-0001"));
    expect(tenantCode === "not-edp-staff", `tenant got ${tenantCode}`);
    const applied = await session(STAFF).changeList.markApplied("CL-0001");
    expect(applied.applied?.by === STAFF.principalId, "not applied by staff");
    const again = await refusal(session(STAFF).changeList.markApplied("CL-0001"));
    expect(again === "already-applied", `again got ${again}`);
    const [application] = await sql(
      `SELECT method, run_id FROM ${t("change_list", "change_list_applications")}`,
    );
    expect(
      application?.["method"] === "by-hand" && application["run_id"] === null,
      "application row",
    );
    expect((await count("change_list", "change_list_applications")) === 1, "applications ≠ 1");
    return "not-edp-staff for an owner; applied by staff, by-hand; already-applied the second time";
  });

  await check(
    "8. owners: last-owner refused; a removal lists the Maintainer-group removal",
    async () => {
      const store = session(STAFF);
      const result = await store.datasetTeam.removeOwner({
        datasetId: DATASET,
        owner: OWNER_2.principalId,
      });
      expect(
        result.entries.some(
          (e) => e.kind === "remove-member" && e.target.person.principalId === OWNER_2.principalId,
        ),
        "no removal entry",
      );
      await store.datasetTeam.removeOwner({ datasetId: DATASET, owner: "live-drew-1" });
      const code = await refusal(
        store.datasetTeam.removeOwner({ datasetId: DATASET, owner: OWNER_1.principalId }),
      );
      expect(code === "last-owner", `got ${code}`);
      return "removals listed by account ID; the last owner stays";
    },
  );

  await check("9. audit.actions has the initiatives, teams and change_list branches", async () => {
    const rows = await sql(
      `SELECT area, count(*) AS n FROM ${t("audit", "actions")} GROUP BY area ORDER BY area`,
    );
    const areas = rows.map((r) => String(r["area"]));
    for (const area of ["change_list", "initiatives", "teams"])
      expect(areas.includes(area), `no ${area} rows`);
    return rows.map((r) => `${String(r["area"])} ${String(r["n"])}`).join(", ");
  });
}

async function cleanup() {
  if (args.keep) {
    console.log(`--keep: left ${prefix}* in ${catalog}`);
    return;
  }
  for (const schema of SCHEMAS)
    await sql(`DROP SCHEMA IF EXISTS \`${catalog}\`.\`${prefix}${schema}\` CASCADE`);
  const left = (
    await sql(
      `SELECT schema_name FROM \`${catalog}\`.information_schema.schemata WHERE startswith(schema_name, :p)`,
      { p: prefix },
    )
  ).map((r) => String(r["schema_name"]));
  checks.push({
    name: "cleanup: throwaway schemas dropped",
    pass: left.length === 0,
    detail: left.length
      ? `still there: ${left.join(", ")}`
      : `no ${prefix}* schemas remain in ${catalog}`,
  });
  console.log(`${left.length ? "FAIL" : "PASS"}  cleanup: ${checks.at(-1)!.detail}`);
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
  const retries = attempts.filter((a) => a.outcome === "retry").length;
  console.log("\n| Check | Result | Detail |\n| --- | --- | --- |");
  for (const c of checks)
    console.log(`| ${c.name} | ${c.pass ? "pass" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`);
  console.log(`\nCommands attempted: ${attempts.length}; conflict retries: ${retries}.`);
}
process.exit(failed || checks.some((c) => !c.pass) ? 1 : 0);
