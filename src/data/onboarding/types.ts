/**
 * Domain types for the onboarding request (#86): a data provider's request to
 * start an initiative, reviewed by the EDP business office and then the CCB.
 *
 * This lifecycle runs ALONGSIDE the old seven-stage access-request lifecycle
 * (src/data/lifecycle.ts) — the expand step of the domain-model migration. The
 * datasets and owners named here are fields of the request's intake package;
 * standup (#89) turns them into datasets with owners.
 */
import type {
  IntakeInitiativeOwner,
  IntakeOwnerContact,
  IntakeDatasetInput,
} from "../../schema/types";
import type { SlaStatus } from "../sla";

/** The non-terminal stages, in order. Activation (after standup) is #89. */
export type OnboardingStage = "submitted" | "business-roi-review" | "ccb" | "standup";
export type OnboardingTerminalStage = "rejected" | "withdrawn";
export type OnboardingRequestStage = OnboardingStage | OnboardingTerminalStage;

/** The two review stages, each with exactly one reviewer role. */
export type OnboardingReviewStage = "business-roi-review" | "ccb";

/** Membership of a configured reviewer group, derived server-side from SCIM groups. */
export type OnboardingReviewerRole = "business-office" | "ccb";

/** Owner contact data from intake; resolved to a SCIM id at standup (#89), never an ownership record itself. */
export type DatasetOwnerContact = IntakeOwnerContact;
export type IntakeDataset = IntakeDatasetInput;
export type InitiativeOwnerChoice = IntakeInitiativeOwner;

/**
 * Whether the app knows which Databricks principal an owner is (#103).
 * `verified`: the provider picked Myself, so it's their own signed-in session
 * (SCIM `/Me`). `not-verified`: a name and email the provider typed; nothing
 * has confirmed who they are yet (staff matching is #103's next slice).
 */
export type OwnerVerification = "verified" | "not-verified";

/** The initiative owner as the request stores it. */
export interface InitiativeOwner {
  kind: IntakeInitiativeOwner["kind"];
  name: string;
  /** Normalised (trimmed, lower-case). Display and matching data, never an actor key (ADR-0006). */
  email: string;
  /** The session's principal for Myself; null for Someone else. */
  principalId: string | null;
  verification: OwnerVerification;
}

/** Answers to the workspace-needs questions. The decision criteria are a stub. */
export interface WorkspaceNeeds {
  isolation: string;
  teamSize: number;
}

/** The intake package an onboarding request carries. */
export interface OnboardingIntake {
  initiativeName: string;
  businessCase: string;
  annualBenefit: number;
  levers: string[];
  datasets: IntakeDataset[];
  workspaceNeeds: WorkspaceNeeds;
  /** every raw intake answer, kept so reviewers read the same record the provider filled in */
  answers: Record<string, unknown>;
  /** Who owns the initiative (#103). Absent on requests made before it was asked. */
  initiativeOwner?: InitiativeOwnerChoice | undefined;
}

/** Who is acting. `principalId` is the stable SCIM id every decision is recorded against. */
export interface OnboardingActor {
  principalId: string;
  name: string;
  reviewerRoles: readonly OnboardingReviewerRole[];
}

export type OnboardingDecisionKind =
  "submit" | "forward" | "approve" | "send-back" | "reject" | "withdraw" | "resubmit";

/** One recorded transition: who did what, when, from which stage to which. */
export interface OnboardingDecision {
  kind: OnboardingDecisionKind;
  from: OnboardingRequestStage | null;
  to: OnboardingRequestStage;
  /** SCIM id of the actor, or "system" for a forward transition */
  actorId: string;
  actorName: string;
  at: string;
  note: string;
  /** On a resubmission: the provider's answer and what it changed (#221). */
  resubmission?: OnboardingResubmissionRecord;
}

/** One intake field a resubmission changed, as the reviewer reads it. */
export interface OnboardingIntakeChange {
  /** e.g. "Dataset 1 dataset tag", "Workspace isolation", "Dataset 2 removed" */
  field: string;
  before: string;
  after: string;
  /** Set when a whole dataset or owner contact was added or removed, not one field edited (#222). */
  kind?: "added" | "removed";
}

/**
 * What a resubmission recorded for the reviewer it returns to: the provider's
 * answer on its own, and every intake field that differs from the request the
 * reviewer sent back (empty when only the answer changed).
 */
export interface OnboardingResubmissionRecord {
  answer: string;
  changes: OnboardingIntakeChange[];
}

/** The questions a reviewer sent back, open until the provider resubmits. */
export interface OpenSendBack {
  from: OnboardingReviewStage;
  questions: string;
  actorId: string;
  at: string;
}

/** The SLA state of a request at a review stage, from the shared SLA module. */
export type OnboardingSlaStatus = Omit<SlaStatus, "stage"> & { stage: OnboardingReviewStage };

/** The stored onboarding request. */
export interface OnboardingRequestRecord {
  id: string;
  version: number;
  title: string;
  providerId: string;
  providerName: string;
  submittedAt: string;
  stage: OnboardingRequestStage;
  stageEnteredAt: string;
  intake: OnboardingIntake;
  openSendBack: OpenSendBack | null;
  decisions: OnboardingDecision[];
  /** The initiative owner as stored (#103); null on requests made before it was asked. */
  initiativeOwner: InitiativeOwner | null;
  /** Each dataset owner contact's verification, by the contact's ID (#103). */
  ownerVerification: Record<string, OwnerVerification>;
}

/** What every read returns: the record plus its current stage's SLA state (null off review stages). */
export interface OnboardingRequest extends OnboardingRequestRecord {
  sla: OnboardingSlaStatus | null;
}

/** A reviewer's decision at their stage. */
export type OnboardingReviewDecision =
  | { type: "approve"; note?: string }
  | { type: "send-back"; to: "submitted"; note: string }
  | { type: "reject"; note: string };

/**
 * One user intent behind a write: the key is made when the person confirms and
 * reused on every retry of that same intent, so a second invocation replays the
 * first instead of writing again. A changed decision or input is a new intent.
 */
export interface OnboardingWriteIntent {
  key: string;
  /**
   * The version of the record the person confirmed against. A Delta command
   * sends it as its expected version, so the server refuses the write if the
   * record has changed since; there's no preliminary read. A different version
   * is a different intent, with a new key.
   */
  version?: number;
}

export interface OnboardingResubmission {
  answer: string;
  /**
   * The whole intake as the provider edited it in the wizard (#222); left out,
   * the stored intake stands. A dataset or owner contact that keeps its stored
   * `id` is the same record; one without an `id` is new, and the server gives
   * it one; a stored one left out is removed. The server re-validates all of it.
   */
  intake?: OnboardingIntake;
}
