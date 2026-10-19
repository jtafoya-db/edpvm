/**
 * Live check for the `eir` area (#126) on a real warehouse, in throwaway
 * schemas, through the real API handler, runner and area:
 *
 *   1. provisioning store-eir.sql (twice: idempotent) and the audit view
 *   2. a submission, read back after a "reload", with its row, action and audit.actions row
 *   3. the lifecycle: send-back, answered resubmission, validation, a renewal
 *      alongside, revocation closing it (system follow-on), starting again as a submission
 *   4. a validator can't decide their own EIR
 *   5. two validators deciding at once → one wins, the other gets a version conflict
 *   6. a draft save racing a decision → both land
 *   7. one person's two first submissions at once → one EIR
 *   8. a resent key replays the original answer
 *   9. the volume migration: fixture records (current and legacy shapes) on a
 *      throwaway volume plus the real records on --source-volume (read only),
 *      migrated, checked, re-run (nothing changes), and read back
 *
 * Then it drops every schema it made (with the throwaway volume) and checks
 * they're gone. Exits non-zero if any check fails or anything is left.
 *
 *   node scripts/eir-live-check.ts --profile example-workspace --warehouse 1111111111111111 \
 *     --catalog example_catalog --source-volume example_catalog.edp_vm_preview.eir_pr98
 *
 * GovCloud (example-gov-demo) is run by a human, with that workspace's profile, warehouse and catalog.
 */
import { parseArgs } from "node:util";

import { registerEirArea } from "../src/server/delta/areas/eir.ts";
import { BusyError, DomainError } from "../src/server/delta/errors.ts";
import {
  createRegistry,
  type CommandDefinition,
  type SessionUser,
} from "../src/server/delta/registry.ts";
import { createStoreNames } from "../src/server/delta/sql-builder.ts";
import { createTransactionRunner } from "../src/server/delta/transaction.ts";
import {
  listVolumeRecords,
  migrateEirVolumeRecords,
  describeReport,
} from "../src/server/eir-migration.ts";
import { eirVolumePath, type EirVolumeConfig } from "../src/server/eir-storage.ts";
import { EIR_STUB_VALUES, EIR_VALUES } from "../src/data/__tests__/eir-fixtures.ts";
import { connect, runDdl } from "./eir-cli.ts";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    warehouse: { type: "string" },
    catalog: { type: "string" },
    prefix: { type: "string" },
    "source-volume": { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.profile || !args.warehouse || !args.catalog) {
  console.error(
    "Usage: node scripts/eir-live-check.ts --profile <p> --warehouse <id> --catalog <catalog> [--source-volume <c.s.v>]",
  );
  process.exit(2);
}
const catalog = args.catalog;
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
const prefix = args.prefix ?? `edp_eir_live_${stamp}_`;
const { client, sql, storage: storageFor, me } = connect(args.profile, args.warehouse);
const names = createStoreNames(catalog, prefix);
const T = (schema: string, table: string) => names.table(schema, table);
const VOLUME: EirVolumeConfig = { catalog, schema: `${prefix}eirvol`, volume: "files" };

const user = (principalId: string, displayName: string, validator = false): SessionUser => ({
  principalId,
  displayName,
  email: "",
  isAdmin: false,
  onboardingReviewerRoles: [],
  isSafeguardsValidator: validator,
});
// Synthetic people, so the real records migrated in check 9 (the CLI user's
// own, from #98's preview) land in a store that has nothing for them yet.
const PERSON = user("live-person-1", `Live Person One (run by ${me.userName})`);
const OTHER = user("live-person-2", "Live Person Two");
const THIRD = user("live-person-3", "Live Person Three");
const VAL = user("live-validator-1", "Live Validator One", true);
const VIC = user("live-validator-2", "Live Validator Two", true);
// Synthetic answers only: never a real person's name, email, ID or manager.
const VALUES = EIR_VALUES;
const STUB_VALUES = EIR_STUB_VALUES;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
async function check(name: string, run: () => Promise<string>) {
  const started = Date.now();
  try {
    const detail = await run();
    checks.push({
      name,
      ok: true,
      detail: `${detail} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const last = checks.at(-1)!;
  console.log(`${last.ok ? "PASS" : "FAIL"} ${name}: ${last.detail}`);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const storage = await storageFor();
  const registry = createRegistry();
  registerEirArea(registry, {
    volume: () => VOLUME,
    readFile: (path) => storage.read(path),
  });
  const runner = createTransactionRunner({ client, names });
  // What the API router does for a command or read (src/server/delta/api.ts),
  // without its identity module: authorize, parse, run, and map errors.
  const api = async (as: SessionUser, path: string, body?: any) => {
    const [, kind, area, name] = /^\/api\/(commands|reads)\/([a-z-]+)\/([a-z-]+)/.exec(path)!;
    try {
      if (kind === "commands") {
        const definition = registry.findWrite(area!, name!) as CommandDefinition<any, any>;
        definition.authorize?.(as);
        const outcome = await runner.runCommand(definition, {
          user: as,
          actor: { principalId: as.principalId, display: as.displayName, app: definition.app },
          idempotencyKey: body.idempotencyKey,
          expectedVersion: body.expectedVersion,
          payload: definition.payload.parse(body.payload),
        });
        return { status: 200, body: outcome as any };
      }
      const definition = registry.findRead(area!, name!)!;
      definition.authorize?.(as);
      const query = Object.fromEntries(new URL(`https://live${path}`).searchParams);
      const result = await definition.run({
        query: definition.query.parse(query),
        user: as,
        names,
        read: runner.reader({ readId: crypto.randomUUID() }),
      });
      return { status: 200, body: result as any };
    } catch (error) {
      if (error instanceof DomainError || error instanceof BusyError) {
        return {
          status: error.status,
          body: { error: { code: error.code, message: error.message } },
        };
      }
      throw error;
    }
  };
  let n = 0;
  const upload = async (as: SessionUser) => {
    n += 1;
    const path = eirVolumePath(VOLUME, as.principalId, `${Date.now()}-${crypto.randomUUID()}`);
    await storage.write(path, new TextEncoder().encode(`%PDF-1.7 live ${n}`), { overwrite: false });
    return path;
  };
  const submit = async (
    as: SessionUser,
    version: number,
    extra: object = {},
    key = crypto.randomUUID(),
  ) =>
    api(as, "/api/commands/eir/submit", {
      idempotencyKey: key,
      expectedVersion: version,
      payload: { volumePath: await upload(as), formVersion: "bootstrap", values: VALUES, ...extra },
    });
  const decide = (
    as: SessionUser,
    of: SessionUser,
    version: number,
    decision: string,
    note?: string,
  ) =>
    api(as, "/api/commands/eir/decide", {
      idempotencyKey: crypto.randomUUID(),
      expectedVersion: version,
      payload: { principalId: of.principalId, decision, ...(note ? { note } : {}) },
    });
  const mine = async (as: SessionUser) => (await api(as, "/api/reads/eir/mine")).body;
  const count = async (statement: string) =>
    Number((await sql(statement)).rows[0]?.["n" as never] ?? -1);

  await check("1. provisioning store-eir.sql (twice) and the audit view", async () => {
    await sql(`CREATE SCHEMA IF NOT EXISTS \`${catalog}\`.\`${prefix}eirvol\``);
    await sql(`CREATE VOLUME IF NOT EXISTS \`${catalog}\`.\`${prefix}eirvol\`.\`files\``);
    // The Record ID counter is in admin.display_counters, so admin comes first (as in the job).
    await runDdl(sql, "resources/store-admin.sql", catalog, prefix);
    await runDdl(sql, "resources/store-eir.sql", catalog, prefix);
    await runDdl(sql, "resources/store-eir.sql", catalog, prefix);
    await runDdl(sql, "resources/store-audit.sql", catalog, prefix);
    const tables = await count(
      `SELECT count(*) AS n FROM \`${catalog}\`.information_schema.tables WHERE table_schema = '${prefix}eir'`,
    );
    assert(tables === 5, `expected 5 eir tables, found ${tables}`);
    const counters = await count(
      `SELECT count(*) AS n FROM ${T("admin", "display_counters")} WHERE prefix = 'EIR' AND next_number = 1001`,
    );
    assert(counters === 1, `EIR counter rows: ${counters}`);
    return "5 tables, EIR Record ID counter at 1001 (seeded once), audit.eir_branch in audit.actions";
  });

  await check("2. a submission survives a reload: row, action and audit.actions row", async () => {
    const first = await submit(PERSON, 0);
    assert(first.status === 200, `submit ${first.status} ${JSON.stringify(first.body)}`);
    const reloaded = await mine(PERSON);
    assert(
      reloaded.stage === "submitted" && reloaded.version === 1,
      `read ${JSON.stringify(reloaded)}`,
    );
    const sha = reloaded.submissions[0]?.sha256;
    assert(/^[0-9a-f]{64}$/.test(sha), "no server-read hash");
    assert(
      reloaded.recordId === "EIR-1001" &&
        reloaded.formVersion === "bootstrap" &&
        reloaded.submissions[0]?.formVersion === "bootstrap" &&
        reloaded.formValues?.userId === VALUES.userId,
      `bootstrap (version 0) / Record ID ${reloaded.recordId} ${reloaded.formVersion}`,
    );
    const invalid = await submit(OTHER, 0, { values: { ...VALUES, workEmail: "" } });
    assert(
      invalid.status === 400 && invalid.body.error.code === "eir-invalid",
      `server validation ${invalid.status} ${JSON.stringify(invalid.body)}`,
    );
    const audit = (
      await sql(
        `SELECT action, actor_app FROM ${T("audit", "actions")} WHERE record_id = '${first.body.recordId}'`,
      )
    ).rows as any[];
    assert(
      audit.length === 1 && audit[0].action === "submitted" && audit[0].actor_app === "tenant",
      `audit ${JSON.stringify(audit)}`,
    );
    return `EIR ${reloaded.recordId} (form ${reloaded.formVersion}) v1, PDF sha256 ${sha.slice(0, 12)}…, audit row present; an incomplete form refused 400 eir-invalid in the command`;
  });

  await check(
    "3. lifecycle: send-back, answer, valid, renewal alongside, revocation, fresh start",
    async () => {
      const steps: [string, () => Promise<{ status: number; body: any }>][] = [
        ["questions", () => decide(VAL, PERSON, 1, "questions", "Which team?")],
        ["resubmit", () => submit(PERSON, 2, { response: "EDP" })],
        ["valid", () => decide(VIC, PERSON, 3, "valid")],
        ["renew", () => submit(PERSON, 4)],
        ["revoke", () => decide(VAL, PERSON, 5, "revoked", "Live check")],
        ["restart", () => submit(PERSON, 7)],
      ];
      for (const [label, step] of steps) {
        const result = await step();
        assert(result.status === 200, `${label}: ${result.status} ${JSON.stringify(result.body)}`);
      }
      const record = await mine(PERSON);
      assert(
        record.stage === "submitted" && record.version === 8,
        `ended ${record.stage} v${record.version}`,
      );
      assert(
        JSON.stringify(record.submissions.map((s: any) => s.kind)) ===
          JSON.stringify(["first", "resubmission", "renewal", "first"]),
        `kinds ${record.submissions.map((s: any) => s.kind)}`,
      );
      const closed = record.actions.find((a: any) => a.kind === "renewal-closed");
      assert(closed?.actorScimId === "system", "renewal not closed by system");
      const actions = await count(
        `SELECT count(*) AS n FROM ${T("eir", "eir_actions")} WHERE eir_id IN (SELECT id FROM ${T("eir", "eirs")} WHERE person_principal_id = '${PERSON.principalId}')`,
      );
      assert(actions === 8, `${actions} action rows`);
      return `8 versions, kinds first/resubmission/renewal/first, renewal-closed by system, 8 action rows`;
    },
  );

  await check("4. a validator can't decide their own EIR", async () => {
    const own = await submit(VAL, 0);
    assert(own.status === 200, `validator submit ${own.status}`);
    const self = await decide(VAL, VAL, 1, "valid");
    assert(self.status === 403 && self.body.error.code === "own-eir", `self ${self.status}`);
    const other = await decide(VIC, VAL, 1, "valid");
    assert(other.status === 200, `second validator ${other.status}`);
    return "403 own-eir; a second validator decided it";
  });

  await check("5. two validators deciding at once: one wins, one is told to reload", async () => {
    assert((await submit(OTHER, 0)).status === 200, "submit");
    const results = await Promise.all([
      decide(VAL, OTHER, 1, "valid"),
      decide(VIC, OTHER, 1, "rejected", "Racing"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert(
      JSON.stringify(statuses) === "[200,409]",
      `statuses ${statuses} ${JSON.stringify(results.map((r) => r.body))}`,
    );
    const decisions = await count(
      `SELECT count(*) AS n FROM ${T("eir", "eir_actions")} WHERE eir_id IN (SELECT id FROM ${T("eir", "eirs")} WHERE person_principal_id = '${OTHER.principalId}') AND action IN ('validated', 'rejected')`,
    );
    assert(decisions === 1, `${decisions} decisions written`);
    return "[200, 409 version-conflict], one decision row";
  });

  await check("6. a draft save racing a decision: both land", async () => {
    const [revoked, draft] = await Promise.all([
      decide(VAL, OTHER, 2, "revoked", "Racing a draft"),
      api(OTHER, "/api/commands/eir/save-draft", {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: 0,
        payload: { formVersion: "bootstrap", values: { ...VALUES, team: "Drafted" } },
      }),
    ]);
    assert(
      revoked.status === 200 && draft.status === 200,
      `decision ${revoked.status}, draft ${draft.status} ${JSON.stringify(draft.body)}`,
    );
    const record = await mine(OTHER);
    assert(
      record.stage === "revoked" && record.draftValues?.team === "Drafted",
      `read ${record.stage} ${JSON.stringify(record.draftValues)}`,
    );
    return `revoked and drafted; draft attempts ${draft.body.attempts}, decision attempts ${revoked.body.attempts}`;
  });

  await check("7. one person's two first submissions at once: one EIR", async () => {
    const results = await Promise.all([submit(THIRD, 0), submit(THIRD, 0)]);
    const statuses = results.map((r) => r.status).sort();
    assert(JSON.stringify(statuses) === "[200,409]", `statuses ${statuses}`);
    const rows = await count(
      `SELECT count(*) AS n FROM ${T("eir", "eirs")} WHERE person_principal_id = '${THIRD.principalId}'`,
    );
    const subs = await count(
      `SELECT count(*) AS n FROM ${T("eir", "eir_submissions")} WHERE eir_id IN (SELECT id FROM ${T("eir", "eirs")} WHERE person_principal_id = '${THIRD.principalId}')`,
    );
    assert(rows === 1 && subs === 1, `${rows} EIRs, ${subs} submissions`);
    return "[200, 409], 1 EIR, 1 submission";
  });

  await check("8. a resent key replays the original answer", async () => {
    const key = crypto.randomUUID();
    const decision = {
      idempotencyKey: key,
      expectedVersion: 1,
      payload: { principalId: THIRD.principalId, decision: "valid" },
    };
    const first = await api(VAL, "/api/commands/eir/decide", decision);
    const again = await api(VAL, "/api/commands/eir/decide", decision);
    assert(
      first.status === 200 && again.status === 200,
      `statuses ${first.status} ${again.status}`,
    );
    assert(again.body.replayed === true, "not replayed");
    assert(
      JSON.stringify(first.body.result) === JSON.stringify(again.body.result),
      "different answer",
    );
    const rows = await count(
      `SELECT count(*) AS n FROM ${T("eir", "eir_actions")} WHERE idempotency_key = '${key}'`,
    );
    assert(rows === 1, `${rows} rows for the key`);
    return "replayed: true, same result, 1 action row";
  });

  await check(
    "9. volume migration: fixtures and real records, checked, re-run changes nothing",
    async () => {
      const root = `/Volumes/${VOLUME.catalog}/${VOLUME.schema}/${VOLUME.volume}`;
      const at = (d: number) => new Date(Date.UTC(2026, 8, d, 12)).toISOString();
      const pdf = (owner: string, i: number) =>
        `${root}/${owner}/${1790000000000 + i}-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.pdf`;
      const fixtures: Record<string, unknown> = {
        [`${root}/mig-1/record/v1.json`]: {
          principalId: "mig-1",
          personName: "Mig One",
          stage: "submitted",
          submissions: [],
          actions: [],
        },
        [`${root}/mig-1/record/v3.json`]: {
          principalId: "mig-1",
          personName: "Mig One",
          stage: "submitted",
          formValues: STUB_VALUES,
          submissions: [
            {
              volumePath: pdf("mig-1", 1),
              submittedAt: at(1),
              sha256: "a".repeat(64),
              sizeBytes: 9,
              formValues: STUB_VALUES,
              kind: "first",
            },
            {
              volumePath: pdf("mig-1", 2),
              submittedAt: at(3),
              sha256: "b".repeat(64),
              sizeBytes: 9,
              formValues: STUB_VALUES,
              kind: "renewal",
            },
          ],
          actions: [
            { kind: "submitted", actorScimId: "mig-1", actorName: "Mig One", at: at(1) },
            { kind: "rejected", actorScimId: "v-1", actorName: "Val", at: at(2), note: "Unsigned" },
            { kind: "renewed", actorScimId: "mig-1", actorName: "Mig One", at: at(3) },
          ],
        },
        [`${root}/mig-2/_record.json`]: {
          principalId: "mig-2",
          personName: "Mig Two",
          stage: "valid",
          formValues: STUB_VALUES,
          expiresAt: "2027-09-02T12:00:00.000Z",
          submissions: [{ volumePath: pdf("mig-2", 1), submittedAt: at(1) }],
          actions: [
            { kind: "submitted", actorScimId: "mig-2", at: at(1) },
            { kind: "valid", actorScimId: "v-1", at: at(2) },
          ],
        },
      };
      for (const [path, value] of Object.entries(fixtures)) {
        await storage.write(path, new TextEncoder().encode(JSON.stringify(value)), {
          overwrite: false,
        });
      }
      const migrate = (volume: EirVolumeConfig) =>
        migrateEirVolumeRecords({ storage, volume, runner, names });
      const sources: EirVolumeConfig[] = [VOLUME];
      const real = args["source-volume"]?.split(".");
      if (real?.length === 3)
        sources.push({ catalog: real[0]!, schema: real[1]!, volume: real[2]! });
      const lines: string[] = [];
      let migrated = 0;
      for (const source of sources) {
        const files =
          source === VOLUME ? [] : (await listVolumeRecords(storage, source)).map((r) => r.path);
        const report = await migrate(source);
        console.log(describeReport(report));
        assert(report.ok, `first run on ${source.volume} failed`);
        migrated += report.entries.filter((e) => e.outcome === "migrated").length;
        const snapshot = async () =>
          JSON.stringify(
            (
              await sql(
                `SELECT (SELECT count(*) FROM ${T("eir", "eirs")}) AS e, (SELECT count(*) FROM ${T("eir", "eir_submissions")}) AS s, (SELECT count(*) FROM ${T("eir", "eir_actions")}) AS a, (SELECT max(version) FROM ${T("eir", "eirs")}) AS v`,
              )
            ).rows,
          );
        const before = await snapshot();
        const again = await migrate(source);
        assert(
          again.ok && again.entries.every((e) => e.outcome === "already-migrated"),
          `re-run: ${describeReport(again)}`,
        );
        assert((await snapshot()) === before, "re-run changed the tables");
        if (source !== VOLUME) {
          const after = (await listVolumeRecords(storage, source)).map((r) => r.path);
          assert(JSON.stringify(after) === JSON.stringify(files), "source volume changed");
        }
        lines.push(
          `${source.volume}: ${report.entries.map((e) => `${e.principalId} ${e.outcome} ${e.tables?.submissions}/${e.source.submissions} subs ${e.tables?.actions}/${e.source.actions} actions`).join("; ")}; re-run all already-migrated, tables unchanged`,
        );
      }
      const mig1 = await mine(user("mig-1", "Mig One"));
      assert(
        mig1.stage === "submitted" &&
          mig1.submissions.map((s: any) => s.kind).join() === "first,first",
        `mig-1 read ${mig1.stage} ${mig1.submissions.map((s: any) => s.kind)}`,
      );
      const versions = (
        await sql(
          `SELECT DISTINCT s.form_version FROM ${T("eir", "eir_submissions")} s JOIN ${T("eir", "eir_actions")} a ON a.eir_id = s.eir_id AND a.action = 'migrated'`,
        )
      ).rows as any[];
      assert(
        versions.length === 1 && versions[0].form_version === "0.1",
        `migrated form versions ${JSON.stringify(versions)}`,
      );
      const lead = (
        await sql(
          `SELECT actor_principal_id, actor_app FROM ${T("eir", "eir_actions")} WHERE action = 'migrated'`,
        )
      ).rows as any[];
      assert(
        lead.length === migrated &&
          lead.every((r) => r.actor_principal_id === "system" && r.actor_app === "system"),
        "migrated lead actions",
      );
      return `${lines.join(" | ")}; #98 renewal after rejection now a first submission; migrated answers kept as form 0.1; ${migrated} migrated lead actions by system`;
    },
  );
}

async function cleanup() {
  if (args.keep) return `kept ${prefix}*`;
  for (const schema of ["eir", "audit", "admin", "eirvol"]) {
    await sql(`DROP SCHEMA IF EXISTS \`${catalog}\`.\`${prefix}${schema}\` CASCADE`);
  }
  const left = (
    await sql(
      `SELECT schema_name FROM \`${catalog}\`.information_schema.schemata WHERE schema_name LIKE '${prefix}%'`,
    )
  ).rows;
  if (left.length) throw new Error(`left behind: ${JSON.stringify(left)}`);
  return `dropped ${prefix}{eir,audit,admin,eirvol}; none left`;
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error("live check aborted:", error);
} finally {
  try {
    console.log(`CLEANUP ${await cleanup()}`);
  } catch (error) {
    failed = true;
    console.error("CLEANUP FAILED:", error);
  }
}
const failures = checks.filter((c) => !c.ok);
console.log(
  `\n${checks.length - failures.length}/${checks.length} checks passed (prefix ${prefix})`,
);
process.exit(failed || failures.length || checks.length < 9 ? 1 : 0);
