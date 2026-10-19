/**
 * The grant reconciler — first cut, covering group membership only.
 *
 * A pure function behind the store seam. It works out the dataset-group
 * memberships the app's records say should exist, and returns those that are
 * neither already in Databricks nor already on the change list. Callers turn
 * each into an add-member entry. Because anything already listed (pending or
 * applied) is skipped, repeating an add never produces a duplicate entry. A
 * membership a later remove-member entry unlisted can be listed again.
 *
 * Grants, revokes, certification and EIR holds are later slices. Reading real
 * Databricks groups is #88; until then callers pass no actual memberships.
 * Members are email contacts, so a membership is keyed by the normalised
 * email until matching emails to Databricks users lands (#103).
 */
import type { ChangeListEntry, DatasetRoleAddedReason } from "./types";
import { datasetGroupName, type GroupNamingConfig } from "../datasets/group-naming";
import type { RoleDescriptions } from "../datasets/role-descriptions";
import { listedMemberships } from "./removals";
import type { Dataset, DatasetMember, DatasetRoleName, PersonContact } from "../datasets/types";

/** One person (by normalised email) in one group. */
export interface GroupMembership {
  group: string;
  email: string;
}

/** A membership the records call for, with the dataset role that caused it. */
export interface DesiredMembership extends GroupMembership {
  person: PersonContact;
  grants: string[];
  datasetId: string;
  role: DatasetRoleName;
  reason: DatasetRoleAddedReason;
}

export interface MembershipReconcileInput {
  datasets: Dataset[];
  members: DatasetMember[];
  naming: GroupNamingConfig;
  roles: RoleDescriptions;
  /** Memberships Databricks already has. */
  actual: GroupMembership[];
  /** Entries already on the change list. */
  changeList: ChangeListEntry[];
}

const key = (m: GroupMembership) => `${m.group}\u0000${m.email}`;

/** The memberships to add: desired, minus actual, minus already listed. */
export function reconcileMembership(input: MembershipReconcileInput): DesiredMembership[] {
  const datasets = new Map(input.datasets.map((d) => [d.id, d]));
  const known = new Set(input.actual.map(key));
  // Net of the list: a later remove-member unlists a membership (removals.ts).
  for (const listed of listedMemberships(input.changeList).keys()) known.add(listed);

  const missing: DesiredMembership[] = [];
  for (const member of input.members) {
    const dataset = datasets.get(member.datasetId);
    if (!dataset) continue;
    const desired: DesiredMembership = {
      group: datasetGroupName(input.naming, dataset, member.role),
      email: member.person.email,
      person: member.person,
      grants: input.roles.roles[member.role].grants,
      datasetId: member.datasetId,
      role: member.role,
      reason: {
        kind: "dataset-role-added",
        datasetId: member.datasetId,
        role: member.role,
        addedBy: member.addedBy,
        addedAt: member.addedAt,
      },
    };
    if (known.has(key(desired))) continue;
    known.add(key(desired));
    missing.push(desired);
  }
  return missing;
}
