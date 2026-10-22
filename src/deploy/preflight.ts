/**
 * Deploy-preflight var resolution (#138).
 *
 * Turnkey deploy is `databricks bundle deploy/run` with a small set of `--var`
 * inputs. Several of those inputs, left empty or malformed, don't fail fast:
 * the bundle renders a broken env entry or an invalid id and the deploy dies
 * deep inside the Databricks API with a cryptic message
 * (`Must specify environment variable source using either 'value' or
 * 'valueFrom'`, or `0 is not a valid endpoint id`). This module is the loud
 * preflight the wrapper runs first: given the vars a deployer actually supplied
 * on the command line (NOT the bundle defaults), it returns the list of
 * missing/invalid required inputs, each naming its variable.
 *
 * Pure and dependency-free so it is unit-tested by `npm test` and run directly
 * by `scripts/deploy-preflight.ts` (Node strips the types) ahead of any
 * workspace call.
 */

export type PreflightSeverity = "error" | "warning";

export interface PreflightProblem {
  /** The bundle variable the problem is about. */
  variable: string;
  severity: PreflightSeverity;
  message: string;
}

export interface PreflightOptions {
  /** Deploy target. `preview` recommends the UAT reviewer identity vars. */
  target?: string;
}

/** The `--var` set a deployer supplied: value present, or `undefined` if omitted. */
export type SuppliedVars = Record<string, string | undefined>;

/** Decode one Databricks CLI `--var` field, including CSV-quoted JSON values. */
export function decodeCliVarPair(input: string): [string, string] | null {
  const pair =
    input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1).replaceAll('""', '"') : input;
  const eq = pair.indexOf("=");
  return eq > 0 ? [pair.slice(0, eq), pair.slice(eq + 1)] : null;
}

// A Unity Catalog identifier (catalog, and each schema the prefix produces).
// Mirrors the server's rule (src/server/delta/sql-builder.ts) and the SQL
// job's assert_true guard.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The schema prefix is empty (production) or a plain identifier (a preview's
// own prefix, e.g. edp_vm_pr150_). Same rule as resources/store-schema.sql.
const SCHEMA_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)?$/;
// Databricks SQL warehouse ids are 16 hex chars. The all-zeros value is the
// placeholder default that `bundle deploy` rejects with "0 is not a valid
// endpoint id".
const WAREHOUSE_ID = /^[0-9a-f]{16}$/;
const WAREHOUSE_PLACEHOLDER = "0000000000000000";
// Stable SCIM account ids are numeric strings (ADR-0004).
const SCIM_ID = /^\d+$/;
// In the MVP one group, the EDP admin group, holds every staff role (#226), so
// it's the one staff group production must name, or nobody is staff.
const PROD_REQUIRED_GROUPS = ["edp_admin_group_id"];
// Per-role group vars reserved for a later role split (#226). The app ignores
// them and the bundle renders no env entry for them, so supplying one warns.
const RESERVED_ROLE_GROUPS = [
  "safeguards_validator_group_id",
  "business_office_group_id",
  "ccb_group_id",
];
// A service principal's application id, e.g. 6f1c2b9e-4d3a-4e8f-9b7c-2a1d0e5f8c34.
const APPLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The committed default for prod_root_path: deliberately not a valid path.
const PROD_ROOT_PLACEHOLDER = "configure-prod-root-path";

// Vars that back a Databricks App env entry. An explicitly-supplied empty (or
// whitespace-only) value for any of these renders a VALUE-LESS env entry, which
// the Apps API rejects with "Must specify environment variable source using
// either 'value' or 'valueFrom'". Omitting the var (so its default/absence
// applies) is fine; passing it empty is not.
const REQUIRED_WHEN_PRESENT = [
  "store_schema_prefix",
  "edp_admin_group_id",
  "seed_dataset_owner_ids",
];

/** A supplied, non-empty value, or `undefined` for an omitted/empty var. */
function supplied(vars: SuppliedVars, name: string): string | undefined {
  const value = vars[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** True when the var KEY is present but its value is empty or whitespace-only. */
function explicitlyEmpty(vars: SuppliedVars, name: string): boolean {
  return name in vars && (vars[name] ?? "").trim() === "";
}

/**
 * Resolve the supplied bundle vars against the turnkey deploy contract.
 * Returns every problem; `error`s block deploy, `warning`s are advisory.
 */
export function resolvePreflight(
  vars: SuppliedVars,
  options: PreflightOptions = {},
): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const error = (variable: string, message: string) =>
    problems.push({ variable, severity: "error", message });
  const warn = (variable: string, message: string) =>
    problems.push({ variable, severity: "warning", message });

  // --- catalog: the single input that configures store tables + EIR volume ---
  const catalog = supplied(vars, "catalog");
  if (!catalog) {
    error("catalog", "catalog is required: pass --var catalog=<unity-catalog-name>.");
  } else if (!IDENTIFIER.test(catalog)) {
    error(
      "catalog",
      `catalog "${catalog}" is not a plain Unity Catalog identifier (letters, digits, underscore; not starting with a digit).`,
    );
  }

  // --- sql_warehouse_id: the provisioning job + the app's Delta API ---
  const warehouse = supplied(vars, "sql_warehouse_id");
  if (!warehouse) {
    error(
      "sql_warehouse_id",
      "sql_warehouse_id is required: pass --var sql_warehouse_id=<16-hex-char warehouse id>.",
    );
  } else if (warehouse === WAREHOUSE_PLACEHOLDER || !WAREHOUSE_ID.test(warehouse)) {
    error(
      "sql_warehouse_id",
      `sql_warehouse_id "${warehouse}" is not a valid warehouse id (expected 16 hex chars; ${WAREHOUSE_PLACEHOLDER} is the placeholder).`,
    );
  }

  // --- explicit empty overrides render a value-less env entry the API rejects ---
  // Omitting a var is fine (its default/absence applies); passing it empty is a
  // footgun, so reject it here by name instead of letting the deploy fail deep
  // in the Apps API. (Resolution from BUNDLE_VAR_*/profile/env sources is caught
  // by the wrapper's resolved-config gate, which parses `bundle validate -o json`.)
  for (const name of REQUIRED_WHEN_PRESENT) {
    if (explicitlyEmpty(vars, name)) {
      error(
        name,
        `${name} was passed empty; an empty value renders a value-less env entry the Apps API rejects. Omit it to use the default, or pass a real value.`,
      );
    }
  }

  // --- store_schema_prefix: a non-empty value must be a plain identifier ---
  const prefix = supplied(vars, "store_schema_prefix");
  if (prefix && !SCHEMA_PREFIX.test(prefix)) {
    error(
      "store_schema_prefix",
      `store_schema_prefix "${prefix}" must be empty or a plain identifier (e.g. edp_vm_pr<N>_).`,
    );
  }

  // --- individual catalog overrides must agree with `catalog` ---
  // This catches divergence in COMMAND-LINE values; the authoritative check is
  // the wrapper's resolved-config gate, which asserts the RENDERED
  // EDP_STORE_CATALOG == EIR_VOLUME_CATALOG regardless of override source.
  const storeCatalog = supplied(vars, "store_catalog");
  const eirCatalog = supplied(vars, "eir_volume_catalog");
  if (catalog && storeCatalog && storeCatalog !== catalog) {
    error(
      "store_catalog",
      `store_catalog "${storeCatalog}" diverges from catalog "${catalog}"; omit it so one --var catalog configures both.`,
    );
  }
  if (catalog && eirCatalog && eirCatalog !== catalog) {
    error(
      "eir_volume_catalog",
      `eir_volume_catalog "${eirCatalog}" diverges from catalog "${catalog}"; omit it so one --var catalog configures both.`,
    );
  }
  if (!catalog && storeCatalog && eirCatalog && storeCatalog !== eirCatalog) {
    error(
      "catalog",
      `store_catalog "${storeCatalog}" and eir_volume_catalog "${eirCatalog}" diverge; pass a single --var catalog instead.`,
    );
  }

  // --- the staff group id: a non-empty value must be a numeric stable SCIM id ---
  const adminGroup = supplied(vars, "edp_admin_group_id");
  if (adminGroup && !SCIM_ID.test(adminGroup)) {
    error(
      "edp_admin_group_id",
      `edp_admin_group_id "${adminGroup}" must be a numeric stable SCIM group id (ADR-0004), not a name.`,
    );
  }

  if (options.target === "govdev") {
    const required = ["app_name", "store_schema_prefix", "eir_volume_name", "edp_admin_group_id"];
    for (const name of required) {
      if (!supplied(vars, name)) {
        error(name, `govdev requires ${name}; pass --var ${name}=<isolated development value>.`);
      }
    }

    const backend = supplied(vars, "data_backend");
    if (backend && backend !== "delta") {
      error(
        "data_backend",
        `govdev must use data_backend=delta (the target default), not "${backend}".`,
      );
    }
  }

  // --- reserved per-role groups: ignored by the app, so warn, never block ---
  for (const name of RESERVED_ROLE_GROUPS) {
    if (name in vars) {
      warn(
        name,
        `${name} is reserved for a later role split and ignored: in the MVP the EDP admin group (edp_admin_group_id) holds every staff role (#226). Omit it.`,
      );
    }
  }

  // --- seed_dataset_owner_ids: comma-separated SCIM ids ---
  const owners = supplied(vars, "seed_dataset_owner_ids");
  if (owners) {
    const ids = owners
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (ids.some((id) => !SCIM_ID.test(id))) {
      error(
        "seed_dataset_owner_ids",
        `seed_dataset_owner_ids "${owners}" must be a comma-separated list of numeric SCIM ids.`,
      );
    }
  }

  if (options.target === "prod") {
    const allowlistJson = supplied(vars, "membership_allowlist_json");
    let allowlist: unknown;
    try {
      allowlist = allowlistJson === undefined ? undefined : JSON.parse(allowlistJson);
    } catch {
      allowlist = undefined;
    }
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      error(
        "membership_allowlist_json",
        "prod requires a non-empty membership_allowlist_json array. An empty snapshot cannot prove membership freshness.",
      );
    }

    // --- prod: the EDP admin group, or nobody holds a staff role ---
    // It must be passed as a real numeric SCIM id (the format check above
    // rejects a non-numeric one; prod's committed default is a placeholder).
    for (const name of PROD_REQUIRED_GROUPS) {
      if (!supplied(vars, name)) {
        error(
          name,
          `prod requires ${name}: pass --var ${name}=<numeric SCIM group id>. Without it nobody holds a staff role in production.`,
        );
      }
    }

    // --- prod: the durable Delta store, never the in-memory seed ---
    const backend = supplied(vars, "data_backend");
    if (backend && backend !== "delta") {
      error(
        "data_backend",
        `prod must use data_backend=delta (the target default), not "${backend}".`,
      );
    }

    // --- prod: the membership snapshot jobs' run_as service principal ---
    // Both prod membership jobs run as ${var.membership_job_sp}, which has no
    // default, so without it `bundle validate -t prod` fails deep in the CLI.
    const jobSp = supplied(vars, "membership_job_sp");
    if (!jobSp) {
      error(
        "membership_job_sp",
        "prod requires membership_job_sp: pass --var membership_job_sp=<service principal application id>. The membership snapshot jobs run as it.",
      );
    } else if (!APPLICATION_ID.test(jobSp)) {
      error(
        "membership_job_sp",
        `membership_job_sp "${jobSp}" must be a service principal application id (a UUID such as 6f1c2b9e-4d3a-4e8f-9b7c-2a1d0e5f8c34), not a name.`,
      );
    }

    // --- prod: a restricted bundle root, never the all-users Shared folder ---
    const rootProblem = prodRootPathProblem(supplied(vars, "prod_root_path"));
    if (rootProblem) error("prod_root_path", rootProblem);
  }

  // --- preview UAT: recommend the reviewer identity vars (advisory only) ---
  if (options.target === "preview") {
    if (!supplied(vars, "edp_admin_group_id")) {
      warn(
        "edp_admin_group_id",
        "preview UAT: no edp_admin_group_id supplied; the preview default group counts as EDP staff.",
      );
    }
    if (!owners) {
      warn(
        "seed_dataset_owner_ids",
        "preview UAT: pass seed_dataset_owner_ids=<your SCIM id> to own the sample dataset in team-management checks.",
      );
    }
  }

  return problems;
}

/** What the workspace says about one catalog name. */
export type CatalogLookupResult = { exists: true } | { exists: false; detail: string };

/** Asks the workspace whether a catalog exists (and the deployer can see it). */
export type CatalogLookup = (name: string) => CatalogLookupResult;

/**
 * Refuse any catalog the deploy writes to that the workspace doesn't have. A
 * DAB can't create a catalog, and nothing else fails early on one that's
 * missing: `bundle deploy` succeeds, and only provision_store and the app's
 * first query hit TABLE_OR_VIEW_NOT_FOUND. The #158 preview broke exactly this
 * way, with store_catalog defaulting to a nonexistent `edp_vending`.
 *
 * Checks `catalog` and any explicit `store_catalog` / `eir_volume_catalog`,
 * asking about each distinct name once. Run it only after `resolvePreflight`
 * is clean, so every name is a plain identifier.
 */
export function missingCatalogProblems(
  vars: SuppliedVars,
  lookup: CatalogLookup,
): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const asked = new Set<string>();
  for (const variable of ["catalog", "store_catalog", "eir_volume_catalog"]) {
    const name = supplied(vars, variable);
    if (!name || asked.has(name)) continue;
    asked.add(name);
    const result = lookup(name);
    if (!result.exists) {
      problems.push({
        variable,
        severity: "error",
        message: `${variable} "${name}" does not exist on this workspace, or the deployer can't see it (${result.detail}). A bundle can't create a catalog: create it first (docs/production-checklist.md), or pass --var catalog=<an existing catalog>.`,
      });
    }
  }
  return problems;
}

/**
 * Why a prod bundle root is unacceptable, or `undefined` if it's fine. It must
 * be supplied, absolute under /Workspace/, free of `.`/`..` segments (so it
 * can't climb into another folder), and not /Workspace/Shared or anything under
 * it: that folder is writable by every workspace user, so anyone could change
 * the deployed app source or bundle state.
 */
export function prodRootPathProblem(path: string | undefined): string | undefined {
  const fix =
    'Pass --var prod_root_path=<folder owned by the EDP deployment group, CAN_MANAGE for that group only>; see docs/databricks-app.md -> "Production bundle root".';
  if (!path || path === PROD_ROOT_PLACEHOLDER) {
    return `prod requires prod_root_path. ${fix}`;
  }
  // ["", "Workspace", <top folder>, ...]; one trailing slash is tolerated.
  const segments = path.replace(/\/$/, "").split("/");
  if (
    segments[0] !== "" ||
    segments[1] !== "Workspace" ||
    segments.length < 3 ||
    segments.slice(2).some((s) => s === "" || s === "." || s === "..")
  ) {
    return `prod_root_path "${path}" must be an absolute folder under /Workspace/ with no empty, "." or ".." segments. ${fix}`;
  }
  if (segments[2]?.toLowerCase() === "shared") {
    return `prod_root_path "${path}" is under /Workspace/Shared, which every workspace user can write to. ${fix}`;
  }
  return undefined;
}

/** True when any problem is an `error` (deploy must not proceed). */
export function hasErrors(problems: readonly PreflightProblem[]): boolean {
  return problems.some((p) => p.severity === "error");
}

/** Render problems as human-readable lines, each naming its variable + severity. */
export function formatProblems(problems: readonly PreflightProblem[]): string {
  return problems.map((p) => `  [${p.severity}] ${p.variable}: ${p.message}`).join("\n");
}
