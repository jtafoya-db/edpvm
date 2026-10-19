/**
 * TanStack Query hooks for dataset team management (#87), in front of the
 * {@link DataStore} seam. Reads go through Query; writes are optimistic saves
 * (src/data/optimistic-save.ts) that go through the seam and then refresh
 * what they changed.
 */
import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query";

import { accessRequestQueryKeys } from "../access-requests/queries";
import { project, type Projection, type SaveSpec } from "../optimistic-save";
import { useStore } from "../store-context";
import { ownerKey } from "./ownership";
import { datasetQueryKeys, memberRecord } from "./queries";
import { normalizeEmail, type Dataset, type DatasetMember, type DatasetRoleName } from "./types";
import type {
  AddOwnerInput,
  ChangeMemberRoleInput,
  ChangeMemberRoleResult,
  MemberRoleRef,
  OwnerChangeResult,
  RemoveMemberResult,
  TeamEvent,
} from "./team-store";

export const teamQueryKeys = {
  events: datasetQueryKeys.teamEvents,
};

export function useTeamEvents(datasetId: string): UseQueryResult<TeamEvent[]> {
  const store = useStore();
  return useQuery({
    queryKey: teamQueryKeys.events(datasetId),
    queryFn: () => store.datasetTeam.listTeamEvents(datasetId),
  });
}

/** Everything a team-management write can change on one dataset. */
export function teamKeys(datasetId: string): QueryKey[] {
  return [
    datasetQueryKeys.members(datasetId),
    datasetQueryKeys.dataset(datasetId),
    datasetQueryKeys.datasetList(),
    datasetQueryKeys.datasetSummaries(),
    datasetQueryKeys.changeList,
    teamQueryKeys.events(datasetId),
    // An owner change moves the dataset's requests into or out of an owner's inbox.
    accessRequestQueryKeys.inbox(),
  ];
}

/** The record an owner save locks. */
export const ownerRecord = (datasetId: string, owner: string) =>
  `owner:${datasetId}:${owner.trim().toLowerCase()}`;

/** How the screen words a save: the person's name and the role labels it shows. */
interface Words {
  personName: string;
  roleLabel: string;
}

const sameMember = (m: DatasetMember, email: string, role: DatasetRoleName) =>
  m.person.email === normalizeEmail(email) && m.role === role;

const replaceMember = (members: DatasetMember[], member: DatasetMember) => [
  ...members.filter((m) => !sameMember(m, member.person.email, member.role)),
  member,
];

/**
 * Optimistic saves (ADR-0009 phase 1). Refusals surface on the save
 * ({@link useSaves}); the server still checks ownership and every rule.
 */
export const changeMemberRoleSave: SaveSpec<
  ChangeMemberRoleInput & Words & { newRoleLabel: string },
  ChangeMemberRoleResult
> = {
  action: "edit-role",
  refusedTitle: "That change was refused",
  record: (i) => memberRecord(i.datasetId, i.email, i.role),
  describe: (i) => `Change ${i.personName} from ${i.roleLabel} to ${i.newRoleLabel}`,
  describeSaved: (r, i) =>
    r.changed
      ? `Changed ${i.personName} from ${i.roleLabel} to ${i.newRoleLabel}. ` +
        `${r.entries.map((e) => e.id).join(", ")} pending on the change list.`
      : `${i.personName} already had that role; nothing was listed.`,
  run: (store, i) =>
    store.datasetTeam.changeMemberRole({
      datasetId: i.datasetId,
      email: i.email,
      role: i.role,
      newRole: i.newRole,
      idempotencyKey: i.idempotencyKey,
    }),
  projections: (i) => [
    project<DatasetMember[], typeof i, ChangeMemberRoleResult>(
      datasetQueryKeys.members(i.datasetId),
      (members) =>
        members.map((m) => (sameMember(m, i.email, i.role) ? { ...m, role: i.newRole } : m)),
      (members, r) =>
        replaceMember(
          members.filter((m) => !sameMember(m, i.email, i.role)),
          r.member,
        ),
    ),
  ],
  invalidates: (i) => teamKeys(i.datasetId),
};

export const removeMemberSave: SaveSpec<MemberRoleRef & Words, RemoveMemberResult> = {
  action: "remove-role",
  refusedTitle: "That removal was refused",
  record: (i) => memberRecord(i.datasetId, i.email, i.role),
  describe: (i) => `Remove ${i.personName}'s ${i.roleLabel} role`,
  describeSaved: (r, i) =>
    `Removed ${i.personName}'s ${i.roleLabel} role. ` +
    `${r.entries.map((e) => e.id).join(", ")} pending on the change list.`,
  run: (store, i) =>
    store.datasetTeam.removeMember({
      datasetId: i.datasetId,
      email: i.email,
      role: i.role,
      idempotencyKey: i.idempotencyKey,
    }),
  projections: (i) => [
    project<DatasetMember[], typeof i>(datasetQueryKeys.members(i.datasetId), (members) =>
      members.filter((m) => !sameMember(m, i.email, i.role)),
    ),
  ],
  invalidates: (i) => teamKeys(i.datasetId),
};

/** An owner change shows on the dataset's page and in the datasets list (owner reassignment). */
function ownerProjections<TInput>(
  datasetId: string,
  change: (dataset: Dataset) => Dataset,
): Projection<TInput, OwnerChangeResult>[] {
  return [
    project<Dataset | null, TInput, OwnerChangeResult>(
      datasetQueryKeys.dataset(datasetId),
      (dataset) => dataset && change(dataset),
      (_dataset, r) => r.dataset,
    ),
    project<Dataset[], TInput, OwnerChangeResult>(
      datasetQueryKeys.datasetList(),
      (datasets) => datasets.map((d) => (d.id === datasetId ? change(d) : d)),
      (datasets, r) => datasets.map((d) => (d.id === datasetId ? r.dataset : d)),
    ),
  ];
}

export const addOwnerSave: SaveSpec<AddOwnerInput & { managerLabel: string }, OwnerChangeResult> = {
  action: "add-owner",
  refusedTitle: "That owner was refused",
  record: (i) => ownerRecord(i.datasetId, normalizeEmail(i.email)),
  describe: (i) => `Make ${i.name.trim()} an owner`,
  describeSaved: (r, i) =>
    `Made ${i.name.trim()} an owner.` +
    (r.entries.length > 0
      ? ` ${r.entries.map((e) => e.id).join(", ")} pending on the change list.`
      : ` They already held ${i.managerLabel}; nothing new was listed.`),
  run: (store, i) =>
    store.datasetTeam.addOwner({
      datasetId: i.datasetId,
      name: i.name,
      email: i.email,
      idempotencyKey: i.idempotencyKey,
    }),
  projections: (i) =>
    ownerProjections(i.datasetId, (dataset) => ({
      ...dataset,
      owners: [...dataset.owners, { displayName: i.name.trim(), email: normalizeEmail(i.email) }],
    })),
  invalidates: (i) => teamKeys(i.datasetId),
};

export const removeOwnerSave: SaveSpec<
  { datasetId: string; owner: string; ownerName: string; managerLabel: string },
  OwnerChangeResult
> = {
  action: "remove-owner",
  refusedTitle: "That removal was refused",
  record: (i) => ownerRecord(i.datasetId, i.owner),
  describe: (i) => `Remove ${i.ownerName} as an owner`,
  describeSaved: (r, i) =>
    `Removed ${i.ownerName} as an owner and from the ${i.managerLabel} role. ` +
    `${r.entries.map((e) => e.id).join(", ")} pending on the change list.`,
  run: (store, i) =>
    store.datasetTeam.removeOwner({
      datasetId: i.datasetId,
      owner: i.owner,
      idempotencyKey: i.idempotencyKey,
    }),
  projections: (i) =>
    ownerProjections(i.datasetId, (dataset) => ({
      ...dataset,
      owners: dataset.owners.filter((o) => ownerKey(o) !== i.owner),
    })),
  invalidates: (i) => teamKeys(i.datasetId),
};
