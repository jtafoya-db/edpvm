/**
 * The `eir` tables (`resources/store-eir.sql`) and how their rows make the
 * {@link EirRecord} the EIR screens use. Pure: no reads, no clock unless one
 * is passed, so the area's reads, its commands' plans and the volume
 * migration all build the same record from the same rows.
 *
 * Where the record's fields come from:
 *
 * - `stage`, `expiresAt`, `personName`: the `eirs` row. `expired` is shown
 *   when `stage = 'valid'` and `expires_at` has passed; it's never stored.
 * - `formValues`: the form as signed on the submission the stage is about
 *   (`current_submission_id`).
 * - `renewal`: the renewal running alongside a valid EIR
 *   (`renewal_submission_id`), with its own stage, questions, answer and note.
 * - `questions`, `response`, a renewal's `note`: the `note` of the action on
 *   that submission (`sent-back`, the action that submitted it, `rejected`).
 * - `actions`: `eir_actions` in version order, in the code's names. An action
 *   whose stage didn't move (`from_stage = to_stage`) was on the renewal
 *   alongside (`subject: "renewal"`). The `migrated` action records the
 *   import from the volume and isn't part of the EIR's own history.
 * - `draftValues`: `eir_drafts`, unsigned, with its own version.
 */
import { displayLabel } from "../../../data/display-codes.ts";
import { withoutLegacyMarker } from "../../../data/eir/self-decision.ts";
import type {
  EirAction,
  EirFormValues,
  EirRecord,
  EirRenewal,
  EirStage,
  EirSubmission,
} from "../../../data/eir/types";
import { uuidV5 } from "../ids.ts";
import type { ActionTableRef, TableRef } from "../write-helpers.ts";

export const EIRS: TableRef = { schema: "eir", table: "eirs" };
export const EIR_SUBMISSIONS: TableRef = { schema: "eir", table: "eir_submissions" };
export const EIR_ACTIONS: ActionTableRef = {
  schema: "eir",
  table: "eir_actions",
  recordIdColumn: "eir_id",
};
export const EIR_DRAFTS: TableRef = { schema: "eir", table: "eir_drafts" };
/** The runner's lead rows for draft saves: idempotency only, not actions (ADR-0007 decision 9). */
export const EIR_DRAFT_SAVES: ActionTableRef = {
  schema: "eir",
  table: "eir_draft_saves",
  recordIdColumn: "eir_draft_id",
};

/** Namespace for EIR IDs: a person has one EIR ID before and after their first submission. */
const EIR_NAMESPACE = "3b0f8a52-9d1c-4f7e-8a26-5c4e1b9d7f30";

export const eirIdFor = (principalId: string) => uuidV5(EIR_NAMESPACE, `eir:${principalId}`);
export const draftIdFor = (eirId: string) => uuidV5(eirId, "draft");

/**
 * A stored stage: `not-started` once the person starts the form (`eir/start`),
 * then the lifecycle. Never `expired`: that's worked out on read from
 * `expires_at`.
 */
export type StoredEirStage = Exclude<EirStage, "expired">;
export type SubmissionStage = "submitted" | "questions" | "valid" | "rejected" | "closed";

export interface EirRow {
  id: string;
  /** The Record ID of an EIR started before display codes (`EIR-1042`); null since. */
  display_number: number | string | null;
  /** The Record ID (`EIR-7K3QFD`); null on an EIR started before display codes. */
  display_code?: string | null;
  person_principal_id: string;
  person_display: string;
  stage: StoredEirStage;
  stage_entered_at: string;
  sla_due_at?: string | null;
  sla_due_soon_at?: string | null;
  expires_at?: string | null;
  valid_submission_id?: string | null;
  open_submission_id?: string | null;
  current_submission_id?: string | null;
  renewal_submission_id?: string | null;
  version: number | string;
  created_at: string;
  updated_at: string;
  last_action_id: string;
}

export interface EirSubmissionRow {
  id: string;
  eir_id: string;
  kind: "first" | "resubmission" | "renewal";
  volume_path: string;
  document_sha256?: string | null;
  document_size_bytes?: number | string | null;
  form_values?: string | null;
  form_version: string;
  form_started_at: string;
  stage: SubmissionStage;
  submitted_at: string;
}

/** Table action names (docs/data-model.md, `eir_actions`). */
export type EirActionName =
  | "started"
  | "submitted"
  | "resubmitted"
  | "renewal-submitted"
  | "sent-back"
  | "validated"
  | "rejected"
  | "revoked"
  | "renewal-closed"
  | "migrated";

export interface EirActionRow {
  action_id: string;
  eir_id: string;
  eir_submission_id?: string | null;
  action: EirActionName;
  from_stage?: string | null;
  to_stage?: string | null;
  record_version: number | string;
  actor_principal_id: string;
  actor_display: string;
  actor_app?: string;
  occurred_at: string;
  note?: string | null;
  /** JSON details with no column of their own: a test-mode self-decision's marker. */
  payload?: string | null;
}

export interface EirDraftRow {
  id: string;
  eir_id: string;
  form_values?: string | null;
  form_version?: string | null;
  form_started_at?: string | null;
  version: number | string;
}

export interface EirRows {
  eir?: EirRow;
  submissions: EirSubmissionRow[];
  actions: EirActionRow[];
  draft?: EirDraftRow;
}

/** The columns each part is read with (see {@link eirRowsQuery}). */
export const EIR_COLUMNS = [
  "id",
  "display_number",
  "display_code",
  "person_principal_id",
  "person_display",
  "stage",
  "stage_entered_at",
  "sla_due_at",
  "sla_due_soon_at",
  "expires_at",
  "valid_submission_id",
  "open_submission_id",
  "current_submission_id",
  "renewal_submission_id",
  "version",
  "created_at",
  "updated_at",
  "last_action_id",
] as const;
export const SUBMISSION_COLUMNS = [
  "id",
  "eir_id",
  "kind",
  "volume_path",
  "document_sha256",
  "document_size_bytes",
  "form_values",
  "form_version",
  "form_started_at",
  "stage",
  "submitted_at",
] as const;
export const ACTION_COLUMNS = [
  "action_id",
  "eir_id",
  "eir_submission_id",
  "action",
  "from_stage",
  "to_stage",
  "record_version",
  "actor_principal_id",
  "actor_display",
  "actor_app",
  "occurred_at",
  "note",
  "payload",
] as const;
export const DRAFT_COLUMNS = [
  "id",
  "eir_id",
  "form_values",
  "form_version",
  "form_started_at",
  "version",
] as const;

const struct = (columns: readonly string[]) =>
  `to_json(named_struct(${columns.map((c) => `'${c}', ${c}`).join(", ")}))`;

/**
 * One statement, so one snapshot, for every row of the EIRs that `eirs`
 * selects (a condition on `eirs.id`): `{ part, part_json }` rows. Drafts are
 * read only when `drafts` is given (a condition on `eir_drafts.eir_id`): a
 * draft can exist before its EIR's row does.
 */
export function eirRowsQuery(
  table: (schema: string, table: string) => string,
  filter: { eirs: string; drafts?: string },
): string {
  const eirs = table(EIRS.schema, EIRS.table);
  const ids = `eir_id IN (SELECT id FROM ${eirs} WHERE ${filter.eirs})`;
  return [
    `SELECT 'eir' AS part, ${struct(EIR_COLUMNS)} AS part_json FROM ${eirs} WHERE ${filter.eirs}`,
    `SELECT 'submission' AS part, ${struct(SUBMISSION_COLUMNS)} AS part_json FROM ${table(EIR_SUBMISSIONS.schema, EIR_SUBMISSIONS.table)} WHERE ${ids}`,
    `SELECT 'action' AS part, ${struct(ACTION_COLUMNS)} AS part_json FROM ${table(EIR_ACTIONS.schema, EIR_ACTIONS.table)} WHERE ${ids}`,
    ...(filter.drafts
      ? [
          `SELECT 'draft' AS part, ${struct(DRAFT_COLUMNS)} AS part_json FROM ${table(EIR_DRAFTS.schema, EIR_DRAFTS.table)} WHERE ${filter.drafts}`,
        ]
      : []),
  ].join("\nUNION ALL\n");
}

/** Group `{ part, part_json }` rows by EIR ID. */
export function groupEirRows(rows: { part: string; part_json: string }[]): Map<string, EirRows> {
  const byEir = new Map<string, EirRows>();
  const entry = (id: string) => {
    let found = byEir.get(id);
    if (!found) byEir.set(id, (found = { submissions: [], actions: [] }));
    return found;
  };
  for (const row of rows) {
    const value = JSON.parse(row.part_json) as Record<string, unknown>;
    if (row.part === "eir") entry(value["id"] as string).eir = value as unknown as EirRow;
    else if (row.part === "submission")
      entry(value["eir_id"] as string).submissions.push(value as unknown as EirSubmissionRow);
    else if (row.part === "action")
      entry(value["eir_id"] as string).actions.push(value as unknown as EirActionRow);
    else if (row.part === "draft")
      entry(value["eir_id"] as string).draft = value as unknown as EirDraftRow;
  }
  return byEir;
}

/** ISO-8601 in UTC with milliseconds, however the warehouse formatted it. */
export function isoTime(value: string): string {
  return new Date(value).toISOString();
}

const values = (json: string | null | undefined) =>
  json ? (JSON.parse(json) as EirFormValues) : undefined;

/** The table action that submitted a PDF (its `note` is the person's answer). */
const SUBMITTING: ReadonlySet<EirActionName> = new Set([
  "submitted",
  "resubmitted",
  "renewal-submitted",
]);

const KIND: Record<Exclude<EirActionName, "migrated">, EirAction["kind"]> = {
  started: "started",
  submitted: "submitted",
  resubmitted: "submitted",
  "renewal-submitted": "renewed",
  "sent-back": "questions",
  validated: "valid",
  rejected: "rejected",
  revoked: "revoked",
  "renewal-closed": "renewal-closed",
};

function toAction(row: EirActionRow): EirAction {
  const action = row.action as Exclude<EirActionName, "migrated">;
  // A self-decision is marked by its payload; the note is the validator's own words.
  const note = SUBMITTING.has(action) ? row.note : withoutLegacyMarker(row.note);
  const onRenewal =
    action === "renewal-closed" || (row.from_stage != null && row.from_stage === row.to_stage);
  return {
    kind: KIND[action],
    actorScimId: row.actor_principal_id,
    actorName: row.actor_display,
    at: isoTime(row.occurred_at),
    ...(note ? (SUBMITTING.has(action) ? { response: note } : { note }) : {}),
    ...(onRenewal ? { subject: "renewal" as const } : {}),
    ...(selfDecisionPayload(row.payload) ? { selfDecisionTestMode: true as const } : {}),
  };
}

/** Whether an action row's payload records a test-mode self-decision (set only by the server). */
function selfDecisionPayload(payload: string | null | undefined): boolean {
  if (!payload) return false;
  try {
    return (
      (JSON.parse(payload) as { selfDecisionTestMode?: unknown }).selfDecisionTestMode === true
    );
  } catch {
    return false;
  }
}

function toSubmission(row: EirSubmissionRow): EirSubmission {
  const formValues = values(row.form_values);
  return {
    volumePath: row.volume_path,
    submittedAt: isoTime(row.submitted_at),
    ...(row.document_sha256 ? { sha256: row.document_sha256 } : {}),
    ...(row.document_size_bytes != null ? { sizeBytes: Number(row.document_size_bytes) } : {}),
    ...(formValues ? { formValues } : {}),
    formVersion: row.form_version,
    formStartedAt: isoTime(row.form_started_at),
    kind: row.kind,
  };
}

/** Submissions in the order they were made. */
export function orderedSubmissions(rows: EirSubmissionRow[]): EirSubmissionRow[] {
  return [...rows].sort(
    (a, b) =>
      Date.parse(a.submitted_at) - Date.parse(b.submitted_at) ||
      (a.volume_path < b.volume_path ? -1 : a.volume_path > b.volume_path ? 1 : 0),
  );
}

/** Actions in version order, without the volume import. */
export function orderedActions(rows: EirActionRow[]): EirActionRow[] {
  return rows
    .filter((row) => row.action !== "migrated")
    .sort((a, b) => Number(a.record_version) - Number(b.record_version));
}

/**
 * The EIR as the screens see it. Pass `now` to show `expired`; leave it out
 * for the stored stage (what a command plans from).
 */
export function toEirRecord(principalId: string, rows: EirRows, now?: Date): EirRecord {
  const { eir, draft } = rows;
  const submissions = orderedSubmissions(rows.submissions);
  const actions = orderedActions(rows.actions);
  const byId = new Map(submissions.map((row) => [row.id, row]));
  const latestNote = (submissionId: string, action: EirActionName) =>
    withoutLegacyMarker(
      [...actions]
        .reverse()
        .find((a) => a.eir_submission_id === submissionId && a.action === action)?.note,
    );
  // The latest answer on a submission: a Send response reuses the signed one.
  const answerFor = (submissionId: string) =>
    [...actions]
      .reverse()
      .find((a) => a.eir_submission_id === submissionId && SUBMITTING.has(a.action))?.note ??
    undefined;

  const recordId = eir ? displayLabel("EIR", eir) : undefined;
  const record: EirRecord = {
    principalId: eir?.person_principal_id ?? principalId,
    personName: eir?.person_display ?? "",
    ...(recordId ? { recordId } : {}),
    stage: eir?.stage ?? "not-started",
    submissions: submissions.map(toSubmission),
    actions: actions.map(toAction),
  };
  const current = eir?.current_submission_id ? byId.get(eir.current_submission_id) : undefined;
  const formValues = values(current?.form_values);
  if (formValues && current) {
    record.formValues = formValues;
    record.formVersion = current.form_version;
    record.formStartedAt = isoTime(current.form_started_at);
    record.formSubmittedAt = isoTime(current.submitted_at);
  }
  const draftValues = values(draft?.form_values);
  if (draftValues) {
    record.draftValues = draftValues;
    if (draft?.form_version) record.draftFormVersion = draft.form_version;
    if (draft?.form_started_at) record.draftStartedAt = isoTime(draft.form_started_at);
  }
  if (current && record.stage === "questions") {
    const questions = latestNote(current.id, "sent-back");
    if (questions) record.questions = questions;
  }
  const response = current ? answerFor(current.id) : undefined;
  if (response) record.response = response;
  if (eir?.expires_at) record.expiresAt = isoTime(eir.expires_at);

  const renewalRow = eir?.renewal_submission_id ? byId.get(eir.renewal_submission_id) : undefined;
  if (renewalRow) {
    const stage = renewalRow.stage as EirRenewal["stage"];
    const renewalValues = values(renewalRow.form_values);
    const questions = stage === "questions" ? latestNote(renewalRow.id, "sent-back") : undefined;
    const note = stage === "rejected" ? latestNote(renewalRow.id, "rejected") : undefined;
    const answer = answerFor(renewalRow.id);
    record.renewal = {
      stage,
      volumePath: renewalRow.volume_path,
      submittedAt: isoTime(renewalRow.submitted_at),
      ...(renewalValues ? { formValues: renewalValues } : {}),
      formVersion: renewalRow.form_version,
      formStartedAt: isoTime(renewalRow.form_started_at),
      ...(questions ? { questions } : {}),
      ...(answer ? { response: answer } : {}),
      ...(note ? { note } : {}),
    };
  }
  if (
    now &&
    record.stage === "valid" &&
    record.expiresAt &&
    now.getTime() >= Date.parse(record.expiresAt)
  ) {
    record.stage = "expired";
  }
  record.version = eir ? Number(eir.version) : 0;
  record.draftVersion = draft ? Number(draft.version) : 0;
  return record;
}
