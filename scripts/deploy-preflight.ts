#!/usr/bin/env node
// Loud deploy preflight (#138). Runs the pure var-resolution seam
// (src/deploy/preflight.ts) over the --var set a deployer passes, BEFORE any
// `databricks bundle` call, so a missing/invalid input fails here naming its
// variable instead of deep in the Databricks API. When the vars are clean, it
// then asks the workspace (`databricks catalogs get`) whether each catalog
// exists, and refuses one that doesn't.
//
// Node strips the TypeScript types, so this runs with no build step:
//   node scripts/deploy-preflight.ts -t preview -p <profile> --var catalog=<name> --var sql_warehouse_id=<id>
// Exits non-zero if any problem is an error. Used by scripts/deploy-turnkey.sh.
import { spawnSync } from "node:child_process";

import {
  decodeCliVarPair,
  formatProblems,
  hasErrors,
  missingCatalogProblems,
  resolvePreflight,
  type CatalogLookupResult,
  type SuppliedVars,
} from "../src/deploy/preflight.ts";

function parseArgs(argv: string[]): { vars: SuppliedVars; target?: string; profile?: string } {
  const vars: SuppliedVars = {};
  let target: string | undefined;
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--var") {
      const decoded = decodeCliVarPair(argv[++i] ?? "");
      if (decoded) vars[decoded[0]] = decoded[1];
    } else if (arg?.startsWith("--var=")) {
      const decoded = decodeCliVarPair(arg.slice("--var=".length));
      if (decoded) vars[decoded[0]] = decoded[1];
    } else if (arg === "-t" || arg === "--target") {
      target = argv[++i];
    } else if (arg?.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if (arg === "-p" || arg === "--profile") {
      profile = argv[++i];
    }
  }
  return { vars, ...(target === undefined ? {} : { target }), ...(profile ? { profile } : {}) };
}

/** `databricks catalogs get <name>`: exit 0 means the deployer can see it. */
function lookupCatalog(name: string, profile: string | undefined): CatalogLookupResult {
  const run = spawnSync(
    "databricks",
    ["catalogs", "get", name, "-o", "json", ...(profile ? ["-p", profile] : [])],
    { encoding: "utf8" },
  );
  if (run.status === 0) return { exists: true };
  // The CLI prints unrelated notices on stderr too; keep its "Error:" line.
  const lines = `${run.stderr ?? ""}${run.error ? String(run.error) : ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const detail = lines.find((line) => line.startsWith("Error:")) ?? lines.at(-1) ?? "no output";
  return { exists: false, detail };
}

const { vars, target, profile } = parseArgs(process.argv.slice(2));
const problems = resolvePreflight(vars, target === undefined ? {} : { target });
// Ask the workspace only once the inputs are well-formed.
if (!hasErrors(problems)) {
  problems.push(...missingCatalogProblems(vars, (name) => lookupCatalog(name, profile)));
}

if (problems.length === 0) {
  console.log("deploy-preflight: all required inputs present and valid; the catalog exists.");
  process.exit(0);
}

const warnings = problems.filter((p) => p.severity === "warning");
const errors = problems.filter((p) => p.severity === "error");

if (warnings.length) {
  console.error("deploy-preflight warnings:");
  console.error(formatProblems(warnings));
}
if (errors.length) {
  console.error("deploy-preflight errors — fix these before deploying:");
  console.error(formatProblems(errors));
}

process.exit(hasErrors(problems) ? 1 : 0);
