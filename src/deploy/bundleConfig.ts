/**
 * Read the deploy-relevant fields out of `databricks bundle validate -o json`
 * (#138).
 *
 * The turnkey wrapper needs the RESOLVED app name, catalog, schema prefix, EIR
 * volume coordinates, EDP admin group id and warehouse id to issue its
 * idempotent `CREATE ... IF NOT EXISTS` / `GRANT` statements. Reading them
 * field-by-field (never positional splitting) is deliberate: an empty field —
 * `store_schema_prefix` is empty in prod/dev — must map to an empty value, not
 * shift the other fields. (A tab/whitespace-delimited `read` collapses an empty
 * field and silently misassigns every later value.)
 *
 * Pure and dependency-free so it's unit-tested by `npm test` and run directly by
 * `scripts/bundle-config.ts` (Node strips the types).
 */

export interface AppDeployFields {
  appName: string;
  storeCatalog: string;
  storeSchemaPrefix: string;
  eirCatalog: string;
  eirSchema: string;
  eirVolume: string;
  /** The EDP admin group, which holds the Safeguards validator role in the MVP (#226). */
  adminGroupId: string;
  warehouseId: string;
  membershipCatalog: string;
  membershipSchema: string;
}

export type AppDeployField = keyof AppDeployFields;

interface EnvEntry {
  name: string;
  value?: string;
  value_from?: string;
}

interface AppResource {
  name?: string;
  sql_warehouse?: { id?: string };
}

interface AppNode {
  name: string;
  env: EnvEntry[];
  resources: AppResource[];
}

export class BundleConfigError extends Error {}

/** Navigate to resources.apps.edp_vending_machine, throwing if it's absent. */
function appNode(config: unknown): AppNode {
  const app = (
    config as {
      resources?: { apps?: Record<string, unknown> };
    }
  )?.resources?.apps?.["edp_vending_machine"] as
    | {
        name?: unknown;
        config?: { env?: unknown };
        resources?: unknown;
      }
    | undefined;
  if (!app || typeof app.name !== "string") {
    throw new BundleConfigError(
      "bundle config has no resources.apps.edp_vending_machine; is this `bundle validate -o json` output?",
    );
  }
  const env = Array.isArray(app.config?.env) ? (app.config.env as EnvEntry[]) : [];
  const resources = Array.isArray(app.resources) ? (app.resources as AppResource[]) : [];
  return { name: app.name, env, resources };
}

/** Map of env name -> value (a value-less entry maps to ""). */
function envMap(app: AppNode): Map<string, string> {
  return new Map(app.env.map((e) => [e.name, e.value ?? ""]));
}

/** Extract every deploy field by name. Empty values stay empty — never shift. */
export function readAppDeployFields(config: unknown): AppDeployFields {
  const app = appNode(config);
  const env = envMap(app);
  const warehouse = app.resources.find((r) => r.name === "sql-warehouse")?.sql_warehouse?.id ?? "";
  return {
    appName: app.name,
    storeCatalog: env.get("EDP_STORE_CATALOG") ?? "",
    storeSchemaPrefix: env.get("EDP_STORE_SCHEMA_PREFIX") ?? "",
    eirCatalog: env.get("EIR_VOLUME_CATALOG") ?? "",
    eirSchema: env.get("EIR_VOLUME_SCHEMA") ?? "",
    eirVolume: env.get("EIR_VOLUME_NAME") ?? "",
    adminGroupId: env.get("EDP_ADMIN_GROUP_ID") ?? "",
    warehouseId: warehouse,
    membershipCatalog: env.get("EDP_MEMBERSHIP_CATALOG") ?? "",
    membershipSchema: env.get("EDP_MEMBERSHIP_SCHEMA") ?? "",
  };
}

/**
 * Gate the resolved config before any mutation: no app env entry may be
 * value-less (the Apps API rejects it), the store and EIR catalogs must match
 * (divergence from any override source), and no `<MISSING>` token may remain.
 * Returns a list of problems; empty means the config is safe to deploy.
 */
export function checkResolvedConfig(config: unknown): string[] {
  const app = appNode(config);
  const problems: string[] = [];
  const valueless = app.env
    .filter((e) => e.value === undefined && e.value_from === undefined)
    .map((e) => e.name);
  if (valueless.length) {
    problems.push(`value-less env entries (the Apps API will reject): ${valueless.join(", ")}`);
  }
  const fields = readAppDeployFields(config);
  if (fields.storeCatalog !== fields.eirCatalog) {
    problems.push(
      `EDP_STORE_CATALOG ("${fields.storeCatalog}") != EIR_VOLUME_CATALOG ("${fields.eirCatalog}")`,
    );
  }
  if (JSON.stringify(config).includes("<MISSING>")) {
    problems.push("rendered config contains a <MISSING> token");
  }
  // prod: the Delta store, and real group ids rather than committed placeholders
  // (whichever source set them — --var, BUNDLE_VAR_*, a profile or a default).
  const target = (config as { bundle?: { target?: unknown } })?.bundle?.target;
  if (target === "prod") {
    const backend = envMap(app).get("VITE_DATA_BACKEND");
    if (backend !== "delta") {
      problems.push(`prod must run VITE_DATA_BACKEND=delta, not "${backend ?? ""}"`);
    }
    const placeholders = app.env
      .filter((e) => e.value?.startsWith("configure-"))
      .map((e) => `${e.name}=${e.value}`);
    if (placeholders.length) {
      problems.push(`prod env still has placeholder values: ${placeholders.join(", ")}`);
    }
  }
  if (target === "govdev") {
    const env = envMap(app);
    if (env.get("VITE_DATA_BACKEND") !== "delta") {
      problems.push(
        `govdev must run VITE_DATA_BACKEND=delta, not "${env.get("VITE_DATA_BACKEND") ?? ""}"`,
      );
    }
    const requiredNames: [string, string][] = [
      ["app name", fields.appName],
      ["EDP_STORE_SCHEMA_PREFIX", fields.storeSchemaPrefix],
      ["EIR_VOLUME_SCHEMA", fields.eirSchema],
      ["EIR_VOLUME_NAME", fields.eirVolume],
    ];
    for (const [name, value] of requiredNames) {
      if (!value.trim()) problems.push(`govdev ${name} must not be empty`);
    }
    if (!/^\d+$/.test(fields.adminGroupId)) {
      problems.push(
        `govdev EDP_ADMIN_GROUP_ID must be a numeric stable SCIM id, not "${fields.adminGroupId}"`,
      );
    }
  }
  return problems;
}

/** Plan actions that would drop a UC data object (and the data in it). */
const DESTRUCTIVE_ACTIONS = new Set(["delete", "recreate"]);

/**
 * Gate `databricks bundle plan -o json` before deploy (#141): list every
 * schema or volume the plan would delete or recreate, as "<action> <key>".
 * Empty means the deploy can't drop UC data. `lifecycle.prevent_destroy` on the
 * prod EIR schema/volume already blocks destroy/recreate of a declared
 * resource, but a resource whose block was removed from the config plans as
 * "delete" with no lifecycle left to stop it — this catches that case.
 */
export function destructiveUcActions(planJson: unknown): string[] {
  const plan = (planJson as { plan?: unknown })?.plan;
  if (!plan || typeof plan !== "object") {
    throw new BundleConfigError(
      "input has no `plan` object; is this `bundle plan -o json` output?",
    );
  }
  return Object.entries(plan as Record<string, { action?: unknown }>)
    .filter(([key]) => key.startsWith("resources.schemas.") || key.startsWith("resources.volumes."))
    .filter(
      ([, entry]) => typeof entry?.action === "string" && DESTRUCTIVE_ACTIONS.has(entry.action),
    )
    .map(([key, entry]) => `${String(entry.action)} ${key}`);
}

// `CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog_name || '.' || :schema_prefix || '<name>')`,
// the one form every resources/store-*.sql file uses to create a store schema.
const CREATE_STORE_SCHEMA =
  /CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+IDENTIFIER\s*\(\s*:catalog_name\s*\|\|\s*'\.'\s*\|\|\s*:schema_prefix\s*\|\|\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\)/gi;

/** The store schema names (unprefixed) one DDL file creates, in file order. */
export function schemasFromDdl(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, ""); // a commented-out CREATE doesn't count
  return [...code.matchAll(CREATE_STORE_SCHEMA)].map((m) => m[1] as string);
}

/**
 * The repo-relative DDL files the provision_store job runs, from the resolved
 * config. The CLI renders each task's file as `<workspace.file_path>/<path>`.
 */
export function provisionDdlFiles(config: unknown): string[] {
  const c = config as {
    workspace?: { file_path?: unknown };
    resources?: {
      jobs?: { provision_store?: { tasks?: { sql_task?: { file?: { path?: unknown } } }[] } };
    };
  };
  const tasks = c?.resources?.jobs?.provision_store?.tasks;
  const root = c?.workspace?.file_path;
  if (!Array.isArray(tasks) || tasks.length === 0 || typeof root !== "string") {
    throw new BundleConfigError(
      "bundle config has no resources.jobs.provision_store tasks / workspace.file_path",
    );
  }
  return tasks.map((task) => {
    const path = task?.sql_task?.file?.path;
    if (typeof path !== "string") {
      throw new BundleConfigError("a provision_store task has no sql_task.file.path");
    }
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  });
}

/**
 * Every store schema the provision_store job creates (unprefixed, de-duplicated,
 * first-seen order), derived from the DDL files it actually runs. The wrapper
 * grants the app service principal on exactly these, so a new area's
 * resources/store-<area>.sql task is covered without editing the wrapper.
 */
export function provisionedSchemas(config: unknown, readDdl: (path: string) => string): string[] {
  const schemas = [
    ...new Set(provisionDdlFiles(config).flatMap((file) => schemasFromDdl(readDdl(file)))),
  ];
  if (schemas.length === 0) {
    throw new BundleConfigError("the provision_store DDL creates no store schemas");
  }
  return schemas;
}
