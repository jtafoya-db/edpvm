// @vitest-environment node
/**
 * scripts/deploy-turnkey.sh is the one operator entry point (#138). It runs the
 * preflight (inputs, and the catalog exists), the resolved-config gate and the
 * destructive-plan gate, then hands the build, staging and `bundle deploy
 * --auto-approve` to scripts/deploy.sh, then provisions the store, creates the
 * EIR schema/volume and applies the narrow grants.
 *
 * These run the real wrapper, deploy.sh, preflight and bundle-config scripts
 * against fake `databricks` and `npm` binaries that log every call.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FILE_PATH = "/Workspace/Users/me/.bundle/edp-vending-machine/edp-vm-pr1/files";

/** A `bundle validate -o json` shape with what deploy.sh and bundle-config read. */
function resolved(target: "preview" | "prod") {
  const prod = target === "prod";
  const catalog = prod ? "edp_prod" : "example_catalog";
  const env = [
    { name: "NODE_ENV", value: "production" },
    { name: "EIR_VOLUME_CATALOG", value: catalog },
    { name: "EIR_VOLUME_SCHEMA", value: prod ? "documents" : "edp_vm_preview" },
    { name: "EIR_VOLUME_NAME", value: prod ? "eir" : "eir_pr1" },
    { name: "EDP_ADMIN_GROUP_ID", value: prod ? "2" : "11111111111111" },
    { name: "VITE_DATA_BACKEND", value: prod ? "delta" : "memory" },
    { name: "EDP_STORE_CATALOG", value: catalog },
    { name: "EDP_MEMBERSHIP_CATALOG", value: catalog },
    { name: "EDP_MEMBERSHIP_SCHEMA", value: "membership" },
    { name: "DATABRICKS_WAREHOUSE_ID", value_from: "sql-warehouse" },
    ...(prod ? [] : [{ name: "EDP_STORE_SCHEMA_PREFIX", value: "edp_vm_pr1_" }]),
  ];
  const task = (file: string) => ({
    sql_task: { file: { path: `${FILE_PATH}/resources/${file}` } },
  });
  return {
    bundle: { target, mode: prod ? "production" : "development" },
    workspace: { file_path: FILE_PATH },
    variables: { data_backend: { value: prod ? "delta" : "memory" } },
    resources: {
      apps: {
        edp_vending_machine: {
          name: prod ? "edp-vending-machine" : "edp-vm-pr1",
          config: { env },
          resources: [{ name: "sql-warehouse", sql_warehouse: { id: "1111111111111111" } }],
        },
      },
      jobs: {
        provision_store: {
          tasks: ["store-schema.sql", "store-admin.sql", "store-eir.sql", "store-audit.sql"].map(
            task,
          ),
        },
      },
    },
  };
}

const PREVIEW_ARGS = [
  "-t",
  "preview",
  "-p",
  "ws",
  "--var",
  "app_name=edp-vm-pr1",
  "--var",
  "catalog=example_catalog",
  "--var",
  "sql_warehouse_id=1111111111111111",
  "--var",
  "store_schema_prefix=edp_vm_pr1_",
  "--var",
  "eir_volume_name=eir_pr1",
  "--var",
  "edp_admin_group_id=11111111111111",
  "--var",
  "seed_dataset_owner_ids=123",
];

const PROD_VARS = [
  "--var",
  "catalog=edp_prod",
  "--var",
  "sql_warehouse_id=1111111111111111",
  "--var",
  "prod_root_path=/Workspace/edp-deploy/prod",
  "--var",
  "edp_admin_group_id=2",
  "--var",
  "membership_job_sp=6f1c2b9e-4d3a-4e8f-9b7c-2a1d0e5f8c34",
  "--var",
  '"membership_allowlist_json=[{""group_id"":""g1"",""group_name"":""admins"",""kind"":""domain"",""domain"":""operations"",""managed_by"":""manual"",""account_group"":true}]"',
];

interface TurnkeyOptions {
  args?: string[];
  target?: "preview" | "prod";
  /** Catalogs the fake workspace has. */
  catalogs?: string[];
  plan?: unknown;
  membershipGrantFails?: boolean;
  membershipProvisionFails?: boolean;
}

function turnkey(opts: TurnkeyOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "edp-turnkey-"));
  for (const path of ["scripts", "src/deploy", "resources", "databricks-app"]) {
    cpSync(join(ROOT, path), join(dir, path), { recursive: true });
  }
  const tools = mkdtempSync(join(tmpdir(), "edp-turnkey-tools-"));
  const bin = join(tools, "bin");
  mkdirSync(bin);
  const log = join(tools, "calls.log");
  writeFileSync(join(tools, "validate.json"), JSON.stringify(resolved(opts.target ?? "preview")));
  writeFileSync(join(tools, "plan.json"), JSON.stringify(opts.plan ?? { plan: {} }));
  const catalogs = (opts.catalogs ?? ["example_catalog", "edp_prod"]).join(" ");
  const membershipGrantFailure = opts.membershipGrantFails
    ? `if [[ "$*" == *"GRANT SELECT ON TABLE"*"membership"* ]]; then echo '{"statement_id":"s1","status":{"state":"FAILED","error":{"message":"membership table missing"}}}'; exit 0; fi;`
    : "";
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -e\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "databricks",
    `echo "databricks $*" >> "${log}"
case "$1 $2" in
  "catalogs get")
    for c in ${catalogs}; do [ "$c" = "$3" ] && { echo '{}'; exit 0; }; done
    echo "Error: Catalog '$3' does not exist." >&2; exit 1 ;;
  "bundle validate") cat "${tools}/validate.json" ;;
  "bundle plan") cat "${tools}/plan.json" ;;
  "bundle run")
    if [[ "${opts.membershipProvisionFails ? "$3" : ""}" = "provision_membership_snapshot" ]]; then
      echo "membership snapshot provisioning failed" >&2; exit 1
    fi ;;
  "api get")
    if [[ "$3" == "/api/2.0/preview/scim/v2/Groups/11111111111111" ]]; then echo '{"displayName":"edp-admins"}'; fi ;;
  "api post") ${membershipGrantFailure} echo '{"statement_id":"s1","status":{"state":"SUCCEEDED"}}' ;;
  "apps get") echo '{"service_principal_client_id":"sp-1","url":"https://edp-vm-pr1.example"}' ;;
esac`,
  );
  fake(
    "npm",
    `echo "npm $* VITE_DATA_BACKEND=$VITE_DATA_BACKEND" >> "${log}"
mkdir -p .output/server .output/public
echo 'export {}' > .output/server/index.mjs
echo ok > .output/public/robots.txt`,
  );
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(DATABRICKS_BUNDLE_|BUNDLE_VAR_|EDP_DEPLOY_)/.test(name)) delete env[name];
  }
  const run = spawnSync(
    "bash",
    [join(dir, "scripts/deploy-turnkey.sh"), ...(opts.args ?? PREVIEW_ARGS)],
    {
      cwd: dir,
      env: { ...env, PATH: `${bin}:${process.env["PATH"]}` },
      encoding: "utf8",
    },
  );
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { run, calls };
}

const SPAWNS = { timeout: 60_000 };
const indexOf = (calls: string[], prefix: string) => calls.findIndex((c) => c.startsWith(prefix));
const sql = (calls: string[]) =>
  calls
    .filter((c) => c.startsWith("databricks api post /api/2.0/sql/statements"))
    .map((c) => JSON.parse(c.slice(c.indexOf("{"))).statement as string);

describe("scripts/deploy-turnkey.sh — one deploy path", SPAWNS, () => {
  it("gates, deploys through scripts/deploy.sh, then provisions, creates the EIR volume and grants", () => {
    const { run, calls } = turnkey();
    expect(run.status, run.stderr).toBe(0);
    const order = [
      "databricks catalogs get example_catalog",
      "databricks bundle validate",
      "databricks bundle plan",
      "npm run build:databricks",
      "databricks bundle deploy",
      "databricks bundle run edp_vending_machine",
      "databricks bundle run provision_store",
      "databricks bundle run provision_membership_snapshot",
      "databricks api post",
      "databricks apps get",
    ].map((prefix) => indexOf(calls, prefix));
    expect(
      order.every((i) => i >= 0),
      calls.join("\n"),
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // deploy.sh's --auto-approve is the only deploy, and it follows the plan gate.
    expect(calls.filter((c) => c.startsWith("databricks bundle deploy"))).toEqual([
      `databricks bundle deploy ${PREVIEW_ARGS.join(" ")} --auto-approve`,
    ]);
    expect(run.stdout).toContain("https://edp-vm-pr1.example");
  });

  it("provisions membership before grants and preserves EIR grants if a membership grant fails", () => {
    const { run, calls } = turnkey({ membershipGrantFails: true });
    expect(run.status).not.toBe(0);
    const provision = indexOf(calls, "databricks bundle run provision_membership_snapshot");
    const membershipGrant = calls.findIndex(
      (call) => call.includes("GRANT SELECT ON TABLE") && call.includes("membership"),
    );
    expect(provision, `${run.stderr}\n${calls.join("\n")}`).toBeGreaterThan(-1);
    expect(membershipGrant).toBeGreaterThan(provision);
    const statements = sql(calls);
    const eirGrant = statements.findIndex((statement) =>
      statement.includes("GRANT READ VOLUME, WRITE VOLUME"),
    );
    const failedMembershipGrant = statements.findIndex(
      (statement) =>
        statement.includes("GRANT SELECT ON TABLE") && statement.includes("membership"),
    );
    expect(eirGrant).toBeGreaterThan(-1);
    expect(failedMembershipGrant).toBeGreaterThan(eirGrant);
    expect(run.stderr).toContain("membership table missing");
  });

  it("stops with the provisioning error before applying grants when membership provisioning fails", () => {
    const { run, calls } = turnkey({ membershipProvisionFails: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("membership snapshot provisioning failed");
    expect(indexOf(calls, "databricks bundle run provision_membership_snapshot")).toBeGreaterThan(
      -1,
    );
    expect(calls.some((call) => call.startsWith("databricks api post"))).toBe(false);
    expect(calls.some((call) => call.startsWith("databricks apps get"))).toBe(false);
  });

  it("creates the EIR schema/volume and grants only the app service principal, on the DDL's schemas", () => {
    const { run, calls } = turnkey();
    expect(run.status, run.stderr).toBe(0);
    const statements = sql(calls);
    expect(statements.slice(0, 2)).toEqual([
      "CREATE SCHEMA IF NOT EXISTS `example_catalog`.`edp_vm_preview`",
      "CREATE VOLUME IF NOT EXISTS `example_catalog`.`edp_vm_preview`.`eir_pr1`",
    ]);
    const grants = statements.filter((s) => s.startsWith("GRANT"));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.endsWith("TO `sp-1`"))).toBe(true);
    expect(grants).toContain(
      "GRANT USE SCHEMA, SELECT, MODIFY ON SCHEMA `example_catalog`.`edp_vm_pr1_eir` TO `sp-1`",
    );
    expect(grants).toContain(
      "GRANT SELECT ON TABLE `example_catalog`.`membership`.`group_members` TO `sp-1`",
    );
    expect(grants).toContain(
      "GRANT SELECT ON TABLE `example_catalog`.`membership`.`snapshot_runs` TO `sp-1`",
    );
    expect(grants.some((grant) => grant.includes("membership") && grant.includes("MODIFY"))).toBe(
      false,
    );
    // The validator volume read is opt-in.
    expect(statements.some((s) => s.includes("READ VOLUME") && !s.includes("sp-1"))).toBe(false);
  });

  it("grants the opt-in validator volume read to the EDP admin group, never SELECT on EIR tables (#226)", () => {
    const { run, calls } = turnkey({ args: [...PREVIEW_ARGS, "--grant-validator-volume-read"] });
    expect(run.status, run.stderr).toBe(0);
    const toAdmins = sql(calls).filter((s) => s.endsWith("TO `edp-admins`"));
    expect(toAdmins).toEqual([
      "GRANT USE CATALOG ON CATALOG `example_catalog` TO `edp-admins`",
      "GRANT USE SCHEMA ON SCHEMA `example_catalog`.`edp_vm_preview` TO `edp-admins`",
      "GRANT READ VOLUME ON VOLUME `example_catalog`.`edp_vm_preview`.`eir_pr1` TO `edp-admins`",
    ]);
  });

  it("refuses a catalog the workspace doesn't have, before any bundle call", () => {
    const { run, calls } = turnkey({ catalogs: ["main"] });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/catalog "example_catalog" does not exist/);
    expect(calls).toEqual(["databricks catalogs get example_catalog -o json -p ws"]);
  });

  it("builds and deploys nothing when the plan would drop a schema or volume", () => {
    const { run, calls } = turnkey({
      plan: { plan: { "resources.volumes.eir_volume": { action: "delete" } } },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/plan gate failed/);
    expect(indexOf(calls, "npm")).toBe(-1);
    expect(indexOf(calls, "databricks bundle deploy")).toBe(-1);
  });

  it("refuses prod without --production, before touching the workspace", () => {
    const { run, calls } = turnkey({
      target: "prod",
      args: ["-t", "prod", "-p", "ws", ...PROD_VARS],
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/--production/);
    expect(calls).toEqual([]);
  });

  it("passes --production on to scripts/deploy.sh for prod", () => {
    const args = ["-t", "prod", "--production", "-p", "ws", ...PROD_VARS];
    const { run, calls } = turnkey({ target: "prod", args });
    expect(run.status, run.stderr).toBe(0);
    expect(calls).toContain("npm run build:databricks VITE_DATA_BACKEND=delta");
    // --production is the acknowledgement; deploy.sh doesn't pass it to the CLI.
    expect(calls.filter((c) => c.startsWith("databricks bundle deploy"))).toEqual([
      `databricks bundle deploy -t prod -p ws ${PROD_VARS.join(" ")} --auto-approve`,
    ]);
  });
});
