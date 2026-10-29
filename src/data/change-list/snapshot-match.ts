import type { GroupMembershipReader, SnapshotRun } from "../group-membership";
import { normalizeEmail, type Dataset } from "../datasets/types";
import { isMembershipEntry, type ChangeListEntry } from "./types";

/** Two missed 15-minute snapshot opportunities, matching the freshness monitor default. */
export const MAX_MEMBERSHIP_SNAPSHOT_AGE_MS = 30 * 60 * 1000;

function isFreshCompleteRun(run: SnapshotRun | null, now: Date): run is SnapshotRun {
  if (
    !run ||
    run.status !== "succeeded" ||
    !run.complete ||
    run.groupsExpected.length === 0 ||
    run.groupsRead.length === 0
  ) {
    return false;
  }
  const age = now.getTime() - Date.parse(run.endedAt);
  return Number.isFinite(age) && age >= 0 && age <= MAX_MEMBERSHIP_SNAPSHOT_AGE_MS;
}

/** Project immutable entries against a trustworthy snapshot without writing Databricks. */
export async function applyObservedMemberships(
  entries: ChangeListEntry[],
  datasets: Dataset[],
  reader: GroupMembershipReader,
  now: Date,
): Promise<ChangeListEntry[]> {
  const run = await reader.latestRun().catch((error: unknown) => {
    console.warn(
      "[change-list] membership snapshot metadata unavailable; leaving entries unverified.",
      error,
    );
    return null;
  });
  if (!isFreshCompleteRun(run, now)) return structuredClone(entries);
  const memberships = await reader
    .listMemberships({ includeRemoved: true })
    .catch((error: unknown) => {
      console.warn(
        "[change-list] membership snapshot rows unavailable; leaving entries unverified.",
        error,
      );
      return null;
    });
  if (!memberships) return structuredClone(entries);
  const datasetTags = new Map(datasets.map((dataset) => [dataset.id, dataset.datasetTag]));
  const verified = { runId: run.runId, at: run.endedAt };

  return entries.map((entry) => {
    if (!isMembershipEntry(entry)) return structuredClone(entry);
    const datasetTag = datasetTags.get(entry.target.datasetId);
    if (!datasetTag) return structuredClone(entry);
    const groupRows = memberships.filter(
      (row) =>
        row.kind === "dataset" &&
        row.groupName === entry.target.group &&
        row.datasetTag === datasetTag &&
        run.groupsRead.includes(row.groupId),
    );
    if (groupRows.length === 0) return structuredClone(entry);
    const principalId = entry.target.person.principalId?.trim();
    const email = normalizeEmail(entry.target.person.email);
    const personRows = groupRows.filter((row) => {
      const rowPrincipalId = row.userId?.trim();
      if (rowPrincipalId && principalId) return rowPrincipalId === principalId;
      return Boolean(email) && normalizeEmail(row.email) === email;
    });
    const matches =
      entry.kind === "add-member"
        ? personRows.some(
            (row) => !row.removedAt && Date.parse(row.lastSeen) >= Date.parse(run.startedAt),
          )
        : // An old removedAt still counts if a later re-add was missed by a partial run. The UI says
          // "Seen in snapshot" because this evidence does not prove the removal followed the entry.
          personRows.some((row) => Boolean(row.removedAt));
    return matches ? { ...structuredClone(entry), verified } : structuredClone(entry);
  });
}
