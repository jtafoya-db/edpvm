/**
 * Row shapes and mappings for #72's legacy cart-request tables
 * (`requests.access_requests`, `request_items`, `request_steps`,
 * `waiver_attestations`). Pure, with no I/O: the server's legacy request reads
 * and writes (`src/server/delta/areas/requests.ts`) use them. #96 retires
 * these tables and this module with them.
 */
import type { AccessRequest, RequestItem, SubRequest, WaiverAttestation } from "./types";

export interface AccessRequestRow {
  id: string;
  title: string;
  submitted_at: string;
  status: string;
  overall: string;
  purpose: string;
  stage_index: number;
  requester_principal_id: string | null;
  requester_username: string | null;
}
export interface RequestItemRow {
  request_id: string;
  item_order: number;
  kind: string;
  ref: string | null;
  dataset_id: string | null;
  bundle_id: string | null;
  label: string | null;
  sub: string | null;
}
export interface RequestStepRow {
  request_id: string;
  step_order: number;
  system: string;
  status: SubRequest["status"];
  detail: string;
  ticket: string | null;
  error: string | null;
}
export interface WaiverAttestationRow {
  id: string;
  request_id: string;
  checklist_item_id: string;
  attestor_principal_id: string;
  attestor_username: string;
  attested: boolean;
  attested_at: string;
  note: string | null;
  source: string;
  created_at: string;
  superseded_at: string | null;
}

export function requestToRows(request: AccessRequest): {
  request: AccessRequestRow;
  items: RequestItemRow[];
  steps: RequestStepRow[];
} {
  return {
    request: {
      id: request.id,
      title: request.title,
      submitted_at: request.submittedAt,
      status: request.status,
      overall: request.overall,
      purpose: request.purpose,
      stage_index: request.stageIndex,
      requester_principal_id: request.requesterPrincipalId ?? null,
      requester_username: request.requesterUsername ?? null,
    },
    items: request.items.map((item, item_order) => ({
      request_id: request.id,
      item_order,
      kind: item.kind,
      ref: item.ref ?? null,
      dataset_id: item.id ?? null,
      bundle_id: item.bundle ?? null,
      label: item.label ?? null,
      sub: item.sub ?? null,
    })),
    steps: request.subRequests.map((step, step_order) => ({
      request_id: request.id,
      step_order,
      system: step.system,
      status: step.status,
      detail: step.detail,
      ticket: step.ticket ?? null,
      error: step.error ?? null,
    })),
  };
}
export function rowsToRequest(
  row: AccessRequestRow,
  items: RequestItemRow[],
  steps: RequestStepRow[],
): AccessRequest {
  return {
    id: row.id,
    title: row.title,
    submittedAt: row.submitted_at,
    status: row.status,
    overall: row.overall,
    purpose: row.purpose,
    stageIndex: row.stage_index,
    ...(row.requester_principal_id ? { requesterPrincipalId: row.requester_principal_id } : {}),
    ...(row.requester_username ? { requesterUsername: row.requester_username } : {}),
    items: items
      .sort((a, b) => a.item_order - b.item_order)
      .map((item): RequestItem => ({
        kind: item.kind,
        ...(item.ref ? { ref: item.ref } : {}),
        ...(item.dataset_id ? { id: item.dataset_id } : {}),
        ...(item.bundle_id ? { bundle: item.bundle_id } : {}),
        ...(item.label ? { label: item.label } : {}),
        ...(item.sub ? { sub: item.sub } : {}),
      })),
    subRequests: steps
      .sort((a, b) => a.step_order - b.step_order)
      .map((step): SubRequest => ({
        system: step.system,
        status: step.status,
        detail: step.detail,
        ...(step.ticket ? { ticket: step.ticket } : {}),
        ...(step.error ? { error: step.error } : {}),
      })),
  };
}
export function attestationToRow(value: WaiverAttestation): WaiverAttestationRow {
  return {
    id: value.id,
    request_id: value.requestId,
    checklist_item_id: value.checklistItemId,
    attestor_principal_id: value.attestorPrincipalId,
    attestor_username: value.attestorUsername,
    attested: value.attested,
    attested_at: value.attestedAt,
    note: value.note ?? null,
    source: value.source,
    created_at: value.createdAt,
    superseded_at: value.supersededAt ?? null,
  };
}
export function rowToAttestation(row: WaiverAttestationRow): WaiverAttestation {
  return {
    id: row.id,
    requestId: row.request_id,
    checklistItemId: row.checklist_item_id,
    attestorPrincipalId: row.attestor_principal_id,
    attestorUsername: row.attestor_username,
    attested: row.attested,
    attestedAt: row.attested_at,
    ...(row.note ? { note: row.note } : {}),
    source: row.source,
    createdAt: row.created_at,
    ...(row.superseded_at ? { supersededAt: row.superseded_at } : {}),
  };
}
