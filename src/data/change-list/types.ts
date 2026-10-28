/**
 * The change list: what EDP staff need to change in Databricks, and why
 * (ADR-0005). The app never writes to Databricks; staff apply entries by hand
 * and mark them applied.
 *
 * Entry kinds so far: `add-member`, plus `remove-member` from team
 * management (#87, team-entries.ts), and `onboard-user` from EDP staff owner
 * matching (#103, onboard-user.ts). Grants, revokes, tag changes and standup
 * steps join the union in later slices (#263).
 */
import type { DatasetRoleName, PersonContact } from "../datasets/types";
import type { OnboardUserEntry } from "./onboard-user";
import type {
  DatasetOwnerAddedReason,
  DatasetRoleChangedReason,
  RemoveMemberEntry,
} from "./team-entries";

/** Why an add-member entry exists: a dataset owner recorded a dataset role. */
export interface DatasetRoleAddedReason {
  kind: "dataset-role-added";
  datasetId: string;
  role: DatasetRoleName;
  /** SCIM id of the dataset owner who added the person. */
  addedBy: string;
  addedAt: string;
}

/** Add one person to one dataset group. */
export interface AddMemberEntry {
  id: string;
  kind: "add-member";
  target: {
    group: string;
    /** Whom to add, by name and email. EDP staff find the Databricks user. */
    person: PersonContact;
    datasetId: string;
    role: DatasetRoleName;
  };
  /** What the role grants, from the role-description config when the entry was made. */
  grants: string[];
  reason: DatasetRoleAddedReason | DatasetRoleChangedReason | DatasetOwnerAddedReason;
  /** SCIM id of whoever's action created the entry. */
  createdBy: string;
  createdAt: string;
  /** `null` while pending; who marked it applied and when, once applied. */
  applied: { by: string; at: string } | null;
}

/** The membership kinds: one person in or out of one dataset group. */
export type MembershipEntry = AddMemberEntry | RemoveMemberEntry;

/** Snapshot evidence is separate from a person's manual applied record (AC7). */
export interface SnapshotVerification {
  runId: string;
  at: string;
}

export type ChangeListEntry = (MembershipEntry | OnboardUserEntry) & {
  /** Derived on read; never stored on or mutates the immutable entry. */
  verified?: SnapshotVerification;
  /** Derived on read; the later membership entry that replaced this pending entry. */
  supersededBy?: string;
};

export type { OnboardUserEntry } from "./onboard-user";

/** Whether an entry changes a dataset group's membership (every kind but `onboard-user`). */
export function isMembershipEntry(
  entry: ChangeListEntry,
): entry is ChangeListEntry & MembershipEntry {
  return entry.kind === "add-member" || entry.kind === "remove-member";
}

/** The dataset an entry is scoped to; none for an initiative-wide, staff-only kind. */
export function entryDatasetId(entry: ChangeListEntry): string | undefined {
  return isMembershipEntry(entry) ? entry.target.datasetId : undefined;
}

/** Whether EDP staff still need to apply this entry by hand. */
export function isPendingChange(entry: ChangeListEntry): boolean {
  return !entry.applied && !entry.verified && !entry.supersededBy;
}
