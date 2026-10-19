import type {
  AccessRequest,
  PipelineDecision,
  PipelineEntry,
  RequestItem,
  SubRequest,
} from "./types";
import {
  LIFECYCLE_STAGES,
  type LifecycleStage,
  type LifecycleTransition,
  type RequestStage,
  isTerminalStage,
  stageLabel,
  validateTransition,
} from "./lifecycle";

export interface CanonicalDecision {
  at: string;
  actor: string;
  decision: string;
  note: string;
}

export interface LifecycleEvent {
  at: string;
  type: string;
  fromStage?: RequestStage;
  toStage?: RequestStage;
  detail?: string;
}

export interface IntakeAnswers extends Record<string, unknown> {
  /** Selected BusinessDomain.id as captured by the intake wizard. */
  domain: string;
  /** Accountable data steward answer captured by the intake wizard. */
  steward: string;
}

export interface RequestIntakePackage {
  purpose: string;
  answers: IntakeAnswers;
  items: RequestItem[];
  subRequests: SubRequest[];
  pipeline?: Pick<
    PipelineEntry,
    | "kind"
    | "nextAction"
    | "jira"
    | "jiraStatus"
    | "monthlyCost"
    | "roi"
    | "sensitivity"
    | "pattern"
    | "delivery"
  > & { decisionJiras: string[]; stateOverride?: "blocked" | "returned" };
}

export interface CanonicalRequest {
  id: string;
  title: string;
  tenant: string;
  requester: string;
  submittedAt: string;
  /** Stable reference to the selected BusinessDomain.id. */
  domainId: string;
  intake: RequestIntakePackage;
  stage: RequestStage;
  owner: string;
  priority?: string;
  livesOnLiveData: boolean;
  decisions: CanonicalDecision[];
  events: LifecycleEvent[];
}

const LEGACY_ACCESS_STAGE_MAP: readonly LifecycleStage[] = [
  "submitted",
  "domain-review",
  "edp-roi-review",
  "ccb",
  "provisioning",
  "active",
];

const PIPELINE_STATE_TO_STAGE: Readonly<Record<string, RequestStage>> = {
  intake: "submitted",
  review: "edp-roi-review",
  ccb: "ccb",
  provisioning: "provisioning",
  live: "active",
  blocked: "provisioning",
  returned: "domain-review",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

function cloneItems(items: RequestItem[]): RequestItem[] {
  return items.map((item) => ({ ...item }));
}

function cloneSubRequests(subRequests: SubRequest[]): SubRequest[] {
  return subRequests.map((subRequest) => ({ ...subRequest }));
}

function ageDays(submittedAt: string, now: Date): number {
  const submitted = new Date(submittedAt);
  if (Number.isNaN(submitted.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - submitted.getTime()) / 86_400_000));
}

function canonicalStageIndex(stage: RequestStage): number {
  if (stage === "rejected" || stage === "withdrawn") return 0;
  const legacyIndex: Record<LifecycleStage, number> = {
    submitted: 0,
    "domain-review": 1,
    "edp-roi-review": 2,
    ccb: 3,
    "live-data-waiver": 4,
    provisioning: 4,
    active: 5,
  };
  return legacyIndex[stage];
}

export function toAccessRequest(request: CanonicalRequest): AccessRequest {
  const terminal = isTerminalStage(request.stage);
  return {
    id: request.id,
    title: request.title,
    submittedAt: request.submittedAt,
    status:
      request.stage === "active"
        ? "Completed"
        : terminal
          ? stageLabel(request.stage)
          : "In progress",
    overall: stageLabel(request.stage),
    purpose: request.intake.purpose,
    items: cloneItems(request.intake.items),
    subRequests: cloneSubRequests(request.intake.subRequests),
    stageIndex: canonicalStageIndex(request.stage),
  };
}

export function fromAccessRequest(
  request: AccessRequest,
  context: { tenant?: string; requester?: string; owner?: string; livesOnLiveData?: boolean } = {},
): CanonicalRequest {
  const normalizedStatus = request.status.toLowerCase();
  const stage: RequestStage = normalizedStatus.includes("withdraw")
    ? "withdrawn"
    : normalizedStatus.includes("reject")
      ? "rejected"
      : (LEGACY_ACCESS_STAGE_MAP[request.stageIndex] ?? "submitted");
  return {
    id: request.id,
    title: request.title,
    tenant: context.tenant ?? "",
    requester: context.requester ?? "",
    submittedAt: request.submittedAt,
    domainId: "",
    intake: {
      purpose: request.purpose,
      answers: { domain: "", steward: "" },
      items: cloneItems(request.items),
      subRequests: cloneSubRequests(request.subRequests),
    },
    stage,
    owner: context.owner ?? "",
    livesOnLiveData: context.livesOnLiveData ?? false,
    decisions: [],
    events: [],
  };
}

function pipelineState(stage: RequestStage): string {
  if (stage === "submitted" || stage === "domain-review") return "intake";
  if (stage === "edp-roi-review" || stage === "live-data-waiver") return "review";
  if (stage === "ccb") return "ccb";
  if (stage === "provisioning") return "provisioning";
  if (stage === "active") return "live";
  return stage;
}

export function toPipelineEntry(request: CanonicalRequest, now = new Date()): PipelineEntry {
  const legacy = request.intake.pipeline;
  return {
    id: request.id,
    kind: legacy?.kind ?? "access",
    title: request.title,
    tenant: request.tenant,
    requester: request.requester,
    submittedAt: request.submittedAt,
    state: legacy?.stateOverride ?? pipelineState(request.stage),
    stage: stageLabel(request.stage),
    nextAction: legacy?.nextAction ?? "",
    owner: request.owner,
    ageDays: ageDays(request.submittedAt, now),
    jira: legacy?.jira ?? "",
    jiraStatus: legacy?.jiraStatus ?? "",
    monthlyCost: legacy?.monthlyCost ?? 0,
    roi: legacy?.roi ?? null,
    sensitivity: legacy?.sensitivity ?? "",
    pattern: legacy?.pattern ?? "",
    delivery: legacy?.delivery ?? "",
    decisions: request.decisions.map((decision, index) => ({
      ...decision,
      jira: legacy?.decisionJiras[index] ?? legacy?.jira ?? "",
    })),
  };
}

function inferPipelineStage(request: PipelineEntry): RequestStage {
  const byLabel = LIFECYCLE_STAGES.find(
    ({ label }) => label.toLowerCase() === request.stage.toLowerCase(),
  );
  return byLabel?.key ?? PIPELINE_STATE_TO_STAGE[request.state] ?? "submitted";
}

export function fromPipelineEntry(request: PipelineEntry): CanonicalRequest {
  return {
    id: request.id,
    title: request.title,
    tenant: request.tenant,
    requester: request.requester,
    submittedAt: request.submittedAt,
    domainId: "",
    intake: {
      purpose: "",
      answers: { domain: "", steward: "" },
      items: [],
      subRequests: [],
      pipeline: {
        kind: request.kind,
        nextAction: request.nextAction,
        jira: request.jira,
        jiraStatus: request.jiraStatus,
        monthlyCost: request.monthlyCost,
        roi: request.roi,
        sensitivity: request.sensitivity,
        pattern: request.pattern,
        delivery: request.delivery,
        decisionJiras: request.decisions.map(({ jira }) => jira),
        ...((request.state === "blocked" || request.state === "returned") && {
          stateOverride: request.state,
        }),
      },
    },
    stage: inferPipelineStage(request),
    owner: request.owner,
    livesOnLiveData:
      request.sensitivity.toLowerCase().includes("fti") ||
      request.stage.toLowerCase().includes("waiver"),
    decisions: request.decisions.map(({ at, actor, decision, note }) => ({
      at,
      actor,
      decision,
      note,
    })),
    events: [],
  };
}

export function applyTransition(
  request: CanonicalRequest,
  transition: LifecycleTransition,
  context: { actor: string; note: string; now: string | Date },
): CanonicalRequest {
  validateTransition(request, transition);
  const at = typeof context.now === "string" ? context.now : context.now.toISOString();
  const toStage: RequestStage =
    transition.type === "reject"
      ? "rejected"
      : transition.type === "withdraw"
        ? "withdrawn"
        : transition.to;
  const decision =
    transition.type === "approve"
      ? "Approved"
      : transition.type === "reject"
        ? "Rejected"
        : transition.type === "send-back"
          ? "Questions requested"
          : undefined;
  const pipeline = request.intake.pipeline;
  const intake = pipeline
    ? (() => {
        const { stateOverride: _stateOverride, ...rest } = pipeline;
        return { ...request.intake, pipeline: rest };
      })()
    : request.intake;

  return {
    ...request,
    intake,
    stage: toStage,
    owner: transition.owner ?? request.owner,
    decisions: decision
      ? [...request.decisions, { at, actor: context.actor, decision, note: context.note }]
      : request.decisions,
    events: [
      ...request.events,
      {
        at,
        type: transition.type,
        fromStage: request.stage,
        toStage,
        ...(context.note ? { detail: context.note } : {}),
      },
    ],
  };
}

export type { LifecycleTransition } from "./lifecycle";
