import type { SlaStatus } from "../sla";
import type { EirAutomaticValidity } from "./approval-mode";
import type { EirDisposition, EirOutcome } from "./definition/types";

export type EirStage =
  "not-started" | "submitted" | "questions" | "valid" | "rejected" | "expired" | "revoked";

/**
 * One form's answers, keyed by field ID. Each form version's fields are in `config.ts`;
 * answers stored under an older version keep that version's keys.
 */
export type EirFormValues = Record<string, string>;

export interface EirRuleOutcome {
  ruleId: string;
  field: string;
  reasonCode: string;
  disposition: EirDisposition;
  guidance: string;
}

export interface EirEvaluation {
  definitionVersion: string;
  formVersion: string;
  effectiveAt: string;
  evaluatedDraftVersion: number;
  outcome: EirOutcome;
  outcomes: EirRuleOutcome[];
  /** Whether the outcome is one the deploy names as qualifying for automatic validity (#204). */
  automaticValidityEligible: boolean;
  /**
   * Its place among the draft's recorded pre-checks (#204): a later one is
   * higher, even in the same millisecond. Absent until it's recorded, and on
   * pre-checks recorded before the sequence existed.
   */
  sequence?: number;
  actorPrincipalId: "system";
  actorDisplay: "EDP Vending Machine";
  actorApp: "system";
}

export interface EirAction {
  kind:
    | "started"
    | "submitted"
    | "questions"
    | "valid"
    | "rejected"
    | "revoked"
    | "renewed"
    | "renewal-closed";
  /** The person or validator who acted; `system` for a renewal closed by a revocation. */
  actorScimId: string;
  /** Snapshot for new actions; absent only on migrated legacy records. */
  actorName?: string;
  at: string;
  note?: string;
  response?: string;
  subject?: "renewal";
  /**
   * A validator's decision on their own EIR, under a PR preview's test mode.
   * Set only by the rules (`self-decision.ts`); stored as the action's payload.
   */
  selfDecisionTestMode?: true;
  /**
   * On the system's `valid` action in automatic approval mode (#204): the
   * upload-time pre-check it rests on. Set only by the rules; stored as the
   * action's payload.
   */
  automaticValidity?: EirAutomaticValidity;
}

export interface EirRenewal {
  stage: "submitted" | "questions" | "rejected";
  volumePath: string;
  submittedAt: string;
  questions?: string;
  response?: string;
  note?: string;
  formValues?: EirFormValues;
  formVersion?: string;
  formStartedAt?: string;
}

export interface EirSubmission {
  volumePath: string;
  submittedAt: string;
  /** Integrity and signed-value fields are absent only on migrated legacy submissions. */
  sha256?: string;
  sizeBytes?: number;
  formValues?: EirFormValues;
  /** The form version the answers were given under (`config.ts`; `0.1` for #98's records). */
  formVersion?: string;
  /** When the person started this form: the training rule counts back a year from it. */
  formStartedAt?: string;
  kind?: "first" | "resubmission" | "renewal";
}

export interface EirRecord {
  principalId: string;
  personName: string;
  /** The display ID (`EIR-7K3QFD`; `EIR-1042` on records started before display codes), assigned when the record is started. */
  recordId?: string;
  stage: EirStage;
  /** The answers as signed, on the submission the stage is about. */
  formValues?: EirFormValues;
  formVersion?: string;
  formStartedAt?: string;
  /** When those answers were submitted ("in the future" flags count from it). */
  formSubmittedAt?: string;
  /** Unsigned corrections for the next resubmission/renewal; never the current approved record. */
  draftValues?: EirFormValues;
  draftFormVersion?: string;
  /** When this draft was started (its first save since the last submission). */
  draftStartedAt?: string;
  questions?: string;
  response?: string;
  expiresAt?: string;
  renewal?: EirRenewal;
  submissions: EirSubmission[];
  actions: EirAction[];
  /**
   * The EIR's version on Delta (0 before the first submission). A decision or
   * submission sends it back, so a change made meanwhile is refused instead of
   * overwritten. Absent from the in-memory repository, which has no versions.
   */
  version?: number;
  /** The draft's own version on Delta (0 when there's none); drafts never touch the EIR's version. */
  draftVersion?: number;
  /** Latest persisted pre-check for this draft; its version reveals whether it is stale. */
  evaluation?: EirEvaluation;
  /** Server-computed SLA for a submitted EIR, when one is waiting on a validator. */
  sla?: SlaStatus;
}

export interface EirInboxItem extends EirRecord {
  sla: SlaStatus;
}

export type EirDecision = "valid" | "questions" | "rejected" | "revoked";
