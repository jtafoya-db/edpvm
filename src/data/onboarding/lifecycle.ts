/**
 * The onboarding request lifecycle (#86) — a pure module, tested through the
 * DataStore seam.
 *
 *   submitted → business & ROI review → CCB → standup   (→ active, #89)
 *
 * Forward moves submitted → business & ROI review with no one deciding.
 * Approval moves a request past a review stage. Every send-back returns it to
 * the data provider, and a resubmission returns to the review stage that sent
 * it back (#221). Rejection and withdrawal are terminal. Anything else
 * is refused with an error that says why, as the old lifecycle does.
 */
import {
  addBusinessDays,
  computeSlaStatus,
  computeStoredSlaStatus,
  type SlaStage,
} from "../sla.ts";
import {
  configuredLifecycleSla,
  type EffectiveSlaConfig,
  DEFAULT_EFFECTIVE_SLA_CONFIG,
} from "../sla-config.ts";
import type {
  OnboardingActor,
  OnboardingRequestStage,
  OnboardingReviewStage,
  OnboardingReviewerRole,
  OnboardingSlaStatus,
  OnboardingStage,
  OnboardingTerminalStage,
} from "./types";

export const ONBOARDING_STAGES = [
  { key: "submitted", label: "Submitted" },
  { key: "business-roi-review", label: "Business & ROI review" },
  { key: "ccb", label: "CCB" },
  { key: "standup", label: "Standup" },
] as const satisfies ReadonlyArray<{ key: OnboardingStage; label: string }>;

export const ONBOARDING_TERMINAL_STAGES: readonly OnboardingTerminalStage[] = [
  "rejected",
  "withdrawn",
];

/** Which reviewer role decides at each review stage. */
export const REVIEWER_FOR_STAGE: Readonly<Record<OnboardingReviewStage, OnboardingReviewerRole>> = {
  "business-roi-review": "business-office",
  ccb: "ccb",
};

export const STAGE_FOR_REVIEWER: Readonly<Record<OnboardingReviewerRole, OnboardingReviewStage>> = {
  "business-office": "business-roi-review",
  ccb: "ccb",
};

export const REVIEWER_LABEL: Readonly<Record<OnboardingReviewerRole, string>> = {
  "business-office": "EDP business office",
  ccb: "CCB",
};

/** The provider-owned stage used for every reviewer send-back. */
export const ONBOARDING_SEND_BACK_STAGE = "submitted" as const;

/**
 * Where a resubmission goes when no stored record names the stage that sent the
 * request back. Every send-back records it, so this only covers a row written
 * without one; it is the stage the pre-#221 rule always used.
 */
export const ONBOARDING_RESUBMISSION_FALLBACK_STAGE = "business-roi-review" as const;

/**
 * Each review stage borrows its SLA target from the matching stage of the
 * existing SLA module, so the business-day clock and targets are shared.
 */
const SLA_STAGE: Readonly<Record<OnboardingReviewStage, "edp-roi-review" | "ccb">> = {
  "business-roi-review": "edp-roi-review",
  ccb: "ccb",
};

export type OnboardingTransition =
  | { type: "forward" }
  /** `to` is the stage that sent the request back, from {@link resubmissionStage}. */
  | { type: "resubmit"; to: OnboardingReviewStage }
  | { type: "approve" }
  | { type: "send-back"; to: OnboardingRequestStage }
  | { type: "reject" }
  | { type: "withdraw" };

export function isOnboardingTerminal(
  stage: OnboardingRequestStage,
): stage is OnboardingTerminalStage {
  return (ONBOARDING_TERMINAL_STAGES as readonly OnboardingRequestStage[]).includes(stage);
}

export function isReviewStage(stage: OnboardingRequestStage): stage is OnboardingReviewStage {
  return stage === "business-roi-review" || stage === "ccb";
}

export function onboardingStageLabel(stage: OnboardingRequestStage): string {
  if (stage === "rejected") return "Rejected";
  if (stage === "withdrawn") return "Withdrawn";
  return ONBOARDING_STAGES.find(({ key }) => key === stage)?.label ?? stage;
}

function invalid(message: string): Error {
  return new Error(`Invalid onboarding transition: ${message}`);
}

/**
 * The stage a transition lands on, or a thrown error explaining why the
 * transition is not allowed from `from`.
 */
export function nextOnboardingStage(
  from: OnboardingRequestStage,
  transition: OnboardingTransition,
): OnboardingRequestStage {
  if (isOnboardingTerminal(from)) {
    throw invalid(`terminal stage '${from}' cannot transition`);
  }

  switch (transition.type) {
    case "forward":
      if (from !== "submitted") {
        throw invalid(`only 'submitted' moves forward without a decision, not '${from}'`);
      }
      return "business-roi-review";
    case "resubmit":
      if (from !== ONBOARDING_SEND_BACK_STAGE) {
        throw invalid(`only a request with the data provider can be resubmitted, not '${from}'`);
      }
      if (!isReviewStage(transition.to)) {
        throw invalid(`a resubmission returns to a review stage, not '${transition.to}'`);
      }
      return transition.to;
    case "withdraw":
      if (from === "standup") {
        throw invalid("cannot withdraw from 'standup'; the request is already approved");
      }
      return "withdrawn";
    case "approve":
    case "reject":
    case "send-back": {
      if (!isReviewStage(from)) throw invalid(`'${from}' is not a review stage`);
      if (transition.type === "approve") return from === "business-roi-review" ? "ccb" : "standup";
      if (transition.type === "reject") return "rejected";
      if (transition.to !== ONBOARDING_SEND_BACK_STAGE) {
        throw invalid(
          `send-back from '${from}' must target the data provider at '${ONBOARDING_SEND_BACK_STAGE}', not '${transition.to}'`,
        );
      }
      return ONBOARDING_SEND_BACK_STAGE;
    }
  }
}

/**
 * The review stage a resubmission returns to: the stage that sent the request
 * back (#221). `recorded` lists what the stored history says, most
 * authoritative first: the request's open send-back, then the stage on the
 * send-back action row. The first review stage among them wins; if none is one,
 * the request goes to {@link ONBOARDING_RESUBMISSION_FALLBACK_STAGE}. Never pass
 * anything from the resubmission itself.
 */
export function resubmissionStage(
  ...recorded: ReadonlyArray<string | null | undefined>
): OnboardingReviewStage {
  const stage = recorded.find(
    (candidate): candidate is OnboardingReviewStage =>
      !!candidate && isReviewStage(candidate as OnboardingRequestStage),
  );
  return stage ?? ONBOARDING_RESUBMISSION_FALLBACK_STAGE;
}

/** Refuse a reviewer decision from anyone outside the stage's configured reviewer group. */
export function assertReviewer(stage: OnboardingReviewStage, actor: OnboardingActor): void {
  const role = REVIEWER_FOR_STAGE[stage];
  if (!actor.reviewerRoles.includes(role)) {
    throw new Error(
      `Only the ${REVIEWER_LABEL[role]} can decide at ${onboardingStageLabel(stage)}; ` +
        `${actor.name} is not a member of the configured ${REVIEWER_LABEL[role]} group.`,
    );
  }
}

/** The SLA state at a review stage, or null where no reviewer owes a decision. */
export function onboardingSla(
  stage: OnboardingRequestStage,
  enteredAt: string,
  now: Date,
  slaConfig: EffectiveSlaConfig = DEFAULT_EFFECTIVE_SLA_CONFIG,
): OnboardingSlaStatus | null {
  if (!isReviewStage(stage)) return null;
  return {
    ...computeSlaStatus(SLA_STAGE[stage], enteredAt, now, {
      config: configuredLifecycleSla(slaConfig),
      holidays: slaConfig.holidays,
      dueSoonThreshold: slaConfig.dueSoonThresholdBusinessDays,
    }),
    stage,
  };
}

/** The persisted SLA deadlines for the stage just entered, or null where no reviewer owes a decision. */
export interface OnboardingSlaDeadlines {
  /** When the stage's SLA target is reached (the breach boundary). */
  dueAt: string;
  /** When the stage enters its due-soon window. */
  dueSoonAt: string;
}

/**
 * The two SLA deadline timestamps a review stage carries from the moment it is
 * entered (`docs/data-model.md`: worked out by the SLA module on stage entry,
 * null at stages with no target). `dueAt` is the breach boundary; `dueSoonAt`
 * is the start of the due-soon window, both counted in business days from
 * `enteredAt`, so a job or query reads them straight from the row.
 */
export function onboardingSlaDeadlines(
  stage: OnboardingRequestStage,
  enteredAt: string,
  slaConfig: EffectiveSlaConfig = DEFAULT_EFFECTIVE_SLA_CONFIG,
): OnboardingSlaDeadlines | null {
  if (!isReviewStage(stage)) return null;
  const target = configuredLifecycleSla(slaConfig)[SLA_STAGE[stage]];
  if (target === null) return null;
  return {
    dueAt: addBusinessDays(enteredAt, target, slaConfig.holidays).toISOString(),
    dueSoonAt: addBusinessDays(
      enteredAt,
      Math.max(0, target - slaConfig.dueSoonThresholdBusinessDays),
      slaConfig.holidays,
    ).toISOString(),
  };
}

/**
 * SLA state projected from the deadlines persisted when the stage was entered,
 * so a later change to the deploy-time targets doesn't move a request's due
 * date. Falls back to {@link onboardingSla} for a row with no stored deadline.
 */
export function onboardingStoredSla(
  stage: OnboardingRequestStage,
  enteredAt: string,
  now: Date,
  stored: { dueAt: string | null; dueSoonAt: string | null },
  slaConfig: EffectiveSlaConfig = DEFAULT_EFFECTIVE_SLA_CONFIG,
): OnboardingSlaStatus | null {
  if (!isReviewStage(stage)) return null;
  if (!stored.dueAt) return onboardingSla(stage, enteredAt, now, slaConfig);
  return {
    ...computeStoredSlaStatus(SLA_STAGE[stage], enteredAt, now, stored.dueAt, stored.dueSoonAt, {
      holidays: slaConfig.holidays,
    }),
    stage,
  };
}
