/**
 * Repository interface for dataset team management (#87): editing and
 * removing dataset roles and managing owners. Part of the {@link DataStore}
 * seam (src/data/store.ts), next to DatasetRoleStore.
 *
 * As there, writes take no actor: the adapter resolves the signed-in user.
 * Members are named by email. Owners are named by SCIM id or email.
 */
import type { ChangeListEntry } from "../change-list/types";
import type { Dataset, DatasetMember, DatasetRoleName, PersonContact } from "./types";

/** One of a person's dataset roles. A person can hold more than one. */
export interface MemberRoleRef {
  datasetId: string;
  /** Matched after trimming and lower-casing. */
  email: string;
  role: DatasetRoleName;
  /** Optional browser-minted key for retrying one confirmed save intent. */
  idempotencyKey?: string;
}

export interface ChangeMemberRoleInput extends MemberRoleRef {
  newRole: DatasetRoleName;
}

export interface ChangeMemberRoleResult {
  member: DatasetMember;
  /** False for a no-op edit (the new role is the old one): nothing was recorded. */
  changed: boolean;
  /** The remove-old and add-new entries (empty on a no-op). */
  entries: ChangeListEntry[];
}

export interface RemoveMemberResult {
  removed: DatasetMember;
  entries: ChangeListEntry[];
}

export interface AddOwnerInput {
  datasetId: string;
  name: string;
  email: string;
  /** Optional browser-minted key for retrying one confirmed save intent. */
  idempotencyKey?: string;
}

export interface OwnerChangeResult {
  dataset: Dataset;
  entries: ChangeListEntry[];
}

/** One team-management action, with who took it and when. */
export type TeamEvent = {
  datasetId: string;
  by: string;
  at: string;
  /** Change-list entries the action created. */
  entryIds: string[];
} & (
  | { kind: "role-changed"; person: PersonContact; from: DatasetRoleName; to: DatasetRoleName }
  | { kind: "member-removed"; person: PersonContact; role: DatasetRoleName }
  | {
      kind: "owner-added" | "owner-removed";
      /** Owners named at intake have a SCIM id but no email. */
      person: { name: string; email: string | null };
      /** Present when making this owner replaced an existing dataset role. */
      replacedRole?: DatasetRoleName;
    }
);

export interface DatasetTeamStore {
  /**
   * Move one of a person's roles to another. Refused unless the signed-in
   * user owns the dataset and its initiative is active; refused as a
   * `duplicate` if the person already holds the new role; refused for an
   * owner's Maintainer (stored as `manager`) role. Lists remove-old and add-new entries.
   */
  changeMemberRole(input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult>;
  /** Remove one of a person's roles, listing a remove-member entry. Same refusals. */
  removeMember(input: MemberRoleRef): Promise<RemoveMemberResult>;
  /**
   * Add an owner by name and email. Any owner, or EDP staff (to reassign
   * ownership when none remains), can. The new owner gets the Maintainer role.
   */
  addOwner(input: AddOwnerInput): Promise<OwnerChangeResult>;
  /**
   * Remove an owner, named by SCIM id or email ({@link ownerKey}). Refused
   * with `last-owner` if they're the only one. Their Maintainer role goes too,
   * listing a remove-member entry; their other roles stay, and so does their
   * email's SCIM binding (ADR-0006).
   */
  removeOwner(input: {
    datasetId: string;
    owner: string;
    /** Optional browser-minted key for retrying one confirmed save intent. */
    idempotencyKey?: string;
  }): Promise<OwnerChangeResult>;
  /** The team-management actions taken on one dataset, oldest first. */
  listTeamEvents(datasetId: string): Promise<TeamEvent[]>;
}
