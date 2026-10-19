/**
 * The change list: what EDP staff need to change in Databricks, and why
 * (ADR-0005). The app never writes to Databricks; staff apply entries by hand
 * and mark them applied.
 *
 * Entry kinds so far: `add-member`, plus `remove-member` from team
 * management (#87, team-entries.ts). Grants, revokes, tag changes and standup
 * steps join the union in later slices.
 */
import type { DatasetRoleName, PersonContact } from "../datasets/types";
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

export type ChangeListEntry = AddMemberEntry | RemoveMemberEntry;
