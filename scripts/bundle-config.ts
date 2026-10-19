#!/usr/bin/env node
// Read `databricks bundle validate -o json` (on stdin) for the turnkey wrapper
// (#138), using the pure, unit-tested seam in src/deploy/bundleConfig.ts. Node
// strips the types, so this runs with no build step.
//
//   ... | node scripts/bundle-config.ts --check            # gate: exit 1 on any problem
//   ... | node scripts/bundle-config.ts --field storeCatalog   # print one field, empty-safe
//   bundle plan -o json | node scripts/bundle-config.ts --check-plan  # exit 1 if a schema/volume would be dropped
//   ... | node scripts/bundle-config.ts --schemas   # store schemas the provision_store DDL creates
//
// Reading one field at a time (never positional splitting) means an empty value
// (e.g. storeSchemaPrefix in prod/dev) can never shift another field's value.
import { readFileSync } from "node:fs";

import {
  checkResolvedConfig,
  destructiveUcActions,
  provisionedSchemas,
  readAppDeployFields,
  type AppDeployField,
} from "../src/deploy/bundleConfig.ts";

const mode = process.argv[2];
let config: unknown;
try {
  config = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
  console.error(`bundle-config: could not parse bundle JSON from stdin: ${String(error)}`);
  process.exit(2);
}

if (mode === "--check") {
  const problems = checkResolvedConfig(config);
  if (problems.length) {
    console.error("resolved-config gate failed:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "--check-plan") {
  const destructive = destructiveUcActions(config);
  if (destructive.length) {
    console.error(
      "plan gate failed: this deploy would drop Unity Catalog data objects (signed EIR records/PDFs must never be deleted by a deploy):\n  - " +
        destructive.join("\n  - "),
    );
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "--schemas") {
  // DDL paths are repo-relative; the wrapper runs from the repo root.
  process.stdout.write(provisionedSchemas(config, (path) => readFileSync(path, "utf8")).join(" "));
  process.exit(0);
}

if (mode === "--field") {
  const key = process.argv[3] as AppDeployField | undefined;
  const fields = readAppDeployFields(config);
  if (key === undefined || !(key in fields)) {
    console.error(`bundle-config: unknown field "${key}"`);
    process.exit(2);
  }
  // No trailing newline: the wrapper captures this verbatim with $(...).
  process.stdout.write(fields[key]);
  process.exit(0);
}

console.error(
  "usage: bundle-config.ts (--check | --check-plan | --schemas | --field <name>) < bundle-validate-or-plan.json",
);
process.exit(2);
