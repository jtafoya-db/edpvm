/**
 * TanStack Query hooks for access requests, in front of the {@link DataStore}
 * seam. Same pattern as src/data/datasets/queries.ts: reads go through Query;
 * writes are optimistic saves (src/data/optimistic-save.ts).
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { datasetQueryKeys } from "../datasets/queries";
import { project, type SaveSpec } from "../optimistic-save";
import { useStore } from "../store-context";
import type { AccessRequestConfig } from "./config";
import type { ApproveAccessRequestResult } from "./store";
import type { AccessRequester, DatasetAccessRequest, SubmitAccessRequestInput } from "./types";

export const accessRequestQueryKeys = {
  all: ["access-requests"] as const,
  mine: () => ["access-requests", "mine"] as const,
  inbox: () => ["access-requests", "inbox"] as const,
  settings: () => ["access-requests", "settings"] as const,
};

/** Requestable roles and the owners' SLA target, from configuration. */
export function useAccessRequestSettings(): UseQueryResult<AccessRequestConfig> {
  const store = useStore();
  return useQuery({
    queryKey: accessRequestQueryKeys.settings(),
    queryFn: () => store.accessRequests.describeSettings(),
    staleTime: Infinity,
  });
}

export function useMyAccessRequests(): UseQueryResult<DatasetAccessRequest[]> {
  const store = useStore();
  return useQuery({
    queryKey: accessRequestQueryKeys.mine(),
    queryFn: () => store.accessRequests.listMine(),
  });
}

export function useAccessRequestInbox(): UseQueryResult<DatasetAccessRequest[]> {
  const store = useStore();
  return useQuery({
    queryKey: accessRequestQueryKeys.inbox(),
    queryFn: () => store.accessRequests.listInbox(),
  });
}

/** The record an access-request save locks. */
export const accessRequestRecord = (id: string) => `access-request:${id}`;

const replaceRequest = (requests: DatasetAccessRequest[], request: DatasetAccessRequest) =>
  requests.map((r) => (r.id === request.id ? request : r));

/** Close an open request as the person expects, until the server says how. */
const closing =
  (status: "active" | "rejected" | "withdrawn", by: string, note?: string) =>
  (requests: DatasetAccessRequest[], id: string) =>
    requests.map((r) =>
      r.id === id && r.status === "requested"
        ? {
            ...r,
            status,
            sla: null,
            outcome: { by, at: new Date().toISOString(), note: note?.trim() || null },
          }
        : r,
    );

/**
 * Optimistic saves (ADR-0009 phase 1). Refusals surface on the save
 * ({@link useSaves}); the store still checks every rule.
 */
export const submitAccessRequestSave: SaveSpec<
  SubmitAccessRequestInput & {
    requester: AccessRequester;
    roleLabel: string;
    datasetName: string;
    /** The owners who decide, by name. */
    owners: string;
  },
  DatasetAccessRequest
> = {
  action: "request-access",
  refusedTitle: "That request was refused",
  record: (i) => accessRequestRecord(`new:${i.datasetId}:${i.role}`),
  describe: (i) => `Ask for ${i.roleLabel} on ${i.datasetName}`,
  describeSaved: (r, i) => `Sent ${r.id} to ${i.owners}.`,
  run: (store, i) =>
    store.accessRequests.submit({ datasetId: i.datasetId, role: i.role, reason: i.reason }),
  projections: (i) => {
    const placeholder = `Saving ${i.datasetId} ${i.role}`;
    return [
      project<DatasetAccessRequest[], typeof i, DatasetAccessRequest>(
        accessRequestQueryKeys.mine(),
        (requests) => [
          {
            id: placeholder,
            datasetId: i.datasetId,
            role: i.role,
            reason: i.reason.trim(),
            requester: i.requester,
            status: "requested",
            requestedAt: new Date().toISOString(),
            outcome: null,
            changeListEntryIds: [],
            sla: null,
          },
          ...requests.filter((r) => r.id !== placeholder),
        ],
        (requests, r) => [r, ...requests.filter((x) => x.id !== placeholder && x.id !== r.id)],
      ),
    ];
  },
  invalidates: () => [accessRequestQueryKeys.all],
};

type Decision = {
  request: DatasetAccessRequest;
  by: string;
  datasetName: string;
  roleLabel: string;
};

export const approveAccessRequestSave: SaveSpec<Decision, ApproveAccessRequestResult> = {
  action: "approve",
  refusedTitle: "That decision was refused",
  record: (i) => accessRequestRecord(i.request.id),
  describe: (i) => `Approve ${i.request.id} for ${i.request.requester.name}`,
  describeSaved: (r, i) =>
    `Approved ${r.request.id}: ${i.request.requester.name} is now ${i.roleLabel}.` +
    (r.added.entries.length > 0
      ? ` ${r.added.entries.map((e) => e.id).join(", ")} is pending on the change list.`
      : " They already held the role; nothing new was listed."),
  run: (store, i) =>
    store.accessRequests.approve(i.request.id, { idempotencyKey: i.idempotencyKey }),
  projections: (i) => [
    project<DatasetAccessRequest[], Decision, ApproveAccessRequestResult>(
      accessRequestQueryKeys.inbox(),
      (requests) => closing("active", i.by)(requests, i.request.id),
      (requests, r) => replaceRequest(requests, r.request),
    ),
  ],
  invalidates: () => [
    accessRequestQueryKeys.all,
    datasetQueryKeys.datasets,
    datasetQueryKeys.changeList,
  ],
};

export const rejectAccessRequestSave: SaveSpec<Decision & { note?: string }, DatasetAccessRequest> =
  {
    action: "reject",
    refusedTitle: "That decision was refused",
    record: (i) => accessRequestRecord(i.request.id),
    describe: (i) => `Reject ${i.request.id} for ${i.request.requester.name}`,
    describeSaved: (r) => `Rejected ${r.id}.`,
    run: (store, i) => store.accessRequests.reject(i.request.id, i.note),
    projections: (i) => [
      project<DatasetAccessRequest[], typeof i, DatasetAccessRequest>(
        accessRequestQueryKeys.inbox(),
        (requests) => closing("rejected", i.by, i.note)(requests, i.request.id),
        (requests, r) => replaceRequest(requests, r),
      ),
    ],
    invalidates: () => [accessRequestQueryKeys.all],
  };

export const withdrawAccessRequestSave: SaveSpec<
  { id: string; by: string; datasetName: string; roleLabel: string },
  DatasetAccessRequest
> = {
  action: "withdraw",
  refusedTitle: "That withdrawal was refused",
  record: (i) => accessRequestRecord(i.id),
  describe: (i) => `Withdraw ${i.id}, your request for ${i.roleLabel} on ${i.datasetName}`,
  describeSaved: (r) =>
    `You withdrew ${r.id}. Its owners can no longer decide it. Ask again from the datasets list if you still need the role.`,
  run: (store, i) => store.accessRequests.withdraw(i.id),
  projections: (i) => [
    project<DatasetAccessRequest[], typeof i, DatasetAccessRequest>(
      accessRequestQueryKeys.mine(),
      (requests) => closing("withdrawn", i.by)(requests, i.id),
      (requests, r) => replaceRequest(requests, r),
    ),
  ],
  invalidates: () => [accessRequestQueryKeys.all],
};
