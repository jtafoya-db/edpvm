import { describe, expect, it } from "vitest";

import {
  formatProblems,
  decodeCliVarPair,
  hasErrors,
  missingCatalogProblems,
  prodRootPathProblem,
  resolvePreflight,
  type CatalogLookup,
} from "../preflight.ts";

// The deploy-preflight var-resolution seam (#138). A pure function: given the
// set of bundle vars a deployer supplied on the command line, it returns the
// list of missing/invalid required inputs that would otherwise fail
// `bundle deploy`/`bundle run` with a cryptic Databricks API error. The wrapper
// (scripts/deploy-turnkey.sh) and its CLI (scripts/deploy-preflight.ts) run this
// before touching the workspace, so the failure names the var.

const MINIMAL = { catalog: "edp_vending", sql_warehouse_id: "1111111111111111" };
const RESTRICTED_ROOT = "/Workspace/edp-deploy/edp-vending-machine/prod";
const PROD_MINIMAL = {
  ...MINIMAL,
  prod_root_path: RESTRICTED_ROOT,
  edp_admin_group_id: "111",
  membership_job_sp: "6f1c2b9e-4d3a-4e8f-9b7c-2a1d0e5f8c34",
  membership_allowlist_json:
    '[{"group_id":"g1","group_name":"edp-admins","kind":"domain","domain":"edp-operations","managed_by":"manual","account_group":true}]',
};
const GOVDEV_MINIMAL = {
  ...MINIMAL,
  app_name: "edp-vm-govdev",
  store_schema_prefix: "edp_vm_govdev_",
  eir_volume_name: "eir_govdev",
  edp_admin_group_id: "123456789",
};

describe("resolvePreflight — govdev isolation", () => {
  it("accepts a complete isolated Delta-backed deployment", () => {
    expect(resolvePreflight(GOVDEV_MINIMAL, { target: "govdev" })).toEqual([]);
  });

  it.each(["app_name", "store_schema_prefix", "eir_volume_name", "edp_admin_group_id"])(
    "requires %s",
    (name) => {
      const vars = { ...GOVDEV_MINIMAL, [name]: undefined };
      expect(resolvePreflight(vars, { target: "govdev" })).toContainEqual(
        expect.objectContaining({ variable: name, severity: "error" }),
      );
    },
  );

  it.each([
    ["app_name", "edp-vending-machine"],
    ["store_schema_prefix", ""],
    ["eir_volume_name", "eir"],
  ])("rejects unsafe production-like %s=%s", (name, value) => {
    expect(
      resolvePreflight({ ...GOVDEV_MINIMAL, [name]: value }, { target: "govdev" }),
    ).toContainEqual(expect.objectContaining({ variable: name, severity: "error" }));
  });

  it("rejects an explicit memory backend", () => {
    expect(
      resolvePreflight({ ...GOVDEV_MINIMAL, data_backend: "memory" }, { target: "govdev" }),
    ).toContainEqual(expect.objectContaining({ variable: "data_backend", severity: "error" }));
  });
});

describe("resolvePreflight — required inputs", () => {
  it("is clean when the minimal turnkey var set is supplied", () => {
    expect(resolvePreflight(MINIMAL)).toEqual([]);
  });

  it("flags a missing catalog by name", () => {
    const problems = resolvePreflight({ sql_warehouse_id: "1111111111111111" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ variable: "catalog", severity: "error" });
    expect(problems[0]?.message).toMatch(/catalog/i);
  });

  it("flags an empty-string catalog (not just absent)", () => {
    const problems = resolvePreflight({ catalog: "", sql_warehouse_id: "1111111111111111" });
    expect(problems.some((p) => p.variable === "catalog" && p.severity === "error")).toBe(true);
  });

  it("flags a catalog that is not a plain Unity Catalog identifier", () => {
    const problems = resolvePreflight({
      catalog: "edp-vending",
      sql_warehouse_id: "1111111111111111",
    });
    expect(problems.some((p) => p.variable === "catalog" && /identifier/i.test(p.message))).toBe(
      true,
    );
  });

  it("flags a missing sql_warehouse_id by name", () => {
    const problems = resolvePreflight({ catalog: "edp_vending" });
    expect(problems.some((p) => p.variable === "sql_warehouse_id" && p.severity === "error")).toBe(
      true,
    );
  });

  it("rejects the all-zeros warehouse placeholder", () => {
    const problems = resolvePreflight({
      catalog: "edp_vending",
      sql_warehouse_id: "0000000000000000",
    });
    expect(problems.some((p) => p.variable === "sql_warehouse_id" && p.severity === "error")).toBe(
      true,
    );
  });

  it("rejects a malformed warehouse id", () => {
    const problems = resolvePreflight({ catalog: "edp_vending", sql_warehouse_id: "not-an-id" });
    expect(problems.some((p) => p.variable === "sql_warehouse_id" && p.severity === "error")).toBe(
      true,
    );
  });
});

describe("resolvePreflight — production membership allowlist", () => {
  it("decodes the CLI's CSV quoting for JSON --var values", () => {
    expect(
      decodeCliVarPair(
        '"membership_allowlist_json=[{""group_id"":""g1"",""group_name"":""admins""}]"',
      ),
    ).toEqual(["membership_allowlist_json", '[{"group_id":"g1","group_name":"admins"}]']);
  });
  it.each([undefined, "", "[]", "   []   "])(
    "refuses a missing or empty production allowlist (%j)",
    (membership_allowlist_json) => {
      const problems = resolvePreflight(
        { ...PROD_MINIMAL, membership_allowlist_json },
        { target: "prod" },
      );
      expect(problems).toContainEqual(
        expect.objectContaining({ variable: "membership_allowlist_json", severity: "error" }),
      );
    },
  );

  it("accepts a non-empty production allowlist", () => {
    expect(hasErrors(resolvePreflight(PROD_MINIMAL, { target: "prod" }))).toBe(false);
  });

  it("keeps an omitted allowlist valid for preview", () => {
    expect(hasErrors(resolvePreflight(MINIMAL, { target: "preview" }))).toBe(false);
  });
});

describe("resolvePreflight — footgun vars (empty is safe, malformed is not)", () => {
  it("accepts an omitted store_schema_prefix (production uses the empty prefix)", () => {
    expect(hasErrors(resolvePreflight(MINIMAL))).toBe(false);
  });

  it("accepts a valid non-empty store_schema_prefix", () => {
    expect(hasErrors(resolvePreflight({ ...MINIMAL, store_schema_prefix: "edp_vm_pr138_" }))).toBe(
      false,
    );
  });

  it("rejects a store_schema_prefix that is not an identifier", () => {
    const problems = resolvePreflight({ ...MINIMAL, store_schema_prefix: "pr-138" });
    expect(
      problems.some((p) => p.variable === "store_schema_prefix" && p.severity === "error"),
    ).toBe(true);
  });

  it("rejects a non-numeric SCIM group id", () => {
    const problems = resolvePreflight({ ...MINIMAL, edp_admin_group_id: "edp-admins" });
    expect(
      problems.some((p) => p.variable === "edp_admin_group_id" && p.severity === "error"),
    ).toBe(true);
  });

  it("accepts a numeric SCIM group id", () => {
    expect(hasErrors(resolvePreflight({ ...MINIMAL, edp_admin_group_id: "11111111111111" }))).toBe(
      false,
    );
  });

  it("rejects a seed_dataset_owner_ids list with a malformed id", () => {
    const problems = resolvePreflight({ ...MINIMAL, seed_dataset_owner_ids: "123,abc" });
    expect(
      problems.some((p) => p.variable === "seed_dataset_owner_ids" && p.severity === "error"),
    ).toBe(true);
  });

  it("accepts a comma-separated seed_dataset_owner_ids list of SCIM ids", () => {
    expect(
      hasErrors(resolvePreflight({ ...MINIMAL, seed_dataset_owner_ids: "123, 456 ,789" })),
    ).toBe(false);
  });
});

describe("resolvePreflight — explicit empty overrides are rejected", () => {
  // Omitting a var is fine (default applies); passing it empty renders a
  // value-less env entry the Apps API rejects, so each must be named.
  for (const name of ["store_schema_prefix", "edp_admin_group_id", "seed_dataset_owner_ids"]) {
    it(`rejects an explicit empty ${name}`, () => {
      const problems = resolvePreflight({ ...MINIMAL, [name]: "" });
      expect(problems.some((p) => p.variable === name && p.severity === "error")).toBe(true);
    });

    it(`rejects a whitespace-only ${name}`, () => {
      const problems = resolvePreflight({ ...MINIMAL, [name]: "   " });
      expect(problems.some((p) => p.variable === name && p.severity === "error")).toBe(true);
    });
  }

  it("still accepts these vars when omitted entirely", () => {
    expect(hasErrors(resolvePreflight(MINIMAL))).toBe(false);
  });
});

describe("resolvePreflight — individual catalog overrides must agree", () => {
  it("flags a store_catalog override that diverges from catalog", () => {
    const problems = resolvePreflight({ ...MINIMAL, store_catalog: "something_else" });
    expect(problems.some((p) => p.variable === "store_catalog" && p.severity === "error")).toBe(
      true,
    );
  });

  it("flags an eir_volume_catalog override that diverges from catalog", () => {
    const problems = resolvePreflight({ ...MINIMAL, eir_volume_catalog: "something_else" });
    expect(
      problems.some((p) => p.variable === "eir_volume_catalog" && p.severity === "error"),
    ).toBe(true);
  });

  it("accepts individual overrides that agree with catalog", () => {
    const problems = resolvePreflight({
      ...MINIMAL,
      store_catalog: "edp_vending",
      eir_volume_catalog: "edp_vending",
    });
    expect(hasErrors(problems)).toBe(false);
  });

  it("flags store_catalog and eir_volume_catalog diverging from each other when catalog is absent", () => {
    const problems = resolvePreflight({
      sql_warehouse_id: "1111111111111111",
      store_catalog: "a_catalog",
      eir_volume_catalog: "b_catalog",
    });
    expect(problems.some((p) => p.severity === "error" && /diverge/i.test(p.message))).toBe(true);
  });
});

describe("resolvePreflight — preview UAT recommendations", () => {
  it("warns (does not error) when preview omits the UAT reviewer identity vars", () => {
    const problems = resolvePreflight(MINIMAL, { target: "preview" });
    expect(hasErrors(problems)).toBe(false);
    expect(
      problems.some((p) => p.variable === "seed_dataset_owner_ids" && p.severity === "warning"),
    ).toBe(true);
  });

  it("is clean on prod with the EDP admin group as the only staff group (#226)", () => {
    expect(resolvePreflight(PROD_MINIMAL, { target: "prod" })).toEqual([]);
  });
});

// #226: one group, the EDP admin group, holds every staff role in the MVP. The
// per-role group vars stay as reserved for a later split; the app ignores them,
// so supplying one warns and never blocks.
describe("resolvePreflight — reserved per-role group vars", () => {
  const RESERVED = ["safeguards_validator_group_id", "business_office_group_id", "ccb_group_id"];

  it.each(RESERVED.flatMap((name) => ["prod", "preview"].map((target) => [name, target])))(
    "warns, and doesn't block, when %s is supplied (%s)",
    (name, target) => {
      const vars = target === "prod" ? PROD_MINIMAL : MINIMAL;
      for (const value of ["11111111111111", "", "configure-safeguards-validator-group-id"]) {
        const problems = resolvePreflight({ ...vars, [name]: value }, { target });
        expect(hasErrors(problems), value).toBe(false);
        const warning = problems.find((p) => p.variable === name);
        expect(warning, value).toMatchObject({ severity: "warning" });
        expect(warning?.message).toMatch(/reserved.*edp_admin_group_id/s);
      }
    },
  );

  it("says nothing about the reserved vars when they're omitted", () => {
    const problems = resolvePreflight(MINIMAL, { target: "preview" });
    expect(problems.filter((p) => RESERVED.includes(p.variable))).toEqual([]);
  });
});

describe("formatProblems / hasErrors", () => {
  it("hasErrors is false for an empty list and for warnings only", () => {
    expect(hasErrors([])).toBe(false);
    expect(hasErrors([{ variable: "x", severity: "warning", message: "m" }])).toBe(false);
    expect(hasErrors([{ variable: "x", severity: "error", message: "m" }])).toBe(true);
  });

  it("formatProblems names each variable and its severity", () => {
    const text = formatProblems([
      { variable: "catalog", severity: "error", message: "catalog is required" },
    ]);
    expect(text).toMatch(/catalog/);
    expect(text).toMatch(/error/i);
  });
});

// #150 review (blocking): the prod bundle root holds the deployed app source and
// bundle state. /Workspace/Shared is writable by every workspace user, so a prod
// root there lets anyone tamper with the app. The root is a required prod var
// with no shared default, and the preflight refuses unsafe values.
describe("resolvePreflight — prod bundle root", () => {
  const prod = (prod_root_path?: string) =>
    resolvePreflight(
      { ...MINIMAL, edp_admin_group_id: "111", prod_root_path },
      { target: "prod" },
    ).filter((p) => p.variable === "prod_root_path");

  it("BLOCKS prod when prod_root_path is omitted or still the placeholder", () => {
    for (const value of [undefined, "", "configure-prod-root-path"]) {
      const problems = prod(value);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ severity: "error" });
      expect(problems[0]?.message).toMatch(/requires prod_root_path/);
    }
  });

  it("refuses /Workspace/Shared and anything under it", () => {
    for (const value of [
      "/Workspace/Shared",
      "/Workspace/Shared/",
      "/Workspace/Shared/.bundle/edp-vending-machine/prod",
      "/Workspace/shared/edp",
    ]) {
      expect(prod(value)[0]?.message, value).toMatch(/Workspace\/Shared/);
    }
  });

  it("refuses a path that isn't absolute under /Workspace/", () => {
    for (const value of [
      "edp/prod",
      "/Users/someone/edp",
      "/Workspace",
      "/Workspace/",
      "/WorkspaceShared/edp",
      "/Workspace/edp/../Shared/x",
      "/Workspace/./Shared",
      "/Workspace//Shared",
    ]) {
      expect(prod(value)[0]?.message, value).toMatch(/absolute folder under \/Workspace\//);
    }
  });

  it("accepts a restricted deployment-group folder", () => {
    expect(prod(RESTRICTED_ROOT)).toEqual([]);
    expect(
      prodRootPathProblem("/Workspace/Users/deployer-sp-app-id/.bundle/edp/prod"),
    ).toBeUndefined();
  });

  it("doesn't require prod_root_path outside prod", () => {
    expect(
      resolvePreflight(MINIMAL, { target: "preview" }).some((p) => p.variable === "prod_root_path"),
    ).toBe(false);
  });
});

// #144 readiness (blocking): prod never emitted the staff group id, so nobody
// was EDP staff; and prod must serve the Delta store, not the in-memory seed.
// Since #226 the EDP admin group is the only staff group prod requires.
describe("resolvePreflight — prod groups and data backend", () => {
  const PROD_OK = PROD_MINIMAL;
  const problemsFor = (vars: Record<string, string | undefined>, variable: string) =>
    resolvePreflight(vars, { target: "prod" }).filter((p) => p.variable === variable);

  it.each(["edp_admin_group_id"])(
    "BLOCKS prod when %s is omitted, empty or not a numeric SCIM id",
    (name) => {
      for (const value of [undefined, "", "configure-x", "edp-admins"]) {
        const problems = problemsFor({ ...PROD_OK, [name]: value }, name);
        expect(problems.length, String(value)).toBeGreaterThan(0);
        expect(problems.every((p) => p.severity === "error")).toBe(true);
      }
    },
  );

  it("doesn't require the group ids outside prod", () => {
    expect(hasErrors(resolvePreflight(MINIMAL, { target: "dev" }))).toBe(false);
  });

  it("refuses data_backend=memory on prod and accepts delta or the default", () => {
    expect(problemsFor({ ...PROD_OK, data_backend: "memory" }, "data_backend")).toHaveLength(1);
    expect(problemsFor({ ...PROD_OK, data_backend: "delta" }, "data_backend")).toEqual([]);
    expect(resolvePreflight(PROD_OK, { target: "prod" })).toEqual([]);
  });
});

// The #158 preview broke because store_catalog defaulted to a catalog that
// didn't exist on the workspace (edp_vending): the deploy went through and
// provision_store never created a table. The preflight asks the workspace
// whether each catalog the deploy writes to exists, and refuses one that
// doesn't, before any bundle call.
describe("missingCatalogProblems — the catalog must exist on the workspace", () => {
  const workspace = (...existing: string[]): CatalogLookup & { asked: string[] } => {
    const asked: string[] = [];
    const lookup = (name: string) => {
      asked.push(name);
      return existing.includes(name)
        ? { exists: true as const }
        : { exists: false as const, detail: `Catalog '${name}' does not exist.` };
    };
    return Object.assign(lookup, { asked });
  };

  it("is clean when the catalog exists", () => {
    expect(
      missingCatalogProblems(
        { catalog: "example_catalog" },
        workspace("example_catalog"),
      ),
    ).toEqual([]);
  });

  it("refuses a catalog the workspace doesn't have, naming it and the fix", () => {
    const problems = missingCatalogProblems({ catalog: "edp_vending" }, workspace("main"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ variable: "catalog", severity: "error" });
    expect(problems[0]?.message).toMatch(/"edp_vending" does not exist/);
    expect(problems[0]?.message).toMatch(/does not exist\./);
    expect(hasErrors(problems)).toBe(true);
  });

  it("checks an explicit store_catalog or eir_volume_catalog too, each once", () => {
    const ws = workspace("example_catalog");
    const problems = missingCatalogProblems(
      {
        catalog: "example_catalog",
        store_catalog: "edp_vending",
        eir_volume_catalog: "example_catalog",
      },
      ws,
    );
    expect(problems.map((p) => p.variable)).toEqual(["store_catalog"]);
    expect(ws.asked).toEqual(["example_catalog", "edp_vending"]);
  });

  it("asks nothing when no catalog was supplied (resolvePreflight already refuses that)", () => {
    const ws = workspace();
    expect(missingCatalogProblems({}, ws)).toEqual([]);
    expect(ws.asked).toEqual([]);
  });
});

// Both prod membership-snapshot jobs run_as ${var.membership_job_sp}, which has
// no default; without it `bundle validate -t prod` fails deep in the CLI. The
// preflight names it, and requires a service principal application id (UUID).
describe("resolvePreflight — prod membership job service principal", () => {
  const PROD_OK = PROD_MINIMAL;
  const problemsFor = (vars: Record<string, string | undefined>) =>
    resolvePreflight(vars, { target: "prod" }).filter((p) => p.variable === "membership_job_sp");

  it("BLOCKS prod when membership_job_sp is omitted or empty, naming the var", () => {
    for (const value of [undefined, "", "  "]) {
      const problems = problemsFor({ ...PROD_OK, membership_job_sp: value });
      expect(problems, String(value)).toHaveLength(1);
      expect(problems[0]?.severity).toBe("error");
      expect(problems[0]?.message).toMatch(/--var membership_job_sp=/);
    }
  });

  it("BLOCKS prod when membership_job_sp isn't a service principal application id", () => {
    for (const value of [
      "edp-snapshot-sp",
      "123",
      "preview-deployer-not-used",
      "6f1c2b9e4d3a4e8f9b7c2a1d0e5f8c34",
    ]) {
      const problems = problemsFor({ ...PROD_OK, membership_job_sp: value });
      expect(problems, value).toHaveLength(1);
      expect(problems[0]?.message).toMatch(/application id/);
    }
  });

  it("accepts a UUID application id on prod, in either case", () => {
    expect(problemsFor(PROD_OK)).toEqual([]);
    expect(
      problemsFor({ ...PROD_OK, membership_job_sp: "6F1C2B9E-4D3A-4E8F-9B7C-2A1D0E5F8C34" }),
    ).toEqual([]);
  });

  it("doesn't require it outside prod (preview/dev set a placeholder)", () => {
    for (const target of ["preview", "dev"]) {
      expect(
        resolvePreflight(MINIMAL, { target }).some((p) => p.variable === "membership_job_sp"),
        target,
      ).toBe(false);
    }
  });
});
