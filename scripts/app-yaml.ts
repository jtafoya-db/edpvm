#!/usr/bin/env node
// Generate and check the staged databricks-app/app.yaml for scripts/deploy.sh,
// using the unit-tested seam in src/deploy/appYaml.ts. Node strips the types.
//
//   bundle validate -o json | node scripts/app-yaml.ts --render <out app.yaml>
//   node scripts/app-yaml.ts --check <app.yaml> <build-info.json>   # exit 1 on any problem
import { readFileSync, writeFileSync } from "node:fs";

import {
  AppYamlError,
  appYamlFromBundle,
  checkStagedAppYaml,
  renderAppYaml,
} from "../src/deploy/appYaml.ts";

const [mode, first, second] = process.argv.slice(2);

if (mode === "--render" && first) {
  try {
    const config = appYamlFromBundle(JSON.parse(readFileSync(0, "utf8")));
    writeFileSync(first, renderAppYaml(config));
  } catch (error) {
    const reason = error instanceof AppYamlError ? error.message : String(error);
    console.error(`[deploy] cannot generate app.yaml from the resolved bundle config: ${reason}`);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "--check" && first && second) {
  let buildInfo: unknown = null;
  try {
    buildInfo = JSON.parse(readFileSync(second, "utf8"));
  } catch {
    // reported by checkStagedAppYaml as missing build-info
  }
  const problems = checkStagedAppYaml(readFileSync(first, "utf8"), buildInfo);
  if (problems.length) {
    console.error(
      "[deploy] the staged app.yaml would not start the app; nothing was uploaded:\n  - " +
        problems.join("\n  - "),
    );
    process.exit(1);
  }
  process.exit(0);
}

console.error(
  "usage: app-yaml.ts --render <out> < bundle-validate.json | --check <app.yaml> <build-info.json>",
);
process.exit(2);
