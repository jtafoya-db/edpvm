import { describe, expect, it } from "vitest";
import { intakeAnswers, toOnboardingIntake } from "../onboarding/intake";

describe("toOnboardingIntake — number answers", () => {
  it("leaves an empty optional number out of the answers", () => {
    for (const hoursSaved of [undefined, "", "  "]) {
      const intake = toOnboardingIntake({ annualBenefit: 425000, hoursSaved });
      expect(intake.annualBenefit).toBe(425000);
      expect("hoursSaved" in intake.answers).toBe(false);
      expect(JSON.parse(JSON.stringify(intake.answers))).toEqual({ annualBenefit: 425000 });
    }
  });

  it("keeps a saved number as a number", () => {
    const intake = toOnboardingIntake({ annualBenefit: 425000, hoursSaved: 80 });
    expect(intake.answers["hoursSaved"]).toBe(80);
  });

  it("reads the text typed into number fields as numbers", () => {
    const intake = toOnboardingIntake({
      annualBenefit: "$1,250,000",
      hoursSaved: "1 200",
      teamSize: "6",
      sizeGb: "2,500.5",
      dataName: "Case signals",
    });
    expect(intake.annualBenefit).toBe(1250000);
    expect(intake.workspaceNeeds.teamSize).toBe(6);
    expect(intake.answers).toMatchObject({
      annualBenefit: 1250000,
      hoursSaved: 1200,
      teamSize: 6,
      sizeGb: 2500.5,
      dataName: "Case signals",
    });
  });
});

describe("intakeAnswers — the package a reviewer reads (#229)", () => {
  it("is every answer the provider gave, as the wizard holds them", () => {
    const intake = toOnboardingIntake({
      dataName: "Case signals",
      pattern: "other",
      access: "tableau",
      sizeGb: "750",
      teamSize: "6",
      isolation: "Not sure",
      datasets: [],
    });
    expect(intakeAnswers(intake)).toMatchObject({
      dataName: "Case signals",
      pattern: "other",
      access: "tableau",
      sizeGb: 750,
      teamSize: 6,
      isolation: "Not sure",
    });
  });

  it("reads the fields a resubmission can edit from the request, not the answers at submit", () => {
    const intake = toOnboardingIntake({ isolation: "Not sure", teamSize: 6, datasets: [] });
    intake.workspaceNeeds = {
      isolation: "Yes — it must be isolated from other tenants",
      teamSize: 9,
    };
    intake.datasets = [{ name: "Renamed", domain: "other", datasetTag: "renamed", owners: [] }];
    expect(intakeAnswers(intake)).toMatchObject({
      isolation: "Yes — it must be isolated from other tenants",
      teamSize: 9,
      datasets: [{ name: "Renamed" }],
    });
  });

  it("leaves a field the provider never answered out, so it reads as not answered", () => {
    const intake = toOnboardingIntake({ dataName: "Case signals" });
    const answers = intakeAnswers({ ...intake, answers: {} });
    expect(answers["pattern"]).toBeUndefined();
    expect(answers["dataName"]).toBe("Case signals");
  });
});
