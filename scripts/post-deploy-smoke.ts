#!/usr/bin/env node
// The decision half of scripts/post-deploy-smoke.sh (seam:
// src/deploy/postDeploySmoke.ts). Node strips the types.
//
//   node scripts/post-deploy-smoke.ts --read <app-url|deployment-id|source-path|access-token> < json
//   node scripts/post-deploy-smoke.ts --evaluate <dir>   # dir holds app.json, deployment.json,
//                                                        # app.yaml, status, body; plus
//                                                        # APP_NAME / PROFILE in the env
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { evaluatePostDeploy } from "../src/deploy/postDeploySmoke.ts";

const [mode, arg] = process.argv.slice(2);

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

if (mode === "--read" && arg) {
  const json = parse(readFileSync(0, "utf8")) as
    | {
        url?: unknown;
        access_token?: unknown;
        default_source_code_path?: unknown;
        active_deployment?: { deployment_id?: unknown; source_code_path?: unknown };
      }
    | undefined;
  const value = {
    "app-url": json?.url,
    "deployment-id": json?.active_deployment?.deployment_id,
    "source-path": json?.active_deployment?.source_code_path ?? json?.default_source_code_path,
    "access-token": json?.access_token,
  }[arg];
  process.stdout.write(typeof value === "string" ? value : "");
  process.exit(0);
}

if (mode === "--evaluate" && arg) {
  const read = (name: string) =>
    existsSync(join(arg, name)) ? readFileSync(join(arg, name), "utf8") : undefined;
  const status = Number((read("status") ?? "0").trim()) || 0;
  const appName = process.env["APP_NAME"] ?? "";
  const { ok, failures } = evaluatePostDeploy({
    appName,
    profile: process.env["PROFILE"] ?? "",
    app: parse(read("app.json") ?? ""),
    deployment: parse(read("deployment.json") ?? ""),
    appYamlText: read("app.yaml"),
    probe: read("status") === undefined ? undefined : { status, body: read("body") ?? "" },
  });
  if (!ok) {
    console.error(`[smoke] post-deploy smoke FAILED for ${appName}:`);
    for (const failure of failures) {
      console.error(`  - ${failure.check}: ${failure.message}\n      next: ${failure.next}`);
    }
    process.exit(1);
  }
  console.log(
    `[smoke] ${appName}: deployment SUCCEEDED, runtime env present, /api/seed-config returned 200.`,
  );
  process.exit(0);
}

console.error("usage: post-deploy-smoke.ts --read <field> < json | --evaluate <dir>");
process.exit(2);
