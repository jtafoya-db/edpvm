/**
 * Repository interfaces for initiatives, datasets and their owners, and
 * dataset roles. Part of the {@link DataStore} seam (src/data/store.ts).
 *
 * Writes take no actor argument: the adapter resolves the signed-in user
 * itself, so a caller can't act as someone else.
 */
import type { AddMemberEntry } from "../change-list/types";
import type { RoleDescriptions } from "./role-descriptions";
import type {
  AddMemberInput,
  Dataset,
  DatasetMember,
  DatasetWithMemberSummary,
  Initiative,
} from "./types";

/** Initiatives and datasets, with each dataset's domain tag, dataset tag and owners. */
export interface DatasetStore {
  listInitiatives(): Promise<Initiative[]>;
  listDatasets(): Promise<Dataset[]>;
  listDatasetSummaries(): Promise<DatasetWithMemberSummary[]>;
  getDataset(id: string): Promise<Dataset | undefined>;
  /**
   * Authorize the signed-in session as this dataset's owner, applying or
   * enforcing its ADR-0006 email-to-SCIM binding. Returns false for a non-owner.
   */
  claimOwnership(datasetId: string): Promise<boolean>;
}

export interface AddMemberResult {
  member: DatasetMember;
  /** False when the person already held this role; nothing new was recorded. */
  created: boolean;
  /** Change-list entries this add created (empty on a repeat). */
  entries: AddMemberEntry[];
}

/** Who holds which dataset role, and direct adds by dataset owners. */
export interface DatasetRoleStore {
  listMembers(datasetId: string): Promise<DatasetMember[]>;
  /**
   * Record a dataset role and put the resulting change-list entries on the
   * list. Refused (`ActionRefusedError`) unless the signed-in user owns the
   * dataset and its initiative is active. A repeat (same dataset, same
   * normalised email, same role) is a no-op.
   */
  addMember(input: AddMemberInput): Promise<AddMemberResult>;
  /** What each role grants, from configuration (role-descriptions.json). */
  describeRoles(): Promise<RoleDescriptions>;
}
