// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it, vi } from "vitest";

import { AccessMatrixError, loadAccessMatrix, validateAccessMatrix } from "../../access-matrix.ts";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { createAppRegistry } from "../areas/index.ts";
import { createStoreNames } from "../sql-builder.ts";

const validMatrix = () => ({
  metadata: {
    approvalStatus: "approved",
    decision: "#145",
    approvedAt: "2026-10-24",
  },
  layers: ["bronze", "silver", "gold"],
  environments: ["dev", "test", "preprod", "prod", "analytics-prod"],
  roles: {
    tester: {
      rules: [
        {
          kind: "uc",
          privilege: "SELECT",
          grantPointType: "schema",
          directSecurableType: "table",
          target: "{env.catalog}.{datasetTag}_{layer}",
          layers: "*",
          environments: "*",
        },
      ],
    },
    developer: {
      inherits: "tester",
      rules: [
        {
          kind: "uc",
          privilege: "MODIFY",
          grantPointType: "schema",
          directSecurableType: "table",
          target: "{env.catalog}.{datasetTag}_{layer}",
          layers: "*",
          environments: ["dev", "test", "preprod", "prod"],
        },
      ],
    },
    manager: {
      inherits: "developer",
      rules: [
        {
          kind: "job-acl",
          accessLevel: "CAN_MANAGE",
          target: "dataset-job:{datasetTag}",
          environments: "*",
          label: "Maintainer manages the dataset jobs",
        },
      ],
    },
  },
  consumer: {
    certificationStatuses: ["certified", "deprecated"],
    rules: [
      {
        kind: "uc",
        privilege: "SELECT",
        grantPointType: "schema",
        directSecurableType: "table",
        target: "{env.catalog}.{datasetTag}_{layer}",
        layers: ["silver", "gold"],
        environments: ["prod", "analytics-prod"],
      },
    ],
  },
  sensitiveAccess: {
    rules: [
      {
        kind: "workspace-assignment",
        accessLevel: "USER",
        target: "workspace:{environment}",
        environments: ["preprod", "prod", "analytics-prod"],
      },
    ],
  },
});

const clone = <T>(value: T): T => structuredClone(value);

describe("loadAccessMatrix", () => {
  it("loads the approved repo default when the override is absent or none", () => {
    for (const accessMatrixJson of [undefined, "none"]) {
      const loaded = loadAccessMatrix({ accessMatrixJson });
      expect(loaded.source).toBe("repo-default");
      expect(loaded.approvalStatus).toBe("approved");
      expect(loaded.decision).toBe("#145 comment 6385978601");
      expect(loaded.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("wholly replaces the default with a valid approved deploy override", () => {
    const override = validMatrix();
    override.metadata.decision = "IRS deploy review 2026-10-24";
    override.roles.tester.rules[0]!.privilege = " select ";
    const loaded = loadAccessMatrix({ accessMatrixJson: JSON.stringify(override) });

    expect(loaded.source).toBe("deploy-override");
    expect(loaded.matrix.metadata).toEqual(override.metadata);
    expect(loaded.matrix.roles.tester.rules).toHaveLength(1);
    expect(loaded.matrix.roles.tester.rules[0]).toMatchObject({
      kind: "uc",
      privilege: "SELECT",
    });
  });

  it("permits a declared draft override only with the explicit opt-in", () => {
    const draft = validMatrix();
    draft.metadata.approvalStatus = "draft";
    draft.metadata.decision = "pending deploy review";
    expect(() => loadAccessMatrix({ accessMatrixJson: JSON.stringify(draft) })).toThrowError(
      expect.objectContaining({ code: "access-matrix-draft-not-permitted" }),
    );
    expect(
      loadAccessMatrix({ accessMatrixJson: JSON.stringify(draft), allowDraft: "true" })
        .approvalStatus,
    ).toBe("draft");
  });

  it("rejects non-JSON deploy input and never falls back to the repo default", () => {
    expect(() => loadAccessMatrix({ accessMatrixJson: "not json" })).toThrowError(
      expect.objectContaining({
        code: "access-matrix-invalid",
        issues: expect.arrayContaining([expect.stringContaining("EDP_ACCESS_MATRIX_JSON")]),
      }),
    );
  });

  it("rejects an invalid deploy matrix and never falls back to the repo default", () => {
    const invalid = validMatrix() as any;
    invalid.roles.tester.rules[0].privilege = "MANAGE";
    expect(() => loadAccessMatrix({ accessMatrixJson: JSON.stringify(invalid) })).toThrowError(
      expect.objectContaining({
        code: "access-matrix-invalid",
        issues: expect.arrayContaining([expect.stringContaining("roles.tester.rules.0.privilege")]),
      }),
    );
  });
});

describe("validateAccessMatrix", () => {
  it("keeps Zod 3's exact operator-facing enum and strict-key messages", () => {
    const matrix = validMatrix() as any;
    matrix.metadata.approvalStatus = "pending";
    matrix.metadata.version = 1;

    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          "metadata.approvalStatus: Invalid enum value. Expected 'approved' | 'draft', received 'pending'",
          "metadata: Unrecognized key(s) in object: 'version'",
        ]),
      }),
    );
  });

  it("aggregates strict shape, inheritance, duplicate and template errors by path", () => {
    const matrix = validMatrix() as any;
    matrix.extra = true;
    delete matrix.roles.tester.rules;
    matrix.roles.tester.inherits = "manager";
    delete matrix.roles.developer.inherits;
    matrix.roles.manager.rules.push(clone(matrix.roles.manager.rules[0]));
    matrix.consumer.rules[0].target = "{env.catalog}.{surprise}";
    matrix.consumer.rules[0].privilege = " manage ";

    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({
        code: "access-matrix-invalid",
        issues: expect.arrayContaining([
          expect.stringContaining("extra"),
          expect.stringContaining("roles.tester.rules"),
          expect.stringContaining("inherit"),
          expect.stringContaining("roles.developer.inherits"),
          expect.stringContaining("duplicate"),
          expect.stringContaining("consumer.rules.0.target"),
          expect.stringContaining("consumer.rules.0.privilege"),
        ]),
      }),
    );
  });

  it("rejects duplicate executable rules after case, spacing and selector normalization", () => {
    const matrix = validMatrix() as any;
    const duplicate = clone(matrix.roles.tester.rules[0]);
    duplicate.privilege = " select ";
    duplicate.layers = [" gold ", "silver", "silver"];
    matrix.roles.tester.rules[0].layers = ["silver", "gold"];
    matrix.roles.tester.rules.push(duplicate);

    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({ issues: [expect.stringContaining("duplicate rule")] }),
    );
  });

  it("rejects duplicate executable rules after target normalization", () => {
    const matrix = validMatrix() as any;
    const duplicate = clone(matrix.roles.tester.rules[0]);
    duplicate.target = `  ${duplicate.target}  `;
    matrix.roles.tester.rules.push(duplicate);

    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({ issues: [expect.stringContaining("duplicate rule")] }),
    );
  });

  it("accepts only allowlisted privilege/grant-point/direct-securable triples", () => {
    const matrix = validMatrix();
    matrix.roles.tester.rules[0]!.grantPointType = "catalog";
    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.stringMatching(/roles\.tester.*SELECT.*catalog.*table/),
        ]),
      }),
    );
  });

  it.each([" manage ", "all   privileges", "OWNER", "transfer ownership", "apply tag", "*"])(
    "refuses dangerous UC privilege %j regardless of case or spacing",
    (privilege) => {
      const matrix = validMatrix();
      (matrix.roles.manager.rules as any[]).unshift({
        ...clone(matrix.roles.tester.rules[0]!),
        privilege,
      });
      expect(() => validateAccessMatrix(matrix)).toThrowError(
        expect.objectContaining({ code: "access-matrix-invalid" }),
      );
    },
  );

  it("keeps UC strings out of target ACLs and owner levels out of every ACL", () => {
    for (const [kind, accessLevel] of [
      ["job-acl", "SELECT"],
      ["job-acl", "IS_OWNER"],
      ["folder-acl", "CAN_MANAGE"],
      ["workspace-assignment", "MODIFY"],
    ]) {
      const matrix = validMatrix() as any;
      matrix.roles.tester.rules = [
        { kind, accessLevel, target: "target:{datasetTag}", environments: "*" },
      ];
      expect(() => validateAccessMatrix(matrix), `${kind}/${accessLevel}`).toThrowError(
        AccessMatrixError,
      );
    }
  });

  it("allows workspace assignment only for the EIR-gated sensitive-access group", () => {
    for (const principal of ["tester", "developer", "manager", "consumer"] as const) {
      const matrix = validMatrix() as any;
      const rule = clone(matrix.sensitiveAccess.rules[0]);
      if (principal === "consumer") matrix.consumer.rules = [rule];
      else matrix.roles[principal].rules = [rule];

      expect(() => validateAccessMatrix(matrix), principal).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.stringContaining("workspace-assignment is sensitiveAccess-only"),
          ]),
        }),
      );
    }
  });

  it("allows the sensitive-access group only workspace USER and never data privileges", () => {
    for (const rule of [
      {
        ...clone(validMatrix().roles.developer.rules[0]!),
        layers: "*",
        environments: "*",
      },
      {
        ...clone(validMatrix().roles.tester.rules[0]!),
        layers: ["bronze"],
      },
      {
        kind: "folder-acl",
        accessLevel: "CAN_READ",
        target: "/Workspace/edp/{datasetTag}",
        environments: "*",
      },
    ]) {
      const matrix = validMatrix() as any;
      matrix.sensitiveAccess.rules = [rule];
      expect(() => validateAccessMatrix(matrix)).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.stringContaining("sensitiveAccess accepts only workspace-assignment USER"),
          ]),
        }),
      );
    }
  });

  it.each([
    ["wildcard UC target", "tester", 0, "*"],
    ["literal catalog", "tester", 0, "other_catalog"],
    ["empty placeholder", "tester", 0, "{}"],
    ["unbalanced placeholder", "tester", 0, "{env.catalog}}"],
    ["layer placeholder in job target", "manager", 0, "dataset-job:{layer}"],
  ] as const)(
    "refuses %s instead of the fixed target template",
    (_name, principal, index, target) => {
      const matrix = validMatrix() as any;
      matrix.roles[principal].rules[index].target = target;
      expect(() => validateAccessMatrix(matrix)).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("target: must be exactly")]),
        }),
      );
    },
  );

  it("refuses a literal bronze consumer target hidden behind a gold selector", () => {
    const matrix = validMatrix();
    matrix.consumer.rules[0]!.target = "{env.catalog}.{datasetTag}_bronze";
    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.stringContaining("target: must be exactly")]),
      }),
    );
  });

  it("refuses rule selectors outside the matrix's declared layers and environments", () => {
    const matrix = validMatrix() as any;
    matrix.layers = ["gold"];
    matrix.environments = ["prod"];

    expect(() => validateAccessMatrix(matrix)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.stringContaining("roles.developer.rules.0.environments"),
          expect.stringContaining("consumer.rules.0.layers"),
          expect.stringContaining("consumer.rules.0.environments"),
        ]),
      }),
    );
  });

  it("keeps consumers UC-only and tester folder access read-only", () => {
    for (const rule of [
      {
        kind: "job-acl",
        accessLevel: "CAN_VIEW",
        target: "dataset-job:{datasetTag}",
        environments: "*",
      },
      {
        kind: "folder-acl",
        accessLevel: "CAN_READ",
        target: "/Workspace/edp/{datasetTag}",
        environments: "*",
      },
    ]) {
      const matrix = validMatrix() as any;
      matrix.consumer.rules = [rule];
      expect(() => validateAccessMatrix(matrix)).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("consumer rules must be UC")]),
        }),
      );
    }

    const testerEdit = validMatrix() as any;
    testerEdit.roles.tester.rules = [
      {
        kind: "folder-acl",
        accessLevel: "CAN_EDIT",
        target: "/Workspace/edp/{datasetTag}",
        environments: "*",
      },
    ];
    expect(() => validateAccessMatrix(testerEdit)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.stringContaining("tester folder access is CAN_READ"),
        ]),
      }),
    );

    for (const [principal, rule] of [
      [
        "tester",
        {
          kind: "job-acl",
          accessLevel: "CAN_MANAGE_RUN",
          target: "dataset-job:{datasetTag}",
          environments: "*",
        },
      ],
      [
        "developer",
        {
          kind: "folder-acl",
          accessLevel: "CAN_EDIT",
          target: "/Workspace/edp/{datasetTag}",
          environments: "*",
        },
      ],
      [
        "manager",
        {
          kind: "job-acl",
          accessLevel: "CAN_MANAGE_RUN",
          target: "dataset-job:{datasetTag}",
          environments: "*",
        },
      ],
    ] as const) {
      const matrix = validMatrix() as any;
      matrix.roles[principal].rules = [rule];
      expect(() => validateAccessMatrix(matrix), principal).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("approved access levels")]),
        }),
      );
    }
  });

  it("allows job CAN_MANAGE only for the labelled Maintainer rule", () => {
    expect(validateAccessMatrix(validMatrix()).roles.manager.rules).toHaveLength(1);
    for (const principal of ["tester", "developer", "consumer"] as const) {
      const matrix = validMatrix() as any;
      matrix[principal === "consumer" ? "consumer" : "roles"][principal]?.rules?.push(
        clone(matrix.roles.manager.rules[0]),
      );
      if (principal === "consumer")
        matrix.consumer.rules.push(clone(matrix.roles.manager.rules[0]));
      expect(() => validateAccessMatrix(matrix), principal).toThrowError(AccessMatrixError);
    }
    const unlabelled = validMatrix();
    delete (unlabelled.roles.manager.rules[0] as any).label;
    expect(() => validateAccessMatrix(unlabelled)).toThrowError(AccessMatrixError);
  });

  it("expands roles monotonically without mutating input and keeps consumers isolated", () => {
    const input = validMatrix();
    const before = clone(input);
    const matrix = validateAccessMatrix(input);

    expect(matrix.roles.tester.expandedRules).toHaveLength(1);
    expect(matrix.roles.developer.expandedRules).toHaveLength(2);
    expect(matrix.roles.manager.expandedRules).toHaveLength(3);
    expect(matrix.consumer.rules).toHaveLength(1);
    expect(input).toEqual(before);
  });

  it("refuses tester writes and consumer writes or bronze access", () => {
    const testerWrite = validMatrix();
    testerWrite.roles.tester.rules[0]!.privilege = "MODIFY";
    expect(() => validateAccessMatrix(testerWrite)).toThrowError(AccessMatrixError);

    const consumerWrite = validMatrix();
    consumerWrite.consumer.rules[0]!.privilege = "CREATE TABLE";
    consumerWrite.consumer.rules[0]!.directSecurableType = "schema";
    expect(() => validateAccessMatrix(consumerWrite)).toThrowError(AccessMatrixError);

    const consumerBronze = validMatrix();
    consumerBronze.consumer.rules[0]!.layers = ["bronze", "gold"];
    expect(() => validateAccessMatrix(consumerBronze)).toThrowError(AccessMatrixError);
  });
});

describe("configuration/access-matrix-status", () => {
  const request = () =>
    new Request("https://app.example/api/reads/configuration/access-matrix-status");
  const deps = (isAdmin: boolean, loader = () => loadAccessMatrix({})): DeltaApiDeps => ({
    registry: createAppRegistry(undefined, undefined, loader),
    runner: { reader: () => vi.fn() } as any,
    names: createStoreNames("catalog", ""),
    serves: ["tenant", "staff"],
    resolveUser: async () => ({
      principalId: "123",
      displayName: "Person",
      email: "person@example.gov",
      isAdmin,
      onboardingReviewerRoles: [],
    }),
    requirePrivacyAcknowledgment: async () => undefined,
  });

  it("returns only source, approval status and digest to EDP staff", async () => {
    const response = await handleDeltaApiRequest(request(), deps(true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: "repo-default",
      approvalStatus: "approved",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("does not disclose status to a non-admin", async () => {
    const response = await handleDeltaApiRequest(request(), deps(false));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toMatch(/digest|source|approval/i);
  });

  it("logs private details but returns only the generic matrix error code", async () => {
    const error = new AccessMatrixError("access-matrix-invalid", [
      'roles.tester.rules.0.privilege: forbidden value "MANAGE"',
    ]);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleDeltaApiRequest(
      request(),
      deps(true, () => {
        throw error;
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "access-matrix-invalid" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("roles.tester.rules.0"));
    log.mockRestore();
  });

  it("does not load the matrix for unrelated routes", async () => {
    const loader = vi.fn(() => {
      throw new Error("bad matrix");
    });
    const response = await handleDeltaApiRequest(
      new Request("https://app.example/api/reads/missing/read"),
      deps(true, loader),
    );
    expect(response.status).toBe(404);
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("access matrix deploy contract", () => {
  it("maps the matrix and false-by-default draft switch to server-only environments", () => {
    const bundle = load(readFileSync(join(process.cwd(), "databricks.yml"), "utf8")) as any;
    expect(bundle.variables.access_matrix_json.default).toBe("none");
    expect(bundle.variables.access_matrix_allow_draft.default).toBe("false");
    expect(bundle.resources.apps.edp_vending_machine.config.env).toContainEqual({
      name: "EDP_ACCESS_MATRIX_JSON",
      value: "${var.access_matrix_json}",
    });
    expect(bundle.resources.apps.edp_vending_machine.config.env).toContainEqual({
      name: "EDP_ACCESS_MATRIX_ALLOW_DRAFT",
      value: "${var.access_matrix_allow_draft}",
    });
  });

  it("ships a stdin helper that computes an approved override's loader digest", () => {
    const override = validMatrix();
    override.metadata.decision = "IRS UAT override";
    const expected = loadAccessMatrix({ accessMatrixJson: JSON.stringify(override) }).digest;
    const result = spawnSync(process.execPath, ["scripts/access-matrix-digest.ts"], {
      cwd: process.cwd(),
      input: JSON.stringify(override),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });
});
