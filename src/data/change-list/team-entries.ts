/**
 * Change-list entry kinds and reasons from dataset team management (#87):
 * a role removed or changed, and an owner added or removed.
 */
import type { DatasetRoleName, PersonContact } from "../datasets/types";

/** A dataset owner moved a person from one dataset role to another. */
export interface DatasetRoleChangedReason {
  kind: "dataset-role-changed";
  datasetId: string;
  from: DatasetRoleName;
  to: DatasetRoleName;
  changedBy: string;
  changedAt: string;
}

/** A dataset owner removed one of a person's dataset roles. */
export interface DatasetRoleRemovedReason {
  kind: "dataset-role-removed";
  datasetId: string;
  role: DatasetRoleName;
  removedBy: string;
  removedAt: string;
}

/** Someone was made a dataset owner, so they hold the Maintainer (stored as `manager`) role (ADR-0005). */
export interface DatasetOwnerAddedReason {
  kind: "dataset-owner-added";
  datasetId: string;
  /** The role replaced by Maintainer (stored as `manager`) when an existing member became an owner. */
  replacedRole?: DatasetRoleName;
  addedBy: string;
  addedAt: string;
}

/**
 * Someone was removed as a dataset owner, which removes their Maintainer role
 * too (ADR-0005: the role comes with ownership).
 */
export interface DatasetOwnerRemovedReason {
  kind: "dataset-owner-removed";
  datasetId: string;
  removedBy: string;
  removedAt: string;
}

/** Remove one person from one dataset group. */
export interface RemoveMemberEntry {
  id: string;
  kind: "remove-member";
  target: {
    group: string;
    /** Whom to remove, by name and email. */
    person: PersonContact;
    datasetId: string;
    role: DatasetRoleName;
  };
  /** What the person loses: the role's grants from config when the entry was made. */
  grants: string[];
  reason:
    | DatasetRoleRemovedReason
    | DatasetRoleChangedReason
    | DatasetOwnerAddedReason
    | DatasetOwnerRemovedReason;
  createdBy: string;
  createdAt: string;
  applied: { by: string; at: string } | null;
}
