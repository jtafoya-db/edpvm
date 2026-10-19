/**
 * Grant reconciler rules for removals (#87). Pure, like reconciler.ts.
 *
 * What's "listed" is the net of the change list: an add-member entry lists a
 * membership and a later remove-member entry for the same group and email
 * unlists it. A listed membership that no dataset role calls for any more is
 * one to remove. Reading real Databricks groups (#88) will add memberships
 * that exist there but were never listed.
 */
import { datasetGroupName, type GroupNamingConfig } from "../datasets/group-naming";
import type { Dataset, DatasetMember } from "../datasets/types";
import type { GroupMembership } from "./reconciler";
import type { AddMemberEntry, ChangeListEntry } from "./types";

const key = (m: GroupMembership) => `${m.group}\u0000${m.email}`;

/** The memberships the change list currently lists, keyed by group and email, with the entry that listed each. */
export function listedMemberships(changeList: ChangeListEntry[]): Map<string, AddMemberEntry> {
  const listed = new Map<string, AddMemberEntry>();
  for (const entry of changeList) {
    if (entry.kind === "add-member") {
      listed.set(key({ group: entry.target.group, email: entry.target.person.email }), entry);
    } else if (entry.kind === "remove-member") {
      listed.delete(key({ group: entry.target.group, email: entry.target.person.email }));
    }
  }
  return listed;
}

export interface RemovalReconcileInput {
  /** Only memberships of this dataset's groups are considered. */
  datasetId: string;
  datasets: Dataset[];
  members: DatasetMember[];
  naming: GroupNamingConfig;
  changeList: ChangeListEntry[];
}

/** The listed memberships of one dataset's groups that no member's role calls for: remove them. */
export function reconcileRemovals(input: RemovalReconcileInput): AddMemberEntry["target"][] {
  const datasets = new Map(input.datasets.map((d) => [d.id, d]));
  const desired = new Set<string>();
  for (const member of input.members) {
    const dataset = datasets.get(member.datasetId);
    if (!dataset) continue;
    desired.add(
      key({
        group: datasetGroupName(input.naming, dataset, member.role),
        email: member.person.email,
      }),
    );
  }
  const stale: AddMemberEntry["target"][] = [];
  for (const [k, entry] of listedMemberships(input.changeList)) {
    if (entry.target.datasetId === input.datasetId && !desired.has(k)) stale.push(entry.target);
  }
  return stale;
}
