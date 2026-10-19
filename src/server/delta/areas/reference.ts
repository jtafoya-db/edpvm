/**
 * #72's reference reads, behind allow-listed endpoints: the discovery
 * catalogue (`catalog.*` except domains), the signed-in person's access
 * (`access.*`), and for EDP staff only, the tenant financials
 * (`admin.tenants`) and the admin pipeline (`requests.pipeline*`).
 *
 * These replace the browser posting SQL. Each read is a fixed query; the only
 * input is the session, so "my access" is always the caller's own. A read
 * that isn't the shared catalogue or the caller's own data is staff-only:
 * hiding a screen isn't authorization.
 */
import { z } from "zod";

import type {
  AccessBundle,
  BundleComponentType,
  BundleRequirement,
  DataAsset,
  MyAccess,
  OnboardingPersona,
  PipelineEntry,
  SourceSystem,
  Tenant,
} from "../../../data/types";
import type { Registry } from "../registry.ts";
import { requireEdpStaff } from "../registry.ts";
import type { DeltaSnapshot, SnapshotRow } from "../snapshot-cache.ts";

const noQuery = z.object({}).strict();
type Row = Record<string, unknown>;
const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

interface CatalogBootstrap {
  domains: [];
  datasets: DataAsset[];
  bundles: AccessBundle[];
  systems: SourceSystem[];
  personas: OnboardingPersona[];
  tenants: Tenant[] | null;
  tenantsError?: {
    code: "tenant-rollup-unavailable";
    message: string;
  };
}

const systemsFrom = (rows: Row[]): SourceSystem[] =>
  rows.map((r) => ({
    id: str(r["id"]),
    name: str(r["name"]),
    short: str(r["short"]),
    org: str(r["org"]),
    type: str(r["type"]),
  }));

const bundlesFrom = (bundles: Row[], components: Row[]): AccessBundle[] =>
  bundles.map((r) => ({
    id: str(r["id"]),
    name: str(r["name"]),
    persona: str(r["persona"]),
    color: str(r["color"]),
    description: str(r["description"]),
    sla: str(r["sla"]),
    bearsRequired: r["bears_required"] === true,
    approvalModel: str(r["approval_model"]),
    approvers: list(r["approvers"]),
    prerequisites: list(r["prerequisites"]),
    requestable: r["requestable"] === true,
    components: components
      .filter((c) => c["bundle_id"] === r["id"])
      .map((c) => ({
        type: str(c["component_type"]) as BundleComponentType,
        label: str(c["label"]),
        scope: str(c["scope"]),
      })),
    unlocks: list(r["unlocks"]),
  }));

const datasetsFrom = (datasets: Row[], required: Row[], lineage: Row[]): DataAsset[] =>
  datasets.map((r) => ({
    id: str(r["id"]),
    assetType: str(r["asset_type"]) as DataAsset["assetType"],
    name: str(r["name"]),
    businessName: str(r["business_name"]),
    domain: str(r["domain"]),
    system: str(r["system"]),
    classification: str(r["classification"]),
    certification: str(r["certification"]),
    usageType: str(r["usage_type"]),
    freshness: str(r["freshness"]),
    popularity: num(r["popularity"]),
    owner: str(r["owner"]),
    steward: str(r["steward"]),
    catalog: str(r["catalog"]),
    schema: str(r["schema"]),
    object: str(r["object"]),
    workspace: str(r["workspace"]),
    tags: list(r["tags"]),
    description: str(r["description"]),
    requiredBundles: required
      .filter((b) => b["dataset_id"] === r["id"])
      .map((b) => ({
        bundle: str(b["bundle"]),
        requirement: str(b["requirement"]) as BundleRequirement,
        note: str(b["note"]),
      })),
    unlocks: [],
    lineage: lineage.filter((l) => l["dataset_id"] === r["id"]).map((l) => str(l["node"])),
  }));

const personasFrom = (rows: Row[]): OnboardingPersona[] =>
  rows.map((r) => ({
    id: str(r["id"]),
    label: str(r["label"]),
    desc: str(r["desc"]),
    bundles: list(r["bundles"]),
  }));

const tenantsFrom = (rows: Row[]): Tenant[] =>
  rows.map((r) => ({
    id: str(r["id"]),
    name: str(r["name"]),
    lead: str(r["lead"]),
    fyBudget: num(r["fy_budget"]),
    fytdSpend: num(r["fytd_spend"]),
    mtdSpend: num(r["mtd_spend"]),
    forecastFy: num(r["forecast_fy"]),
    dbusMonth: num(r["dbus_month"]),
    storageTb: num(r["storage_tb"]),
    users: num(r["users"]),
    datasets: num(r["datasets"]),
    openItems: num(r["open_items"]),
  }));

const snapshotRows = (snapshot: DeltaSnapshot, schema: string, table: string): SnapshotRow[] =>
  snapshot.table(schema, table);

export function registerReferenceArea(registry: Registry): void {
  registry.read<unknown, CatalogBootstrap>({
    area: "catalog",
    name: "bootstrap",
    app: "tenant",
    query: noQuery,
    snapshot({ snapshot, user }) {
      return {
        domains: [],
        systems: systemsFrom(snapshotRows(snapshot, "catalog", "source_systems")),
        bundles: bundlesFrom(
          snapshotRows(snapshot, "catalog", "access_bundles"),
          snapshotRows(snapshot, "catalog", "bundle_components"),
        ),
        datasets: datasetsFrom(
          snapshotRows(snapshot, "catalog", "datasets"),
          snapshotRows(snapshot, "catalog", "dataset_required_bundles"),
          snapshotRows(snapshot, "catalog", "dataset_lineage"),
        ),
        personas: personasFrom(snapshotRows(snapshot, "catalog", "onboarding_personas")),
        tenants: user.isAdmin ? tenantsFrom(snapshotRows(snapshot, "admin", "tenants")) : [],
      };
    },
    async run({ names, read, user }) {
      const tenants = user.isAdmin
        ? read<Row>({
            statement: `SELECT id, name, lead, fy_budget, fytd_spend, mtd_spend, forecast_fy, dbus_month, storage_tb, users, datasets, open_items FROM ${names.table("admin", "tenants")} ORDER BY name`,
          }).catch(() => {
            console.error(
              "[delta-api] catalog/bootstrap tenant rollup failed; returning shared catalog without staff tenants.",
            );
            return null;
          })
        : Promise.resolve([]);
      const [systems, bundles, components, datasets, required, lineage, personas, tenantRows] =
        await Promise.all([
          read<Row>({
            statement: `SELECT id, name, short, org, type FROM ${names.table("catalog", "source_systems")} ORDER BY name`,
          }),
          read<Row>({
            statement: `SELECT id, name, persona, color, description, sla, bears_required, approval_model, approvers, prerequisites, requestable, unlocks FROM ${names.table("catalog", "access_bundles")} ORDER BY name`,
          }),
          read<Row>({
            statement: `SELECT bundle_id, component_type, label, scope FROM ${names.table("catalog", "bundle_components")}`,
          }),
          read<Row>({
            statement: `SELECT id, asset_type, name, business_name, domain, system, classification, certification, usage_type, freshness, popularity, owner, steward, catalog, schema, object, workspace, tags, description FROM ${names.table("catalog", "datasets")} ORDER BY name`,
          }),
          read<Row>({
            statement: `SELECT dataset_id, bundle, requirement, note FROM ${names.table("catalog", "dataset_required_bundles")}`,
          }),
          read<Row>({
            statement: `SELECT dataset_id, step_order, node FROM ${names.table("catalog", "dataset_lineage")} ORDER BY dataset_id, step_order`,
          }),
          read<Row>({
            statement: `SELECT id, label, \`desc\`, bundles FROM ${names.table("catalog", "onboarding_personas")} ORDER BY label`,
          }),
          tenants,
        ]);
      return {
        // The domain taxonomy is still checked-in configuration (#102 will move
        // it behind governed tags); the Delta adapter fills this from the seed.
        domains: [],
        systems: systemsFrom(systems),
        bundles: bundlesFrom(bundles, components),
        datasets: datasetsFrom(datasets, required, lineage),
        personas: personasFrom(personas),
        tenants: tenantRows ? tenantsFrom(tenantRows) : null,
        ...(tenantRows
          ? {}
          : {
              tenantsError: {
                code: "tenant-rollup-unavailable" as const,
                message: "Tenant financials are temporarily unavailable.",
              },
            }),
      };
    },
  });

  registry.read<unknown, SourceSystem[]>({
    area: "catalog",
    name: "systems",
    app: "tenant",
    query: noQuery,
    snapshot: ({ snapshot }) => systemsFrom(snapshotRows(snapshot, "catalog", "source_systems")),
    run: async ({ names, read }) =>
      systemsFrom(
        await read<Row>({
          statement: `SELECT id, name, short, org, type FROM ${names.table("catalog", "source_systems")} ORDER BY name`,
        }),
      ),
  });

  // No `catalog/domains` read: the business domain list is configuration
  // served from the checked-in seed in every mode (see the Delta adapter's
  // `domains`), until the governed domain tag (#102) lands.

  registry.read<unknown, AccessBundle[]>({
    area: "catalog",
    name: "bundles",
    app: "tenant",
    query: noQuery,
    snapshot: ({ snapshot }) =>
      bundlesFrom(
        snapshotRows(snapshot, "catalog", "access_bundles"),
        snapshotRows(snapshot, "catalog", "bundle_components"),
      ),
    async run({ names, read }) {
      const [bundles, components] = await Promise.all([
        read<Row>({
          statement: `SELECT id, name, persona, color, description, sla, bears_required, approval_model, approvers, prerequisites, requestable, unlocks FROM ${names.table("catalog", "access_bundles")} ORDER BY name`,
        }),
        read<Row>({
          statement: `SELECT bundle_id, component_type, label, scope FROM ${names.table("catalog", "bundle_components")}`,
        }),
      ]);
      return bundlesFrom(bundles, components);
    },
  });

  registry.read<unknown, DataAsset[]>({
    area: "catalog",
    name: "datasets",
    app: "tenant",
    query: noQuery,
    snapshot: ({ snapshot }) =>
      datasetsFrom(
        snapshotRows(snapshot, "catalog", "datasets"),
        snapshotRows(snapshot, "catalog", "dataset_required_bundles"),
        snapshotRows(snapshot, "catalog", "dataset_lineage"),
      ),
    async run({ names, read }) {
      const [datasets, required, lineage] = await Promise.all([
        read<Row>({
          statement: `SELECT id, asset_type, name, business_name, domain, system, classification, certification, usage_type, freshness, popularity, owner, steward, catalog, schema, object, workspace, tags, description FROM ${names.table("catalog", "datasets")} ORDER BY name`,
        }),
        read<Row>({
          statement: `SELECT dataset_id, bundle, requirement, note FROM ${names.table("catalog", "dataset_required_bundles")}`,
        }),
        read<Row>({
          statement: `SELECT dataset_id, step_order, node FROM ${names.table("catalog", "dataset_lineage")} ORDER BY dataset_id, step_order`,
        }),
      ]);
      return datasetsFrom(datasets, required, lineage);
    },
  });

  registry.read<unknown, OnboardingPersona[]>({
    area: "catalog",
    name: "personas",
    app: "tenant",
    query: noQuery,
    snapshot: ({ snapshot }) =>
      personasFrom(snapshotRows(snapshot, "catalog", "onboarding_personas")),
    run: async ({ names, read }) =>
      personasFrom(
        await read<Row>({
          statement: `SELECT id, label, \`desc\`, bundles FROM ${names.table("catalog", "onboarding_personas")} ORDER BY label`,
        }),
      ),
  });

  // Every tenant's budget, spend and forecast: EDP staff only.
  registry.read<unknown, Tenant[]>({
    area: "admin",
    name: "tenants",
    app: "staff",
    query: noQuery,
    authorize: requireEdpStaff,
    snapshot: ({ snapshot }) => tenantsFrom(snapshotRows(snapshot, "admin", "tenants")),
    run: async ({ names, read }) =>
      tenantsFrom(
        await read<Row>({
          statement: `SELECT id, name, lead, fy_budget, fytd_spend, mtd_spend, forecast_fy, dbus_month, storage_tb, users, datasets, open_items FROM ${names.table("admin", "tenants")} ORDER BY name`,
        }),
      ),
  });

  // The caller's own access only: the principal comes from the session.
  registry.read<unknown, MyAccess>({
    area: "access",
    name: "my-access",
    app: "tenant",
    query: noQuery,
    snapshot({ snapshot, user }) {
      const me = user.principalId;
      const workspaces = snapshotRows(snapshot, "access", "my_access_workspaces").filter(
        (row) => row["principal_id"] === me,
      );
      const bundles = snapshotRows(snapshot, "access", "my_access_bundles").filter(
        (row) => row["principal_id"] === me,
      );
      const summary = snapshotRows(snapshot, "access", "my_access").find(
        (row) => row["principal_id"] === me,
      );
      return {
        workspaces: workspaces.map((w) => ({
          name: str(w["name"]),
          entitlement: str(w["entitlement"]),
          since: str(w["since"]),
        })),
        bundles: bundles.map((b) => ({
          bundle: str(b["bundle"]),
          since: str(b["since"]),
          status: str(b["status"]),
          ...(b["expires"] ? { expires: str(b["expires"]) } : {}),
          ...(b["domain"] ? { domain: str(b["domain"]) } : {}),
        })),
        domains: list(summary?.["domains"]),
        recentAssets: list(summary?.["recent_assets"]),
      };
    },
    async run({ names, read, user }) {
      const me = { me: user.principalId };
      const [workspaces, bundles, summary] = await Promise.all([
        read<Row>({
          statement: `SELECT name, entitlement, since FROM ${names.table("access", "my_access_workspaces")} WHERE principal_id = :me ORDER BY name`,
          parameters: me,
        }),
        read<Row>({
          statement: `SELECT bundle, since, status, expires, domain FROM ${names.table("access", "my_access_bundles")} WHERE principal_id = :me ORDER BY bundle`,
          parameters: me,
        }),
        read<Row>({
          statement: `SELECT domains, recent_assets FROM ${names.table("access", "my_access")} WHERE principal_id = :me LIMIT 1`,
          parameters: me,
        }),
      ]);
      return {
        workspaces: workspaces.map((w) => ({
          name: str(w["name"]),
          entitlement: str(w["entitlement"]),
          since: str(w["since"]),
        })),
        bundles: bundles.map((b) => ({
          bundle: str(b["bundle"]),
          since: str(b["since"]),
          status: str(b["status"]),
          ...(b["expires"] ? { expires: str(b["expires"]) } : {}),
          ...(b["domain"] ? { domain: str(b["domain"]) } : {}),
        })),
        domains: list(summary[0]?.["domains"]),
        recentAssets: list(summary[0]?.["recent_assets"]),
      };
    },
  });

  registry.read<unknown, PipelineEntry[]>({
    area: "requests",
    name: "pipeline",
    app: "staff",
    query: noQuery,
    authorize: requireEdpStaff,
    snapshot({ snapshot }) {
      const entries = snapshotRows(snapshot, "requests", "pipeline");
      const decisions = snapshotRows(snapshot, "requests", "pipeline_decisions");
      return entries.map((r) => ({
        id: str(r["id"]),
        kind: str(r["kind"]) as PipelineEntry["kind"],
        title: str(r["title"]),
        tenant: str(r["tenant"]),
        requester: str(r["requester"]),
        submittedAt: str(r["submitted_at"]),
        state: str(r["state"]),
        stage: str(r["stage"]),
        nextAction: str(r["next_action"]),
        owner: str(r["owner"]),
        ageDays: num(r["age_days"]),
        jira: str(r["jira"]),
        jiraStatus: str(r["jira_status"]),
        monthlyCost: num(r["monthly_cost"]),
        roi: r["roi"] === null || r["roi"] === undefined ? null : Number(r["roi"]),
        sensitivity: str(r["sensitivity"]),
        pattern: str(r["pattern"]),
        delivery: str(r["delivery"]),
        decisions: decisions
          .filter((d) => d["pipeline_id"] === r["id"])
          .map((d) => ({
            at: str(d["at"]),
            actor: str(d["actor_username"]),
            decision: str(d["decision"]),
            note: str(d["note"]),
            jira: str(d["jira"]),
          })),
      }));
    },
    async run({ names, read }) {
      const [entries, decisions] = await Promise.all([
        read<Row>({
          statement: `SELECT id, kind, title, tenant, requester, submitted_at, state, stage, next_action, owner, age_days, jira, jira_status, monthly_cost, roi, sensitivity, pattern, delivery FROM ${names.table("requests", "pipeline")} ORDER BY submitted_at DESC`,
        }),
        read<Row>({
          statement: `SELECT pipeline_id, at, actor_username, decision, note, jira FROM ${names.table("requests", "pipeline_decisions")} ORDER BY at`,
        }),
      ]);
      return entries.map((r) => ({
        id: str(r["id"]),
        kind: str(r["kind"]) as PipelineEntry["kind"],
        title: str(r["title"]),
        tenant: str(r["tenant"]),
        requester: str(r["requester"]),
        submittedAt: str(r["submitted_at"]),
        state: str(r["state"]),
        stage: str(r["stage"]),
        nextAction: str(r["next_action"]),
        owner: str(r["owner"]),
        ageDays: num(r["age_days"]),
        jira: str(r["jira"]),
        jiraStatus: str(r["jira_status"]),
        monthlyCost: num(r["monthly_cost"]),
        roi: r["roi"] === null || r["roi"] === undefined ? null : Number(r["roi"]),
        sensitivity: str(r["sensitivity"]),
        pattern: str(r["pattern"]),
        delivery: str(r["delivery"]),
        decisions: decisions
          .filter((d) => d["pipeline_id"] === r["id"])
          .map((d) => ({
            at: str(d["at"]),
            actor: str(d["actor_username"]),
            decision: str(d["decision"]),
            note: str(d["note"]),
            jira: str(d["jira"]),
          })),
      }));
    },
  });
}
