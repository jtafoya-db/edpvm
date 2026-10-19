/** Server-only Delta adapter. Do not export this module through src/data/index.ts. */
import { newId } from "./delta/ids.ts";
import type { SqlClient } from "./delta/sql-client.ts";
import type {
  GroupKind,
  GroupManager,
  GroupMembershipReader,
  MembershipVisibility,
  SnapshotRun,
} from "../data/group-membership";
import { isCompleteRun } from "../data/group-membership";

export interface DeltaMembershipReaderConfig {
  client: SqlClient;
  catalog: string;
  schema: string;
  visibility: () => Promise<MembershipVisibility>;
}
function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `\`${value}\``;
}
interface SnapshotRunRow {
  run_id: string;
  started_at: string;
  ended_at: string;
  status: string;
  groups_expected: string[] | null;
  groups_read: string[] | null;
}
interface MembershipRow {
  group_name: string;
  group_id: string;
  kind: GroupKind;
  domain: string;
  dataset_tag: string | null;
  managed_by: GroupManager;
  user_id: string;
  email: string;
  display_name: string;
  first_seen: string;
  last_seen: string;
  removed_at: string | null;
}
interface MembershipChangeRow extends MembershipRow {
  _change_type: string;
  _commit_timestamp: string;
  _commit_version: number;
}
interface TableHistoryRow {
  version: number;
  timestamp: string;
}
function membership(row: MembershipRow) {
  return {
    groupName: row.group_name,
    groupId: row.group_id,
    kind: row.kind,
    domain: row.domain,
    ...(row.dataset_tag ? { datasetTag: row.dataset_tag } : {}),
    managedBy: row.managed_by,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
  };
}
function tableNames(catalog: string, schema: string, table: string) {
  const quoted = `${identifier(catalog)}.${identifier(schema)}.${identifier(table)}`;
  return { quoted, cdf: `${catalog}.${schema}.${table}` };
}
function visibilitySql(visibility: Exclude<MembershipVisibility, { edpStaff: true }>, alias = "") {
  const column = (name: string) => `${alias}${name}`;
  const predicates = [
    ...(visibility.domains.length
      ? [
          `(${column("kind")} = 'domain' AND ${column("domain")} IN (${visibility.domains.map((_, i) => `:domain${i}`).join(",")}))`,
        ]
      : []),
    ...(visibility.datasetTags.length
      ? [
          `(${column("kind")} = 'dataset' AND ${column("dataset_tag")} IN (${visibility.datasetTags.map((_, i) => `:datasetTag${i}`).join(",")}))`,
        ]
      : []),
  ];
  return predicates.length ? `(${predicates.join(" OR ")})` : "FALSE";
}
function visibilityParameters(visibility: Exclude<MembershipVisibility, { edpStaff: true }>) {
  return {
    ...Object.fromEntries(visibility.domains.map((domain, i) => [`domain${i}`, domain])),
    ...Object.fromEntries(visibility.datasetTags.map((tag, i) => [`datasetTag${i}`, tag])),
  };
}
export function createDeltaGroupMembershipReader(
  config: DeltaMembershipReaderConfig,
): GroupMembershipReader {
  return {
    listMemberships: async (options) => {
      const visibility = await config.visibility();
      if (
        !visibility.edpStaff &&
        visibility.domains.length === 0 &&
        visibility.datasetTags.length === 0
      )
        return [];
      const parameters = visibility.edpStaff ? undefined : visibilityParameters(visibility);
      const predicates = [
        ...(options?.includeRemoved ? [] : ["removed_at IS NULL"]),
        ...(visibility.edpStaff ? [] : [visibilitySql(visibility)]),
      ];
      const filter = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
      const table = tableNames(config.catalog, config.schema, "group_members").quoted;
      const { rows } = await config.client.execute<MembershipRow>(
        {
          statement: `SELECT group_name,group_id,kind,domain,dataset_tag,managed_by,user_id,email,display_name,first_seen,last_seen,removed_at FROM ${table}${filter} ORDER BY domain,group_name,email`,
          ...(parameters ? { parameters } : {}),
        },
        { readId: newId() },
      );
      return rows.map(membership);
    },
    listHistory: async (options) => {
      const visibility = await config.visibility();
      if (
        !visibility.edpStaff &&
        visibility.domains.length === 0 &&
        visibility.datasetTags.length === 0
      )
        return { rows: [], nextCursor: null };
      const limit = Math.min(Math.max(options?.limit ?? 500, 1), 500);
      const cursor = options?.cursor;
      const parameters = {
        ...(visibility.edpStaff ? {} : visibilityParameters(visibility)),
        fetchLimit: { type: "INT" as const, value: limit + 1 },
        ...(cursor
          ? {
              cursorVersion: cursor.commitVersion,
              cursorGroupId: cursor.groupId,
              cursorUserId: cursor.userId,
            }
          : {}),
      };
      const names = tableNames(config.catalog, config.schema, "group_members");
      const history = await config.client.execute<TableHistoryRow>(
        { statement: `DESCRIBE HISTORY ${names.quoted} LIMIT 1000` },
        { readId: newId() },
      );
      if (history.rows.length === 0) return { rows: [], nextCursor: null };
      const cutoff = Date.now() - 6 * 24 * 60 * 60 * 1000;
      const retained = history.rows.filter((row) => Date.parse(row.timestamp) >= cutoff);
      if (retained.length === 0) return { rows: [], nextCursor: null };
      const startVersion = Math.min(...retained.map((row) => row.version));
      const visibilityFilter = visibility.edpStaff
        ? ""
        : ` AND ${visibilitySql(visibility, "post.")}`;
      const pageFilter = cursor
        ? " AND (post._commit_version < :cursorVersion OR (post._commit_version = :cursorVersion AND (post.group_id > :cursorGroupId OR (post.group_id = :cursorGroupId AND post.user_id > :cursorUserId))))"
        : "";
      const { rows } = await config.client.execute<MembershipChangeRow>(
        {
          // The snapshot MERGE key guarantees at most one pre/post pair for each
          // (commit version, group_id, user_id), so this join cannot fan out rows.
          statement: `WITH changes AS (SELECT * FROM table_changes('${names.cdf}', ${startVersion})) SELECT post.group_name,post.group_id,post.kind,post.domain,post.dataset_tag,post.managed_by,post.user_id,post.email,post.display_name,post.first_seen,post.last_seen,post.removed_at,post._change_type,post._commit_timestamp,post._commit_version FROM changes post LEFT JOIN changes pre ON pre._commit_version = post._commit_version AND pre.group_id = post.group_id AND pre.user_id = post.user_id AND pre._change_type = 'update_preimage' WHERE post.group_id IS NOT NULL AND post.user_id IS NOT NULL AND (post._change_type = 'insert' OR (post._change_type = 'update_postimage' AND NOT (post.removed_at <=> pre.removed_at)))${visibilityFilter}${pageFilter} ORDER BY post._commit_version DESC,post.group_id,post.user_id LIMIT :fetchLimit`,
          parameters,
        },
        { readId: newId() },
      );
      const pageRows = rows.slice(0, limit).map((row) => ({
        ...membership(row),
        changeType: row._change_type,
        changedAt: row._commit_timestamp,
        commitVersion: row._commit_version,
      }));
      const last = pageRows.at(-1);
      return {
        rows: pageRows,
        nextCursor:
          rows.length > limit && last
            ? {
                commitVersion: last.commitVersion,
                groupId: last.groupId,
                userId: last.userId,
              }
            : null,
      };
    },
    latestRun: async (): Promise<SnapshotRun | null> => {
      const table = tableNames(config.catalog, config.schema, "snapshot_runs").quoted;
      const { rows } = await config.client.execute<SnapshotRunRow>(
        {
          statement: `SELECT run_id,started_at,ended_at,status,groups_expected,groups_read FROM ${table} ORDER BY started_at DESC LIMIT 1`,
        },
        { readId: newId() },
      );
      const row = rows[0];
      if (!row) return null;
      const groupsExpected = row.groups_expected ?? [];
      const groupsRead = row.groups_read ?? [];
      return {
        runId: row.run_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        status: row.status,
        groupsExpected,
        groupsRead,
        complete: isCompleteRun(groupsExpected, groupsRead),
      };
    },
  };
}
