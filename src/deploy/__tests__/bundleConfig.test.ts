import { readFileSync } from "node:fs";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  BundleConfigError,
  checkResolvedConfig,
  destructiveUcActions,
  provisionDdlFiles,
  provisionedSchemas,
  readAppDeployFields,
  schemasFromDdl,
} from "../bundleConfig.ts";

// Guards the field-parsing fix (#138): the turnkey wrapper reads resolved deploy
// fields out of `bundle validate -o json`. An EMPTY field — store_schema_prefix
// is empty in prod/dev — must map to "" and must NOT shift the other fields
// (the earlier tab-delimited readback collapsed the empty field and misassigned
// catalog/schema/volume/group/warehouse). Each field is read by name here.

/** A bundle-validate shape with the given env map + warehouse id. */
function config(
  env: Record<string, string | undefined>,
  warehouseId = "1111111111111111",
  target?: string,
  appName = "edp-vending-machine",
) {
  return {
    bundle: { target },
    resources: {
      apps: {
        edp_vending_machine: {
          name: appName,
          config: {
            env: Object.entries(env).map(([name, value]) =>
              value === undefined ? { name } : { name, value },
            ),
          },
          resources: [{ name: "sql-warehouse", sql_warehouse: { id: warehouseId } }],
        },
      },
    },
  };
}

const PROD_ENV = {
  EDP_STORE_CATALOG: "edp_prod",
  // No EDP_STORE_SCHEMA_PREFIX in prod — the empty-prefix case.
  EIR_VOLUME_CATALOG: "edp_prod",
  EIR_VOLUME_SCHEMA: "documents",
  EIR_VOLUME_NAME: "eir",
  EDP_ADMIN_GROUP_ID: "11111111111111",
  EDP_MEMBERSHIP_CATALOG: "edp_prod",
  EDP_MEMBERSHIP_SCHEMA: "membership",
};

describe("readAppDeployFields — empty fields never shift", () => {
  it("maps every field correctly when the schema prefix is absent (prod)", () => {
    const fields = readAppDeployFields(config(PROD_ENV));
    expect(fields).toEqual({
      appName: "edp-vending-machine",
      storeCatalog: "edp_prod",
      storeSchemaPrefix: "",
      eirCatalog: "edp_prod",
      eirSchema: "documents",
      eirVolume: "eir",
      adminGroupId: "11111111111111",
      warehouseId: "1111111111111111",
      membershipCatalog: "edp_prod",
      membershipSchema: "membership",
    });
  });

  it("maps every field correctly when the schema prefix is an explicit empty value", () => {
    const fields = readAppDeployFields(config({ ...PROD_ENV, EDP_STORE_SCHEMA_PREFIX: "" }));
    // The empty prefix must not pull the warehouse/admin group/volume forward.
    expect(fields.storeSchemaPrefix).toBe("");
    expect(fields.warehouseId).toBe("1111111111111111");
    expect(fields.adminGroupId).toBe("11111111111111");
    expect(fields.eirVolume).toBe("eir");
  });

  it("reads a non-empty preview prefix", () => {
    const fields = readAppDeployFields(
      config({
        ...PROD_ENV,
        EDP_STORE_CATALOG: "example_catalog",
        EIR_VOLUME_CATALOG: "example_catalog",
        EDP_STORE_SCHEMA_PREFIX: "edp_vm_pr138_",
      }),
    );
    expect(fields.storeSchemaPrefix).toBe("edp_vm_pr138_");
    expect(fields.storeCatalog).toBe("example_catalog");
  });
});

describe("checkResolvedConfig", () => {
  it("passes a clean resolved config", () => {
    expect(checkResolvedConfig(config(PROD_ENV))).toEqual([]);
  });

  it("flags a value-less env entry by name", () => {
    const problems = checkResolvedConfig(
      config({ ...PROD_ENV, EDP_STORE_SCHEMA_PREFIX: undefined }),
    );
    // undefined => entry with no `value` key => value-less.
    expect(problems.some((p) => /value-less/.test(p) && /EDP_STORE_SCHEMA_PREFIX/.test(p))).toBe(
      true,
    );
  });

  it("flags a store/EIR catalog divergence", () => {
    const problems = checkResolvedConfig(config({ ...PROD_ENV, EIR_VOLUME_CATALOG: "other_cat" }));
    expect(problems.some((p) => /EDP_STORE_CATALOG/.test(p) && /EIR_VOLUME_CATALOG/.test(p))).toBe(
      true,
    );
  });

  it("flags a <MISSING> token in the rendered config", () => {
    const bad = config(PROD_ENV);
    bad.resources.apps.edp_vending_machine.resources[0]!.sql_warehouse!.id = "<MISSING>";
    expect(checkResolvedConfig(bad).some((p) => /<MISSING>/.test(p))).toBe(true);
  });

  it("passes a Delta-backed govdev config whose resource names do not repeat the target", () => {
    expect(
      checkResolvedConfig(
        config(
          {
            ...PROD_ENV,
            VITE_DATA_BACKEND: "delta",
            EDP_STORE_SCHEMA_PREFIX: "edp_vm_test_",
            EIR_VOLUME_NAME: "eir_pdfs",
          },
          undefined,
          "govdev",
          "edp-vm-test",
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ["VITE_DATA_BACKEND", "memory"],
    ["EDP_STORE_SCHEMA_PREFIX", ""],
    ["EIR_VOLUME_NAME", ""],
    ["EDP_ADMIN_GROUP_ID", "configure-edp-admin-group-id"],
  ])("rejects unsafe govdev %s=%s", (name, value) => {
    const problems = checkResolvedConfig(
      config(
        {
          ...PROD_ENV,
          VITE_DATA_BACKEND: "delta",
          EDP_STORE_SCHEMA_PREFIX: "edp_vm_govdev_",
          EIR_VOLUME_NAME: "eir_govdev",
          [name]: value,
        },
        undefined,
        "govdev",
        "edp-vm-govdev",
      ),
    );
    expect(problems.some((problem) => problem.includes("govdev"))).toBe(true);
  });
});

// Guards #141 item 3: a deploy must never drop or recreate a Unity Catalog
// schema or volume (the prod EIR volume holds signed PDFs). lifecycle
// .prevent_destroy covers destroy/recreate of a declared resource, but NOT a
// resource whose block was removed from the config — the plan then says
// "delete". The wrapper gates `bundle plan -o json` on this before deploying.
describe("destructiveUcActions — the bundle plan gate", () => {
  const plan = (actions: Record<string, string>) => ({
    plan_version: 2,
    plan: Object.fromEntries(Object.entries(actions).map(([k, action]) => [k, { action }])),
  });

  it("passes a plan that only creates, updates or skips UC objects", () => {
    expect(
      destructiveUcActions(
        plan({
          "resources.schemas.eir_schema": "skip",
          "resources.volumes.eir_volume": "update",
          "resources.apps.edp_vending_machine": "create",
        }),
      ),
    ).toEqual([]);
  });

  it("flags a deleted volume (its block removed from the config)", () => {
    expect(destructiveUcActions(plan({ "resources.volumes.eir_volume": "delete" }))).toEqual([
      "delete resources.volumes.eir_volume",
    ]);
  });

  it("flags a recreated schema (e.g. a changed catalog)", () => {
    expect(destructiveUcActions(plan({ "resources.schemas.eir_schema": "recreate" }))).toEqual([
      "recreate resources.schemas.eir_schema",
    ]);
  });

  it("ignores deleting non-data resources such as a job", () => {
    expect(destructiveUcActions(plan({ "resources.jobs.provision_store": "delete" }))).toEqual([]);
  });

  it("rejects input that isn't a bundle plan", () => {
    expect(() => destructiveUcActions({ resources: {} })).toThrow(BundleConfigError);
  });
});

// #144 readiness: the wrapper grants the app SP on the store schemas the
// provision_store DDL creates, derived rather than hard-coded, so a new area's
// resources/store-<area>.sql (e.g. #130/#131) is covered when its task merges.
describe("provisionedSchemas — grant list derived from the DDL", () => {
  const ROOT = "/Workspace/edp-deploy/edp-vending-machine/prod/files";
  const withTasks = (paths: string[]) => ({
    workspace: { file_path: ROOT },
    resources: {
      jobs: {
        provision_store: {
          tasks: paths.map((path, i) => ({ task_key: `t${i}`, sql_task: { file: { path } } })),
        },
      },
    },
  });
  const CURRENT_DDL = [
    "resources/store-schema.sql",
    "resources/store-admin.sql",
    "resources/store-eir.sql",
    "resources/store-onboarding.sql",
    "resources/store-audit.sql",
  ];

  it("reads every schema the CREATE SCHEMA form names, ignoring comments", () => {
    const sql = [
      "-- CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'old');",
      "CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams');",
      "create schema if not exists identifier( :catalog_name || '.' || :schema_prefix || 'audit' );",
      "CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || 'teams.t') (id STRING);",
    ].join("\n");
    expect(schemasFromDdl(sql)).toEqual(["teams", "audit"]);
  });

  it("maps the job's workspace task paths back to repo-relative DDL files", () => {
    expect(provisionDdlFiles(withTasks(CURRENT_DDL.map((f) => `${ROOT}/${f}`)))).toEqual(
      CURRENT_DDL,
    );
  });

  it("derives today's schemas from the real provisioned DDL", () => {
    const config = withTasks(CURRENT_DDL.map((f) => `${ROOT}/${f}`));
    expect(provisionedSchemas(config, (f) => readFileSync(f, "utf8")).sort()).toEqual(
      ["access", "admin", "audit", "catalog", "eir", "monitoring", "onboarding", "requests"].sort(),
    );
  });

  it("grants on every schema the bundle's provision_store tasks create, teams and onboarding included", () => {
    const bundle = load(readFileSync("databricks.yml", "utf8")) as {
      resources: {
        jobs: { provision_store: { tasks: { sql_task: { file: { path: string } } }[] } };
      };
    };
    const paths = bundle.resources.jobs.provision_store.tasks.map((t) => t.sql_task.file.path);
    const config = withTasks(paths.map((f) => `${ROOT}/${f}`));
    expect(provisionedSchemas(config, (f) => readFileSync(f, "utf8")).sort()).toEqual(
      [
        "access",
        "admin",
        "audit",
        "catalog",
        "change_list",
        "eir",
        "initiatives",
        "monitoring",
        "onboarding",
        "privacy",
        "requests",
        "teams",
      ].sort(),
    );
  });

  it("covers a new area's schemas as soon as its DDL task is added", () => {
    const area = "resources/store-teams.sql";
    const config = withTasks([...CURRENT_DDL, area].map((f) => `${ROOT}/${f}`));
    const read = (f: string) =>
      f === area
        ? ["teams", "initiatives", "change_list", "onboarding"]
            .map(
              (n) =>
                `CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || '${n}');`,
            )
            .join("\n")
        : readFileSync(f, "utf8");
    expect(provisionedSchemas(config, read)).toEqual(
      expect.arrayContaining(["eir", "teams", "initiatives", "change_list", "onboarding"]),
    );
  });

  it("fails loud when the job or its schemas are missing", () => {
    expect(() => provisionDdlFiles({ workspace: { file_path: ROOT } })).toThrow(BundleConfigError);
    expect(() => provisionedSchemas(withTasks([`${ROOT}/x.sql`]), () => "SELECT 1;")).toThrow(
      BundleConfigError,
    );
  });
});

describe("checkResolvedConfig — prod gates", () => {
  const prodConfig = (env: Record<string, string>) => ({
    ...config(env),
    bundle: { target: "prod" },
  });
  const OK = {
    ...PROD_ENV,
    VITE_DATA_BACKEND: "delta",
    EDP_ADMIN_GROUP_ID: "1",
  };

  it("passes a prod config on Delta with real group ids", () => {
    expect(checkResolvedConfig(prodConfig(OK))).toEqual([]);
  });

  it("refuses prod on the in-memory backend", () => {
    expect(checkResolvedConfig(prodConfig({ ...OK, VITE_DATA_BACKEND: "memory" })).join()).toMatch(
      /delta/,
    );
  });

  it("refuses a prod placeholder group id from any source", () => {
    expect(
      checkResolvedConfig(
        prodConfig({ ...OK, EDP_ADMIN_GROUP_ID: "configure-edp-admin-group-id" }),
      ).join(),
    ).toMatch(/EDP_ADMIN_GROUP_ID=configure-edp-admin-group-id/);
  });

  it("doesn't apply the prod gates to other targets", () => {
    expect(checkResolvedConfig(config({ ...OK, VITE_DATA_BACKEND: "memory" }))).toEqual([]);
  });
});
