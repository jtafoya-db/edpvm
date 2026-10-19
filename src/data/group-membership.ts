export type GroupKind = "domain" | "dataset";
export type GroupManager = "scim" | "manual";
export interface GroupMembership {
  groupName: string;
  groupId: string;
  kind: GroupKind;
  domain: string;
  datasetTag?: string;
  managedBy: GroupManager;
  userId: string;
  email: string;
  displayName: string;
  firstSeen: string;
  lastSeen: string;
  removedAt?: string;
}
/**
 * The newest row of the job's run-metadata table, so the UI can show when the
 * snapshot was last refreshed. Freshness is non-sensitive run metadata (a
 * timestamp, a status and counts), so it is not domain-scoped.
 */
export interface SnapshotRun {
  runId: string;
  startedAt: string;
  endedAt: string;
  status: string;
  groupsExpected: string[];
  groupsRead: string[];
  /** True only when a non-empty expected set was read in full. */
  complete: boolean;
}
/** A run is complete only when a non-empty expected set was wholly read. */
export function isCompleteRun(groupsExpected: string[], groupsRead: string[]): boolean {
  return (
    groupsExpected.length > 0 && groupsExpected.every((groupId) => groupsRead.includes(groupId))
  );
}
export interface GroupMembershipChange extends GroupMembership {
  changeType: string;
  changedAt: string;
  commitVersion: number;
}
export interface GroupMembershipHistoryCursor {
  commitVersion: number;
  groupId: string;
  userId: string;
}
export interface GroupMembershipHistoryPage {
  rows: GroupMembershipChange[];
  nextCursor: GroupMembershipHistoryCursor | null;
}
/** Server-resolved visibility. It must never be populated from request input. */
export type MembershipVisibility =
  { edpStaff: true } | { edpStaff: false; domains: string[]; datasetTags: string[] };
export interface GroupMembershipReader {
  listMemberships(options?: { includeRemoved?: boolean }): Promise<GroupMembership[]>;
  /** Change Data Feed rows, restricted by the same server-resolved visibility. */
  listHistory(options?: {
    limit?: number;
    cursor?: GroupMembershipHistoryCursor;
  }): Promise<GroupMembershipHistoryPage>;
  /** The most recent snapshot run, or null when the job has never run. */
  latestRun(): Promise<SnapshotRun | null>;
}
export function createMemoryGroupMembershipReader(
  rows: GroupMembership[],
  visibility: () => Promise<MembershipVisibility>,
  latestRun: SnapshotRun | null = null,
  history: GroupMembershipChange[] = [],
): GroupMembershipReader {
  return {
    listMemberships: async (options) => {
      const allowed = await visibility();
      const current = options?.includeRemoved ? rows : rows.filter((row) => !row.removedAt);
      return structuredClone(
        allowed.edpStaff
          ? current
          : current.filter(
              (row) =>
                (row.kind === "domain" && allowed.domains.includes(row.domain)) ||
                (row.kind === "dataset" &&
                  row.datasetTag !== undefined &&
                  allowed.datasetTags.includes(row.datasetTag)),
            ),
      );
    },
    listHistory: async (options) => {
      const allowed = await visibility();
      const visible = allowed.edpStaff
        ? history
        : history.filter(
            (row) =>
              (row.kind === "domain" && allowed.domains.includes(row.domain)) ||
              (row.kind === "dataset" &&
                row.datasetTag !== undefined &&
                allowed.datasetTags.includes(row.datasetTag)),
          );
      const cursor = options?.cursor;
      const ordered = [...visible]
        .filter(
          (row) =>
            row.groupId !== null &&
            row.userId !== null &&
            (!cursor ||
              row.commitVersion < cursor.commitVersion ||
              (row.commitVersion === cursor.commitVersion &&
                (row.groupId > cursor.groupId ||
                  (row.groupId === cursor.groupId && row.userId > cursor.userId)))),
        )
        .sort(
          (a, b) =>
            b.commitVersion - a.commitVersion ||
            (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0) ||
            (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
        );
      const limit = Math.min(Math.max(options?.limit ?? 500, 1), 500);
      const pageRows = ordered.slice(0, limit);
      const last = pageRows.at(-1);
      return structuredClone({
        rows: pageRows,
        nextCursor:
          ordered.length > limit && last
            ? { commitVersion: last.commitVersion, groupId: last.groupId, userId: last.userId }
            : null,
      });
    },
    latestRun: async () =>
      latestRun
        ? structuredClone({
            ...latestRun,
            complete: isCompleteRun(latestRun.groupsExpected, latestRun.groupsRead),
          })
        : null,
  };
}
