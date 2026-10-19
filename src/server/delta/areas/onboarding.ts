import { z } from "zod";

import {
  ONBOARDING_SEND_BACK_STAGE,
  REVIEWER_FOR_STAGE,
  REVIEWER_LABEL,
  STAGE_FOR_REVIEWER,
  isOnboardingTerminal,
  isReviewStage,
  nextOnboardingStage,
  onboardingSlaDeadlines,
  onboardingStoredSla,
  resubmissionStage,
} from "../../../data/onboarding/lifecycle.ts";
import {
  findResubmittedIdProblem,
  findSubmittedIdProblem,
  normalizeIntake,
  resubmissionChanges,
  resubmittedAnswers,
  submittedAnswers,
  resubmitNote,
  wholeIntakeProblem,
  type IntakeProblem,
} from "../../../data/onboarding/resubmission.ts";
import {
  initiativeOwnerChoice,
  initiativeOwnerFor,
  normalizeOwnerEmail,
  ownerPrincipalId,
  ownerVerificationFor,
  withSessionOwners,
  type OwnerSession,
} from "../../../data/onboarding/owners.ts";
import type {
  InitiativeOwner,
  OnboardingDecision,
  OnboardingIntake,
  OnboardingRequest,
  OnboardingRequestRecord,
  OnboardingRequestStage,
  OnboardingResubmissionRecord,
  OnboardingReviewStage,
  OnboardingReviewerRole,
} from "../../../data/onboarding/types.ts";
import { displayLabel, parseDisplayLabel } from "../../../data/display-codes.ts";
import { cloneEffectiveSlaConfig, type EffectiveSlaConfig } from "../../../data/sla-config.ts";
import {
  findDatasetTagProblem,
  loadSchema,
  validateStep,
  type IntakeState,
} from "../../../schema/index.ts";
import { configuredSlaConfig } from "../../sla-config.ts";
import { DomainError } from "../errors.ts";
import type {
  CommandContext,
  ReadFn,
  Registry,
  ResultRowContext,
  SessionUser,
} from "../registry.ts";
import type { DeltaSnapshot } from "../snapshot-cache.ts";
import type { StoreNames } from "../sql-builder.ts";
import {
  NO_DISPLAY_NUMBER,
  allocateDisplayCode,
  expectRow,
  followOn,
  insertRow,
  json,
  stringArray,
  timestamp,
  updateCurrentState,
  SYSTEM_ACTOR,
  type ActionTableRef,
  type ColumnValue,
  type TableRef,
} from "../write-helpers.ts";

const REQUESTS: TableRef = { schema: "onboarding", table: "onboarding_requests" };
const DATASETS: TableRef = { schema: "onboarding", table: "onboarding_intake_datasets" };
const OWNERS: TableRef = { schema: "onboarding", table: "onboarding_intake_owners" };
const ACTIONS: ActionTableRef = {
  schema: "onboarding",
  table: "onboarding_request_actions",
  recordIdColumn: "onboarding_request_id",
};

const stages = z.enum([
  "submitted",
  "business-roi-review",
  "ccb",
  "standup",
  "rejected",
  "withdrawn",
]);
const reviewRole = z.enum(["business-office", "ccb"]);
const workspaceNeeds = z.object({ isolation: z.string(), teamSize: z.number() }).strict();
// A record ID names a stored row on a resubmission; the plan refuses any it doesn't own (#222).
const recordId = z.string().min(1).optional();
// `self`: the provider picked Myself; the server fills the identity from the session (#103).
const owner = z
  .object({ id: recordId, self: z.literal(true).optional(), name: z.string(), email: z.string() })
  .strict();
const initiativeOwner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }).strict(),
  z.object({ kind: z.literal("someone-else"), name: z.string(), email: z.string() }).strict(),
]);
const dataset = z
  .object({
    id: recordId,
    name: z.string(),
    domain: z.string(),
    datasetTag: z.string(),
    owners: z.array(owner),
  })
  .strict();
const intake = z
  .object({
    initiativeName: z.string(),
    businessCase: z.string(),
    annualBenefit: z.number(),
    levers: z.array(z.string()),
    datasets: z.array(dataset),
    workspaceNeeds,
    answers: z.record(z.string(), z.unknown()),
    // Optional here so the refusal is the intake's own "Choose who owns the initiative".
    initiativeOwner: initiativeOwner.optional(),
  })
  .strict();

const submitPayload = z.object({ intake }).strict();
const decisionPayload = z
  .object({
    requestId: z.string().min(1),
    decision: z.discriminatedUnion("type", [
      z.object({ type: z.literal("approve"), note: z.string().optional() }).strict(),
      z
        .object({ type: z.literal("send-back"), to: z.literal("submitted"), note: z.string() })
        .strict(),
      z.object({ type: z.literal("reject"), note: z.string() }).strict(),
    ]),
  })
  .strict();
const resubmitPayload = z
  .object({
    requestId: z.string().min(1),
    resubmission: z
      .object({
        answer: z.string(),
        intake: intake.optional(),
      })
      .strict(),
  })
  .strict();
const withdrawPayload = z
  .object({ requestId: z.string().min(1), note: z.string().optional() })
  .strict();

type RequestRow = {
  uuid: string;
  /** The display label: the code (`ONB-7K3QFD`), or `ONB-<n>` from the old counter. */
  id: string;
  display_number: number | null;
  display_code: string | null;
  version: number;
  title: string;
  provider_principal_id: string;
  provider_display: string;
  submitted_at: string;
  stage: OnboardingRequestStage;
  stage_entered_at: string;
  sla_due_at: string | null;
  sla_due_soon_at: string | null;
  initiative_name: string;
  business_case: string;
  annual_benefit: number;
  levers: string[] | string;
  workspace_isolation: string;
  workspace_team_size: number;
  intake_answers: string;
  open_send_back_from_stage: OnboardingReviewStage | null;
  open_send_back_action_id: string | null;
  initiative_owner_kind: InitiativeOwner["kind"] | null;
  initiative_owner_display: string | null;
  initiative_owner_email: string | null;
  initiative_owner_principal_id: string | null;
};
type DatasetRow = {
  id: string;
  onboarding_request_id: string;
  position: number;
  name: string;
  domain: string;
  dataset_tag: string;
};
type OwnerRow = {
  id: string;
  intake_dataset_id: string;
  position: number;
  person_display: string;
  person_email: string;
  person_principal_id: string | null;
};
type ActionRow = {
  action_id: string;
  action: string;
  from_stage: OnboardingRequestStage | null;
  to_stage: OnboardingRequestStage;
  record_version: number;
  actor_principal_id: string;
  actor_display: string;
  occurred_at: string;
  note: string | null;
  /** JSON text; on a resubmission, its {@link OnboardingResubmissionRecord} (#221). */
  payload?: string | null;
};

/** The request row's columns, as every onboarding read selects them (exported for the read-parity test). */
export const REQUEST_COLUMNS =
  "id AS uuid, coalesce(display_code, concat('ONB-', CAST(display_number AS STRING))) AS id, display_number, display_code, version, title, provider_principal_id, provider_display, CAST(submitted_at AS STRING) AS submitted_at, stage, CAST(stage_entered_at AS STRING) AS stage_entered_at, CAST(sla_due_at AS STRING) AS sla_due_at, CAST(sla_due_soon_at AS STRING) AS sla_due_soon_at, initiative_name, business_case, annual_benefit, levers, workspace_isolation, workspace_team_size, intake_answers, open_send_back_from_stage, open_send_back_action_id, initiative_owner_kind, initiative_owner_display, initiative_owner_email, initiative_owner_principal_id";

function parseLevers(value: string[] | string): string[] {
  return Array.isArray(value) ? value : JSON.parse(value || "[]");
}

function assertIntake(value: OnboardingIntake): void {
  // Tags become UC tag values and group names: refuse a bad or repeated one with
  // its own code, so a bypassed form can't store it.
  const tagProblem = findDatasetTagProblem(value.datasets);
  if (tagProblem) throw new DomainError(tagProblem.code, tagProblem.message, 400);
  const state: IntakeState = {
    dataName: value.initiativeName,
    useCase: value.businessCase,
    annualBenefit: value.annualBenefit,
    levers: value.levers,
    datasets: value.datasets,
    isolation: value.workspaceNeeds?.isolation,
    teamSize: value.workspaceNeeds?.teamSize,
    initiativeOwner: value.initiativeOwner,
  };
  const issues = [
    ...validateStep(loadSchema(), "source", state).filter(
      ({ field }) => field === "dataName" || field === "initiativeOwner",
    ),
    ...validateStep(loadSchema(), "business", state),
    ...validateStep(loadSchema(), "datasets", state),
    ...validateStep(loadSchema(), "workspace", state),
  ].map(({ message }) => message);
  if (issues.length)
    throw new DomainError(
      "invalid-intake",
      `Onboarding request is incomplete: ${issues.join(" ")}`,
      400,
    );
}

function refuseOn(problem: IntakeProblem | null): void {
  if (problem) throw new DomainError(problem.code, problem.message, 400);
}

/**
 * The request a quoted ID stands for: its display code (`ONB-7K3QFD`), or the
 * number of a request made before display codes (`ONB-1000`). `label` is the
 * ID as reads give it; `where` matches it (with `alias`, e.g. `r.`).
 */
function displayLookup(
  id: string,
  alias = "",
): { label: string; where: string; parameters: { display: string | number } } | undefined {
  const parsed = parseDisplayLabel("ONB", id);
  if (!parsed) return undefined;
  return "code" in parsed
    ? {
        label: parsed.code,
        where: `${alias}display_code = :display`,
        parameters: { display: parsed.code },
      }
    : {
        label: `ONB-${parsed.number}`,
        where: `${alias}display_number = :display`,
        parameters: { display: parsed.number },
      };
}

async function loadByDisplay(
  names: StoreNames,
  read: ReadFn,
  displayId: string,
): Promise<RequestRow | undefined> {
  const lookup = displayLookup(displayId);
  if (!lookup) return undefined;
  return (
    await read<RequestRow>({
      statement: `SELECT ${REQUEST_COLUMNS} FROM ${names.table("onboarding", "onboarding_requests")} WHERE ${lookup.where} LIMIT 1`,
      parameters: lookup.parameters,
    })
  )[0];
}

async function loadRequest(
  names: StoreNames,
  read: ReadFn,
  user: SessionUser,
  id: string,
  slaConfig: EffectiveSlaConfig,
): Promise<OnboardingRequest | undefined> {
  const lookup = displayLookup(id, "r.");
  if (!lookup) return undefined;
  const scope = visibleScope(user);
  const [row] = await readRequests(names, read, {
    where: `${lookup.where} AND ${scope.where}`,
    parameters: { ...lookup.parameters, ...scope.parameters },
    orderBy: "r.submitted_at",
  });
  // The statement's WHERE already scopes it; this is the same rule, kept as a second check.
  if (!row || !canSee(user, row)) return undefined;
  return toRequest(row, row.datasets, row.owners, row.actions, slaConfig);
}

/** A request row with its intake children and history aggregated in, as one statement returns it. */
type RequestWithChildren = RequestRow & {
  datasets: DatasetRow[];
  owners: OwnerRow[];
  actions: ActionRow[];
};

/** A `to_json(collect_list(...))` column: JSON text, `[]`, or null for no rows. */
function jsonList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || value === "") return [];
  return JSON.parse(value) as T[];
}

/**
 * The requests `where` selects, each with its datasets, owners and actions,
 * in one statement however many there are: every child table is aggregated
 * per request by a correlated subquery, and the rows are split back apart
 * here. A list used to cost 1 + 3 statements per request, sent at once,
 * which queued on the warehouse until it scaled out. `where` is the read's
 * whole authorization scope, so a child row is only ever read for a request
 * the read may return.
 */
async function readRequests(
  names: StoreNames,
  read: ReadFn,
  query: { where: string; parameters: Record<string, string | number>; orderBy: string },
): Promise<RequestWithChildren[]> {
  const datasets = names.table("onboarding", "onboarding_intake_datasets");
  const owners = names.table("onboarding", "onboarding_intake_owners");
  const actions = names.table("onboarding", "onboarding_request_actions");
  const rows = await read<
    RequestRow & { datasets_json: unknown; owners_json: unknown; actions_json: unknown }
  >({
    statement:
      `SELECT ${REQUEST_COLUMNS}, ` +
      `(SELECT to_json(collect_list(named_struct('id', d.id, 'onboarding_request_id', d.onboarding_request_id, 'position', d.position, 'name', d.name, 'domain', d.domain, 'dataset_tag', d.dataset_tag))) FROM ${datasets} d WHERE d.onboarding_request_id = r.id) AS datasets_json, ` +
      `(SELECT to_json(collect_list(named_struct('id', o.id, 'intake_dataset_id', o.intake_dataset_id, 'onboarding_request_id', o.onboarding_request_id, 'position', o.position, 'person_display', o.person_display, 'person_email', o.person_email, 'person_principal_id', o.person_principal_id))) FROM ${owners} o WHERE o.onboarding_request_id = r.id) AS owners_json, ` +
      `(SELECT to_json(collect_list(named_struct('action_id', a.action_id, 'action', a.action, 'from_stage', a.from_stage, 'to_stage', a.to_stage, 'record_version', a.record_version, 'actor_principal_id', a.actor_principal_id, 'actor_display', a.actor_display, 'occurred_at', CAST(a.occurred_at AS STRING), 'note', a.note, 'payload', a.payload))) FROM ${actions} a WHERE a.onboarding_request_id = r.id) AS actions_json ` +
      `FROM ${names.table("onboarding", "onboarding_requests")} r WHERE ${query.where} ORDER BY ${query.orderBy}`,
    parameters: query.parameters,
  });
  return rows.map(({ datasets_json, owners_json, actions_json, ...row }) => ({
    ...row,
    datasets: jsonList<DatasetRow>(datasets_json),
    owners: jsonList<OwnerRow>(owners_json),
    actions: jsonList<ActionRow>(actions_json),
  }));
}

async function children(names: StoreNames, read: ReadFn, uuid: string) {
  const [datasets, owners, actions] = await Promise.all([
    read<DatasetRow>({
      statement: `SELECT id, onboarding_request_id, position, name, domain, dataset_tag FROM ${names.table("onboarding", "onboarding_intake_datasets")} WHERE onboarding_request_id = :id ORDER BY position`,
      parameters: { id: uuid },
    }),
    read<OwnerRow>({
      statement: `SELECT id, intake_dataset_id, position, person_display, person_email, person_principal_id FROM ${names.table("onboarding", "onboarding_intake_owners")} WHERE onboarding_request_id = :id ORDER BY intake_dataset_id, position`,
      parameters: { id: uuid },
    }),
    read<ActionRow>({
      statement: `SELECT action_id, action, from_stage, to_stage, record_version, actor_principal_id, actor_display, CAST(occurred_at AS STRING) AS occurred_at, note, payload FROM ${names.table("onboarding", "onboarding_request_actions")} WHERE onboarding_request_id = :id ORDER BY record_version, occurred_at`,
      parameters: { id: uuid },
    }),
  ]);
  return [datasets, owners, actions] as const;
}

/** The fields of each child row the request view needs, from a read or a result row. */
type DatasetPart = Pick<DatasetRow, "id" | "position" | "name" | "domain" | "dataset_tag">;
type OwnerPart = Pick<
  OwnerRow,
  "id" | "intake_dataset_id" | "position" | "person_display" | "person_email"
> &
  // `to_json` drops a null field, so an aggregated row may have none.
  Partial<Pick<OwnerRow, "person_principal_id">>;
type ActionPart = Pick<
  ActionRow,
  | "action_id"
  | "action"
  | "from_stage"
  | "to_stage"
  | "record_version"
  | "actor_principal_id"
  | "actor_display"
  | "occurred_at"
  | "note"
  | "payload"
>;

/** Action verb (as stored) → decision kind in the request view. */
const DECISION_KIND: Readonly<Record<string, OnboardingDecision["kind"]>> = {
  submitted: "submit",
  forwarded: "forward",
  approved: "approve",
  "sent-back": "send-back",
  rejected: "reject",
  withdrawn: "withdraw",
  resubmitted: "resubmit",
};

/**
 * Map a stored action verb to its decision kind, refusing loudly on anything
 * the view does not model (e.g. a future `activated` from standup, #89) rather
 * than silently coercing it — an unmapped action is a bug in our own data.
 */
function decisionKind(action: string): OnboardingDecision["kind"] {
  const kind = DECISION_KIND[action];
  if (!kind) {
    throw new DomainError(
      "unknown-action",
      `Unknown onboarding action '${action}' in the request history.`,
      500,
    );
  }
  return kind;
}

/** A resubmit action's stored answer and changes, or undefined for any other action or an older row. */
function resubmissionRecord(action: ActionPart): OnboardingResubmissionRecord | undefined {
  if (action.action !== "resubmitted" || !action.payload) return undefined;
  const value = JSON.parse(action.payload) as Partial<OnboardingResubmissionRecord>;
  if (typeof value.answer !== "string" || !Array.isArray(value.changes)) return undefined;
  return { answer: value.answer, changes: value.changes };
}

/**
 * The intake package from the request row and its dataset and owner rows,
 * each dataset and owner contact with its stored record ID, so a
 * resubmission can name the ones it keeps (#222).
 */
function intakeFrom(
  row: RequestRow,
  datasets: DatasetPart[],
  owners: OwnerPart[],
): OnboardingIntake {
  const orderedDatasets = [...datasets].sort((a, b) => Number(a.position) - Number(b.position));
  const owner = storedInitiativeOwner(row);
  const orderedOwners = [...owners].sort(
    (a, b) =>
      a.intake_dataset_id.localeCompare(b.intake_dataset_id) ||
      Number(a.position) - Number(b.position),
  );
  return {
    initiativeName: row.initiative_name,
    businessCase: row.business_case,
    annualBenefit: Number(row.annual_benefit),
    levers: parseLevers(row.levers),
    datasets: orderedDatasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      domain: dataset.domain,
      datasetTag: dataset.dataset_tag,
      owners: orderedOwners
        .filter((owner) => owner.intake_dataset_id === dataset.id)
        .map((owner) => ({
          id: owner.id,
          // Only Myself stores the provider's own principal on an owner (#103).
          ...(ownerVerificationFor(owner.person_principal_id, row.provider_principal_id) ===
          "verified"
            ? { self: true as const }
            : {}),
          name: owner.person_display,
          email: owner.person_email,
        })),
    })),
    workspaceNeeds: {
      isolation: row.workspace_isolation,
      teamSize: Number(row.workspace_team_size),
    },
    answers: JSON.parse(row.intake_answers || "{}") as Record<string, unknown>,
    ...(owner ? { initiativeOwner: initiativeOwnerChoice(owner) } : {}),
  };
}

/** The initiative owner the request row stores (#103); null on a request made before it was asked. */
function storedInitiativeOwner(row: RequestRow): InitiativeOwner | null {
  if (row.initiative_owner_kind !== "self" && row.initiative_owner_kind !== "someone-else")
    return null;
  const principalId = row.initiative_owner_principal_id ?? null;
  return {
    kind: row.initiative_owner_kind,
    name: row.initiative_owner_display ?? "",
    email: row.initiative_owner_email ?? "",
    principalId,
    verification: ownerVerificationFor(principalId, row.provider_principal_id),
  };
}

/** The request row's initiative owner columns for a stored owner. */
function initiativeOwnerColumns(owner: InitiativeOwner | null): Record<string, ColumnValue> {
  return {
    initiative_owner_kind: owner?.kind ?? null,
    initiative_owner_display: owner?.name ?? null,
    initiative_owner_email: owner?.email ?? null,
    initiative_owner_principal_id: owner?.principalId ?? null,
  };
}

/** Who Myself is on the server: the session the request came in on. */
function ownerSession(user: SessionUser): OwnerSession {
  return { principalId: user.principalId, name: user.displayName, email: user.email };
}

/**
 * Build the request view every read and every command response returns, from
 * the request row and its children. Ordering is re-applied here so a result row
 * (whose `collect_list` order is not guaranteed) hydrates the same as a read.
 */
function assembleRequest(
  row: RequestRow,
  datasets: DatasetPart[],
  owners: OwnerPart[],
  actions: ActionPart[],
  slaConfig: EffectiveSlaConfig,
): OnboardingRequest {
  const orderedActions = [...actions].sort(
    (a, b) =>
      Number(a.record_version) - Number(b.record_version) ||
      a.occurred_at.localeCompare(b.occurred_at),
  );
  const intake = intakeFrom(row, datasets, owners);
  const decisions: OnboardingDecision[] = orderedActions.map((action) => {
    const resubmission = resubmissionRecord(action);
    return {
      kind: decisionKind(action.action),
      // `to_json` drops null fields, so a child row aggregated on the warehouse
      // (a set-based read, or a stored command result) has no `from_stage` at all.
      from: action.from_stage ?? null,
      to: action.to_stage,
      actorId: action.actor_principal_id,
      actorName: action.actor_display,
      at: new Date(action.occurred_at).toISOString(),
      note: action.note ?? "",
      ...(resubmission ? { resubmission } : {}),
    };
  });
  const sendBack = row.open_send_back_action_id
    ? orderedActions.find((action) => action.action_id === row.open_send_back_action_id)
    : undefined;
  const record: OnboardingRequestRecord = {
    id: row.id,
    version: Number(row.version),
    title: row.title,
    providerId: row.provider_principal_id,
    providerName: row.provider_display,
    submittedAt: new Date(row.submitted_at).toISOString(),
    stage: row.stage,
    stageEnteredAt: new Date(row.stage_entered_at).toISOString(),
    intake,
    openSendBack:
      row.open_send_back_from_stage && sendBack
        ? {
            from: row.open_send_back_from_stage,
            questions: sendBack.note ?? "",
            actorId: sendBack.actor_principal_id,
            at: new Date(sendBack.occurred_at).toISOString(),
          }
        : null,
    decisions,
    initiativeOwner: storedInitiativeOwner(row),
    ownerVerification: Object.fromEntries(
      owners.map((owner) => [
        owner.id,
        ownerVerificationFor(owner.person_principal_id, row.provider_principal_id),
      ]),
    ),
  };
  // The deadlines stored at stage entry win, so a redeploy with new targets
  // doesn't move an open request's due date.
  const sla = onboardingStoredSla(
    record.stage,
    record.stageEnteredAt,
    new Date(),
    {
      dueAt: row.sla_due_at ? new Date(row.sla_due_at).toISOString() : null,
      dueSoonAt: row.sla_due_soon_at ? new Date(row.sla_due_soon_at).toISOString() : null,
    },
    slaConfig,
  );
  return { ...record, sla };
}

/** A request from its row and child rows (exported for the read-parity test). */
export function toRequest(
  row: RequestRow,
  datasets: DatasetRow[],
  owners: OwnerRow[],
  actions: ActionRow[],
  slaConfig: EffectiveSlaConfig,
): OnboardingRequest {
  return assembleRequest(row, datasets, owners, actions, slaConfig);
}

function text(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : text(value);
}

function requestRowFromSnapshot(row: Record<string, unknown>): RequestRow {
  const number = row["display_number"];
  const code = nullableText(row["display_code"]);
  return {
    uuid: text(row["id"]),
    id: displayLabel("ONB", {
      display_code: code,
      display_number: number as number | null,
    })!,
    display_number: number === null || number === undefined ? null : Number(number),
    display_code: code,
    version: Number(row["version"]),
    title: text(row["title"]),
    provider_principal_id: text(row["provider_principal_id"]),
    provider_display: text(row["provider_display"]),
    submitted_at: text(row["submitted_at"]),
    stage: text(row["stage"]) as OnboardingRequestStage,
    stage_entered_at: text(row["stage_entered_at"]),
    sla_due_at: nullableText(row["sla_due_at"]),
    sla_due_soon_at: nullableText(row["sla_due_soon_at"]),
    initiative_name: text(row["initiative_name"]),
    business_case: text(row["business_case"]),
    annual_benefit: Number(row["annual_benefit"]),
    levers: Array.isArray(row["levers"]) ? (row["levers"] as string[]) : text(row["levers"]),
    workspace_isolation: text(row["workspace_isolation"]),
    workspace_team_size: Number(row["workspace_team_size"]),
    intake_answers: text(row["intake_answers"]),
    open_send_back_from_stage: nullableText(
      row["open_send_back_from_stage"],
    ) as OnboardingReviewStage | null,
    open_send_back_action_id: nullableText(row["open_send_back_action_id"]),
    initiative_owner_kind: nullableText(row["initiative_owner_kind"]) as
      InitiativeOwner["kind"] | null,
    initiative_owner_display: nullableText(row["initiative_owner_display"]),
    initiative_owner_email: nullableText(row["initiative_owner_email"]),
    initiative_owner_principal_id: nullableText(row["initiative_owner_principal_id"]),
  };
}

function actionRowFromSnapshot(row: Record<string, unknown>): ActionRow {
  return {
    action_id: text(row["action_id"]),
    action: text(row["action"]),
    from_stage: nullableText(row["from_stage"]) as OnboardingRequestStage | null,
    to_stage: text(row["to_stage"]) as OnboardingRequestStage,
    record_version: Number(row["record_version"]),
    actor_principal_id: text(row["actor_principal_id"]),
    actor_display: text(row["actor_display"]),
    occurred_at: text(row["occurred_at"]),
    note: nullableText(row["note"]),
    payload: nullableText(row["payload"]),
  };
}

function requestRowsFromSnapshot(snapshot: DeltaSnapshot): RequestRow[] {
  return snapshot
    .table<Record<string, unknown>>("onboarding", "onboarding_requests")
    .map(requestRowFromSnapshot);
}

function childrenFromSnapshot(snapshot: DeltaSnapshot, uuid: string) {
  const datasets = snapshot
    .table<DatasetRow>("onboarding", "onboarding_intake_datasets")
    .filter((row) => row.onboarding_request_id === uuid)
    .sort((a, b) => Number(a.position) - Number(b.position));
  const owners = snapshot
    .table<OwnerRow & { onboarding_request_id: string }>("onboarding", "onboarding_intake_owners")
    .filter((row) => row.onboarding_request_id === uuid)
    .sort(
      (a, b) =>
        a.intake_dataset_id.localeCompare(b.intake_dataset_id) ||
        Number(a.position) - Number(b.position),
    );
  const actions = snapshot
    .table<Record<string, unknown>>("onboarding", "onboarding_request_actions")
    .filter((row) => row["onboarding_request_id"] === uuid)
    .map(actionRowFromSnapshot)
    .sort(
      (a, b) =>
        Number(a.record_version) - Number(b.record_version) ||
        a.occurred_at.localeCompare(b.occurred_at),
    );
  return [datasets, owners, actions] as const;
}

function requestFromSnapshot(
  snapshot: DeltaSnapshot,
  row: RequestRow,
  slaConfig: EffectiveSlaConfig,
): OnboardingRequest {
  return toRequest(row, ...childrenFromSnapshot(snapshot, row.uuid), slaConfig);
}

/**
 * {@link canSee} as SQL over the request row `r`: the caller's own requests,
 * or requests at a stage one of the caller's reviewer roles decides. A read
 * puts it in its WHERE, so the warehouse never aggregates the children of a
 * request the caller can't see, and a stranger's not-found is the same for a
 * real ID and a made-up one.
 */
export function visibleScope(user: SessionUser): {
  where: string;
  parameters: Record<string, string>;
} {
  const stages = [
    ...new Set(
      user.onboardingReviewerRoles.flatMap((role) =>
        role in STAGE_FOR_REVIEWER ? [STAGE_FOR_REVIEWER[role as OnboardingReviewerRole]] : [],
      ),
    ),
  ];
  const parameters: Record<string, string> = { viewer: user.principalId };
  stages.forEach((stage, i) => (parameters[`viewer_stage_${i}`] = stage));
  const byStage = stages.length
    ? ` OR r.stage IN (${stages.map((_, i) => `:viewer_stage_${i}`).join(", ")})`
    : "";
  return { where: `(r.provider_principal_id = :viewer${byStage})`, parameters };
}

function canSee(
  user: SessionUser,
  row: Pick<RequestRow, "provider_principal_id" | "stage">,
): boolean {
  return (
    row.provider_principal_id === user.principalId ||
    (isReviewStage(row.stage) &&
      user.onboardingReviewerRoles.includes(REVIEWER_FOR_STAGE[row.stage]))
  );
}

function notFound(): DomainError {
  return new DomainError("not-found", "Onboarding request not found.", 404);
}

function assertReviewerRole(user: SessionUser, role: OnboardingReviewerRole): void {
  if (!user.onboardingReviewerRoles.includes(role))
    throw new DomainError(
      "forbidden",
      `${user.displayName} is not a member of the configured ${REVIEWER_LABEL[role]} group.`,
      403,
    );
}

async function currentForCommand<P>(
  ctx: CommandContext<P>,
  displayId: string,
): Promise<RequestRow> {
  const current = await loadByDisplay(ctx.names, ctx.read, displayId);
  if (!current || !canSee(ctx.user, current)) throw notFound();
  return current;
}

/**
 * The response row for a command: the request row with its children aggregated
 * in, so a command returns the same complete request a read hydrates. The lead
 * action is unioned in from its planned values because it is not yet in the
 * action table when this row is read (see {@link ResultRowContext}).
 */
function resultRow({
  recordId,
  recordVersion,
  actionId,
  occurredAt,
  actor,
  names,
  block,
  leadAction,
}: ResultRowContext) {
  const requests = names.table("onboarding", "onboarding_requests");
  const datasets = names.table("onboarding", "onboarding_intake_datasets");
  const owners = names.table("onboarding", "onboarding_intake_owners");
  const actions = names.table("onboarding", "onboarding_request_actions");
  const id = block.bind(recordId);
  const [fromStage, toStage] = leadAction.change?.["stage"] ?? [null, null];
  const leadRow =
    `SELECT ${block.bind(actionId)} AS action_id, ${block.bind(leadAction.action)} AS action, ` +
    `CAST(${block.bind(fromStage)} AS STRING) AS from_stage, CAST(${block.bind(toStage)} AS STRING) AS to_stage, ` +
    `CAST(${block.bind(recordVersion)} AS BIGINT) AS record_version, ` +
    `${block.bind(actor.principalId)} AS actor_principal_id, ${block.bind(actor.display)} AS actor_display, ` +
    `${block.bind(occurredAt.toISOString())} AS occurred_at, CAST(${block.bind(leadAction.note ?? null)} AS STRING) AS note, ` +
    `CAST(${block.bind(json(leadAction.payload))} AS STRING) AS payload`;
  return (
    `SELECT ${REQUEST_COLUMNS}, ` +
    `(SELECT collect_list(named_struct('id', id, 'position', position, 'name', name, 'domain', domain, 'dataset_tag', dataset_tag)) FROM ${datasets} WHERE onboarding_request_id = ${id}) AS datasets, ` +
    `(SELECT collect_list(named_struct('id', id, 'intake_dataset_id', intake_dataset_id, 'position', position, 'person_display', person_display, 'person_email', person_email, 'person_principal_id', person_principal_id)) FROM ${owners} WHERE onboarding_request_id = ${id}) AS owners, ` +
    `(SELECT collect_list(named_struct('action_id', action_id, 'action', action, 'from_stage', from_stage, 'to_stage', to_stage, 'record_version', record_version, 'actor_principal_id', actor_principal_id, 'actor_display', actor_display, 'occurred_at', occurred_at, 'note', note, 'payload', payload)) FROM (` +
    `SELECT action_id, action, from_stage, to_stage, record_version, actor_principal_id, actor_display, CAST(occurred_at AS STRING) AS occurred_at, note, payload FROM ${actions} WHERE onboarding_request_id = ${id} ` +
    `UNION ALL ${leadRow}` +
    `)) AS actions ` +
    `FROM ${requests} WHERE id = ${id}`
  );
}

function result(row: Record<string, unknown>, slaConfig: EffectiveSlaConfig): OnboardingRequest {
  const value = row as unknown as RequestRow & {
    datasets?: unknown;
    owners?: unknown;
    actions?: unknown;
  };
  return assembleRequest(
    value,
    jsonList<DatasetPart>(value.datasets),
    jsonList<OwnerPart>(value.owners),
    jsonList<ActionPart>(value.actions),
    slaConfig,
  );
}

/**
 * The persisted SLA deadline columns for the stage just entered, worked out by
 * the SLA module (`docs/data-model.md`): both timestamps at a review stage,
 * both null where no reviewer owes a decision. Persisted on every stage entry
 * so a job or escalation query reads the deadlines straight from the row.
 */
function slaColumns(
  stage: OnboardingRequestStage,
  enteredAt: Date,
  slaConfig: EffectiveSlaConfig,
): Record<string, ColumnValue> {
  const deadlines = onboardingSlaDeadlines(stage, enteredAt.toISOString(), slaConfig);
  return deadlines
    ? {
        sla_due_at: timestamp(new Date(deadlines.dueAt)),
        sla_due_soon_at: timestamp(new Date(deadlines.dueSoonAt)),
      }
    : { sla_due_at: null, sla_due_soon_at: null };
}

function updateIntakeDataset(
  ctx: CommandContext<unknown>,
  id: string,
  set: Pick<DatasetRow, "position" | "name" | "domain" | "dataset_tag">,
): void {
  const target = ctx.names.table(DATASETS.schema, DATASETS.table);
  const idParam = ctx.block.bind(id);
  ctx.block.add(
    `UPDATE ${target} SET ` +
      [
        `position = ${ctx.block.bind(set.position)}`,
        `name = ${ctx.block.bind(set.name)}`,
        `domain = ${ctx.block.bind(set.domain)}`,
        `dataset_tag = ${ctx.block.bind(set.dataset_tag)}`,
      ].join(", ") +
      ` WHERE ${"`id`"} = ${idParam}`,
  );
  ctx.effects.push({
    table: `${DATASETS.schema}.${DATASETS.table}`,
    id,
    check: `(SELECT count(*) FROM ${target} WHERE id = ${idParam})`,
  });
}

function updateIntakeOwner(
  ctx: CommandContext<unknown>,
  id: string,
  set: Pick<OwnerRow, "position" | "person_display" | "person_email" | "person_principal_id">,
): void {
  const target = ctx.names.table(OWNERS.schema, OWNERS.table);
  const idParam = ctx.block.bind(id);
  ctx.block.add(
    `UPDATE ${target} SET ` +
      [
        `position = ${ctx.block.bind(set.position)}`,
        `person_display = ${ctx.block.bind(set.person_display)}`,
        `person_email = ${ctx.block.bind(set.person_email)}`,
        `person_principal_id = ${ctx.block.bind(set.person_principal_id)}`,
      ].join(", ") +
      ` WHERE ${"`id`"} = ${idParam}`,
  );
  ctx.effects.push({
    table: `${OWNERS.schema}.${OWNERS.table}`,
    id,
    check: `(SELECT count(*) FROM ${target} WHERE id = ${idParam})`,
  });
}

/** Delete an intake row the resubmission removed; the block refuses to commit if it's still there. */
function deleteIntakeRow(ctx: CommandContext<unknown>, table: TableRef, id: string): void {
  const target = ctx.names.table(table.schema, table.table);
  const idParam = ctx.block.bind(id);
  ctx.block.add(`DELETE FROM ${target} WHERE ${"`id`"} = ${idParam}`);
  ctx.effects.push({
    table: `${table.schema}.${table.table}`,
    id,
    check: `(SELECT CASE WHEN count(*) = 0 THEN 1 ELSE 0 END FROM ${target} WHERE id = ${idParam})`,
  });
}

/**
 * Write a resubmitted intake's datasets and owner contacts (#222): a kept row
 * is updated in place under its stored ID (its position too, so the order
 * the provider left them in holds), a new one is inserted under a follow-on
 * ID of this resubmission, and a stored one the provider removed is deleted.
 * The removal is on the resubmit action's note and change record.
 */
async function writeIntakeChildren(
  ctx: CommandContext<unknown>,
  requestId: string,
  stored: OnboardingIntake,
  next: OnboardingIntake,
): Promise<void> {
  // Follow-on positions from 10, as on submit; the lead action's own IDs never collide with them.
  let reserved = 10;
  const keptDatasets = new Set<string>();
  const keptOwners = new Set<string>();
  for (const [position, item] of next.datasets.entries()) {
    let datasetId = item.id;
    if (datasetId) {
      updateIntakeDataset(ctx, datasetId, {
        position,
        name: item.name,
        domain: item.domain,
        dataset_tag: item.datasetTag,
      });
    } else {
      datasetId = await followOn(ctx, reserved++);
      insertRow(ctx, DATASETS, {
        id: datasetId,
        onboarding_request_id: requestId,
        position,
        name: item.name,
        domain: item.domain,
        dataset_tag: item.datasetTag,
      });
      expectRow(ctx, DATASETS, "id", datasetId);
    }
    keptDatasets.add(datasetId);
    for (const [ownerPosition, contact] of item.owners.entries()) {
      if (contact.id) {
        keptOwners.add(contact.id);
        // Myself keeps the session's principal; switching to a typed contact clears it (#103).
        // Only Myself sets one in 103-A; staff matching (103-B) must keep its match here.
        updateIntakeOwner(ctx, contact.id, {
          position: ownerPosition,
          person_display: contact.name,
          person_email: contact.email,
          person_principal_id: ownerPrincipalId(contact, ownerSession(ctx.user)),
        });
        continue;
      }
      const ownerId = await followOn(ctx, reserved++);
      insertRow(ctx, OWNERS, {
        id: ownerId,
        intake_dataset_id: datasetId,
        onboarding_request_id: requestId,
        position: ownerPosition,
        person_display: contact.name,
        person_email: contact.email,
        person_principal_id: ownerPrincipalId(contact, ownerSession(ctx.user)),
      });
      expectRow(ctx, OWNERS, "id", ownerId);
    }
  }
  for (const dataset of stored.datasets) {
    for (const contact of dataset.owners) {
      if (contact.id && !keptOwners.has(contact.id)) deleteIntakeRow(ctx, OWNERS, contact.id);
    }
    if (dataset.id && !keptDatasets.has(dataset.id)) deleteIntakeRow(ctx, DATASETS, dataset.id);
  }
}

/** What the area needs from the server. Tests inject these; the app reads them from env. */
export interface OnboardingAreaDeps {
  /** The deploy-time SLA targets, holidays and due-soon threshold (#157). */
  slaConfig: () => EffectiveSlaConfig;
}

const defaultDeps: OnboardingAreaDeps = {
  slaConfig: () => configuredSlaConfig(),
};

export function registerOnboardingArea(
  registry: Registry,
  overrides: Partial<OnboardingAreaDeps> = {},
): void {
  const deps: OnboardingAreaDeps = { ...defaultDeps, ...overrides };
  const sla = () => cloneEffectiveSlaConfig(deps.slaConfig());
  const commandResult = (row: Record<string, unknown>) => result(row, sla());

  registry.command({
    area: "onboarding",
    name: "submit",
    app: "tenant",
    payload: submitPayload,
    leadActionTable: ACTIONS,
    async plan(ctx) {
      refuseOn(findSubmittedIdProblem(ctx.payload.intake));
      assertIntake(ctx.payload.intake);
      const session = ownerSession(ctx.user);
      const datasets = withSessionOwners(ctx.payload.intake, session).datasets;
      if (ctx.expectedVersion !== 0)
        throw new DomainError(
          "bad-version",
          "A new onboarding request starts from version 0.",
          400,
        );
      const requestId = await followOn(ctx, 0);
      const forwardActionId = await followOn(ctx, 1);
      const initiativeId = await followOn(ctx, 2);
      insertRow(ctx, REQUESTS, {
        id: requestId,
        display_number: NO_DISPLAY_NUMBER,
        display_code: allocateDisplayCode(ctx, "ONB", REQUESTS),
        title: ctx.payload.intake.initiativeName.trim(),
        initiative_id: initiativeId,
        provider_principal_id: ctx.user.principalId,
        provider_display: ctx.user.displayName,
        submitted_at: timestamp(ctx.occurredAt),
        stage: "business-roi-review",
        stage_entered_at: timestamp(ctx.occurredAt),
        ...slaColumns("business-roi-review", ctx.occurredAt, sla()),
        initiative_name: ctx.payload.intake.initiativeName.trim(),
        business_case: ctx.payload.intake.businessCase.trim(),
        annual_benefit: ctx.payload.intake.annualBenefit,
        levers: stringArray(ctx.block, ctx.payload.intake.levers),
        workspace_isolation: ctx.payload.intake.workspaceNeeds.isolation,
        workspace_team_size: ctx.payload.intake.workspaceNeeds.teamSize,
        intake_answers: json(submittedAnswers(ctx.payload.intake.answers)),
        open_send_back_from_stage: null,
        open_send_back_action_id: null,
        ...initiativeOwnerColumns(initiativeOwnerFor(ctx.payload.intake.initiativeOwner, session)),
        version: 2,
        created_at: timestamp(ctx.occurredAt),
        created_by_principal_id: ctx.user.principalId,
        updated_at: timestamp(ctx.occurredAt),
        updated_by_principal_id: ctx.user.principalId,
        last_action_id: forwardActionId,
      });
      expectRow(
        ctx,
        REQUESTS,
        "id",
        requestId,
        `last_action_id = ${ctx.block.bind(forwardActionId)}`,
      );
      // One running ordinal across every reserved child record, so dataset and
      // owner IDs can never collide however many owners a dataset names. Reserved
      // positions 0–9 are taken by the request, forward action and initiative above.
      let reserved = 10;
      for (const [index, item] of datasets.entries()) {
        const datasetId = await followOn(ctx, reserved++);
        insertRow(ctx, DATASETS, {
          id: datasetId,
          onboarding_request_id: requestId,
          position: index,
          name: item.name.trim(),
          domain: item.domain.trim(),
          dataset_tag: item.datasetTag.trim(),
        });
        expectRow(ctx, DATASETS, "id", datasetId);
        for (const [ownerIndex, contact] of item.owners.entries()) {
          const ownerId = await followOn(ctx, reserved++);
          insertRow(ctx, OWNERS, {
            id: ownerId,
            intake_dataset_id: datasetId,
            onboarding_request_id: requestId,
            position: ownerIndex,
            person_display: contact.name.trim(),
            person_email: normalizeOwnerEmail(contact.email),
            person_principal_id: ownerPrincipalId(contact, session),
          });
          expectRow(ctx, OWNERS, "id", ownerId);
        }
      }
      insertRow(ctx, ACTIONS, {
        action_id: forwardActionId,
        onboarding_request_id: requestId,
        action: "forwarded",
        from_stage: "submitted",
        to_stage: "business-roi-review",
        record_version: 2,
        actor_principal_id: SYSTEM_ACTOR.principalId,
        actor_display: SYSTEM_ACTOR.display,
        actor_app: SYSTEM_ACTOR.app,
        occurred_at: timestamp(ctx.occurredAt),
        idempotency_key: ctx.idempotencyKey,
        caused_by_action_id: ctx.actionId,
        note: null,
        payload: null,
        command: null,
        command_hash: null,
        expected_effects: null,
        result: null,
      });
      expectRow(ctx, ACTIONS, "action_id", forwardActionId);
      return {
        recordId: requestId,
        recordVersion: 1,
        leadAction: { action: "submitted", change: { stage: [null, "submitted"] } },
      };
    },
    resultRow,
    result: commandResult,
  });

  registry.command({
    area: "onboarding",
    name: "decide",
    app: "staff",
    payload: decisionPayload,
    leadActionTable: ACTIONS,
    authorize(user) {
      // A non-reviewer must not learn whether a request exists or its stage, so
      // refuse exactly as the record-scoped checks in plan do: not-found, never
      // a distinguishable 403. (The memory DataStore contract hides it the same.)
      if (!user.onboardingReviewerRoles.length && !user.isAdmin) throw notFound();
    },
    async plan(ctx) {
      const current = await currentForCommand(ctx, ctx.payload.requestId);
      if (!isReviewStage(current.stage)) throw notFound();
      const role = REVIEWER_FOR_STAGE[current.stage];
      if (!ctx.user.onboardingReviewerRoles.includes(role)) throw notFound();
      const note = ctx.payload.decision.note?.trim() ?? "";
      if (ctx.payload.decision.type === "send-back" && !note)
        throw new DomainError(
          "missing-note",
          "A send-back needs questions for the data provider.",
          400,
        );
      if (ctx.payload.decision.type === "reject" && !note)
        throw new DomainError(
          "missing-note",
          "A rejection needs a reason for the data provider.",
          400,
        );
      const to = nextOnboardingStage(
        current.stage,
        ctx.payload.decision.type === "send-back"
          ? { type: "send-back", to: "submitted" }
          : ctx.payload.decision,
      );
      const version = updateCurrentState(ctx, REQUESTS, current.uuid, ctx.expectedVersion, {
        stage: to,
        stage_entered_at: timestamp(ctx.occurredAt),
        ...slaColumns(to, ctx.occurredAt, sla()),
        open_send_back_from_stage: ctx.payload.decision.type === "send-back" ? current.stage : null,
        open_send_back_action_id: ctx.payload.decision.type === "send-back" ? ctx.actionId : null,
      });
      return {
        recordId: current.uuid,
        recordVersion: version,
        leadAction: {
          action:
            ctx.payload.decision.type === "send-back"
              ? "sent-back"
              : ctx.payload.decision.type === "reject"
                ? "rejected"
                : "approved",
          change: { stage: [current.stage, to] },
          note,
        },
      };
    },
    resultRow,
    result: commandResult,
  });

  registry.command({
    area: "onboarding",
    name: "resubmit",
    app: "tenant",
    payload: resubmitPayload,
    leadActionTable: ACTIONS,
    async plan(ctx) {
      const current = await currentForCommand(ctx, ctx.payload.requestId);
      if (current.provider_principal_id !== ctx.user.principalId) throw notFound();
      if (isOnboardingTerminal(current.stage))
        throw new DomainError(
          "invalid-transition",
          `Invalid onboarding transition: terminal stage '${current.stage}' cannot transition`,
          400,
        );
      if (current.stage !== ONBOARDING_SEND_BACK_STAGE || !current.open_send_back_action_id)
        throw new DomainError(
          "invalid-transition",
          `Only a request sent back to the data provider can be resubmitted; ${current.id} is at '${current.stage}'.`,
          400,
        );
      const answer = ctx.payload.resubmission.answer.trim();
      if (!answer)
        throw new DomainError(
          "missing-answer",
          "A resubmission needs an answer for the reviewer.",
          400,
        );
      const [datasets, owners, actions] = await children(ctx.names, ctx.read, current.uuid);
      const stored = intakeFrom(current, datasets, owners);
      // The whole intake as the provider edited it, re-validated here whatever
      // the browser checked (#222). Only the IDs of this request's own rows
      // may be named; nothing else in the body sets an ID, actor or stage.
      const session = ownerSession(ctx.user);
      const browser = ctx.payload.resubmission.intake
        ? withSessionOwners(normalizeIntake(ctx.payload.resubmission.intake), session)
        : undefined;
      // A retired answer (the steward) stays as the request stored it, whatever the browser sent.
      const sent = browser && {
        ...browser,
        answers: resubmittedAnswers(browser.answers, stored.answers),
      };
      if (sent) refuseOn(findResubmittedIdProblem(stored, sent));
      const merged = sent ?? stored;
      // An answer-only resubmission of a request made before #103 keeps having no owner.
      refuseOn(wholeIntakeProblem(merged, undefined, new Set(sent ? [] : ["initiativeOwner"])));
      const note = resubmitNote(answer, stored, merged);
      const storedOwner = storedInitiativeOwner(current);
      const owner = sent ? initiativeOwnerFor(sent.initiativeOwner, session) : storedOwner;
      const resubmission: OnboardingResubmissionRecord = {
        answer,
        changes: resubmissionChanges(stored, merged, undefined, {
          before: storedOwner,
          after: owner,
        }),
      };
      // Back to the stage that sent it back (#221): the open send-back on the
      // row, then the stage on its send-back action, never the request body.
      const sendBackAction = actions.find(
        (action) => action.action_id === current.open_send_back_action_id,
      );
      const to = nextOnboardingStage(current.stage, {
        type: "resubmit",
        to: resubmissionStage(current.open_send_back_from_stage, sendBackAction?.from_stage),
      });
      const version = updateCurrentState(ctx, REQUESTS, current.uuid, ctx.expectedVersion, {
        stage: to,
        stage_entered_at: timestamp(ctx.occurredAt),
        ...slaColumns(to, ctx.occurredAt, sla()),
        ...(sent
          ? {
              title: merged.initiativeName,
              initiative_name: merged.initiativeName,
              business_case: merged.businessCase,
              annual_benefit: merged.annualBenefit,
              levers: stringArray(ctx.block, merged.levers),
              workspace_isolation: merged.workspaceNeeds.isolation,
              workspace_team_size: merged.workspaceNeeds.teamSize,
              intake_answers: json(merged.answers),
              ...initiativeOwnerColumns(owner),
            }
          : {}),
        open_send_back_from_stage: null,
        open_send_back_action_id: null,
      });
      if (sent) await writeIntakeChildren(ctx, current.uuid, stored, merged);
      return {
        recordId: current.uuid,
        recordVersion: version,
        leadAction: {
          action: "resubmitted",
          change: { stage: [current.stage, to] },
          note,
          payload: resubmission,
        },
      };
    },
    resultRow,
    result: commandResult,
  });

  registry.command({
    area: "onboarding",
    name: "withdraw",
    app: "tenant",
    payload: withdrawPayload,
    leadActionTable: ACTIONS,
    async plan(ctx) {
      const current = await currentForCommand(ctx, ctx.payload.requestId);
      if (current.provider_principal_id !== ctx.user.principalId) throw notFound();
      const to = nextOnboardingStage(current.stage, { type: "withdraw" });
      const version = updateCurrentState(ctx, REQUESTS, current.uuid, ctx.expectedVersion, {
        stage: to,
        stage_entered_at: timestamp(ctx.occurredAt),
        ...slaColumns(to, ctx.occurredAt, sla()),
        open_send_back_from_stage: null,
        open_send_back_action_id: null,
      });
      return {
        recordId: current.uuid,
        recordVersion: version,
        leadAction: {
          action: "withdrawn",
          change: { stage: [current.stage, to] },
          note: ctx.payload.note?.trim() ?? "",
        },
      };
    },
    resultRow,
    result: commandResult,
  });

  registry.read({
    area: "onboarding",
    name: "request",
    app: "tenant",
    query: z.object({ id: z.string().min(1) }).strict(),
    async run({ query, names, read, user }) {
      return (await loadRequest(names, read, user, query.id, sla())) ?? null;
    },
    snapshot({ query, snapshot, user }) {
      const lookup = displayLookup(query.id);
      if (!lookup) return null;
      const row = requestRowsFromSnapshot(snapshot).find((item) => item.id === lookup.label);
      if (!row || !canSee(user, row)) return null;
      return requestFromSnapshot(snapshot, row, sla());
    },
  });

  registry.read({
    area: "onboarding",
    name: "mine",
    app: "tenant",
    query: z.object({}).strict(),
    async run({ names, read, user }) {
      const rows = await readRequests(names, read, {
        where: "r.provider_principal_id = :me",
        parameters: { me: user.principalId },
        orderBy: "r.submitted_at DESC",
      });
      const slaConfig = sla();
      return rows.map((row) => toRequest(row, row.datasets, row.owners, row.actions, slaConfig));
    },
    snapshot({ snapshot, user }) {
      const slaConfig = sla();
      return requestRowsFromSnapshot(snapshot)
        .filter((row) => row.provider_principal_id === user.principalId)
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
        .map((row) => requestFromSnapshot(snapshot, row, slaConfig));
    },
  });

  registry.read({
    area: "onboarding",
    name: "inbox",
    app: "staff",
    query: z.object({ role: reviewRole }).strict(),
    authorize(user) {
      if (!user.onboardingReviewerRoles.length && !user.isAdmin)
        throw new DomainError("forbidden", "Only onboarding reviewers can do this.", 403);
    },
    async run({ query, names, read, user }) {
      const role = query.role as OnboardingReviewerRole;
      assertReviewerRole(user, role);
      const stage = STAGE_FOR_REVIEWER[role];
      const rows = await readRequests(names, read, {
        where: "r.stage = :stage",
        parameters: { stage },
        orderBy: "r.stage_entered_at",
      });
      const slaConfig = sla();
      return rows.map((row) => toRequest(row, row.datasets, row.owners, row.actions, slaConfig));
    },
    snapshot({ query, snapshot, user }) {
      const role = query.role as OnboardingReviewerRole;
      assertReviewerRole(user, role);
      const stage = STAGE_FOR_REVIEWER[role];
      const slaConfig = sla();
      return requestRowsFromSnapshot(snapshot)
        .filter((row) => row.stage === stage)
        .sort((a, b) => a.stage_entered_at.localeCompare(b.stage_entered_at))
        .map((row) => requestFromSnapshot(snapshot, row, slaConfig));
    },
  });
}
