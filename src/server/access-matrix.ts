import { createHash } from "node:crypto";
import { z } from "zod";

import { ZOD3_PARSE_OPTIONS, zod3IssueMessage } from "../zod-compat.ts";
import repoDefault from "../data/datasets/access-matrix.json" with { type: "json" };

export type ApprovalStatus = "approved" | "draft";
export type AccessMatrixSource = "repo-default" | "deploy-override";

const selector = z.union([z.literal("*"), z.array(z.string().trim().min(1)).min(1)]);
const baseRule = {
  target: z.string().trim().min(1),
  environments: selector,
};
const ucRule = z
  .object({
    kind: z.literal("uc"),
    privilege: z.string().trim().min(1),
    grantPointType: z.string().trim().min(1),
    directSecurableType: z.string().trim().min(1),
    target: baseRule.target,
    layers: selector,
    environments: selector,
  })
  .strict();
const jobRule = z
  .object({
    kind: z.literal("job-acl"),
    accessLevel: z.string().trim().min(1),
    ...baseRule,
    label: z.string().trim().min(1).optional(),
  })
  .strict();
const folderRule = z
  .object({
    kind: z.literal("folder-acl"),
    accessLevel: z.string().trim().min(1),
    ...baseRule,
  })
  .strict();
const workspaceRule = z
  .object({
    kind: z.literal("workspace-assignment"),
    accessLevel: z.string().trim().min(1),
    ...baseRule,
  })
  .strict();
const ruleSchema = z.discriminatedUnion("kind", [ucRule, jobRule, folderRule, workspaceRule]);
const ruleSet = z.object({ rules: z.array(ruleSchema).min(1) }).strict();
const roleRuleSet = ruleSet
  .extend({ inherits: z.enum(["tester", "developer"]).optional() })
  .strict();
const consumerRuleSet = ruleSet
  .extend({
    certificationStatuses: z
      .array(z.enum(["certified", "deprecated"]))
      .length(2)
      .refine((values) => new Set(values).size === 2, "must contain certified and deprecated"),
  })
  .strict();
const matrixSchema = z
  .object({
    metadata: z
      .object({
        approvalStatus: z.enum(["approved", "draft"]),
        decision: z.string().trim().min(1),
        approvedAt: z.iso.date().optional(),
      })
      .strict(),
    layers: z.array(z.enum(["bronze", "silver", "gold"])).min(1),
    environments: z.array(z.enum(["dev", "test", "preprod", "prod", "analytics-prod"])).min(1),
    roles: z.object({ tester: roleRuleSet, developer: roleRuleSet, manager: roleRuleSet }).strict(),
    consumer: consumerRuleSet,
    sensitiveAccess: ruleSet,
  })
  .strict();

export type AccessRule = z.infer<typeof ruleSchema>;
type ParsedMatrix = z.infer<typeof matrixSchema>;
export type ValidatedAccessMatrix = Omit<ParsedMatrix, "roles"> & {
  roles: {
    [K in keyof ParsedMatrix["roles"]]: ParsedMatrix["roles"][K] & {
      expandedRules: AccessRule[];
    };
  };
};

export interface LoadedAccessMatrix {
  matrix: ValidatedAccessMatrix;
  source: AccessMatrixSource;
  approvalStatus: ApprovalStatus;
  decision: string;
  digest: string;
}

export class AccessMatrixError extends Error {
  readonly code: "access-matrix-invalid" | "access-matrix-draft-not-permitted";
  readonly issues: string[];

  constructor(
    code: "access-matrix-invalid" | "access-matrix-draft-not-permitted",
    issues: string[],
  ) {
    super(code);
    this.name = "AccessMatrixError";
    this.code = code;
    this.issues = issues;
  }
}

const UC_TRIPLES = new Set([
  "USE CATALOG|catalog|catalog",
  "USE SCHEMA|schema|schema",
  "SELECT|schema|table",
  "SELECT|schema|view",
  "SELECT|schema|materialized-view",
  "READ VOLUME|schema|volume",
  "EXECUTE|schema|function",
  "MODIFY|schema|table",
  "CREATE TABLE|schema|schema",
  "CREATE MATERIALIZED VIEW|schema|schema",
  "CREATE FUNCTION|schema|schema",
  "CREATE VOLUME|schema|schema",
  "WRITE VOLUME|schema|volume",
]);
const WRITE_PRIVILEGES = new Set([
  "MODIFY",
  "CREATE TABLE",
  "CREATE MATERIALIZED VIEW",
  "CREATE FUNCTION",
  "CREATE VOLUME",
  "WRITE VOLUME",
]);
const FORBIDDEN_UC = new Set([
  "MANAGE",
  "ALL PRIVILEGES",
  "OWNER",
  "OWNERSHIP",
  "TRANSFER OWNERSHIP",
  "APPLY TAG",
  "*",
]);
const ACL_LEVELS = {
  "job-acl": new Set(["CAN_VIEW", "CAN_MANAGE_RUN", "CAN_MANAGE"]),
  "folder-acl": new Set(["CAN_READ", "CAN_EDIT", "CAN_RUN"]),
  "workspace-assignment": new Set(["USER"]),
} as const;
const KNOWN_LAYERS = new Set(["bronze", "silver", "gold"]);
const KNOWN_ENVIRONMENTS = new Set(["dev", "test", "preprod", "prod", "analytics-prod"]);

const normalizedToken = (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

function normalizedRuleSignature(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return canonical(value);
  const rule = structuredClone(value) as Record<string, unknown>;
  for (const key of ["privilege", "accessLevel"]) {
    if (typeof rule[key] === "string") rule[key] = normalizedToken(rule[key]);
  }
  for (const key of ["grantPointType", "directSecurableType"]) {
    if (typeof rule[key] === "string") rule[key] = rule[key].trim().toLowerCase();
  }
  for (const key of ["target", "label"]) {
    if (typeof rule[key] === "string") rule[key] = rule[key].trim();
  }
  for (const key of ["layers", "environments"]) {
    if (Array.isArray(rule[key]))
      rule[key] = [
        ...new Set(rule[key].map((item) => (typeof item === "string" ? item.trim() : item))),
      ].sort();
  }
  return canonical(rule);
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type MatrixPrincipal = "tester" | "developer" | "manager" | "consumer" | "sensitiveAccess";

function checkRuleCandidate(
  rule: Record<string, unknown>,
  path: string,
  principal: MatrixPrincipal,
  configuredLayers: ReadonlySet<string>,
  configuredEnvironments: ReadonlySet<string>,
  issues: string[],
): void {
  const kind = rule["kind"];
  const privilegeValue = rule["privilege"];
  const accessLevelValue = rule["accessLevel"];
  const accessLevel =
    typeof accessLevelValue === "string" ? normalizedToken(accessLevelValue) : undefined;
  const grantPoint = rule["grantPointType"];
  const directSecurable = rule["directSecurableType"];
  const normalizedGrantPoint =
    typeof grantPoint === "string" ? grantPoint.trim().toLowerCase() : undefined;
  const target = rule["target"];
  const normalizedTarget = typeof target === "string" ? target.trim() : undefined;
  const expectedTarget =
    kind === "uc"
      ? normalizedGrantPoint === "catalog"
        ? "{env.catalog}"
        : "{env.catalog}.{datasetTag}_{layer}"
      : kind === "job-acl"
        ? "dataset-job:{datasetTag}"
        : kind === "folder-acl"
          ? "/Workspace/edp/{datasetTag}"
          : kind === "workspace-assignment"
            ? "workspace:{environment}"
            : undefined;

  if (expectedTarget && normalizedTarget !== expectedTarget)
    issues.push(`${path}.target: must be exactly ${expectedTarget}`);
  if (principal === "consumer" && kind !== "uc")
    issues.push(`${path}.kind: consumer rules must be UC`);
  if (kind === "workspace-assignment" && principal !== "sensitiveAccess")
    issues.push(`${path}.kind: workspace-assignment is sensitiveAccess-only`);
  if (
    principal === "sensitiveAccess" &&
    (kind !== "workspace-assignment" || accessLevel !== "USER")
  )
    issues.push(`${path}: sensitiveAccess accepts only workspace-assignment USER`);
  if (
    (principal === "tester" || principal === "developer" || principal === "manager") &&
    (kind === "job-acl" || kind === "folder-acl")
  ) {
    const approved =
      kind === "folder-acl"
        ? accessLevel === "CAN_READ"
        : principal === "manager"
          ? accessLevel === "CAN_MANAGE"
          : accessLevel === "CAN_VIEW";
    if (!approved) {
      issues.push(
        principal === "tester" && kind === "folder-acl"
          ? `${path}.accessLevel: tester folder access is CAN_READ only`
          : `${path}.accessLevel: ${principal} ${kind} must use its approved access levels`,
      );
    }
  }

  const environments = rule["environments"];
  if (Array.isArray(environments)) {
    for (const environment of environments)
      if (typeof environment === "string") {
        const normalized = environment.trim();
        if (!KNOWN_ENVIRONMENTS.has(normalized))
          issues.push(`${path}.environments: unknown ${environment}`);
        else if (!configuredEnvironments.has(normalized))
          issues.push(`${path}.environments: ${environment} is not declared by the matrix`);
      }
  }

  if (kind === "uc" && typeof privilegeValue === "string") {
    const privilege = normalizedToken(privilegeValue);
    if (FORBIDDEN_UC.has(privilege))
      issues.push(`${path}.privilege: forbidden value ${JSON.stringify(privilegeValue)}`);
    else if (normalizedGrantPoint && typeof directSecurable === "string") {
      const triple = `${privilege}|${normalizedGrantPoint}|${directSecurable.trim().toLowerCase()}`;
      if (!UC_TRIPLES.has(triple)) issues.push(`${path}: unsupported UC triple ${triple}`);
    }
    if (principal === "tester" && WRITE_PRIVILEGES.has(privilege))
      issues.push(`${path}.privilege: tester write is forbidden`);
    if (principal === "consumer" && WRITE_PRIVILEGES.has(privilege))
      issues.push(`${path}.privilege: consumer write is forbidden`);
    const layers = rule["layers"];
    if (
      principal === "consumer" &&
      (layers === "*" ||
        (Array.isArray(layers) &&
          layers.some((layer) => typeof layer === "string" && layer.trim() === "bronze")))
    )
      issues.push(`${path}.layers: consumer bronze access is forbidden`);
    if (Array.isArray(layers)) {
      for (const layer of layers)
        if (typeof layer === "string") {
          const normalized = layer.trim();
          if (!KNOWN_LAYERS.has(normalized)) issues.push(`${path}.layers: unknown ${layer}`);
          else if (!configuredLayers.has(normalized))
            issues.push(`${path}.layers: ${layer} is not declared by the matrix`);
        }
    }
    return;
  }

  if (
    (kind === "job-acl" || kind === "folder-acl" || kind === "workspace-assignment") &&
    accessLevel
  ) {
    if (!ACL_LEVELS[kind].has(accessLevel as never))
      issues.push(
        `${path}.accessLevel: unsupported ${kind} level ${JSON.stringify(accessLevelValue)}`,
      );
    if (accessLevel.includes("OWNER"))
      issues.push(`${path}.accessLevel: owner levels are forbidden`);
    if (kind === "job-acl" && accessLevel === "CAN_MANAGE") {
      if (principal !== "manager")
        issues.push(`${path}.accessLevel: CAN_MANAGE is Maintainer-only`);
      if (typeof rule["label"] !== "string" || !rule["label"].trim())
        issues.push(`${path}.label: Maintainer CAN_MANAGE must be labelled`);
    }
  }
}

function rawSemanticIssues(input: unknown): string[] {
  const issues: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return issues;
  const raw = input as Record<string, unknown>;
  const rawRoles = asRecord(raw["roles"]) ?? {};
  const declaredLayers = Array.isArray(raw["layers"])
    ? new Set(
        raw["layers"]
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim()),
      )
    : KNOWN_LAYERS;
  const declaredEnvironments = Array.isArray(raw["environments"])
    ? new Set(
        raw["environments"]
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim()),
      )
    : KNOWN_ENVIRONMENTS;
  const metadata = asRecord(raw["metadata"]);
  if (metadata?.["approvalStatus"] === "approved" && !metadata["approvedAt"])
    issues.push("metadata.approvedAt: approved matrices require an approval date");
  const groups: [string, unknown][] = [
    ...Object.entries(rawRoles).map(
      ([name, value]) => [`roles.${name}`, value] as [string, unknown],
    ),
    ["consumer", raw["consumer"]],
    ["sensitiveAccess", raw["sensitiveAccess"]],
  ];
  for (const [groupPath, group] of groups) {
    const groupRecord = asRecord(group);
    const seen = new Set<string>();
    const rules = Array.isArray(groupRecord?.["rules"]) ? groupRecord["rules"] : [];
    for (const [index, rule] of rules.entries()) {
      const path = `${groupPath}.rules.${index}`;
      const signature = normalizedRuleSignature(rule);
      if (seen.has(signature)) issues.push(`${path}: duplicate rule`);
      seen.add(signature);
      const ruleRecord = asRecord(rule);
      if (!ruleRecord) continue;
      const principal = groupPath.startsWith("roles.")
        ? groupPath.slice("roles.".length)
        : groupPath;
      if (
        principal === "tester" ||
        principal === "developer" ||
        principal === "manager" ||
        principal === "consumer" ||
        principal === "sensitiveAccess"
      )
        checkRuleCandidate(
          ruleRecord,
          path,
          principal,
          declaredLayers,
          declaredEnvironments,
          issues,
        );
    }
  }
  for (const role of ["tester", "developer", "manager"]) {
    const visited = new Set<string>([role]);
    let parent = asRecord(rawRoles[role])?.["inherits"];
    while (typeof parent === "string") {
      if (visited.has(parent)) {
        issues.push(`roles.${role}.inherits: inheritance cycle`);
        break;
      }
      visited.add(parent);
      parent = asRecord(rawRoles[parent])?.["inherits"];
    }
  }
  if (asRecord(rawRoles["tester"])?.["inherits"] !== undefined)
    issues.push("roles.tester.inherits: tester cannot inherit another role");
  if (asRecord(rawRoles["developer"])?.["inherits"] !== "tester")
    issues.push("roles.developer.inherits: must be tester");
  if (asRecord(rawRoles["manager"])?.["inherits"] !== "developer")
    issues.push("roles.manager.inherits: must be developer");
  return issues;
}

function normalizedRule(rule: AccessRule): AccessRule {
  if (rule.kind === "uc") {
    return {
      ...rule,
      privilege: normalizedToken(rule.privilege),
      grantPointType: rule.grantPointType.trim().toLowerCase(),
      directSecurableType: rule.directSecurableType.trim().toLowerCase(),
    };
  }
  return { ...rule, accessLevel: normalizedToken(rule.accessLevel) };
}

function digestableMatrix(matrix: ValidatedAccessMatrix): ParsedMatrix {
  const withoutExpansion = <T extends { expandedRules: AccessRule[] }>(role: T) => {
    const { expandedRules: _expandedRules, ...source } = role;
    return source;
  };
  return {
    ...structuredClone(matrix),
    roles: {
      tester: withoutExpansion(matrix.roles.tester),
      developer: withoutExpansion(matrix.roles.developer),
      manager: withoutExpansion(matrix.roles.manager),
    },
  };
}

/** Stable SHA-256 over the validated source policy (computed inheritance excluded). */
export function accessMatrixDigest(matrix: ValidatedAccessMatrix): string {
  return createHash("sha256")
    .update(canonical(digestableMatrix(matrix)))
    .digest("hex");
}

/** Validate and normalize one complete matrix without mutating its input. */
export function validateAccessMatrix(input: unknown): ValidatedAccessMatrix {
  const result = matrixSchema.safeParse(input, ZOD3_PARSE_OPTIONS);
  const issues = [
    ...(!result.success
      ? result.error.issues.map(
          (issue) => `${issue.path.join(".") || "matrix"}: ${zod3IssueMessage(issue)}`,
        )
      : []),
    ...rawSemanticIssues(input),
  ];
  if (!result.success) throw new AccessMatrixError("access-matrix-invalid", [...new Set(issues)]);
  const parsed = result.data;
  if (issues.length) throw new AccessMatrixError("access-matrix-invalid", [...new Set(issues)]);

  const normalized = structuredClone(parsed);
  normalized.roles.tester.rules = normalized.roles.tester.rules.map(normalizedRule);
  normalized.roles.developer.rules = normalized.roles.developer.rules.map(normalizedRule);
  normalized.roles.manager.rules = normalized.roles.manager.rules.map(normalizedRule);
  normalized.consumer.rules = normalized.consumer.rules.map(normalizedRule);
  normalized.sensitiveAccess.rules = normalized.sensitiveAccess.rules.map(normalizedRule);
  const tester = structuredClone(normalized.roles.tester.rules);
  const developer = [...tester, ...structuredClone(normalized.roles.developer.rules)];
  const manager = [...developer, ...structuredClone(normalized.roles.manager.rules)];
  return {
    ...normalized,
    roles: {
      tester: { ...normalized.roles.tester, expandedRules: tester },
      developer: { ...normalized.roles.developer, expandedRules: developer },
      manager: { ...normalized.roles.manager, expandedRules: manager },
    },
  };
}

export interface AccessMatrixEnv {
  accessMatrixJson?: string | undefined;
  allowDraft?: string | undefined;
}

/** Load the approved repo policy or one complete deploy replacement. */
export function loadAccessMatrix(env: AccessMatrixEnv): LoadedAccessMatrix {
  const rawOverride = env.accessMatrixJson?.trim();
  const source: AccessMatrixSource =
    !rawOverride || rawOverride === "none" ? "repo-default" : "deploy-override";
  let sourceValue: unknown = repoDefault;
  if (source === "deploy-override") {
    try {
      sourceValue = JSON.parse(rawOverride!);
    } catch (error) {
      throw new AccessMatrixError("access-matrix-invalid", [
        `EDP_ACCESS_MATRIX_JSON: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      ]);
    }
  }
  const matrix = validateAccessMatrix(sourceValue);
  if (matrix.metadata.approvalStatus === "draft" && env.allowDraft !== "true") {
    throw new AccessMatrixError("access-matrix-draft-not-permitted", [
      "metadata.approvalStatus: draft requires EDP_ACCESS_MATRIX_ALLOW_DRAFT=true",
    ]);
  }
  return {
    matrix,
    source,
    approvalStatus: matrix.metadata.approvalStatus,
    decision: matrix.metadata.decision,
    digest: accessMatrixDigest(matrix),
  };
}

/** Compute exactly the digest an approved JSON override will report after deployment. */
export function digestAccessMatrixOverride(accessMatrixJson: string): string {
  return loadAccessMatrix({ accessMatrixJson }).digest;
}
