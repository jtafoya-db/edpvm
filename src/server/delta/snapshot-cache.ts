import { createHash } from "node:crypto";

import type { ReadDefinition } from "./registry.ts";
import type { StoreNames } from "./sql-builder.ts";
import type { SqlStatement } from "./sql-client.ts";

export type SnapshotRow = Record<string, unknown>;
type TableKey = `${string}.${string}`;

export interface SnapshotTable {
  schema: string;
  table: string;
  area: string;
  orderBy?: string;
  loadColumns?: string[];
}

export interface SnapshotLoadStats {
  loadedAt: number;
  elapsedMs: number;
  rowCounts: Record<TableKey, number>;
  approxBytes: number;
}

export interface VersionCheckStats {
  checkedAt: number;
  elapsedMs: number;
  versions: Record<string, string>;
}

export interface DeltaSnapshot {
  table<T = SnapshotRow>(schema: string, table: string): T[];
  stats(): SnapshotLoadStats;
}

type ReadSql = <T extends object>(statement: SqlStatement) => Promise<T[]>;

const keyOf = (schema: string, table: string): TableKey => `${schema}.${table}`;
const sqlString = (expression: string) => `coalesce(CAST(${expression} AS STRING), '')`;
const actionMarker = (table: string, label: string) =>
  `(SELECT concat('${label}:', CAST(count(*) AS STRING), ':', ${sqlString("max(occurred_at)")}, ':', ${sqlString("max(action_id)")}) FROM ${table})`;
const digestMarker = (table: string, label: string, columns: string[]) => {
  const row = `concat_ws('|', ${columns.map((column) => sqlString(column)).join(", ")})`;
  const digest = `sha2(concat_ws('||', sort_array(collect_list(${row}))), 256)`;
  return `(SELECT concat('${label}:', CAST(count(*) AS STRING), ':', coalesce(${digest}, '')) FROM ${table})`;
};

function areaMarker(area: string, parts: string[]) {
  return `SELECT '${area}' AS area, concat_ws('|', ${parts.join(", ")}) AS version`;
}

export function snapshotMarkerStatement(names: StoreNames): string {
  const t = (schema: string, table: string) => names.table(schema, table);
  return [
    areaMarker("access", [
      digestMarker(t("access", "my_access"), "my_access", [
        "principal_id",
        "username",
        "domains",
        "recent_assets",
      ]),
      digestMarker(t("access", "my_access_bundles"), "my_access_bundles", [
        "principal_id",
        "username",
        "bundle",
        "since",
        "status",
        "expires",
        "domain",
      ]),
      digestMarker(t("access", "my_access_workspaces"), "my_access_workspaces", [
        "principal_id",
        "username",
        "name",
        "entitlement",
        "since",
      ]),
    ]),
    areaMarker("admin", [
      actionMarker(t("admin", "write_check_actions"), "write_check_actions"),
      digestMarker(t("admin", "tenants"), "tenants", [
        "id",
        "name",
        "lead",
        "fy_budget",
        "fytd_spend",
        "mtd_spend",
        "forecast_fy",
        "dbus_month",
        "storage_tb",
        "users",
        "datasets",
        "open_items",
      ]),
    ]),
    areaMarker("audit", [actionMarker(t("audit", "actions"), "audit_actions")]),
    areaMarker("catalog", [
      digestMarker(t("catalog", "source_systems"), "source_systems", [
        "id",
        "name",
        "short",
        "org",
        "type",
      ]),
      digestMarker(t("catalog", "access_bundles"), "access_bundles", [
        "id",
        "name",
        "persona",
        "color",
        "description",
        "sla",
        "bears_required",
        "approval_model",
        "approvers",
        "prerequisites",
        "requestable",
        "unlocks",
      ]),
      digestMarker(t("catalog", "bundle_components"), "bundle_components", [
        "bundle_id",
        "component_type",
        "label",
        "scope",
      ]),
      digestMarker(t("catalog", "datasets"), "datasets", [
        "id",
        "asset_type",
        "name",
        "business_name",
        "domain",
        "system",
        "classification",
        "certification",
        "usage_type",
        "freshness",
        "popularity",
        "owner",
        "steward",
        "catalog",
        "schema",
        "object",
        "workspace",
        "tags",
        "description",
      ]),
      digestMarker(t("catalog", "dataset_required_bundles"), "dataset_required_bundles", [
        "dataset_id",
        "bundle",
        "requirement",
        "note",
      ]),
      digestMarker(t("catalog", "dataset_lineage"), "dataset_lineage", [
        "dataset_id",
        "step_order",
        "node",
      ]),
      digestMarker(t("catalog", "onboarding_personas"), "onboarding_personas", [
        "id",
        "label",
        "`desc`",
        "bundles",
      ]),
    ]),
    areaMarker("change-list", [
      actionMarker(t("change_list", "change_list_entry_actions"), "change_list_entry_actions"),
      digestMarker(t("change_list", "change_list_approvals"), "change_list_approvals", [
        "id",
        "change_list_entry_id",
        "created_at",
        "created_by_principal_id",
        "caused_by_action_id",
      ]),
      digestMarker(t("change_list", "change_list_applications"), "change_list_applications", [
        "id",
        "change_list_entry_id",
        "method",
        "run_id",
        "outcome",
        "created_at",
        "created_by_principal_id",
        "caused_by_action_id",
      ]),
    ]),
    areaMarker("eir", [
      actionMarker(t("eir", "eir_actions"), "eir_actions"),
      actionMarker(t("eir", "eir_draft_saves"), "eir_draft_saves"),
      actionMarker(t("eir", "eir_evaluations"), "eir_evaluations"),
    ]),
    // EIR definitions (#201): their reads use SQL; the action log marks their publishes.
    areaMarker("eir-definitions", [
      actionMarker(t("eir", "eir_definition_actions"), "eir_definition_actions"),
    ]),
    areaMarker("initiatives", [
      actionMarker(t("initiatives", "initiative_actions"), "initiative_actions"),
      actionMarker(t("initiatives", "dataset_actions"), "dataset_actions"),
    ]),
    areaMarker("onboarding", [
      actionMarker(t("onboarding", "onboarding_request_actions"), "onboarding_request_actions"),
    ]),
    areaMarker("privacy", [
      actionMarker(t("privacy", "acknowledgments"), "privacy_acknowledgments"),
    ]),
    areaMarker("requests", [
      digestMarker(t("requests", "access_requests"), "access_requests", [
        "id",
        "title",
        "submitted_at",
        "status",
        "overall",
        "purpose",
        "stage_index",
        "requester_principal_id",
        "requester_username",
      ]),
      digestMarker(t("requests", "request_items"), "request_items", [
        "request_id",
        "item_order",
        "kind",
        "ref",
        "dataset_id",
        "bundle_id",
        "label",
        "sub",
      ]),
      digestMarker(t("requests", "request_steps"), "request_steps", [
        "request_id",
        "step_order",
        "system",
        "status",
        "detail",
        "ticket",
        "error",
      ]),
      digestMarker(t("requests", "pipeline"), "pipeline", [
        "id",
        "kind",
        "title",
        "tenant",
        "requester",
        "submitted_at",
        "state",
        "stage",
        "next_action",
        "owner",
        "age_days",
        "jira",
        "jira_status",
        "monthly_cost",
        "roi",
        "sensitivity",
        "pattern",
        "delivery",
      ]),
      digestMarker(t("requests", "pipeline_decisions"), "pipeline_decisions", [
        "pipeline_id",
        "at",
        "actor_principal_id",
        "actor_username",
        "decision",
        "note",
        "jira",
      ]),
      digestMarker(t("requests", "waiver_attestations"), "waiver_attestations", [
        "id",
        "request_id",
        "checklist_item_id",
        "attestor_principal_id",
        "attestor_username",
        "attested",
        "attested_at",
        "note",
        "source",
        "created_at",
        "superseded_at",
      ]),
    ]),
    areaMarker("teams", [
      actionMarker(t("teams", "dataset_owner_actions"), "dataset_owner_actions"),
      actionMarker(t("teams", "dataset_member_actions"), "dataset_member_actions"),
      actionMarker(t("teams", "email_binding_actions"), "email_binding_actions"),
    ]),
  ].join("\nUNION ALL\n");
}

export const SNAPSHOT_TABLES: SnapshotTable[] = [
  { area: "catalog", schema: "catalog", table: "source_systems", orderBy: "name" },
  { area: "catalog", schema: "catalog", table: "access_bundles", orderBy: "name" },
  { area: "catalog", schema: "catalog", table: "bundle_components" },
  { area: "catalog", schema: "catalog", table: "datasets", orderBy: "name" },
  { area: "catalog", schema: "catalog", table: "dataset_required_bundles" },
  {
    area: "catalog",
    schema: "catalog",
    table: "dataset_lineage",
    orderBy: "dataset_id, step_order",
  },
  { area: "catalog", schema: "catalog", table: "onboarding_personas", orderBy: "label" },
  { area: "admin", schema: "admin", table: "tenants", orderBy: "name" },
  { area: "admin", schema: "admin", table: "write_checks", orderBy: "created_at DESC" },
  { area: "admin", schema: "admin", table: "write_check_actions" },
  { area: "audit", schema: "audit", table: "actions" },
  { area: "access", schema: "access", table: "my_access" },
  { area: "access", schema: "access", table: "my_access_bundles", orderBy: "bundle" },
  { area: "access", schema: "access", table: "my_access_workspaces", orderBy: "name" },
  { area: "requests", schema: "requests", table: "access_requests", orderBy: "submitted_at DESC" },
  { area: "requests", schema: "requests", table: "request_items" },
  { area: "requests", schema: "requests", table: "request_steps" },
  { area: "requests", schema: "requests", table: "waiver_attestations" },
  { area: "requests", schema: "requests", table: "pipeline", orderBy: "submitted_at DESC" },
  { area: "requests", schema: "requests", table: "pipeline_decisions", orderBy: "at" },
  { area: "initiatives", schema: "initiatives", table: "initiatives" },
  { area: "initiatives", schema: "initiatives", table: "initiative_actions" },
  { area: "initiatives", schema: "initiatives", table: "datasets" },
  { area: "initiatives", schema: "initiatives", table: "dataset_actions" },
  {
    area: "onboarding",
    schema: "onboarding",
    table: "onboarding_requests",
    orderBy: "submitted_at DESC",
  },
  {
    area: "onboarding",
    schema: "onboarding",
    table: "onboarding_intake_datasets",
    orderBy: "onboarding_request_id, position",
  },
  {
    area: "onboarding",
    schema: "onboarding",
    table: "onboarding_intake_owners",
    orderBy: "onboarding_request_id, intake_dataset_id, position",
  },
  {
    area: "onboarding",
    schema: "onboarding",
    table: "onboarding_request_actions",
    orderBy: "onboarding_request_id, record_version, occurred_at",
  },
  { area: "teams", schema: "teams", table: "dataset_owners" },
  { area: "teams", schema: "teams", table: "dataset_owner_actions" },
  { area: "teams", schema: "teams", table: "dataset_members" },
  { area: "teams", schema: "teams", table: "dataset_member_actions" },
  { area: "teams", schema: "teams", table: "email_bindings" },
  { area: "teams", schema: "teams", table: "email_binding_actions" },
  {
    area: "change-list",
    schema: "change_list",
    table: "change_list_entries",
    orderBy: "display_number",
  },
  { area: "change-list", schema: "change_list", table: "change_list_entry_actions" },
  { area: "change-list", schema: "change_list", table: "change_list_approvals" },
  { area: "change-list", schema: "change_list", table: "change_list_applications" },
  { area: "eir", schema: "eir", table: "eirs" },
  { area: "eir", schema: "eir", table: "eir_submissions" },
  { area: "eir", schema: "eir", table: "eir_actions" },
  { area: "eir", schema: "eir", table: "eir_drafts" },
  {
    area: "eir",
    schema: "eir",
    table: "eir_draft_saves",
    loadColumns: ["action_id"],
  },
  { area: "eir", schema: "eir", table: "eir_evaluations" },
  // Only the action log: the versions table holds every definition's YAML (#201).
  { area: "eir-definitions", schema: "eir", table: "eir_definition_actions" },
  { area: "privacy", schema: "privacy", table: "acknowledgments" },
];

export const SNAPSHOT_AREAS = [...new Set(SNAPSHOT_TABLES.map((table) => table.area))].sort();

class MemorySnapshot implements DeltaSnapshot {
  private readonly rows: Map<TableKey, SnapshotRow[]>;
  private readonly loadStats: SnapshotLoadStats;

  constructor(rows: Map<TableKey, SnapshotRow[]>, loadStats: SnapshotLoadStats) {
    this.rows = rows;
    this.loadStats = loadStats;
  }

  table<T = SnapshotRow>(schema: string, table: string): T[] {
    return (this.rows.get(keyOf(schema, table)) ?? []) as T[];
  }

  stats(): SnapshotLoadStats {
    return this.loadStats;
  }
}

export interface SnapshotCacheOptions {
  tables?: SnapshotTable[];
  pollIntervalMs?: number;
  pollJitterRatio?: number;
  ownWriteReloadDelayMs?: number;
  activeWindowMs?: number;
  maxStaleMs?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export interface SnapshotCache {
  start(read: ReadSql, names: StoreNames): Promise<void>;
  reload(read: ReadSql, names: StoreNames, areas?: Iterable<string>): Promise<void>;
  snapshotForRead<R>(
    definition: ReadDefinition<unknown, R>,
    read: ReadSql,
    names: StoreNames,
    seenWatermarks?: Record<string, string>,
  ): Promise<DeltaSnapshot | undefined>;
  markersForAreas(
    read: ReadSql,
    names: StoreNames,
    areas: Iterable<string>,
  ): Promise<Record<string, string>>;
  invalidateAreas(areas: Iterable<string>): void;
  reloadSoon(read: ReadSql, names: StoreNames, areas: Iterable<string>): void;
  latestLoadStats(): SnapshotLoadStats | undefined;
  latestVersionCheck(): VersionCheckStats | undefined;
}

export const WATERMARK_TTL_MS = 60_000;
export const WATERMARK_ALLOWED_CLOCK_SKEW_MS = 5_000;
const WATERMARK_RE = /^wm1\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{64})$/;

export function actionWatermark(area: string, actionId: string, occurredAt: number): string {
  const expiresAt = occurredAt + WATERMARK_TTL_MS;
  const hash = createHash("sha256")
    .update(`edp-snapshot:${area}:${actionId}:${expiresAt}`)
    .digest("hex");
  return `wm1.${expiresAt.toString(36)}.${occurredAt.toString(36)}.${hash}`;
}

export function watermarkIssuedAt(value: string): number | undefined {
  const match = WATERMARK_RE.exec(value);
  if (!match) return undefined;
  return Number.parseInt(match[2]!, 36);
}

export function createDeltaSnapshotCache(options: SnapshotCacheOptions = {}): SnapshotCache {
  const tables = options.tables ?? SNAPSHOT_TABLES;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const pollJitterRatio = options.pollJitterRatio ?? 0.2;
  const ownWriteReloadDelayMs = options.ownWriteReloadDelayMs ?? 1_000;
  const activeWindowMs = options.activeWindowMs ?? 15 * 60_000;
  const maxStaleMs = options.maxStaleMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });

  let snapshot: MemorySnapshot | undefined;
  let versions: Record<string, string> = {};
  let loading: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  let loadStats: SnapshotLoadStats | undefined;
  let versionStats: VersionCheckStats | undefined;
  let lastRequestAt = 0;
  let lastSuccessfulCheckAt = 0;
  let nextCheckDueAt = 0;
  let polling = false;
  const dirtyAreas = new Set<string>();
  const areaGenerations = new Map<string, number>();
  const watermarkReloadDueAt = new Map<string, number>();
  const pendingReloadAreas = new Set<string>();
  let reloadTimer = false;

  const actionTablesByArea = () => {
    const byArea = new Map<string, SnapshotTable[]>();
    for (const table of tables) {
      if (
        !table.table.endsWith("_actions") &&
        !(table.schema === "eir" && ["eir_draft_saves", "eir_evaluations"].includes(table.table))
      )
        continue;
      byArea.set(table.area, [...(byArea.get(table.area) ?? []), table]);
    }
    return byArea;
  };
  const actionTables = actionTablesByArea();

  const areasFor = (definition: ReadDefinition<unknown, unknown>) => [
    ...new Set([definition.area, ...(definition.dependsOn ?? [])]),
  ];

  const snapshotSatisfiesWatermark = (current: MemorySnapshot, area: string, watermark: string) => {
    const match = WATERMARK_RE.exec(watermark);
    if (!match) return false;
    const expiresAt = Number.parseInt(match[1]!, 36);
    const issuedAt = Number.parseInt(match[2]!, 36);
    if (!Number.isFinite(issuedAt) || issuedAt > now() + WATERMARK_ALLOWED_CLOCK_SKEW_MS)
      return true;
    const cappedExpiresAt = Math.min(expiresAt, issuedAt + WATERMARK_TTL_MS);
    if (!Number.isFinite(cappedExpiresAt) || cappedExpiresAt < now()) return true;
    const hash = match[3]!;
    const candidates = actionTables.get(area) ?? [];
    for (const table of candidates) {
      for (const row of current.table<SnapshotRow>(table.schema, table.table)) {
        const actionId = row["action_id"];
        if (typeof actionId !== "string") continue;
        const rowHash = createHash("sha256")
          .update(`edp-snapshot:${area}:${actionId}:${expiresAt}`)
          .digest("hex");
        if (rowHash === hash) return true;
      }
    }
    return false;
  };

  const loadTables = async (read: ReadSql, names: StoreNames, areas?: Set<string>) => {
    const started = now();
    const selected = areas ? tables.filter((table) => areas.has(table.area)) : tables;
    const selectedAreas = new Set(selected.map((table) => table.area));
    const generations = new Map(
      [...selectedAreas].map((area) => {
        const next = (areaGenerations.get(area) ?? 0) + 1;
        areaGenerations.set(area, next);
        return [area, next] as const;
      }),
    );
    const loaded = await Promise.all(
      selected.map(async (table) => {
        const projection = table.loadColumns?.join(", ") ?? "*";
        const statement =
          `SELECT ${projection} FROM ${names.table(table.schema, table.table)}` +
          (table.orderBy ? ` ORDER BY ${table.orderBy}` : "");
        const rows = await read<SnapshotRow>({ statement });
        return { table, rows };
      }),
    );
    const current = new Map<TableKey, SnapshotRow[]>(
      snapshot
        ? tables.map((table) => [
            keyOf(table.schema, table.table),
            snapshot!.table(table.schema, table.table),
          ])
        : [],
    );
    for (const { table, rows } of loaded) {
      if (areaGenerations.get(table.area) === generations.get(table.area)) {
        current.set(keyOf(table.schema, table.table), rows);
        dirtyAreas.delete(table.area);
      }
    }
    const rowCounts = Object.fromEntries(
      tables.map((table) => {
        const key = keyOf(table.schema, table.table);
        return [key, current.get(key)?.length ?? 0];
      }),
    ) as Record<TableKey, number>;
    const approxBytes = [...current.values()].reduce(
      (sum, rows) => sum + JSON.stringify(rows).length,
      0,
    );
    loadStats = {
      loadedAt: now(),
      elapsedMs: now() - started,
      rowCounts,
      approxBytes,
    };
    snapshot = new MemorySnapshot(current, loadStats);
    console.info(
      `[delta-snapshot] loaded ${Object.values(rowCounts).reduce((sum, count) => sum + count, 0)} rows in ${loadStats.elapsedMs} ms (${approxBytes} bytes approx)`,
    );
  };

  const readMarkers = async (read: ReadSql, names: StoreNames) => {
    const started = now();
    const rows = await read<{ area: string; version: string }>({
      statement: snapshotMarkerStatement(names),
    });
    const next = Object.fromEntries(rows.map((row) => [String(row.area), String(row.version)]));
    return {
      next,
      stats: { checkedAt: now(), elapsedMs: now() - started, versions: next },
    };
  };

  const checkVersions = async (read: ReadSql, names: StoreNames) => {
    const { next, stats } = await readMarkers(read, names);
    const changed = new Set<string>();
    for (const area of SNAPSHOT_AREAS) {
      if (versions[area] !== undefined && next[area] !== versions[area]) changed.add(area);
    }
    if (changed.size) await loadTables(read, names, changed);
    versions = next;
    versionStats = stats;
    lastSuccessfulCheckAt = now();
    nextCheckDueAt = now() + pollIntervalMs;
  };

  const triggerCheck = (read: ReadSql, names: StoreNames) => {
    checking ??= checkVersions(read, names)
      .catch((error) =>
        console.warn(
          "[delta-snapshot] version check failed; using bounded-staleness fallback.",
          error,
        ),
      )
      .finally(() => {
        checking = undefined;
      });
    return checking;
  };

  const triggerWatermarkReload = (read: ReadSql, names: StoreNames, area: string) => {
    const due = watermarkReloadDueAt.get(area) ?? 0;
    if (now() < due) return;
    watermarkReloadDueAt.set(area, now() + pollIntervalMs);
    void triggerCheck(read, names);
  };

  const nextPollDelay = () => {
    if (pollIntervalMs <= 0 || pollJitterRatio <= 0) return pollIntervalMs;
    const spread = pollIntervalMs * pollJitterRatio;
    return Math.max(0, Math.round(pollIntervalMs - spread / 2 + random() * spread));
  };

  const schedule = (read: ReadSql, names: StoreNames) => {
    if (polling) return;
    polling = true;
    const tick = () => {
      polling = false;
      if (now() - lastRequestAt > activeWindowMs) return;
      void (async () => {
        await triggerCheck(read, names);
        schedule(read, names);
      })();
    };
    setTimer(tick, nextPollDelay());
  };

  const cache: SnapshotCache = {
    async start(read, names) {
      if (!loading) {
        loading = (async () => {
          const { next, stats } = await readMarkers(read, names);
          versions = next;
          versionStats = stats;
          await loadTables(read, names);
          lastSuccessfulCheckAt = now();
          nextCheckDueAt = now() + pollIntervalMs;
        })().finally(() => {
          loading = undefined;
        });
      }
      await loading;
      schedule(read, names);
    },

    async reload(read, names, areas) {
      const reloaded = areas ? new Set(areas) : undefined;
      await loadTables(read, names, reloaded);
      if (!reloaded) dirtyAreas.clear();
      nextCheckDueAt = now() + pollIntervalMs;
    },

    async snapshotForRead(definition, read, names, seenWatermarks = {}) {
      lastRequestAt = now();
      schedule(read, names);
      if (!snapshot) {
        void cache
          .start(read, names)
          .catch((error) =>
            console.warn("[delta-snapshot] startup load failed; using Delta fallback.", error),
          );
        return undefined;
      }
      if (now() >= nextCheckDueAt) triggerCheck(read, names);
      if (now() - lastSuccessfulCheckAt > maxStaleMs) return undefined;
      if (!definition.snapshot) return undefined;
      for (const area of areasFor(definition)) {
        const seen = seenWatermarks[area];
        if (seen && !snapshotSatisfiesWatermark(snapshot, area, seen)) {
          triggerWatermarkReload(read, names, area);
          return undefined;
        }
        if (dirtyAreas.has(area)) return undefined;
      }
      return snapshot;
    },

    async markersForAreas(read, names, areas) {
      const wanted = new Set(areas);
      if (!wanted.size) return {};
      const { next } = await readMarkers(read, names);
      return Object.fromEntries(
        [...wanted].filter((area) => next[area] !== undefined).map((area) => [area, next[area]!]),
      );
    },

    invalidateAreas(areas) {
      const changed = new Set(areas);
      if (!changed.size) return;
      for (const area of changed) {
        versions[area] = `invalidated:${now()}:${versions[area] ?? ""}`;
        dirtyAreas.add(area);
        areaGenerations.set(area, (areaGenerations.get(area) ?? 0) + 1);
      }
      nextCheckDueAt = 0;
    },

    reloadSoon(read, names, areas) {
      for (const area of areas) pendingReloadAreas.add(area);
      if (reloadTimer) return;
      reloadTimer = true;
      setTimer(() => {
        reloadTimer = false;
        const areas = [...pendingReloadAreas];
        pendingReloadAreas.clear();
        if (!areas.length) return;
        void cache
          .reload(read, names, areas)
          .catch((error) =>
            console.warn(
              "[delta-snapshot] own-write reload failed; dirty areas will use Delta fallback.",
              error,
            ),
          );
      }, ownWriteReloadDelayMs);
    },

    latestLoadStats: () => loadStats,
    latestVersionCheck: () => versionStats,
  };
  return cache;
}
