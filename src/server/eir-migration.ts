/**
 * One-off migration of #98's interim EIR records on the Unity Catalog volume
 * (`<principal>/record/v<N>.json`, or a legacy `<principal>/_record.json`)
 * into the `eir` tables (#126; docs/data-model.md, "Migration from #72").
 *
 * - **Through the runner.** Each person is one command, with the `system`
 *   actor and an idempotency key derived from their ID. Its lead action is
 *   `migrated` (by `system`); the record's history follows as follow-on
 *   actions, each keeping who acted and when, written by `system`
 *   (`actor_app = 'system'`).
 * - **Idempotent.** Re-running replays each person's key and writes nothing.
 *   A person whose record changed on the volume since is reported, not
 *   rewritten; a person who already has an EIR on Delta is skipped.
 * - **Checked.** Before writing, the rows are turned back into a record with
 *   the same code the app reads with, and compared with the source; after
 *   writing, the table's row counts are compared with the source's. Any
 *   mismatch is reported and fails the run.
 * - **Non-destructive.** Nothing on the volume is changed or deleted: the
 *   PDFs stay where they are, and the record files stay as the rollback
 *   path (see docs/eir-volume.md).
 *
 * Starting again after a rejection or revocation is a submission
 * (decision 2026-10-05), so a #98 "renewal" of a rejected or revoked EIR is
 * migrated as a first submission.
 */
import { z } from "zod";

import { LEGACY_EIR_FORM_VERSION } from "../data/eir/config.ts";
import type { EirAction, EirRecord, EirSubmission } from "../data/eir/types";
import { addBusinessDays } from "../data/sla.ts";
import { cloneEffectiveSlaConfig, type EffectiveSlaConfig } from "../data/sla-config.ts";
import { readEirState } from "./delta/areas/eir.ts";
import {
  draftIdFor,
  EIR_ACTIONS,
  EIR_DRAFTS,
  EIR_SUBMISSIONS,
  eirIdFor,
  EIRS,
  toEirRecord,
  type EirActionName,
  type EirActionRow,
  type EirDraftRow,
  type EirRow,
  type EirRows,
  type EirSubmissionRow,
  type SubmissionStage,
} from "./delta/areas/eir-records.ts";
import { DomainError, IdempotencyKeyReusedError } from "./delta/errors.ts";
import { uuidV5 } from "./delta/ids.ts";
import type { CommandDefinition, SessionUser } from "./delta/registry.ts";
import type { StoreNames } from "./delta/sql-builder.ts";
import type { TransactionRunner } from "./delta/transaction.ts";
import {
  actionColumns,
  NO_DISPLAY_NUMBER,
  allocateDisplayCode,
  expectRow,
  followOn,
  insertRow,
  json,
  SYSTEM_ACTOR,
  timestamp,
  type ColumnValue,
  type WriteContext,
} from "./delta/write-helpers.ts";
import { isSafePrincipalId } from "./eir-path.ts";
import type { EirFileStorageClient, EirVolumeConfig } from "./eir-storage";
import { configuredSlaConfig } from "./sla-config.ts";

// ---- Reading the volume -----------------------------------------------------

export interface VolumeRecord {
  principalId: string;
  /** The file the record came from. */
  path: string;
  /** `N` of `record/v<N>.json`; 0 for a legacy `_record.json`. */
  sourceVersion: number;
  record: EirRecord;
}

const isMissing = (error: unknown) => error instanceof Error && error.message.includes("404");

async function readJson(storage: EirFileStorageClient, path: string): Promise<EirRecord> {
  return JSON.parse(new TextDecoder().decode(await storage.read(path))) as EirRecord;
}

/**
 * Each person's current interim record, read the way #98 read it: the
 * highest `record/v<N>.json`, else `_record.json`. Folders without one
 * (probes, PDFs only) are skipped.
 */
export async function listVolumeRecords(
  storage: EirFileStorageClient,
  volume: EirVolumeConfig,
): Promise<VolumeRecord[]> {
  const root = `/Volumes/${volume.catalog}/${volume.schema}/${volume.volume}`;
  const people = [
    ...new Set(
      (await storage.list(root))
        .map((path) => path.slice(root.length + 1).split("/")[0] ?? "")
        .filter((id) => isSafePrincipalId(id) && !id.startsWith(".")),
    ),
  ].sort();
  const found: VolumeRecord[] = [];
  for (const principalId of people) {
    const versions = (await storage.list(`${root}/${principalId}/record`))
      .map((path) => ({ path, match: /\/v(\d+)\.json$/.exec(path) }))
      .filter((entry): entry is { path: string; match: RegExpExecArray } => Boolean(entry.match))
      .map((entry) => ({ path: entry.path, version: Number(entry.match[1]) }))
      .filter((entry) => Number.isSafeInteger(entry.version) && entry.version > 0)
      .sort((a, b) => b.version - a.version);
    const latest = versions[0];
    if (latest) {
      found.push({
        principalId,
        path: latest.path,
        sourceVersion: latest.version,
        record: await readJson(storage, latest.path),
      });
      continue;
    }
    const legacy = `${root}/${principalId}/_record.json`;
    try {
      found.push({
        principalId,
        path: legacy,
        sourceVersion: 0,
        record: await readJson(storage, legacy),
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return found;
}

// ---- Turning one record into rows -------------------------------------------

export interface ImportedAction extends EirActionRow {
  actor_display: string;
}

export interface ImportPlan {
  rows: EirRows & { eir: EirRow };
  /** Source fields the rows can't reproduce. Empty when the import is exact. */
  mismatches: string[];
}

const DAY = 86_400_000;

/**
 * The rows for one interim record, replaying its actions in order to work
 * out each submission's kind and stage, each action's stage change and the
 * submission it was about. IDs come from `ids`, so the same record always
 * plans the same rows. Pure.
 */
export function planImport(
  source: VolumeRecord,
  ids: {
    eirId: string;
    submission: (i: number) => string;
    action: (i: number) => string;
    lead: string;
  },
  importedAt: Date,
  config: EffectiveSlaConfig = configuredSlaConfig(),
): ImportPlan {
  const slaConfig = cloneEffectiveSlaConfig(config);
  const { record, principalId } = source;
  const mismatches: string[] = [];
  const at = importedAt.toISOString();
  const submissions: EirSubmissionRow[] = record.submissions.map((s, i) => ({
    id: ids.submission(i),
    eir_id: ids.eirId,
    kind: s.kind ?? "first",
    volume_path: s.volumePath,
    document_sha256: s.sha256 ?? null,
    document_size_bytes: s.sizeBytes ?? null,
    form_values: s.formValues ? JSON.stringify(s.formValues) : null,
    // #98 stored no version: its answers are the interim checklist's, kept
    // as they were under that version. Nothing is filled in for form 1.2.
    form_version: s.formVersion ?? LEGACY_EIR_FORM_VERSION,
    // When the form was started wasn't recorded; the submission is the earliest known time.
    form_started_at: s.formStartedAt ?? s.submittedAt,
    stage: "submitted" as SubmissionStage,
    submitted_at: s.submittedAt,
  }));
  let stage = "not-started";
  let current: EirSubmissionRow | undefined;
  let renewal: EirSubmissionRow | undefined;
  let valid: EirSubmissionRow | undefined;
  let expires: number | undefined;
  let stageEnteredAt = record.submissions[0]?.submittedAt ?? at;
  let next = 0;
  // #98 logged starting again after a rejection or revocation as a renewal.
  const restarts = { actions: new Set<number>(), submissions: new Set<number>() };

  const actions: ImportedAction[] = record.actions.map((action: EirAction, i) => {
    const from = stage;
    let name: EirActionName;
    let about: EirSubmissionRow | undefined;
    const renewalPending = renewal?.stage === "submitted";
    switch (action.kind) {
      case "submitted":
      case "renewed": {
        about = submissions[next++];
        if (!about) {
          mismatches.push(`action ${i + 1} (${action.kind}) has no submission in the record`);
          name = "submitted";
          break;
        }
        // #98 marked a renewal alongside a valid EIR with subject "renewal";
        // older records didn't, so a renewal of an unexpired valid EIR is one.
        const alongside =
          action.kind === "renewed" &&
          (action.subject === "renewal" ||
            (action.subject === undefined &&
              stage === "valid" &&
              !(expires !== undefined && Date.parse(action.at) >= expires)));
        if (alongside) {
          about.kind = "renewal";
          renewal = about;
          name = "renewal-submitted";
        } else {
          about.kind =
            stage === "questions" ? "resubmission" : stage === "valid" ? "renewal" : "first"; // not started, rejected or revoked: a fresh start
          if (action.kind === "renewed" && about.kind === "first") {
            restarts.actions.add(i);
            restarts.submissions.add(next - 1);
          }
          name =
            about.kind === "resubmission"
              ? "resubmitted"
              : about.kind === "renewal"
                ? "renewal-submitted"
                : "submitted";
          current = about;
          renewal = undefined;
          stage = "submitted";
          stageEnteredAt = action.at;
        }
        break;
      }
      case "questions":
      case "valid":
      case "rejected": {
        const onRenewal =
          action.subject === "renewal" || (action.subject === undefined && renewalPending);
        about = onRenewal ? renewal : current;
        if (!about) {
          mismatches.push(`action ${i + 1} (${action.kind}) decides no submission`);
        } else {
          about.stage = action.kind;
        }
        if (action.kind === "valid") {
          valid = about;
          expires = Date.parse(action.at) + slaConfig.eirValidityDays * DAY;
        }
        if (onRenewal && action.kind === "valid") {
          current = renewal;
          renewal = undefined;
          stage = "valid";
          stageEnteredAt = action.at;
        } else if (!onRenewal) {
          stage = action.kind;
          stageEnteredAt = action.at;
        }
        name =
          action.kind === "questions"
            ? "sent-back"
            : action.kind === "valid"
              ? "validated"
              : "rejected";
        break;
      }
      case "revoked":
        about = current;
        renewal = undefined;
        stage = "revoked";
        stageEnteredAt = action.at;
        expires = undefined;
        name = "revoked";
        break;
      case "started":
        // #98 had no start; a record that somehow carries one starts nothing here.
        name = "started";
        break;
      case "renewal-closed":
        about = renewal;
        if (about) about.stage = "closed";
        else mismatches.push(`action ${i + 1} closes a renewal that isn't there`);
        renewal = undefined;
        name = "renewal-closed";
        break;
    }
    const submitting = action.kind === "submitted" || action.kind === "renewed";
    return {
      action_id: ids.action(i),
      eir_id: ids.eirId,
      eir_submission_id: about?.id ?? null,
      action: name,
      from_stage: from,
      to_stage: stage,
      record_version: i + 1,
      actor_principal_id: action.actorScimId,
      actor_display: action.actorName ?? action.actorScimId,
      actor_app: "system",
      occurred_at: action.at,
      note: (submitting ? action.response : action.note) ?? null,
    };
  });
  if (next !== submissions.length) {
    mismatches.push(`${submissions.length - next} submission(s) no action submitted`);
  }
  // The oldest records kept the signed values only on the record itself,
  // which #98 set from the latest submission's form.
  const legacyValues = current && !current.form_values && record.formValues ? current : undefined;
  if (legacyValues) legacyValues.form_values = JSON.stringify(record.formValues);

  const open = [renewal, current].find(
    (s) => s && (s.stage === "submitted" || s.stage === "questions"),
  );
  const dueAt =
    open?.stage === "submitted"
      ? addBusinessDays(open.submitted_at, slaConfig.stages["eir-validation"], slaConfig.holidays)
      : undefined;
  const storedStage = record.stage === "expired" ? "valid" : record.stage;
  if (storedStage !== stage)
    mismatches.push(`stage: record says ${record.stage}, its actions say ${stage}`);
  const eir: EirRow = {
    id: ids.eirId,
    // The Record ID is a display code drawn inside the block; null only in the plan.
    display_number: null,
    display_code: null,
    person_principal_id: principalId,
    person_display: record.personName,
    stage: stage as EirRow["stage"],
    stage_entered_at: stageEnteredAt,
    sla_due_at: dueAt?.toISOString() ?? null,
    sla_due_soon_at: dueAt
      ? addBusinessDays(
          dueAt,
          -slaConfig.dueSoonThresholdBusinessDays,
          slaConfig.holidays,
        ).toISOString()
      : null,
    expires_at: record.expiresAt ?? null,
    valid_submission_id: valid?.id ?? null,
    open_submission_id: open?.id ?? null,
    current_submission_id: current?.id ?? null,
    renewal_submission_id: renewal?.id ?? null,
    version: actions.length + 1,
    created_at: record.actions[0]?.at ?? at,
    updated_at: at,
    last_action_id: ids.lead,
  };
  const draft: EirDraftRow | undefined = record.draftValues
    ? {
        id: "",
        eir_id: ids.eirId,
        form_values: JSON.stringify(record.draftValues),
        form_version: record.draftFormVersion ?? LEGACY_EIR_FORM_VERSION,
        form_started_at: record.draftStartedAt ?? null,
        version: 1,
      }
    : undefined;
  const rows = { eir, submissions, actions, ...(draft ? { draft } : {}) };
  const filled = legacyValues ? submissions.indexOf(legacyValues) : -1;
  mismatches.push(...compare(source.record, toEirRecord(principalId, rows), restarts, filled));
  return { rows, mismatches };
}

/**
 * The fields where the migrated record differs from the source. `restarts`
 * are the source's renewals that are now first submissions. Names are only
 * compared where the source had them (older records didn't).
 */
function compare(
  record: EirRecord,
  migrated: EirRecord,
  restarts: { actions: Set<number>; submissions: Set<number> },
  /** The submission given the record's form values, if it had none of its own. */
  filled: number,
): string[] {
  const time = (value: string | undefined) => value && new Date(value).toISOString();
  const submission = (s: EirSubmission, restart: boolean, values = s.formValues) => ({
    volumePath: s.volumePath,
    submittedAt: time(s.submittedAt),
    sha256: s.sha256,
    sizeBytes: s.sizeBytes,
    formValues: values,
    kind: restart
      ? "first"
      : (s.kind ?? migrated.submissions.find((m) => m.volumePath === s.volumePath)?.kind),
  });
  const action = (a: EirAction, restart: boolean, name: boolean) => ({
    kind: restart ? "submitted" : a.kind,
    actorScimId: a.actorScimId,
    actorName: name ? a.actorName : undefined,
    at: time(a.at),
    note: a.note,
    response: a.response,
    subject: restart ? undefined : a.subject,
  });
  const renewal = (r: EirRecord["renewal"]) =>
    r && {
      stage: r.stage,
      volumePath: r.volumePath,
      submittedAt: time(r.submittedAt),
      formValues: r.formValues,
      questions: r.stage === "questions" ? r.questions : undefined,
      note: r.stage === "rejected" ? r.note : undefined,
      response: r.response,
    };
  const pairs: [string, unknown, unknown][] = [
    ["stage", record.stage === "expired" ? "valid" : record.stage, migrated.stage],
    ["personName", record.personName, migrated.personName],
    ["expiresAt", time(record.expiresAt), migrated.expiresAt],
    ["formValues", record.formValues, migrated.formValues],
    ["draftValues", record.draftValues, migrated.draftValues],
    ["questions", record.stage === "questions" ? record.questions : undefined, migrated.questions],
    ["renewal", renewal(record.renewal), renewal(migrated.renewal)],
    [
      "submissions",
      record.submissions.map((s, i) =>
        submission(s, restarts.submissions.has(i), i === filled ? record.formValues : s.formValues),
      ),
      migrated.submissions.map((s) => submission(s, false)),
    ],
    [
      "actions",
      record.actions.map((a, i) => action(a, restarts.actions.has(i), Boolean(a.actorName))),
      migrated.actions.map((a, i) => action(a, false, Boolean(record.actions[i]?.actorName))),
    ],
  ];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return pairs.filter(([, a, b]) => !same(a, b)).map(([field]) => field);
}

// ---- Writing it ---------------------------------------------------------------

/** Namespace for the migration's idempotency keys: one key per person, forever. */
const MIGRATION_NAMESPACE = "8e3c1d7a-2f4b-4a9e-b6d1-0c5f7e2a9b14";
export const migrationKeyFor = (principalId: string) =>
  uuidV5(MIGRATION_NAMESPACE, `eir-volume-migration:${principalId}`);

interface MigrationPayload {
  principalId: string;
  sourcePath: string;
  sourceVersion: number;
  record: EirRecord;
}

/** The command that imports one person. Not on the API: only this migration runs it. */
export const importVolumeRecord: CommandDefinition<
  MigrationPayload,
  { eirId: string; version: number }
> = {
  kind: "command",
  area: "eir",
  name: "import-volume-record",
  app: "staff",
  payload: z
    .object({
      principalId: z.string(),
      sourcePath: z.string(),
      sourceVersion: z.number().int().min(0),
      record: z.custom<EirRecord>((value) => typeof value === "object" && value !== null),
    })
    .strict(),
  leadActionTable: EIR_ACTIONS,
  authorize: () => undefined,
  async plan(ctx) {
    const { principalId, sourcePath, record } = ctx.payload;
    const state = await readEirState(ctx, principalId);
    if (state.rows.eir) {
      throw new DomainError("already-on-delta", `${principalId} already has an EIR on Delta.`, 409);
    }
    const eirId = state.eirId;
    const ids = {
      eirId,
      lead: ctx.actionId,
      submission: (i: number) => submissionIds[i]!,
      action: (i: number) => actionIds[i]!,
    };
    const submissionIds = await Promise.all(record.submissions.map((_s, i) => followOn(ctx, i)));
    const actionIds = await Promise.all(
      record.actions.map((_a, i) => followOn(ctx, record.submissions.length + i)),
    );
    const plan = planImport(
      { principalId, path: sourcePath, sourceVersion: ctx.payload.sourceVersion, record },
      ids,
      ctx.occurredAt,
    );
    if (plan.mismatches.length) {
      throw new DomainError(
        "migration-mismatch",
        `${principalId}: the migrated EIR wouldn't match ${sourcePath} (${plan.mismatches.join(", ")}).`,
        422,
      );
    }
    const { block, names } = ctx;
    const eirs = names.table(EIRS.schema, EIRS.table);
    const subs = names.table(EIR_SUBMISSIONS.schema, EIR_SUBMISSIONS.table);
    block.guard(
      `EXISTS (SELECT 1 FROM ${eirs} WHERE id = ${block.bind(eirId)} OR person_principal_id = ${block.bind(principalId)})`,
      new DomainError("already-on-delta", `${principalId} already has an EIR on Delta.`, 409),
    );
    for (const submission of record.submissions) {
      block.guard(
        `EXISTS (SELECT 1 FROM ${subs} WHERE volume_path = ${block.bind(submission.volumePath)})`,
        new DomainError("already-submitted", `${submission.volumePath} is already on Delta.`, 409),
      );
    }
    const { eir } = plan.rows;
    const ts = (value: string | null | undefined) => (value ? timestamp(new Date(value)) : null);
    insertRow(ctx, EIRS, {
      ...(eir as unknown as Record<string, ColumnValue>),
      display_number: NO_DISPLAY_NUMBER,
      display_code: allocateDisplayCode(ctx, "EIR", EIRS),
      stage_entered_at: ts(eir.stage_entered_at),
      sla_due_at: ts(eir.sla_due_at),
      sla_due_soon_at: ts(eir.sla_due_soon_at),
      expires_at: ts(eir.expires_at),
      version: Number(eir.version),
      created_at: ts(eir.created_at),
      created_by_principal_id: SYSTEM_ACTOR.principalId,
      updated_at: timestamp(ctx.occurredAt),
      updated_by_principal_id: SYSTEM_ACTOR.principalId,
    });
    expectRow(ctx, EIRS, "id", eirId, `last_action_id = ${block.bind(ctx.actionId)}`);
    for (const s of plan.rows.submissions) {
      insertRow(ctx, EIR_SUBMISSIONS, {
        ...(s as unknown as Record<string, ColumnValue>),
        document_size_bytes: s.document_size_bytes == null ? null : Number(s.document_size_bytes),
        submitted_at: timestamp(new Date(s.submitted_at)),
        form_started_at: timestamp(new Date(s.form_started_at)),
        created_at: timestamp(ctx.occurredAt),
        updated_at: timestamp(ctx.occurredAt),
      });
      expectRow(ctx, EIR_SUBMISSIONS, "id", s.id);
    }
    for (const a of plan.rows.actions) {
      // The history keeps who acted and when; `system` wrote it (actor_app).
      const historical: WriteContext = {
        ...ctx,
        actor: { principalId: a.actor_principal_id, display: a.actor_display, app: "system" },
        occurredAt: new Date(a.occurred_at),
      };
      insertRow(ctx, EIR_ACTIONS, {
        ...actionColumns(historical, EIR_ACTIONS, {
          actionId: a.action_id,
          recordId: eirId,
          action: a.action,
          recordVersion: Number(a.record_version),
          change: { stage: [a.from_stage ?? null, a.to_stage ?? null] },
          note: a.note ?? null,
          causedByActionId: ctx.actionId,
        }),
        eir_submission_id: a.eir_submission_id ?? null,
        command: null,
        command_hash: null,
        expected_effects: null,
      });
      expectRow(ctx, EIR_ACTIONS, "action_id", a.action_id);
    }
    if (plan.rows.draft) {
      const draftId = await draftIdFor(eirId);
      insertRow(ctx, EIR_DRAFTS, {
        id: draftId,
        eir_id: eirId,
        form_values: plan.rows.draft.form_values ?? null,
        form_version: plan.rows.draft.form_version ?? LEGACY_EIR_FORM_VERSION,
        form_started_at: plan.rows.draft.form_started_at
          ? timestamp(new Date(plan.rows.draft.form_started_at))
          : null,
        version: 1,
        created_at: timestamp(ctx.occurredAt),
        created_by_principal_id: SYSTEM_ACTOR.principalId,
        updated_at: timestamp(ctx.occurredAt),
        updated_by_principal_id: SYSTEM_ACTOR.principalId,
        last_action_id: ctx.actionId,
      });
      expectRow(ctx, EIR_DRAFTS, "id", draftId);
    }
    return {
      recordId: eirId,
      recordVersion: Number(eir.version),
      leadAction: {
        action: "migrated",
        note: `Imported from the interim volume record ${sourcePath} (v${ctx.payload.sourceVersion}).`,
        payload: { source: sourcePath, sourceVersion: ctx.payload.sourceVersion },
      },
    };
  },
  resultRow: ({ recordId, names, block }) =>
    `SELECT id, version FROM ${names.table(EIRS.schema, EIRS.table)} WHERE id = ${block.bind(recordId)}`,
  result: (row) => ({ eirId: String(row["id"]), version: Number(row["version"]) }),
};

export type MigrationOutcome =
  | "migrated"
  | "already-migrated"
  | "already-on-delta"
  | "source-changed"
  | "mismatch"
  | "would-migrate";

export interface MigrationReportEntry {
  principalId: string;
  path: string;
  sourceVersion: number;
  outcome: MigrationOutcome;
  source: { submissions: number; actions: number };
  /** The tables' rows for this EIR after the run (actions without the `migrated` one). */
  tables?: { submissions: number; actions: number };
  detail?: string;
}

export interface MigrationReport {
  entries: MigrationReportEntry[];
  /** False when any person mismatched, changed since, or the row counts differ. */
  ok: boolean;
}

const SYSTEM_USER: SessionUser = {
  principalId: SYSTEM_ACTOR.principalId,
  displayName: SYSTEM_ACTOR.display,
  email: "",
  isAdmin: false,
  onboardingReviewerRoles: [],
};

/**
 * Migrate every interim record on the volume. `dryRun` plans and checks each
 * person without writing.
 */
export async function migrateEirVolumeRecords(input: {
  storage: EirFileStorageClient;
  volume: EirVolumeConfig;
  runner: TransactionRunner;
  names: StoreNames;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<MigrationReport> {
  const { runner, names } = input;
  const now = input.now ?? (() => new Date());
  const read = runner.reader({ readId: globalThis.crypto.randomUUID() });
  const entries: MigrationReportEntry[] = [];
  for (const source of await listVolumeRecords(input.storage, input.volume)) {
    const entry: MigrationReportEntry = {
      principalId: source.principalId,
      path: source.path,
      sourceVersion: source.sourceVersion,
      outcome: "migrated",
      source: {
        submissions: source.record.submissions.length,
        actions: source.record.actions.length,
      },
    };
    entries.push(entry);
    if (input.dryRun) {
      const eirId = await eirIdFor(source.principalId);
      const plan = planImport(
        source,
        { eirId, lead: "dry-run", submission: (i) => `s${i}`, action: (i) => `a${i}` },
        now(),
      );
      entry.outcome = plan.mismatches.length ? "mismatch" : "would-migrate";
      if (plan.mismatches.length) entry.detail = plan.mismatches.join(", ");
      continue;
    }
    try {
      const outcome = await runner.runCommand(importVolumeRecord, {
        user: SYSTEM_USER,
        actor: SYSTEM_ACTOR,
        idempotencyKey: await migrationKeyFor(source.principalId),
        expectedVersion: 0,
        payload: {
          principalId: source.principalId,
          sourcePath: source.path,
          sourceVersion: source.sourceVersion,
          record: source.record,
        },
      });
      entry.outcome = outcome.replayed ? "already-migrated" : "migrated";
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) {
        entry.outcome = "source-changed";
        entry.detail =
          "The record on the volume changed after it was migrated; nothing was rewritten.";
      } else if (error instanceof DomainError && error.code === "already-on-delta") {
        entry.outcome = "already-on-delta";
        entry.detail = error.message;
      } else if (error instanceof DomainError && error.code === "migration-mismatch") {
        entry.outcome = "mismatch";
        entry.detail = error.message;
      } else {
        throw error;
      }
    }
    if (entry.outcome === "migrated" || entry.outcome === "already-migrated") {
      const state = await readEirState({ names, read }, source.principalId);
      entry.tables = {
        submissions: state.rows.submissions.length,
        actions: state.rows.actions.filter((a) => a.action !== "migrated").length,
      };
    }
  }
  const ok = entries.every(
    (entry) =>
      entry.outcome !== "mismatch" &&
      entry.outcome !== "source-changed" &&
      (!entry.tables ||
        (entry.tables.submissions === entry.source.submissions &&
          entry.tables.actions === entry.source.actions)),
  );
  return { entries, ok };
}

/** Print a report as the migration script does. */
export function describeReport(report: MigrationReport): string {
  return [
    ...report.entries.map(
      (e) =>
        `${e.outcome.padEnd(16)} ${e.principalId}  source v${e.sourceVersion}: ${e.source.submissions} submissions, ${e.source.actions} actions` +
        (e.tables
          ? ` | tables: ${e.tables.submissions} submissions, ${e.tables.actions} actions`
          : "") +
        (e.detail ? ` | ${e.detail}` : ""),
    ),
    `${report.entries.length} record(s); ${report.ok ? "OK" : "FAILED"}`,
  ].join("\n");
}
