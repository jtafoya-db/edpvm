/**
 * Repository interface for access requests. Part of the {@link DataStore}
 * seam (src/data/store.ts).
 *
 * Like the dataset-role store, writes take no actor: the adapter resolves the
 * signed-in user, so nobody can request, decide or withdraw as someone else.
 * Refusals raise `ActionRefusedError` (src/data/datasets/errors.ts).
 */
import type { AddMemberResult } from "../datasets/store";
import type { AccessRequestConfig } from "./config";
import type { DatasetAccessRequest, SubmitAccessRequestInput } from "./types";

export interface ApproveAccessRequestResult {
  request: DatasetAccessRequest;
  /** The direct add the approval performed, with its change-list entries. */
  added: AddMemberResult;
}

export interface AccessRequestStore {
  /** Which roles can be requested and the owners' SLA target, from configuration. */
  describeSettings(): Promise<AccessRequestConfig>;
  /** The signed-in user's own requests, newest first. */
  listMine(): Promise<DatasetAccessRequest[]>;
  /** Requests for the datasets the signed-in user owns, oldest first. */
  listInbox(): Promise<DatasetAccessRequest[]>;
  /**
   * Ask a dataset's owners for a role. Refused if the role isn't requestable,
   * the dataset is unknown, its
   * initiative isn't active, the reason is blank, the person owns the dataset,
   * already holds the role, or already has the same request open.
   */
  submit(input: SubmitAccessRequestInput): Promise<DatasetAccessRequest>;
  /**
   * An owner approves an open request. The role is recorded through the
   * dataset-role store's direct add, so it puts the same add-member entry on
   * the change list. Refused unless the signed-in user owns the dataset and
   * isn't the requester. `idempotencyKey` is the browser's key for this one
   * confirmed approval; the direct add sends it, so a retry can't add twice.
   */
  approve(id: string, options?: { idempotencyKey?: string }): Promise<ApproveAccessRequestResult>;
  /** An owner rejects an open request, with an optional note to the requester. */
  reject(id: string, note?: string): Promise<DatasetAccessRequest>;
  /** The requester withdraws their own request while it's open. */
  withdraw(id: string): Promise<DatasetAccessRequest>;
}
