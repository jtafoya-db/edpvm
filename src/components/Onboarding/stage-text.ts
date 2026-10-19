// Non-component helpers for the onboarding screens (#86): stage phrasing in
// running text and the colour family a request row leads with.
import {
  onboardingStageLabel,
  type OnboardingRequest,
  type OnboardingRequestStage,
  type OnboardingSlaStatus,
} from "@/data";
import { TONE, type Tone } from "./styles";

export const SLA_TONE: Record<
  OnboardingSlaStatus["state"],
  { tone: Tone; label: string; icon: string }
> = {
  "on-track": { tone: "success", label: "On track", icon: "check_circle" },
  "due-soon": { tone: "warning", label: "Due soon", icon: "schedule" },
  breached: { tone: "error", label: "Breached", icon: "warning" },
};

/** A stage in running text: "the CCB", "the business & ROI review" (labels keep their acronyms). */
export function stagePhrase(stage: OnboardingRequestStage): string {
  if (stage === "submitted") return "the data provider";
  if (stage === "ccb") return "the CCB";
  if (stage === "business-roi-review") return "the business & ROI review";
  return onboardingStageLabel(stage).toLowerCase();
}

function pick(tone: Tone): { bg: string; fg: string } {
  return { bg: TONE[tone].bg, fg: TONE[tone].fg };
}

/** The colour family and icon a request row leads with. */
export function requestTone(request: OnboardingRequest): { bg: string; fg: string; icon: string } {
  if (request.stage === "rejected" || request.stage === "withdrawn") {
    return { bg: "var(--color-gray-5)", fg: "var(--color-gray-cool-60)", icon: "description" };
  }
  if (request.stage === "standup") return { ...pick("success"), icon: "check_circle" };
  if (request.stage === "submitted") return { ...pick("warning"), icon: "warning" };
  const sla = request.sla ? SLA_TONE[request.sla.state] : SLA_TONE["on-track"];
  return sla.tone === "success"
    ? { bg: "var(--color-blue-5v)", fg: "var(--color-blue-warm-70v)", icon: "schedule" }
    : { ...pick(sla.tone), icon: sla.icon };
}
