export const LIFECYCLE_STAGES = [
  { key: "submitted", label: "Access request submitted" },
  { key: "domain-review", label: "Domain owner review" },
  { key: "edp-roi-review", label: "EDP business & ROI review" },
  { key: "ccb", label: "EDP intake CCB" },
  { key: "live-data-waiver", label: "Live-data waiver validated" },
  { key: "provisioning", label: "BEARS entitlements + Databricks provisioning" },
  { key: "active", label: "Access active" },
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]["key"];
export type TerminalStage = "active" | "rejected" | "withdrawn";
export type RequestStage = LifecycleStage | Exclude<TerminalStage, "active">;

export const TERMINAL_STAGES: readonly TerminalStage[] = ["active", "rejected", "withdrawn"];

export const FORWARD_TRANSITIONS: Readonly<
  Record<Exclude<LifecycleStage, "active">, readonly LifecycleStage[]>
> = {
  submitted: ["domain-review"],
  "domain-review": ["edp-roi-review"],
  "edp-roi-review": ["ccb"],
  ccb: ["live-data-waiver", "provisioning"],
  "live-data-waiver": ["provisioning"],
  provisioning: ["active"],
};

export type LifecycleTransition =
  | { type: "forward"; to: LifecycleStage; owner?: string }
  | { type: "approve"; to: LifecycleStage; owner?: string }
  | { type: "send-back"; to: Exclude<LifecycleStage, "active">; owner?: string }
  | { type: "reject"; owner?: string }
  | { type: "withdraw"; owner?: string };

export interface TransitionSubject {
  stage: RequestStage;
  livesOnLiveData: boolean;
}

export function isTerminalStage(stage: RequestStage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly RequestStage[]).includes(stage);
}

export function stageLabel(stage: RequestStage): string {
  if (stage === "rejected") return "Rejected";
  if (stage === "withdrawn") return "Withdrawn";
  return LIFECYCLE_STAGES.find((candidate) => candidate.key === stage)?.label ?? stage;
}

export function validateTransition(
  request: TransitionSubject,
  transition: LifecycleTransition,
): void {
  if (isTerminalStage(request.stage)) {
    throw new Error(
      `Invalid lifecycle transition: terminal stage '${request.stage}' cannot transition`,
    );
  }

  if (transition.type === "reject" || transition.type === "withdraw") return;

  const fromIndex = LIFECYCLE_STAGES.findIndex(({ key }) => key === request.stage);
  const toIndex = LIFECYCLE_STAGES.findIndex(({ key }) => key === transition.to);

  if (transition.type === "send-back") {
    if (toIndex >= fromIndex) {
      throw new Error(
        `Invalid lifecycle transition: send-back from '${request.stage}' must target an earlier stage, not '${transition.to}'`,
      );
    }
    return;
  }

  const allowed = FORWARD_TRANSITIONS[request.stage as Exclude<LifecycleStage, "active">];
  if (!allowed.includes(transition.to)) {
    throw new Error(
      `Invalid lifecycle transition: cannot move forward from '${request.stage}' to '${transition.to}'`,
    );
  }
  if (request.stage === "ccb" && transition.to === "provisioning" && request.livesOnLiveData) {
    throw new Error(
      "Invalid lifecycle transition: live-data requests must pass live-data-waiver before provisioning",
    );
  }
}
