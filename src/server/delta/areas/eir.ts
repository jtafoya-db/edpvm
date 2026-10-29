/**
 * The `eir` area (#126, ADR-0007 decision 9): Employee Identity Records on
 * Delta, replacing #98's versioned volume records (`record/v<N>.json`).
 * Signed PDFs stay in the Unity Catalog volume; the tables hold each one's
 * path, SHA-256 and size.
 *
 * - `eir/submit` (tenant): the person submits a signed PDF they uploaded
 *   (`POST /api/eir/uploads`). The kind follows from the stage: a first
 *   submission (also starting again after a rejection or revocation), a
 *   resubmission answering a send-back, or a renewal of a valid or expired
 *   EIR, which runs alongside a valid one.
 * - `eir/save-draft` (tenant): unsigned work in progress, on its own row and
 *   version, so it never conflicts with a decision and never changes a
 *   submitted record.
 * - `eir/decide` (staff, safeguards validators only, never on their own EIR
 *   except under a PR preview's test mode, `eir-test-mode.ts`): valid,
 *   questions, rejected or revoked.
 * - Reads: `eir/mine` (tenant, the session's own EIR), `eir/record` and
 *   `eir/inbox` (staff, safeguards validators only).
 *
 * The lifecycle rules are #98's, applied by the same code the in-memory
 * repository runs ({@link createMemoryEirRepository}) to the EIR as its rows
 * stand. The command then writes what changed: the new submission, the
 * actions, the EIR's new state. Every write runs through the transaction
 * runner, and every EIR change checks the version the plan read, so a rule
 * checked on that state still holds when the block commits.
 */
import { z } from "zod";

import {
  createMemoryEirRepository,
  EIR_UNAVAILABLE_MESSAGE,
  EirDomainError,
  eirWaitingSince,
  evaluatePinnedDraft,
  FORM_CHANGED_REFUSAL,
  formForNextSave,
  formsOfDefinitions,
  isRenewalStage,
  type EirDefinitionLookup,
  type MemoryEirRepository,
  withAutomaticValidity,
} from "../../../data/eir/repository.ts";
import {
  automaticValidityOf,
  qualifiesForAutomaticValidity,
  type EirApprovalConfig,
  type EirAutomaticValidity,
} from "../../../data/eir/approval-mode.ts";
import { configuredEirApprovalConfig } from "../../eir-approval-mode.ts";
import { EIR_FORM, type EirFormConfig } from "../../../data/eir/config.ts";
import { definitionLabel } from "../../../data/eir/definition/identity.ts";
import type { EffectiveSlaConfig } from "../../../data/sla-config.ts";
import { resolveEirDefinitions } from "./eir-definitions.ts";
import { cloneEffectiveSlaConfig, DEFAULT_EFFECTIVE_SLA_CONFIG } from "../../../data/sla-config.ts";
import type { EirAction, EirInboxItem, EirRecord } from "../../../data/eir/types";
import type { EirEvaluation } from "../../../data/eir/types";
import { blockingGuidance, evaluateEirDraft } from "../../../data/eir/evaluation.ts";
import type { EirDefinitionVersions } from "../../../data/eir/definition/repository.ts";
import { generateEirPdf } from "../../../data/eir/pdf.ts";
import { displayLabel } from "../../../data/display-codes.ts";
import {
  addBusinessDays,
  computePeriodSlaStatus,
  computeStoredSlaStatus,
} from "../../../data/sla.ts";
import { configuredSlaConfig } from "../../sla-config.ts";
import { parseEirPdfPath } from "../../eir-path.ts";
import { eirSelfValidationAllowed, readSelfValidationFlag } from "../../eir-test-mode.ts";
import { OWN_EIR_REFUSAL } from "../../../data/eir/self-decision.ts";
import type { EirVolumeConfig } from "../../eir-storage";
import { DomainError, GUARD_STATE, VersionConflictError } from "../errors.ts";
import type {
  CommandContext,
  CommandPlan,
  CommandResultContext,
  ReadFn,
  Registry,
  ResultRowContext,
  SessionUser,
} from "../registry.ts";
import type { DeltaSnapshot } from "../snapshot-cache.ts";
import type { StoreNames } from "../sql-builder.ts";
import {
  actionColumns,
  expectRow,
  followOn,
  allocateDisplayCode,
  insertAction,
  insertCurrentState,
  insertRow,
  json,
  SYSTEM_ACTOR,
  timestamp,
  updateCurrentState,
  type ColumnValue,
  type SqlExpr,
} from "../write-helpers.ts";
import {
  draftIdFor,
  ACTION_COLUMNS,
  EIR_ACTIONS,
  EIR_COLUMNS,
  EIR_DRAFT_SAVES,
  EIR_DRAFTS,
  EIR_SUBMISSIONS,
  DRAFT_COLUMNS,
  eirIdFor,
  eirRowsQuery,
  EIRS,
  groupEirRows,
  orderedActions,
  SUBMISSION_COLUMNS,
  toEirRecord,
  type EirActionRow,
  type EirDraftRow,
  type EirRow,
  type EirActionName,
  type EirRows,
  type EirSubmissionRow,
  type StoredEirStage,
  type SubmissionStage,
} from "./eir-records.ts";

/** `authorize` for safeguards validators (EIR decisions and the validator inbox). */
export function requireSafeguardsValidator(user: SessionUser): void {
  if (!user.isSafeguardsValidator) {
    throw new DomainError("forbidden", "Only safeguards validators can do this.", 403);
  }
}

function eirRowsFromSnapshot(
  snapshot: DeltaSnapshot,
  filter: (row: EirRow) => boolean,
  options: { includeDrafts: boolean; draftIds?: Set<string> },
): EirRows[] {
  const eirs = snapshot.table<EirRow>("eir", "eirs").filter(filter);
  const ids = new Set(eirs.map((row) => row.id));
  for (const id of options.draftIds ?? []) ids.add(id);
  const rows: { part: string; part_json: string }[] = [
    ...eirs.map((row) => ({
      part: "eir",
      part_json: JSON.stringify(
        Object.fromEntries(EIR_COLUMNS.map((column) => [column, row[column]])),
      ),
    })),
    ...snapshot
      .table<EirSubmissionRow>("eir", "eir_submissions")
      .filter((row) => ids.has(row.eir_id))
      .map((row) => ({
        part: "submission",
        part_json: JSON.stringify(
          Object.fromEntries(SUBMISSION_COLUMNS.map((column) => [column, row[column]])),
        ),
      })),
    ...snapshot
      .table<EirActionRow>("eir", "eir_actions")
      .filter((row) => ids.has(row.eir_id))
      .map((row) => ({
        part: "action",
        part_json: JSON.stringify(
          Object.fromEntries(ACTION_COLUMNS.map((column) => [column, row[column]])),
        ),
      })),
  ];
  if (options.includeDrafts) {
    rows.push(
      ...snapshot
        .table<EirDraftRow>("eir", "eir_drafts")
        .filter((row) => ids.has(row.eir_id))
        .map((row) => ({
          part: "draft",
          part_json: JSON.stringify(
            Object.fromEntries(DRAFT_COLUMNS.map((column) => [column, row[column]])),
          ),
        })),
    );
  }
  return [...groupEirRows(rows).values()];
}

/**
 * A record as someone other than its person sees it: the unsigned draft (its
 * answers and its metadata) is the person's own work in progress, never for
 * review (ADR-0007). Validators see submitted records and history only.
 */
function withoutDraft<T extends EirRecord>(record: T): T {
  const {
    draftValues: _draftValues,
    draftFormVersion: _draftFormVersion,
    draftStartedAt: _draftStartedAt,
    draftVersion: _draftVersion,
    ...reviewed
  } = record;
  return reviewed as T;
}

/** The record for `viewer`: their own keeps its draft; anyone else's doesn't. */
const draftOnlyForOwner = (record: EirRecord, viewer: SessionUser) =>
  record.principalId === viewer.principalId ? record : withoutDraft(record);

/** What the area needs from the server. Tests inject these; the app reads them from env. */
export interface EirAreaDeps {
  /** The clock reads use to show `expired` (commands use their own `occurredAt`). */
  now: () => Date;
  volume: () => EirVolumeConfig;
  /** Read a signed PDF from the volume, as the app's service principal. */
  readFile: (path: string) => Promise<Uint8Array>;
  maxUploadBytes: () => number;
  slaConfig: () => EffectiveSlaConfig;
  /**
   * Whether a validator may decide their own EIR in this store: a PR
   * preview's test mode (`eir-test-mode.ts`), off unless both guards pass.
   */
  selfDecisionTestMode: (names: StoreNames) => boolean;
  /**
   * The store's typed EIR definitions (#201): the active one and the ones
   * `wanted` names. Saves use their forms; a draft is evaluated against the
   * one its persisted form version names.
   */
  definitions: (
    ctx: { names: StoreNames; read: ReadFn },
    wanted: EirDefinitionVersions,
  ) => Promise<EirDefinitionLookup>;
  evaluator: typeof evaluateEirDraft;
  /** The deploy-time approval settings (#204), resolved on the server. */
  approval: () => EirApprovalConfig;
}

// The app's own volume and service principal, from env. Loaded on first use,
// so scripts that inject their own (the live check, the migration) don't load
// the session and identity modules.
const eirApi = () => import("../../eir-api");
let volumeConfig: EirVolumeConfig | undefined;
let uploadLimit: number | undefined;
const defaultDeps: EirAreaDeps = {
  now: () => new Date(),
  volume: () => {
    if (!volumeConfig) throw new Error("The EIR volume isn't configured yet.");
    return volumeConfig;
  },
  readFile: async (path) => (await (await eirApi()).resolveEirStorage(undefined)).read(path),
  maxUploadBytes: () => uploadLimit ?? 10 * 1024 * 1024,
  slaConfig: () => configuredSlaConfig(),
  selfDecisionTestMode: (names) => defaultSelfDecisionTestMode(names),
  definitions: resolveEirDefinitions,
  evaluator: evaluateEirDraft,
  approval: () => configuredEirApprovalConfig(),
};

/**
 * The app's test-mode check: the flag from env, and the prefix of the store
 * the runner writes to (not a second reading of the env).
 */
export function defaultSelfDecisionTestMode(names: StoreNames): boolean {
  return eirSelfValidationAllowed(readSelfValidationFlag(), names.schemaPrefix);
}

function withSla(
  record: EirRecord,
  deps: EirAreaDeps,
  now: Date,
  stored?: { sla_due_at?: string | null; sla_due_soon_at?: string | null },
): EirRecord {
  if (record.stage !== "submitted" && record.renewal?.stage !== "submitted") return record;
  const waitingSince = eirWaitingSince(record);
  if (!waitingSince) return record;
  const slaConfig = cloneEffectiveSlaConfig(deps.slaConfig());
  if (stored?.sla_due_at) {
    return {
      ...record,
      sla: computeStoredSlaStatus(
        "eir-validation",
        waitingSince,
        now,
        stored.sla_due_at,
        stored.sla_due_soon_at,
        { holidays: slaConfig.holidays },
      ),
    };
  }
  return {
    ...record,
    sla: computePeriodSlaStatus(
      "eir-validation",
      waitingSince,
      now,
      slaConfig.stages["eir-validation"],
      {
        dueSoonThreshold: slaConfig.dueSoonThresholdBusinessDays,
        holidays: slaConfig.holidays,
      },
    ),
  };
}

/** Read the volume settings from env before the first submission is planned. */
async function loadDefaults(): Promise<void> {
  if (volumeConfig) return;
  const api = await eirApi();
  volumeConfig = api.resolveEirVolumeConfig(undefined);
  uploadLimit = api.maxUploadBytes(undefined);
}

/**
 * Form answers. The shape is checked here; which keys the form has, and
 * what's required and well-formed, are checked by the rules on the form the
 * command uses (the in-memory repository's), so the screen, memory and Delta
 * refuse exactly the same answers.
 */
const formAnswers = z.record(z.string(), z.string().max(1000));

/**
 * The definitions this person's EIR uses (#201): the active one, and the
 * ones their draft and submissions began under. With no active definition
 * (it couldn't be loaded) every employee command refuses, before it writes
 * anything.
 */
async function definitionsFor(
  deps: Pick<EirAreaDeps, "definitions">,
  ctx: { names: StoreNames; read: ReadFn },
  record?: EirRecord,
): Promise<EirDefinitionLookup> {
  const definitions = await deps.definitions(ctx, {
    ids: [record?.draftFormVersion, record?.formVersion, record?.renewal?.formVersion],
  });
  if (!definitions.active()) {
    throw new DomainError("eir-unavailable", EIR_UNAVAILABLE_MESSAGE, 503);
  }
  return definitions;
}

/**
 * The form version the screen showed. A client that showed another form
 * than the one the save would use is refused (`FORM_CHANGED_REFUSAL`)
 * rather than storing answers it can't mean.
 */
const formVersion = z.string().min(1).max(32);

const submitPayload = z
  .object({
    volumePath: z.string().min(1).max(512),
    formVersion,
    values: formAnswers,
    response: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
const draftPayload = z.object({ formVersion, values: formAnswers }).strict();
const evaluatePayload = z.object({}).strict();
/**
 * Send response: the answers on screen (which must be the signed ones) and
 * the response. No form version from the client: the signed submission's own
 * must be the current form's.
 */
const respondPayload = z.object({ values: formAnswers, response: z.string().max(4000) }).strict();
const startPayload = z.object({}).strict();
const decidePayload = z
  .object({
    principalId: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .max(64),
    decision: z.enum(["valid", "questions", "rejected", "revoked"]),
    note: z.string().max(4000).optional(),
  })
  .strict();

/** A command's answer: the EIR record as the block left it, stored for idempotent replay. */
export type EirCommandResult = EirRecord;

const EIR_EVALUATIONS = {
  schema: "eir",
  table: "eir_evaluations",
  recordIdColumn: "eir_draft_id",
} as const;

/** The follow-on position of an upload's own pre-check row (#204), clear of planEirChange's. */
const UPLOAD_EVALUATION_POSITION = 64;

const evaluationFromRow = (row: Record<string, unknown>): EirEvaluation => ({
  definitionVersion: String(row["definition_version"]),
  formVersion: String(row["form_version"]),
  effectiveAt: new Date(String(row["occurred_at"] ?? row["effective_at"])).toISOString(),
  evaluatedDraftVersion: Number(row["record_version"] ?? row["evaluated_draft_version"]),
  outcome: String(row["outcome"]) as EirEvaluation["outcome"],
  outcomes: JSON.parse(String(row["rule_outcomes"])),
  automaticValidityEligible:
    row["automatic_validity_eligible"] === true || Number(row["automatic_validity_eligible"]) === 1,
  ...(row["evaluation_sequence"] != null ? { sequence: Number(row["evaluation_sequence"]) } : {}),
  actorPrincipalId: "system",
  actorDisplay: "EDP Vending Machine",
  actorApp: "system",
});

/**
 * A saved draft's evaluation against the definition it's pinned to (#201,
 * #224), on the command's clock: the shared rule ({@link evaluatePinnedDraft}),
 * so a definition that can't be loaded, or an evaluator that fails, is
 * manual handling, never a refusal or a guess.
 */
function evaluationOf(
  deps: Pick<EirAreaDeps, "evaluator" | "approval">,
  definitions: EirDefinitionLookup,
  draft: Pick<EirRecord, "draftFormVersion">,
  input: { values: Record<string, string>; draftVersion: number; draftStartedAt: string },
  occurredAt: Date,
): EirEvaluation {
  return evaluatePinnedDraft({
    evaluator: deps.evaluator,
    definitions,
    record: draft,
    ...input,
    effectiveAt: occurredAt.toISOString(),
    config: deps.approval(),
  }).evaluation;
}

/**
 * The next pre-check's place in its draft's evaluations (#204): one more
 * than the highest recorded, taken inside the block that writes it. That
 * read of the table also makes a concurrent pre-check of the same draft
 * conflict at commit, so the runner retries it and no number is used twice.
 * Rows recorded before the column existed have none and come first.
 */
function nextEvaluationSequence(ctx: CommandContext<unknown>, draftId: string): SqlExpr {
  const evaluations = ctx.names.table(EIR_EVALUATIONS.schema, EIR_EVALUATIONS.table);
  return {
    sql: ctx.block.declare(
      "BIGINT",
      `SELECT COALESCE(MAX(evaluation_sequence), 0) + 1 FROM ${evaluations} WHERE eir_draft_id = ${ctx.block.bind(draftId)}`,
    ),
  };
}

/** How the reads order a draft's pre-checks, latest first: by sequence, then (older rows) by time. */
const LATEST_EVALUATION_FIRST = (alias = "") =>
  `${alias}evaluation_sequence DESC NULLS LAST, ${alias}occurred_at DESC, ${alias}action_id DESC`;

/** The `eir_evaluations` columns of a recorded pre-check, beyond the shared action columns. */
const evaluationColumns = (
  evaluation: EirEvaluation,
  sequence: SqlExpr,
): Record<string, ColumnValue> => ({
  evaluation_sequence: sequence,
  definition_version: evaluation.definitionVersion,
  form_version: evaluation.formVersion,
  outcome: evaluation.outcome,
  rule_outcomes: json(evaluation.outcomes),
  automatic_validity_eligible: evaluation.automaticValidityEligible,
  evaluator_principal_id: SYSTEM_ACTOR.principalId,
  evaluator_display: SYSTEM_ACTOR.display,
  evaluator_app: SYSTEM_ACTOR.app,
});

/** The lead `evaluated` action of a command that records an evaluation. */
const evaluatedAction = (
  evaluation: EirEvaluation,
  sequence: SqlExpr,
): CommandPlan["leadAction"] => ({
  action: "evaluated",
  payload: evaluation,
  columns: evaluationColumns(evaluation, sequence),
});

/** The evaluation's columns in a command's response row ({@link evaluationFromRow} reads them). */
function evaluationResultColumns(ctx: ResultRowContext): string {
  const evaluation = ctx.leadAction.payload as EirEvaluation;
  return `${ctx.block.bind(evaluation.definitionVersion)} AS definition_version,
        ${ctx.block.bind(evaluation.formVersion)} AS form_version,
        ${ctx.block.bind(ctx.occurredAt.toISOString())} AS effective_at,
        ${ctx.block.bind(ctx.recordVersion)} AS evaluated_draft_version,
        ${ctx.block.bind(evaluation.outcome)} AS outcome,
        ${ctx.block.bind(json(evaluation.outcomes))} AS rule_outcomes,
        ${ctx.block.bind(evaluation.automaticValidityEligible)} AS automatic_validity_eligible,
        ${(ctx.leadAction.columns?.["evaluation_sequence"] as SqlExpr).sql} AS evaluation_sequence`;
}

async function latestEvaluation(
  names: StoreNames,
  read: ReadFn,
  draftId: string | undefined,
  draftVersion: number | undefined,
): Promise<EirEvaluation | undefined> {
  if (!draftId || draftVersion === undefined) return undefined;
  const rows = await read<Record<string, unknown>>({
    statement: `SELECT definition_version, form_version, occurred_at, record_version,
      outcome, rule_outcomes, automatic_validity_eligible, evaluation_sequence
      FROM ${names.table(EIR_EVALUATIONS.schema, EIR_EVALUATIONS.table)}
      WHERE eir_draft_id = :draft_id
      ORDER BY CASE WHEN record_version = :draft_version THEN 0 ELSE 1 END,
        ${LATEST_EVALUATION_FIRST()} LIMIT 1`,
    parameters: { draft_id: draftId, draft_version: draftVersion },
  });
  return rows[0] ? evaluationFromRow(rows[0]) : undefined;
}

function latestEvaluationFromSnapshot(
  snapshot: DeltaSnapshot,
  draftId: string | undefined,
  draftVersion: number | undefined,
): EirEvaluation | undefined {
  if (!draftId || draftVersion === undefined) return undefined;
  const rows = snapshot
    .table<Record<string, unknown>>(EIR_EVALUATIONS.schema, EIR_EVALUATIONS.table)
    .filter((row) => row["eir_draft_id"] === draftId)
    .sort((left, right) => {
      const leftMatches = Number(left["record_version"]) === draftVersion;
      const rightMatches = Number(right["record_version"]) === draftVersion;
      if (leftMatches !== rightMatches) return leftMatches ? -1 : 1;
      // As LATEST_EVALUATION_FIRST: by sequence, rows without one last.
      const leftSequence = left["evaluation_sequence"];
      const rightSequence = right["evaluation_sequence"];
      if ((leftSequence == null) !== (rightSequence == null)) return leftSequence == null ? 1 : -1;
      if (leftSequence != null && Number(leftSequence) !== Number(rightSequence)) {
        return Number(rightSequence) - Number(leftSequence);
      }
      const occurredAt =
        Date.parse(String(right["occurred_at"])) - Date.parse(String(left["occurred_at"]));
      if (occurredAt !== 0) return occurredAt;
      const leftActionId = String(left["action_id"]);
      const rightActionId = String(right["action_id"]);
      if (leftActionId === rightActionId) return 0;
      return leftActionId < rightActionId ? 1 : -1;
    });
  return rows[0] ? evaluationFromRow(rows[0]) : undefined;
}

// ---- Reading the rows -------------------------------------------------------

export interface EirState {
  eirId: string;
  principalId: string;
  rows: EirRows;
  /** The stored record (no expiry applied): what the rules run on. */
  record: EirRecord;
}

/** Every row of one person's EIR, in one statement (one snapshot). */
export async function readEirState(
  ctx: { names: StoreNames; read: ReadFn },
  principalId: string,
): Promise<EirState> {
  const eirId = await eirIdFor(principalId);
  return readEirStateById(ctx, eirId, principalId);
}

async function readEirStateById(
  ctx: { names: StoreNames; read: ReadFn },
  eirId: string,
  fallbackPrincipalId: string,
): Promise<EirState> {
  const rows = await ctx.read<{ part: string; part_json: string }>({
    statement: eirRowsQuery(ctx.names.table, { eirs: "id = :id", drafts: "eir_id = :id" }),
    parameters: { id: eirId },
  });
  const grouped = groupEirRows(rows).get(eirId) ?? { submissions: [], actions: [] };
  const principalId = grouped.eir?.person_principal_id ?? fallbackPrincipalId;
  return { eirId, principalId, rows: grouped, record: toEirRecord(principalId, grouped) };
}

/**
 * The in-memory rules, loaded with this one EIR as its rows stand, on the
 * command's clock. They refuse a self-decision unless the server's own test
 * mode check passed (`selfDecisionTestMode`), and mark one when it did.
 */
function rulesFor(
  state: EirState,
  occurredAt: Date,
  options: {
    selfDecisionTestMode?: boolean;
    slaConfig?: EffectiveSlaConfig;
    definitions?: EirDefinitionLookup;
  } = {},
): MemoryEirRepository {
  const { version: _version, draftVersion: _draftVersion, ...record } = state.record;
  const known = state.rows.eir || record.draftValues;
  return createMemoryEirRepository({
    clock: () => occurredAt,
    initialRecords: known ? [record] : [],
    selfDecisionTestMode: options.selfDecisionTestMode === true,
    ...(options.definitions ? { definitions: options.definitions } : {}),
    ...(options.slaConfig
      ? {
          validityDays: options.slaConfig.eirValidityDays,
          reviewSlaBusinessDays: options.slaConfig.stages["eir-validation"],
          dueSoonThresholdBusinessDays: options.slaConfig.dueSoonThresholdBusinessDays,
          holidays: options.slaConfig.holidays,
        }
      : {}),
  });
}

/** Run a rule; its refusal becomes the API's (400 or 409, with #98's message). */
async function applyRule<T = EirRecord>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EirDomainError) {
      throw new DomainError(
        error.status === 400 ? "eir-invalid" : error.status === 403 ? "own-eir" : "eir-refused",
        error.message,
        error.status,
      );
    }
    throw error;
  }
}

function checkVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new VersionConflictError(`read ${actual}, expected ${expected}`);
}

// ---- Writing what changed ---------------------------------------------------

const SUBMITTED_ACTIONS = new Set<EirActionName>(["submitted", "resubmitted", "renewal-submitted"]);

const DECISION_ACTION = {
  questions: "sent-back",
  valid: "validated",
  rejected: "rejected",
} as const;

interface PlannedAction {
  name: EirActionName;
  from: string;
  to: string;
  submissionId: string | null;
  note: string | null;
  bySystem: boolean;
  /**
   * The action's structured payload, set only by the rules: the marker of a
   * test-mode self-decision, or what an automatic validity decision rests on (#204).
   */
  payload: { selfDecisionTestMode: true } | { automaticValidity: EirAutomaticValidity } | null;
}

/**
 * Write the difference between the EIR as its rows stand (`state`) and as
 * the rules left it (`after`): at most one new submission, one or two new
 * actions (a revocation also closes a renewal running alongside), submission
 * stages, and the EIR row, one version per action.
 */
async function planEirChange(
  ctx: CommandContext<unknown>,
  state: EirState,
  after: EirRecord,
  slaConfig: EffectiveSlaConfig,
): Promise<CommandPlan> {
  const before = state.record;
  const newSubmissions = after.submissions.slice(before.submissions.length);
  const newActions = after.actions.slice(before.actions.length);
  if (newSubmissions.length > 1 || newActions.length < 1 || newActions.length > 2) {
    throw new Error(
      `Unexpected EIR change: ${newSubmissions.length} submissions, ${newActions.length} actions`,
    );
  }
  const subsTable = ctx.names.table(EIR_SUBMISSIONS.schema, EIR_SUBMISSIONS.table);
  const submissionStage = new Map(
    state.rows.submissions.map((s) => [s.id, s.stage as SubmissionStage]),
  );
  const submittedAt = new Map(state.rows.submissions.map((s) => [s.id, s.submitted_at]));
  const changedStage = new Map<string, SubmissionStage>();
  const setStage = (id: string, stage: SubmissionStage) => {
    submissionStage.set(id, stage);
    changedStage.set(id, stage);
  };

  const newSubmission = newSubmissions[0];
  const newSubmissionId = newSubmission ? await followOn(ctx, 0) : undefined;
  const storedBefore: StoredEirStage | "not-started" = state.rows.eir?.stage ?? "not-started";
  let stage: string = storedBefore;
  let current = state.rows.eir?.current_submission_id ?? null;
  let renewal = state.rows.eir?.renewal_submission_id ?? null;
  let valid = state.rows.eir?.valid_submission_id ?? null;

  const planned: PlannedAction[] = newActions.map((action: EirAction) => {
    const from = stage;
    const onRenewal = action.subject === "renewal";
    let name: EirActionName;
    let submissionId: string | null;
    switch (action.kind) {
      case "submitted":
      case "renewed": {
        if (!newSubmission) {
          // Send response: the sent-back submission goes back to the validator,
          // with its signed PDF and answers, and the SLA counts from now.
          submissionId = onRenewal ? renewal : current;
          if (!submissionId || submissionStage.get(submissionId) !== "questions") {
            throw new Error("A response with no sent-back submission to answer.");
          }
          setStage(submissionId, "submitted");
          submittedAt.set(submissionId, action.at);
          if (!onRenewal) stage = "submitted";
          name = onRenewal ? "renewal-submitted" : "resubmitted";
          break;
        }
        submissionId = newSubmissionId!;
        submissionStage.set(submissionId, "submitted");
        submittedAt.set(submissionId, newSubmission.submittedAt);
        if (onRenewal) {
          renewal = submissionId;
          name = "renewal-submitted";
        } else {
          current = submissionId;
          renewal = null;
          stage = "submitted";
          name =
            newSubmission.kind === "resubmission"
              ? "resubmitted"
              : newSubmission.kind === "renewal"
                ? "renewal-submitted"
                : "submitted";
        }
        break;
      }
      case "questions":
      case "valid":
      case "rejected": {
        submissionId = onRenewal ? renewal : current;
        if (!submissionId) throw new Error("A decision with no submission to decide.");
        setStage(submissionId, action.kind);
        if (action.kind === "valid") valid = submissionId;
        if (onRenewal && action.kind === "valid") {
          current = submissionId;
          renewal = null;
          stage = "valid";
        } else if (!onRenewal) {
          stage = action.kind;
        }
        name = DECISION_ACTION[action.kind];
        break;
      }
      case "revoked":
        submissionId = current;
        renewal = null;
        stage = "revoked";
        name = "revoked";
        break;
      case "started":
        // eir/start writes its own row; no change the rules plan starts a record.
        throw new Error("A submission or decision can't start an EIR.");
      case "renewal-closed":
        submissionId = renewal;
        if (!submissionId) throw new Error("Closing a renewal that isn't there.");
        setStage(submissionId, "closed");
        renewal = null;
        name = "renewal-closed";
        break;
    }
    const submitting = action.kind === "submitted" || action.kind === "renewed";
    return {
      name,
      from,
      to: stage,
      submissionId,
      note: (submitting ? action.response : action.note) ?? null,
      bySystem: action.actorScimId === SYSTEM_ACTOR.principalId,
      payload: action.selfDecisionTestMode
        ? { selfDecisionTestMode: true }
        : action.automaticValidity
          ? { automaticValidity: action.automaticValidity }
          : null,
    };
  });

  // The rules and this plan must agree on where the EIR ended up.
  const afterStage = after.stage === "expired" ? "valid" : after.stage;
  const renewalPath = renewal
    ? (state.rows.submissions.find((s) => s.id === renewal)?.volume_path ??
      newSubmission?.volumePath)
    : undefined;
  if (afterStage !== stage || after.renewal?.volumePath !== renewalPath) {
    throw new Error(`EIR plan disagrees with the rules: ${stage} vs ${afterStage}`);
  }

  const { block } = ctx;
  const at = timestamp(ctx.occurredAt);
  if (newSubmission && newSubmissionId) {
    block.guard(
      `EXISTS (SELECT 1 FROM ${subsTable} WHERE volume_path = ${block.bind(newSubmission.volumePath)})`,
      new DomainError("already-submitted", "This signed PDF has already been submitted.", 409),
    );
    insertRow(ctx, EIR_SUBMISSIONS, {
      id: newSubmissionId,
      eir_id: state.eirId,
      kind: newSubmission.kind ?? "first",
      volume_path: newSubmission.volumePath,
      document_sha256: newSubmission.sha256 ?? null,
      document_size_bytes: newSubmission.sizeBytes ?? null,
      form_values: json(newSubmission.formValues),
      form_version: newSubmission.formVersion ?? EIR_FORM.version,
      form_started_at: timestamp(
        new Date(newSubmission.formStartedAt ?? newSubmission.submittedAt),
      ),
      // Valid at once when the system validates it in this block (#204).
      stage: submissionStage.get(newSubmissionId) ?? "submitted",
      submitted_at: timestamp(new Date(newSubmission.submittedAt)),
      created_at: at,
      updated_at: at,
    });
    expectRow(ctx, EIR_SUBMISSIONS, "id", newSubmissionId);
  }
  if (newSubmission || planned.some((a) => SUBMITTED_ACTIONS.has(a.name))) {
    // The draft was for this submission (or response); sending it supersedes the draft.
    block.add(
      `UPDATE ${ctx.names.table(EIR_DRAFTS.schema, EIR_DRAFTS.table)} SET form_values = NULL, version = version + 1, updated_at = ${block.bind(at)}, updated_by_principal_id = ${block.bind(ctx.actor.principalId)}, last_action_id = ${block.bind(ctx.actionId)} WHERE eir_id = ${block.bind(state.eirId)} AND form_values IS NOT NULL`,
    );
  }
  for (const [id, submissionStageNow] of changedStage) {
    if (id === newSubmissionId) continue;
    block.add(
      `UPDATE ${subsTable} SET stage = ${block.bind(submissionStageNow)}, updated_at = ${block.bind(at)} WHERE id = ${block.bind(id)} AND eir_id = ${block.bind(state.eirId)}`,
    );
    expectRow(ctx, EIR_SUBMISSIONS, "id", id, `stage = ${block.bind(submissionStageNow)}`);
  }

  // Waiting on someone: the renewal alongside first, else the EIR's own submission.
  const inReview = (id: string | null) =>
    id && ["submitted", "questions"].includes(submissionStage.get(id) ?? "") ? id : null;
  const open = inReview(renewal) ?? inReview(current);
  const waitingSince =
    open && submissionStage.get(open) === "submitted" ? submittedAt.get(open) : undefined;
  const dueAt = waitingSince
    ? addBusinessDays(waitingSince, slaConfig.stages["eir-validation"], slaConfig.holidays)
    : undefined;
  const columns: Record<string, ColumnValue> = {
    person_principal_id: state.principalId,
    person_display: after.personName,
    stage,
    ...(stage !== storedBefore ? { stage_entered_at: at } : {}),
    sla_due_at: dueAt ? timestamp(dueAt) : null,
    sla_due_soon_at: dueAt
      ? timestamp(
          addBusinessDays(dueAt, -slaConfig.dueSoonThresholdBusinessDays, slaConfig.holidays),
        )
      : null,
    expires_at: after.expiresAt ? timestamp(new Date(after.expiresAt)) : null,
    valid_submission_id: valid,
    open_submission_id: open,
    current_submission_id: current,
    renewal_submission_id: renewal,
  };

  const eirsTable = ctx.names.table(EIRS.schema, EIRS.table);
  if (!state.rows.eir) {
    // A new EIR: someone else's first submission for this person (a second
    // tab) must lose as a version conflict, not add a second row.
    block.signal(
      `EXISTS (SELECT 1 FROM ${eirsTable} WHERE id = ${block.bind(state.eirId)} OR person_principal_id = ${block.bind(state.principalId)})`,
      GUARD_STATE.versionConflict,
      "edp:version-conflict",
    );
    // Its first submission starts the record too: it gets its Record ID now.
    insertCurrentState(
      ctx,
      EIRS,
      state.eirId,
      { stage_entered_at: at, ...columns },
      { displayCode: allocateDisplayCode(ctx, "EIR", EIRS) },
    );
    // A first submission the system also validates (#204) is two versions.
    for (let i = 1; i < planned.length; i++) updateCurrentState(ctx, EIRS, state.eirId, i, {});
  } else {
    // One version per action: a revocation that closes a renewal is two.
    for (let i = 0; i < planned.length - 1; i++) {
      updateCurrentState(ctx, EIRS, state.eirId, ctx.expectedVersion + i, {});
    }
    updateCurrentState(ctx, EIRS, state.eirId, ctx.expectedVersion + planned.length - 1, columns);
  }

  // The lead is the caller's own action; the others are follow-ons it
  // caused, by the system: a renewal closed by a revocation (before the
  // lead), or the validity decision on an upload in automatic approval mode
  // (#204, after it). Each action is one version, in order.
  const own = planned.findIndex((action) => !action.bySystem);
  const leadIndex = own === -1 ? planned.length - 1 : own;
  for (const [i, action] of planned.entries()) {
    if (i === leadIndex) continue;
    const actionId = await followOn(ctx, i < leadIndex ? 1 + i : i);
    insertRow(ctx, EIR_ACTIONS, {
      ...actionColumns(action.bySystem ? { ...ctx, actor: SYSTEM_ACTOR } : ctx, EIR_ACTIONS, {
        actionId,
        recordId: state.eirId,
        action: action.name,
        recordVersion: ctx.expectedVersion + 1 + i,
        change: { stage: [action.from, action.to] },
        note: action.note,
        payload: action.payload,
        causedByActionId: ctx.actionId,
      }),
      eir_submission_id: action.submissionId,
      command: null,
      command_hash: null,
      expected_effects: null,
    });
    expectRow(ctx, EIR_ACTIONS, "action_id", actionId);
  }
  const lead = planned[leadIndex]!;
  return {
    recordId: state.eirId,
    recordVersion: ctx.expectedVersion + 1 + leadIndex,
    leadAction: {
      action: lead.name,
      change: { stage: [lead.from, lead.to] },
      note: lead.note,
      payload: lead.payload,
      columns: { eir_submission_id: lead.submissionId },
    },
  };
}

// ---- The signed PDF ---------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The PDF's hash and size, read from the volume by the server, never taken
 * from the browser. The volume's files are written once (`overwrite=false`),
 * so a path's answer never changes and retries reuse it.
 */
function fileInspector(deps: EirAreaDeps) {
  const known = new Map<string, { sha256: string; sizeBytes: number }>();
  return async (path: string, owner: string) => {
    const parsed = parseEirPdfPath(path, deps.volume());
    if (!parsed || parsed.owner !== owner) {
      throw new DomainError("not-your-file", "Upload your signed PDF, then submit it.", 403);
    }
    const cached = known.get(path);
    if (cached) return cached;
    let bytes: Uint8Array;
    try {
      bytes = await deps.readFile(path);
    } catch {
      throw new DomainError("file-missing", "The uploaded PDF wasn't found. Upload it again.", 409);
    }
    if (bytes.length > deps.maxUploadBytes()) {
      throw new DomainError(
        "file-too-large",
        "The PDF exceeds the configured upload size limit.",
        413,
      );
    }
    if (bytes.length < 5 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
      throw new DomainError("not-a-pdf", "Only PDF files are accepted.", 415);
    }
    const metadata = { sha256: await sha256Hex(bytes), sizeBytes: bytes.length };
    if (known.size > 500) known.clear();
    known.set(path, metadata);
    return metadata;
  };
}

// ---- Registration -----------------------------------------------------------

const jsonStruct = (columns: readonly string[]) =>
  `to_json(named_struct(${columns.map((c) => `'${c}', ${c}`).join(", ")}))`;
const jsonArray = (select: string) =>
  `COALESCE((SELECT to_json(collect_list(value)) FROM (${select}) AS edp_parts), '[]')`;

function eirCommandResultRow(
  ctx: ResultRowContext,
  eirIdSql = ctx.block.bind(ctx.recordId),
  options: { includeLeadAction?: boolean } = {},
) {
  const { block, names } = ctx;
  const eirs = names.table(EIRS.schema, EIRS.table);
  const submissions = names.table(EIR_SUBMISSIONS.schema, EIR_SUBMISSIONS.table);
  const actions = names.table(EIR_ACTIONS.schema, EIR_ACTIONS.table);
  const drafts = names.table(EIR_DRAFTS.schema, EIR_DRAFTS.table);
  const [fromStage, toStage] = ctx.leadAction.change?.["stage"] ?? [null, null];
  const leadSubmissionId = (ctx.leadAction.columns?.["eir_submission_id"] ?? null) as string | null;
  const storedActionRows = `SELECT ${ACTION_COLUMNS.join(", ")} FROM ${actions} WHERE eir_id = ${eirIdSql}`;
  const actionRows =
    options.includeLeadAction === false
      ? storedActionRows
      : `
    SELECT
      ${block.bind(ctx.actionId)} AS action_id,
      ${eirIdSql} AS eir_id,
      ${block.bind(leadSubmissionId)} AS eir_submission_id,
      ${block.bind(ctx.leadAction.action)} AS action,
      ${block.bind(fromStage)} AS from_stage,
      ${block.bind(toStage)} AS to_stage,
      ${block.bind(ctx.recordVersion)} AS record_version,
      ${block.bind(ctx.actor.principalId)} AS actor_principal_id,
      ${block.bind(ctx.actor.display)} AS actor_display,
      ${block.bind(ctx.actor.app)} AS actor_app,
      ${block.bind(ctx.occurredAt.toISOString())} AS occurred_at,
      ${block.bind(ctx.leadAction.note ?? null)} AS note,
      ${block.bind(json(ctx.leadAction.payload))} AS payload
    UNION ALL
    ${storedActionRows}`;
  return `SELECT
    ${block.bind(ctx.user.principalId)} AS principal_id,
    ${jsonArray(`SELECT ${jsonStruct(EIR_COLUMNS)} AS value FROM ${eirs} WHERE id = ${eirIdSql}`)} AS eirs_json,
    ${jsonArray(`SELECT ${jsonStruct(SUBMISSION_COLUMNS)} AS value FROM ${submissions} WHERE eir_id = ${eirIdSql}`)} AS submissions_json,
    ${jsonArray(`SELECT ${jsonStruct(ACTION_COLUMNS)} AS value FROM (${actionRows}) AS edp_actions`)} AS actions_json,
    ${jsonArray(`SELECT ${jsonStruct(DRAFT_COLUMNS)} AS value FROM ${drafts} WHERE eir_id = ${eirIdSql}`)} AS drafts_json`;
}

function draftCommandResultRow(ctx: ResultRowContext) {
  const drafts = ctx.names.table(EIR_DRAFTS.schema, EIR_DRAFTS.table);
  return eirCommandResultRow(
    ctx,
    `(SELECT eir_id FROM ${drafts} WHERE id = ${ctx.block.bind(ctx.recordId)})`,
    { includeLeadAction: false },
  );
}

function jsonRows<T>(value: unknown): T[] {
  return (JSON.parse(String(value ?? "[]")) as Array<T | string>).map((row) =>
    typeof row === "string" ? (JSON.parse(row) as T) : row,
  );
}

function rowsFromCommandResult(row: Record<string, unknown>): {
  principalId: string;
  rows: EirRows;
} {
  const eirs = jsonRows<EirRow>(row["eirs_json"]);
  const submissions = jsonRows<EirSubmissionRow>(row["submissions_json"]);
  const actions = jsonRows<EirActionRow>(row["actions_json"]);
  const drafts = jsonRows<EirDraftRow>(row["drafts_json"]);
  const rows: EirRows = { submissions, actions };
  if (eirs[0]) rows.eir = eirs[0];
  if (drafts[0]) rows.draft = drafts[0];
  return {
    principalId: String(row["principal_id"]),
    rows,
  };
}

/** Start the person's EIR in this block: its row, with a new Record ID. */
function insertStartedEir(
  ctx: CommandContext<unknown>,
  eirId: string,
  principalId: string,
  displayName: string,
): void {
  // The rule, inside the block: a second tab starting it too loses.
  ctx.block.signal(
    `EXISTS (SELECT 1 FROM ${ctx.names.table(EIRS.schema, EIRS.table)} WHERE id = ${ctx.block.bind(eirId)} OR person_principal_id = ${ctx.block.bind(principalId)})`,
    GUARD_STATE.versionConflict,
    "edp:version-conflict",
  );
  insertCurrentState(
    ctx,
    EIRS,
    eirId,
    {
      person_principal_id: principalId,
      person_display: displayName,
      stage: "not-started",
      stage_entered_at: timestamp(ctx.occurredAt),
      sla_due_at: null,
      sla_due_soon_at: null,
      expires_at: null,
      valid_submission_id: null,
      open_submission_id: null,
      current_submission_id: null,
      renewal_submission_id: null,
    },
    { displayCode: allocateDisplayCode(ctx, "EIR", EIRS) },
  );
}

/**
 * Write the draft the rules saved (`saved`) at `ctx.expectedVersion + 1`:
 * inserted, or updated from the version the plan read. Returns its ID.
 */
async function writeDraft(
  ctx: CommandContext<{ values: Record<string, string> }>,
  state: EirState,
  saved: EirRecord,
): Promise<string> {
  const { block, names } = ctx;
  const eirs = names.table(EIRS.schema, EIRS.table);
  const subs = names.table(EIR_SUBMISSIONS.schema, EIR_SUBMISSIONS.table);
  // The rule, inside the block: no draft while the EIR waits on a validator.
  block.guard(
    `EXISTS (SELECT 1 FROM ${eirs} e LEFT JOIN ${subs} s ON s.id = e.renewal_submission_id WHERE e.id = ${block.bind(state.eirId)} AND (e.stage = 'submitted' OR s.stage = 'submitted'))`,
    new DomainError(
      "eir-refused",
      "A draft can't be saved while the EIR waits for a safeguards validator.",
      409,
    ),
  );
  const draftId = await draftIdFor(state.eirId);
  const draft = {
    form_values: json(ctx.payload.values),
    // The version the draft began under, or the active one for a new draft (#201).
    form_version: saved.draftFormVersion ?? EIR_FORM.version,
    form_started_at: timestamp(new Date(saved.draftStartedAt ?? ctx.occurredAt)),
  };
  if (!state.rows.draft) {
    block.signal(
      `EXISTS (SELECT 1 FROM ${names.table(EIR_DRAFTS.schema, EIR_DRAFTS.table)} WHERE id = ${block.bind(draftId)} OR eir_id = ${block.bind(state.eirId)})`,
      GUARD_STATE.versionConflict,
      "edp:version-conflict",
    );
    insertCurrentState(ctx, EIR_DRAFTS, draftId, { eir_id: state.eirId, ...draft });
  } else {
    updateCurrentState(ctx, EIR_DRAFTS, draftId, ctx.expectedVersion, draft);
  }
  return draftId;
}

/** `eir/prepare-pdf`'s answer: the PDF as base64, absent when the evaluation blocks. */
export interface EirPreparedPdfResult {
  record: EirRecord;
  evaluation: EirEvaluation;
  pdf?: string;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function registerEirArea(registry: Registry, overrides: Partial<EirAreaDeps> = {}): void {
  const deps: EirAreaDeps = { ...defaultDeps, ...overrides };
  const usesDefaults = !overrides.volume;
  const fileCheck = fileInspector(deps);
  const toResult = async (
    row: Record<string, unknown>,
    ctx: CommandResultContext,
  ): Promise<EirCommandResult> => {
    const result =
      row["eirs_json"] == null
        ? await readEirStateById(
            { names: ctx.names, read: ctx.read },
            String(row["eir_id"] ?? ctx.recordId),
            ctx.user.principalId,
          )
        : rowsFromCommandResult(row);
    const now = deps.now();
    return withSla(toEirRecord(result.principalId, result.rows, now), deps, now, result.rows.eir);
  };
  const inspect = async (path: string, owner: string) => {
    if (usesDefaults) await loadDefaults();
    return fileCheck(path, owner);
  };

  registry.command({
    area: "eir",
    name: "evaluate",
    app: "tenant",
    payload: evaluatePayload,
    leadActionTable: EIR_EVALUATIONS,
    async plan(ctx) {
      const state = await readEirState(ctx, ctx.user.principalId);
      const draft = state.rows.draft;
      if (!draft?.form_values || !draft.form_started_at) {
        throw new DomainError("draft-required", "Save the EIR draft before evaluating it.", 409);
      }
      const draftVersion = Number(draft.version);
      checkVersion(draftVersion, ctx.expectedVersion);
      // Against the definition the draft was pinned to, not the active one (#201,
      // #224). One that can't be read or loaded is manual handling, not a refusal.
      const definitions = await deps
        .definitions(ctx, { ids: [state.record.draftFormVersion] })
        .catch((): EirDefinitionLookup => ({ active: () => undefined, byId: () => null }));
      const evaluation = evaluationOf(
        deps,
        definitions,
        state.record,
        {
          values: JSON.parse(draft.form_values),
          draftVersion,
          draftStartedAt: draft.form_started_at,
        },
        ctx.occurredAt,
      );
      return {
        recordId: draft.id,
        recordVersion: draftVersion,
        leadAction: evaluatedAction(evaluation, nextEvaluationSequence(ctx, draft.id)),
      };
    },
    resultRow(ctx) {
      return `SELECT ${evaluationResultColumns(ctx)}`;
    },
    result(row): EirEvaluation {
      return evaluationFromRow(row);
    },
  });

  // The forms prepare-pdf planned on, by draft and version, so its first
  // answer needs no second definitions read; a replay reads them again.
  const plannedForms = new Map<string, EirFormConfig>();
  registry.command({
    area: "eir",
    name: "prepare-pdf",
    app: "tenant",
    payload: draftPayload,
    // The evaluation leads: it holds the key, and the draft it evaluated.
    leadActionTable: EIR_EVALUATIONS,
    async plan(ctx) {
      const { principalId, displayName } = ctx.user;
      const state = await readEirState(ctx, principalId);
      checkVersion(Number(state.rows.draft?.version ?? 0), ctx.expectedVersion);
      const definitions = await definitionsFor(deps, ctx, state.record);
      // The same rules as start, save-draft and evaluate, in one block.
      const saved = await applyRule(() =>
        rulesFor(state, ctx.occurredAt, {
          slaConfig: cloneEffectiveSlaConfig(deps.slaConfig()),
          definitions,
        }).saveDraft(principalId, ctx.payload.values, undefined, ctx.payload.formVersion),
      );
      if (!state.rows.eir) {
        insertStartedEir(ctx, state.eirId, principalId, displayName);
        insertAction(ctx, EIR_ACTIONS, {
          actionId: await followOn(ctx, 1),
          recordId: state.eirId,
          action: "started",
          recordVersion: 1,
          change: { stage: [null, "not-started"] },
        });
      }
      const draftId = await writeDraft(ctx, state, saved);
      const draftVersion = ctx.expectedVersion + 1;
      const evaluation = evaluationOf(
        deps,
        definitions,
        saved,
        {
          values: ctx.payload.values,
          draftVersion,
          draftStartedAt: saved.draftStartedAt ?? ctx.occurredAt.toISOString(),
        },
        ctx.occurredAt,
      );
      const form = definitions.byId(evaluation.formVersion)?.form;
      if (form) {
        plannedForms.set(`${draftId}:${draftVersion}`, form);
        // Bounded: a refused block leaves its entry behind.
        if (plannedForms.size > 100) plannedForms.delete(plannedForms.keys().next().value!);
      }
      return {
        recordId: draftId,
        recordVersion: draftVersion,
        leadAction: evaluatedAction(evaluation, nextEvaluationSequence(ctx, draftId)),
      };
    },
    resultRow(ctx) {
      return `SELECT edp_evaluation.*, edp_record.* FROM (SELECT ${evaluationResultColumns(ctx)}) AS edp_evaluation CROSS JOIN (${draftCommandResultRow(ctx)}) AS edp_record`;
    },
    async result(row, ctx): Promise<EirPreparedPdfResult> {
      const evaluation = evaluationFromRow(row);
      const record = { ...(await toResult(row, ctx)), evaluation };
      if (evaluation.outcome === "blocking") return { record, evaluation };
      const key = `${ctx.recordId}:${ctx.recordVersion}`;
      // On the form the draft was evaluated on, never guessed (#201).
      const form =
        plannedForms.get(key) ??
        (
          await deps.definitions(
            { names: ctx.names, read: ctx.read },
            { ids: [evaluation.formVersion] },
          )
        ).byId(evaluation.formVersion)?.form;
      plannedForms.delete(key);
      if (!form || !record.draftValues) {
        throw new DomainError("eir-unavailable", EIR_UNAVAILABLE_MESSAGE, 503);
      }
      const bytes = await generateEirPdf(record.draftValues, {
        recordId: record.recordId ?? ctx.user.principalId,
        form,
      });
      return { record, evaluation, pdf: base64(bytes) };
    },
  });

  registry.command({
    area: "eir",
    name: "submit",
    app: "tenant",
    payload: submitPayload,
    leadActionTable: EIR_ACTIONS,
    async plan(ctx) {
      const { principalId, displayName } = ctx.user;
      const state = await readEirState(ctx, principalId);
      const draft = state.rows.draft;
      if (!draft?.form_values) {
        throw new DomainError(
          "evaluation-required",
          "Evaluate the current saved draft before uploading its PDF.",
          409,
        );
      }
      const evaluations = ctx.names.table(EIR_EVALUATIONS.schema, EIR_EVALUATIONS.table);
      const evaluationRows = await ctx.read<{
        record_version: number | string;
        outcome: string;
        rule_outcomes: string;
      }>({
        statement: `SELECT record_version, outcome, rule_outcomes FROM ${evaluations}
          WHERE eir_draft_id = :draft_id AND record_version = :draft_version
          ORDER BY ${LATEST_EVALUATION_FIRST()} LIMIT 1`,
        parameters: { draft_id: draft.id, draft_version: Number(draft.version) },
      });
      const evaluation = evaluationRows[0];
      if (!evaluation || Number(evaluation.record_version) !== Number(draft.version)) {
        throw new DomainError(
          "evaluation-required",
          "Evaluate the current saved draft before uploading its PDF.",
          409,
        );
      }
      if (evaluation.outcome === "blocking") {
        const guidance = blockingGuidance(
          JSON.parse(evaluation.rule_outcomes) as EirEvaluation["outcomes"],
        );
        throw new DomainError(
          "evaluation-blocking",
          `Correct the blocking EIR fields before uploading its PDF. ${guidance}`,
          409,
        );
      }
      const drafts = ctx.names.table(EIR_DRAFTS.schema, EIR_DRAFTS.table);
      ctx.block.guard(
        `NOT EXISTS (SELECT 1 FROM ${evaluations} WHERE eir_draft_id = ${ctx.block.bind(draft.id)} AND record_version = ${ctx.block.bind(Number(draft.version))} AND outcome <> 'blocking')
          OR NOT EXISTS (SELECT 1 FROM ${drafts} WHERE id = ${ctx.block.bind(draft.id)} AND version = ${ctx.block.bind(Number(draft.version))})`,
        new DomainError(
          "evaluation-stale",
          "The evaluated draft changed before the upload was recorded.",
          409,
        ),
      );
      const metadata = await inspect(ctx.payload.volumePath, principalId);
      checkVersion(Number(state.rows.eir?.version ?? 0), ctx.expectedVersion);
      const definitions = await definitionsFor(deps, ctx, state.record);
      const forms = formsOfDefinitions(definitions);
      // The answers are for the form this submission uses, before any rule runs.
      const ids = await applyRule(async () => {
        const form = formForNextSave(state.record, forms);
        if (form.version !== ctx.payload.formVersion) {
          throw new EirDomainError(FORM_CHANGED_REFUSAL, 400);
        }
        const ids = new Set([
          ...form.sections.flatMap((section) => section.fields.map((field) => field.id)),
          form.declaration.attestation.id,
        ]);
        const unknown = Object.keys(ctx.payload.values).find((key) => !ids.has(key));
        if (unknown)
          throw new EirDomainError(
            `${unknown} isn't on the EIR form for ${definitionLabel(form.version)}.`,
            400,
          );
        return ids;
      });
      // The answers on the PDF are the evaluated draft's, on that form.
      const evaluatedValues = JSON.parse(draft.form_values) as Record<string, string>;
      if (
        [...ids].some(
          (field) => (evaluatedValues[field] ?? "") !== (ctx.payload.values[field] ?? ""),
        )
      ) {
        throw new DomainError(
          "evaluation-mismatch",
          "The uploaded PDF must use the evaluated draft answers.",
          409,
        );
      }
      const slaConfig = cloneEffectiveSlaConfig(deps.slaConfig());
      const rules = rulesFor(state, ctx.occurredAt, { slaConfig, definitions });
      const { volumePath, values, response } = ctx.payload;
      const after = await applyRule(async () =>
        isRenewalStage(await rules.get(principalId))
          ? rules.renew(
              principalId,
              principalId,
              volumePath,
              response,
              metadata,
              displayName,
              values,
            )
          : rules.submit(principalId, displayName, volumePath, values, response, metadata),
      );
      const approval = deps.approval();
      if (approval.mode !== "automatic") return planEirChange(ctx, state, after, slaConfig);
      // Automatic mode (#204): the pre-check again, at the upload, on the
      // definition the draft is pinned to and this command's clock. It's
      // recorded in this block whatever it gives, so the decision and its
      // evidence commit together or not at all.
      const draftVersion = Number(draft.version);
      const atUpload = evaluatePinnedDraft({
        evaluator: deps.evaluator,
        definitions,
        record: state.record,
        values: evaluatedValues,
        draftVersion,
        draftStartedAt: new Date(draft.form_started_at ?? ctx.occurredAt).toISOString(),
        effectiveAt: ctx.occurredAt.toISOString(),
        config: approval,
      });
      const evaluationId = await followOn(ctx, UPLOAD_EVALUATION_POSITION);
      const decided = qualifiesForAutomaticValidity({
        config: approval,
        atUpload: atUpload.evaluation,
        definitionLoaded: atUpload.definitionLoaded,
      })
        ? await applyRule(() =>
            withAutomaticValidity(after, {
              clock: () => ctx.occurredAt,
              validityDays: slaConfig.eirValidityDays,
              reviewSlaBusinessDays: slaConfig.stages["eir-validation"],
              provenance: automaticValidityOf(atUpload.evaluation, evaluationId, approval),
            }),
          )
        : after;
      const sequence = nextEvaluationSequence(ctx, draft.id);
      insertRow(ctx, EIR_EVALUATIONS, {
        ...actionColumns({ ...ctx, actor: SYSTEM_ACTOR }, EIR_EVALUATIONS, {
          actionId: evaluationId,
          recordId: draft.id,
          action: "evaluated",
          recordVersion: draftVersion,
          payload: atUpload.evaluation,
          causedByActionId: ctx.actionId,
        }),
        ...evaluationColumns(atUpload.evaluation, sequence),
        command: null,
        command_hash: null,
        expected_effects: null,
      });
      expectRow(ctx, EIR_EVALUATIONS, "action_id", evaluationId);
      return planEirChange(ctx, state, decided, slaConfig);
    },
    resultRow: eirCommandResultRow,
    result: toResult,
  });

  registry.command({
    area: "eir",
    name: "start",
    app: "tenant",
    payload: startPayload,
    leadActionTable: EIR_ACTIONS,
    async plan(ctx) {
      await definitionsFor(deps, ctx);
      const { principalId, displayName } = ctx.user;
      const state = await readEirState(ctx, principalId);
      if (state.rows.eir) {
        throw new DomainError("already-started", "This EIR has already been started.", 409);
      }
      checkVersion(0, ctx.expectedVersion);
      insertStartedEir(ctx, state.eirId, principalId, displayName);
      return {
        recordId: state.eirId,
        recordVersion: 1,
        leadAction: { action: "started", change: { stage: [null, "not-started"] } },
      };
    },
    resultRow: eirCommandResultRow,
    result: toResult,
  });

  registry.command({
    area: "eir",
    name: "save-draft",
    app: "tenant",
    payload: draftPayload,
    leadActionTable: EIR_DRAFT_SAVES,
    async plan(ctx) {
      const { principalId } = ctx.user;
      const state = await readEirState(ctx, principalId);
      checkVersion(Number(state.rows.draft?.version ?? 0), ctx.expectedVersion);
      const definitions = await definitionsFor(deps, ctx, state.record);
      const saved = await applyRule(() =>
        rulesFor(state, ctx.occurredAt, {
          slaConfig: cloneEffectiveSlaConfig(deps.slaConfig()),
          definitions,
        }).saveDraft(principalId, ctx.payload.values, undefined, ctx.payload.formVersion),
      );
      const draftId = await writeDraft(ctx, state, saved);
      return {
        recordId: draftId,
        recordVersion: ctx.expectedVersion + 1,
        leadAction: { action: "saved" },
      };
    },
    resultRow: draftCommandResultRow,
    result: toResult,
  });

  registry.command({
    area: "eir",
    name: "respond",
    app: "tenant",
    payload: respondPayload,
    leadActionTable: EIR_ACTIONS,
    async plan(ctx) {
      const { principalId, displayName } = ctx.user;
      const state = await readEirState(ctx, principalId);
      const definitions = await definitionsFor(deps, ctx, state.record);
      if (!state.rows.eir) {
        throw new DomainError("not-found", "There's no EIR to respond on.", 404);
      }
      checkVersion(Number(state.rows.eir.version), ctx.expectedVersion);
      const { values, response } = ctx.payload;
      const slaConfig = cloneEffectiveSlaConfig(deps.slaConfig());
      const after = await applyRule(() =>
        rulesFor(state, ctx.occurredAt, { slaConfig, definitions }).respond({
          principalId,
          personName: displayName,
          values,
          response,
        }),
      );
      return planEirChange(ctx, state, after, slaConfig);
    },
    resultRow: eirCommandResultRow,
    result: toResult,
  });

  registry.command({
    area: "eir",
    name: "decide",
    app: "staff",
    payload: decidePayload,
    leadActionTable: EIR_ACTIONS,
    authorize: requireSafeguardsValidator,
    async plan(ctx) {
      const { principalId, decision, note } = ctx.payload;
      const validator = ctx.user;
      const ownEir = new DomainError("own-eir", OWN_EIR_REFUSAL, 403);
      const own = principalId === validator.principalId;
      // Off (production, and every preview without the flag): as before, refused.
      const selfDecision = own && deps.selfDecisionTestMode(ctx.names);
      if (own && !selfDecision) throw ownEir;
      const state = await readEirState(ctx, principalId);
      if (!state.rows.eir) {
        throw new DomainError("not-found", "This person hasn't submitted an EIR.", 404);
      }
      checkVersion(Number(state.rows.eir.version), ctx.expectedVersion);
      const slaConfig = cloneEffectiveSlaConfig(deps.slaConfig());
      // The rules refuse a self-decision unless test mode passed here, and mark it if so.
      const decided = await applyRule(() =>
        rulesFor(state, ctx.occurredAt, { selfDecisionTestMode: selfDecision, slaConfig }).decide(
          principalId,
          decision,
          validator.principalId,
          note,
          validator.displayName,
        ),
      );
      if (!selfDecision) {
        // The rule, inside the block: never on the validator's own EIR.
        ctx.block.guard(
          `EXISTS (SELECT 1 FROM ${ctx.names.table(EIRS.schema, EIRS.table)} WHERE id = ${ctx.block.bind(state.eirId)} AND person_principal_id = ${ctx.block.bind(validator.principalId)})`,
          ownEir,
        );
      }
      return planEirChange(ctx, state, decided, slaConfig);
    },
    resultRow: eirCommandResultRow,
    // A decision answers the validator: not the person's draft.
    result: async (row, ctx) => draftOnlyForOwner(await toResult(row, ctx), ctx.user),
  });

  registry.read({
    area: "eir",
    name: "generated-pdf",
    app: "tenant",
    query: z.object({}).strict(),
    async run({ user, names, read }) {
      const ownEirId = await eirIdFor(user.principalId);
      const drafts = names.table(EIR_DRAFTS.schema, EIR_DRAFTS.table);
      const evaluations = names.table(EIR_EVALUATIONS.schema, EIR_EVALUATIONS.table);
      const rows = await read<{
        form_values: string;
        form_version: string;
        draft_version: number | string;
        definition_version: string;
        evaluated_form_version: string;
        outcome: string;
        rule_outcomes: string;
        evaluated_draft_version: number | string;
      }>({
        statement: `SELECT d.form_values, d.form_version, d.version AS draft_version,
          v.definition_version, v.form_version AS evaluated_form_version, v.outcome, v.rule_outcomes,
          v.record_version AS evaluated_draft_version
          FROM ${drafts} d
          JOIN ${evaluations} v ON v.eir_draft_id = d.id
          WHERE d.eir_id = :eir_id
          ORDER BY CASE WHEN v.record_version = d.version THEN 0 ELSE 1 END,
            ${LATEST_EVALUATION_FIRST("v.")} LIMIT 1`,
        parameters: { eir_id: ownEirId },
      });
      const row = rows[0];
      if (!row?.form_values) {
        throw new DomainError(
          "evaluation-required",
          "Evaluate the saved draft before generating its PDF.",
          409,
        );
      }
      if (Number(row.evaluated_draft_version) !== Number(row.draft_version)) {
        throw new DomainError(
          "evaluation-stale",
          "The draft changed after evaluation. Evaluate it again.",
          409,
        );
      }
      if (row.evaluated_form_version !== row.form_version) {
        throw new DomainError(
          "evaluation-stale",
          "The draft's form version does not match its evaluation. Evaluate it again.",
          409,
        );
      }
      if (row.outcome === "blocking") {
        const guidance = blockingGuidance(
          JSON.parse(row.rule_outcomes) as EirEvaluation["outcomes"],
        );
        throw new DomainError(
          "evaluation-blocking",
          `Correct the blocking EIR fields first. ${guidance}`,
          409,
        );
      }
      const state = await readEirState({ names, read }, user.principalId);
      // On the form the draft was evaluated on, never guessed (#201).
      const definitions = await deps.definitions({ names, read }, { ids: [row.form_version] });
      const form = definitions.byId(row.form_version)?.form;
      if (!form) throw new DomainError("eir-unavailable", EIR_UNAVAILABLE_MESSAGE, 503);
      const bytes = await generateEirPdf(JSON.parse(row.form_values), {
        recordId: (state.rows.eir && displayLabel("EIR", state.rows.eir)) ?? user.principalId,
        form,
      });
      return { bytes: base64(bytes) };
    },
  });

  registry.read({
    area: "eir",
    name: "mine",
    app: "tenant",
    query: z.object({}).strict(),
    async snapshot({ user, snapshot }) {
      const eirId = await eirIdFor(user.principalId);
      const rows =
        eirRowsFromSnapshot(snapshot, (row) => row.id === eirId, {
          includeDrafts: true,
          draftIds: new Set([eirId]),
        })[0] ?? ({ submissions: [], actions: [] } satisfies EirRows);
      const record = withSla(
        toEirRecord(user.principalId, rows, deps.now()),
        deps,
        deps.now(),
        rows.eir,
      );
      const evaluation = rows.draft?.form_values
        ? latestEvaluationFromSnapshot(snapshot, rows.draft.id, Number(rows.draft.version))
        : undefined;
      return evaluation ? { ...record, evaluation } : record;
    },
    async run({ user, names, read }) {
      const state = await readEirState({ names, read }, user.principalId);
      const record = withSla(
        toEirRecord(user.principalId, state.rows, deps.now()),
        deps,
        deps.now(),
        state.rows.eir,
      );
      const evaluation = state.rows.draft?.form_values
        ? await latestEvaluation(names, read, state.rows.draft.id, Number(state.rows.draft.version))
        : undefined;
      return evaluation ? { ...record, evaluation } : record;
    },
  });

  registry.read({
    area: "eir",
    name: "record",
    app: "staff",
    query: z
      .object({
        principalId: z
          .string()
          .regex(/^[A-Za-z0-9._-]+$/)
          .max(64),
      })
      .strict(),
    authorize: requireSafeguardsValidator,
    async snapshot({ query, user, snapshot }) {
      const eirId = await eirIdFor(query.principalId);
      const rows =
        eirRowsFromSnapshot(snapshot, (row) => row.id === eirId, {
          includeDrafts: true,
          draftIds: new Set([eirId]),
        })[0] ?? ({ submissions: [], actions: [] } satisfies EirRows);
      return draftOnlyForOwner(
        withSla(toEirRecord(query.principalId, rows, deps.now()), deps, deps.now(), rows.eir),
        user,
      );
    },
    async run({ query, user, names, read }) {
      const state = await readEirState({ names, read }, query.principalId);
      return draftOnlyForOwner(
        withSla(
          toEirRecord(query.principalId, state.rows, deps.now()),
          deps,
          deps.now(),
          state.rows.eir,
        ),
        user,
      );
    },
  });

  registry.read({
    area: "eir",
    name: "inbox",
    app: "staff",
    query: z.object({}).strict(),
    authorize: requireSafeguardsValidator,
    snapshot({ snapshot }): EirInboxItem[] {
      const now = deps.now();
      return eirRowsFromSnapshot(
        snapshot,
        (row) => row.stage === "submitted" || row.stage === "valid",
        { includeDrafts: false },
      )
        .filter((rows) => rows.eir)
        .sort(
          (a, b) =>
            Date.parse(a.eir!.created_at) - Date.parse(b.eir!.created_at) ||
            (a.eir!.id < b.eir!.id ? -1 : 1),
        )
        .map((rows) => ({
          record: toEirRecord(rows.eir!.person_principal_id, rows, now),
          eir: rows.eir!,
        }))
        .filter(
          ({ record }) =>
            record.stage === "submitted" ||
            record.stage === "valid" ||
            record.renewal?.stage === "submitted",
        )
        .map(({ record, eir }) => withoutDraft(withSla(record, deps, now, eir) as EirInboxItem));
    },
    async run({ names, read }): Promise<EirInboxItem[]> {
      // Everything a validator can act on is stored as submitted or valid
      // (a renewal waits alongside a valid EIR, even an expired one).
      const rows = await read<{ part: string; part_json: string }>({
        statement: eirRowsQuery(names.table, { eirs: "stage IN ('submitted', 'valid')" }),
      });
      const now = deps.now();
      return [...groupEirRows(rows).values()]
        .filter((rows) => rows.eir)
        .sort(
          (a, b) =>
            Date.parse(a.eir!.created_at) - Date.parse(b.eir!.created_at) ||
            (a.eir!.id < b.eir!.id ? -1 : 1),
        )
        .map((rows) => ({
          record: toEirRecord(rows.eir!.person_principal_id, rows, now),
          eir: rows.eir!,
        }))
        .filter(
          ({ record }) =>
            record.stage === "submitted" ||
            record.stage === "valid" ||
            record.renewal?.stage === "submitted",
        )
        .map(({ record, eir }) => withoutDraft(withSla(record, deps, now, eir) as EirInboxItem));
    },
  });
}

/** For tests and the migration: how many actions an EIR's rows hold, by name. */
export function actionNames(rows: EirRows): EirActionName[] {
  return orderedActions(rows.actions).map((row) => row.action);
}
