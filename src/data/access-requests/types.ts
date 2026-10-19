/**
 * Access requests (ADR-0005): one person asks one dataset's owners for one
 * dataset role, and an owner approves or rejects it in the app. Terms follow
 * GLOSSARY.md.
 *
 * Lifecycle: `requested` → `active` | `rejected`, or `withdrawn` by the
 * requester while it's still open. Actors are stable SCIM principal ids
 * (ADR-0004) and times are ISO-8601.
 */
import type { SlaState } from "../sla";
import type { DatasetRoleName, PersonContact } from "../datasets/types";

export const ACCESS_REQUEST_STATUSES = ["requested", "active", "rejected", "withdrawn"] as const;

export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** The person who asked, from their signed-in session. */
export interface AccessRequester extends PersonContact {
  principalId: string;
}

/** Who ended the request and when: the deciding owner, or the requester on withdrawal. */
export interface AccessRequestOutcome {
  by: string;
  at: string;
  /** The owner's note on a rejection, if they gave one. */
  note: string | null;
}

/** How an open request tracks against the owners' SLA target, computed when read. */
export interface AccessRequestSla {
  targetBusinessDays: number;
  /** True while the target is a default the business hasn't confirmed. */
  provisional: boolean;
  dueAt: string;
  businessDaysRemaining: number;
  state: SlaState;
  /** True once breached: the requester may reasonably chase the owners. */
  escalationAppropriate: boolean;
}

export interface DatasetAccessRequest {
  id: string;
  datasetId: string;
  role: DatasetRoleName;
  /** Why the person needs the role, in their words. */
  reason: string;
  requester: AccessRequester;
  status: AccessRequestStatus;
  requestedAt: string;
  /** `null` while the request is open. */
  outcome: AccessRequestOutcome | null;
  /** Change-list entries the approval created (empty if the person already held the role). */
  changeListEntryIds: string[];
  /** `null` once the request is closed. */
  sla: AccessRequestSla | null;
}

/** What a person submits. Who they are comes from the session, never the caller. */
export interface SubmitAccessRequestInput {
  datasetId: string;
  role: DatasetRoleName;
  reason: string;
}
