/**
 * One-off: migrate #98's interim EIR records (`record/v<N>.json`, legacy
 * `_record.json`) from a Unity Catalog volume into the `eir` tables (#126).
 * See `src/server/eir-migration.ts` for what it does and checks, and
 * docs/eir-volume.md for when to run it and how to roll back.
 *
 * Re-running is safe: each person's import has a fixed idempotency key, so
 * a second run replays and writes nothing. The volume is only read.
 *
 *   node scripts/eir-volume-migration.ts --profile example-workspace \
 *     --warehouse 1111111111111111 --catalog example_catalog --prefix edp_vm_pr130_ \
 *     --volume example_catalog.edp_vm_preview.eir_pr98 [--dry-run]
 *
 * Exits 1 when any record mismatches, changed since it was migrated, or the
 * tables' row counts differ from the source's.
 */
import { parseArgs } from "node:util";

import { createStoreNames } from "../src/server/delta/sql-builder.ts";
import { createTransactionRunner } from "../src/server/delta/transaction.ts";
import { describeReport, migrateEirVolumeRecords } from "../src/server/eir-migration.ts";
import { connect } from "./eir-cli.ts";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string" },
    warehouse: { type: "string" },
    catalog: { type: "string" },
    prefix: { type: "string", default: "" },
    volume: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const volumeParts = args.volume?.split(".") ?? [];
if (!args.profile || !args.warehouse || !args.catalog || volumeParts.length !== 3) {
  console.error(
    "Usage: node scripts/eir-volume-migration.ts --profile <p> --warehouse <id> --catalog <store catalog> [--prefix <schema prefix>] --volume <catalog.schema.volume> [--dry-run]",
  );
  process.exit(2);
}
const [catalog, schema, volume] = volumeParts as [string, string, string];
const { client, storage } = connect(args.profile, args.warehouse);
const names = createStoreNames(args.catalog, args.prefix);
const report = await migrateEirVolumeRecords({
  storage: await storage(),
  volume: { catalog, schema, volume },
  runner: createTransactionRunner({ client, names }),
  names,
  dryRun: args["dry-run"],
});
console.log(describeReport(report));
process.exit(report.ok ? 0 : 1);
