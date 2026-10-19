// @vitest-environment node
/**
 * The bundle's provisioning job (`databricks.yml`, `provision_store`).
 *
 * YAML lets a mapping repeat a key, and most readers silently keep the last
 * one: a second `depends_on` under a task replaces the first, so
 * `create_audit_view` could run before an area's tables exist. These checks
 * read the bundle with duplicate keys refused, then pin the ordering every
 * area relies on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

interface SqlTask {
  task_key: string;
  depends_on?: { task_key: string }[];
  sql_task?: { file?: { path?: string } };
}

function provisionTasks(): SqlTask[] {
  // js-yaml refuses a duplicated mapping key instead of keeping the last one.
  const bundle = load(readFileSync(join(ROOT, "databricks.yml"), "utf8")) as {
    resources: { jobs: { provision_store: { tasks: SqlTask[] } } };
  };
  return bundle.resources.jobs.provision_store.tasks;
}

const dependsOn = (task: SqlTask | undefined) =>
  (task?.depends_on ?? []).map((dependency) => dependency.task_key).sort();

describe("provision_store job", () => {
  it("reads with duplicate keys refused", () => {
    expect(() => provisionTasks()).not.toThrow();
    // The parse is strict: a repeated key under one task is an error.
    expect(() => load("task:\n  depends_on: [a]\n  depends_on: [b]\n")).toThrow(
      /duplicated mapping key/,
    );
  });

  it("has one task per store DDL file", () => {
    const files = readdirSync(join(ROOT, "resources"))
      .filter((name) => /^store-.*\.sql$/.test(name))
      .map((name) => `resources/${name}`)
      .sort();
    const tasks = provisionTasks()
      .map((task) => task.sql_task?.file?.path)
      .sort();
    expect(tasks).toEqual(files);
  });

  it("builds the combined audit view after only the areas with SQL audit branches", () => {
    const tasks = provisionTasks();
    const audit = tasks.find((task) => task.sql_task?.file?.path === "resources/store-audit.sql");
    expect(audit?.task_key).toBe("create_audit_view");
    expect(dependsOn(audit)).toEqual([
      "create_admin_tables",
      // audit.eir_definitions_branch (#201).
      "create_eir_definitions_tables",
      "create_eir_tables",
      "create_onboarding_tables",
      "create_store_tables",
      "create_teams_tables",
    ]);
  });

  it("creates the EIR tables after the admin tables, which hold the Record ID counter", () => {
    const eir = provisionTasks().find((task) => task.task_key === "create_eir_tables");
    expect(dependsOn(eir)).toEqual(["create_admin_tables"]);
  });
});

describe("eir_allow_self_validation (preview test mode, 2026-10-07)", () => {
  interface Bundle {
    variables: Record<string, { default?: string }>;
    resources: {
      apps: { edp_vending_machine: { config: { env: { name: string; value: string }[] } } };
    };
    targets: Record<string, { variables?: Record<string, string> }>;
  }
  const bundle = () => load(readFileSync(join(ROOT, "databricks.yml"), "utf8")) as Bundle;

  it('defaults to "false" and reaches the app as EDP_EIR_ALLOW_SELF_VALIDATION', () => {
    const b = bundle();
    expect(b.variables["eir_allow_self_validation"]?.default).toBe("false");
    expect(b.resources.apps.edp_vending_machine.config.env).toContainEqual({
      name: "EDP_EIR_ALLOW_SELF_VALIDATION",
      value: "${var.eir_allow_self_validation}",
    });
  });

  it("is turned on by the preview target only; no other target sets it true", () => {
    const targets = bundle().targets;
    expect(targets["preview"]?.variables?.["eir_allow_self_validation"]).toBe("true");
    const others = Object.entries(targets).filter(([name]) => name !== "preview");
    expect(others.map(([name]) => name).sort()).toEqual(["dev", "govdev", "prod"]);
    for (const [name, target] of others) {
      const value = target.variables?.["eir_allow_self_validation"];
      expect(value === undefined || String(value).trim() !== "true", name).toBe(true);
    }
  });

  it("isn't set in app.yaml, which production runs from", () => {
    expect(readFileSync(join(ROOT, "databricks-app/app.yaml"), "utf8")).not.toMatch(
      /EDP_EIR_ALLOW_SELF_VALIDATION/,
    );
  });
});

describe("EIR support contact deployment setting", () => {
  it("passes the optional bundle setting to the server without inventing an address", () => {
    const bundle = load(readFileSync(join(ROOT, "databricks.yml"), "utf8")) as {
      variables: Record<string, { default?: string }>;
      resources: {
        apps: { edp_vending_machine: { config: { env: { name: string; value: string }[] } } };
      };
    };

    expect(bundle.variables["eir_support_email"]?.default).toBe("none");
    expect(bundle.resources.apps.edp_vending_machine.config.env).toContainEqual({
      name: "EDP_EIR_SUPPORT_EMAIL",
      value: "${var.eir_support_email}",
    });
  });
});
