import type { IntakeInitiativeOwner } from "../../schema/types";
import type { OnboardingIntake } from "./types";

// Shared test answers: every wizard answer an intake carries besides the ones
// the onboarding request keeps on their own (initiative name, business case,
// benefit, levers, datasets, workspace needs), so a whole intake validates as
// the wizard's would (#222).
export const COMPLETE_INTAKE_ANSWERS = {
  sourceSystem: "IMF / Individual Master File",
  domain: "individual-filing",
  sensitivity: "SBU (FTI)",
  pattern: "eftu",
  access: "dbx",
  engModel: "self",
  outcome: "fraud",
  priority: "Mission-critical",
  hoursSaved: 1200,
  sizeGb: 500,
  freq: "Daily",
  complexity: "Moderate",
  users: 40,
  estimated: true,
} as const satisfies Record<string, unknown>;

/** The initiative owner a complete intake names: Myself, filled in by the server from the session (#103). */
export const COMPLETE_INITIATIVE_OWNER = { kind: "self" } as const satisfies IntakeInitiativeOwner;

/**
 * A whole intake that validates as the wizard's would: one dataset with one
 * owner, every required answer, and an initiative owner. Tests override only
 * what they're about, so a newly required intake field is added here once
 * rather than to every test's own intake.
 */
export function completeIntake(overrides: Partial<OnboardingIntake> = {}): OnboardingIntake {
  return {
    initiativeName: "Collections case signals",
    businessCase: "Prioritize balance-due cases across treatment streams.",
    annualBenefit: 1_250_000,
    levers: ["taxgap"],
    datasets: [
      {
        name: "Case signals",
        sourceSystem: "IMF / Individual Master File",
        domain: "individual-filing",
        ingestionMethod: "eftu",
        datasetTag: "case_signals",
        owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
      },
    ],
    workspaceNeeds: { isolation: "shared", teamSize: 4 },
    answers: { ...COMPLETE_INTAKE_ANSWERS },
    initiativeOwner: COMPLETE_INITIATIVE_OWNER,
    ...overrides,
  };
}
