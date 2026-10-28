import { describe, expect, it } from "vitest";
import { intakeAnswers, toOnboardingIntake } from "./intake";
import { resubmissionChanges } from "./resubmission";

describe("toOnboardingIntake clarity contract", () => {
  it("stores the workspace choice separately from its rationale", () => {
    const intake = toOnboardingIntake({
      dataName: "Investigation signals",
      useCase: "Find emerging fraud patterns.",
      annualBenefit: 500000,
      levers: ["fraud"],
      datasets: [],
      isolation: "Not sure — ask EDP staff to assess",
      isolationReason: "Investigative methods may reveal how cases are selected.",
      teamSize: 4,
      sensitivity: "SBU (FTI)",
      sizeGb: null,
    });

    expect(intake.annualBenefit).toBe(500000);
    expect(intake.workspaceNeeds.isolation).toBe("Not sure — ask EDP staff to assess");
    expect(intake.answers).toMatchObject({
      sensitivity: "SBU (FTI)",
    });
    expect(intake.answers).toHaveProperty("isolationReason");
    expect(intake.answers).not.toHaveProperty("sizeGb");
  });

  it("does not submit answers for fields the provider cannot see", () => {
    const intake = toOnboardingIntake({
      dataName: "Case signals",
      domain: "other",
      domainDetails: "Cross-domain compliance leads",
      pattern: "other",
      ingestConsultDetails: "Query a partner API each morning",
    });

    expect(intake.answers).not.toHaveProperty("domainDetails");
    expect(intake.answers).not.toHaveProperty("ingestConsultDetails");
  });

  it.each([
    [
      "No — shared workspaces are fine",
      "No — notebooks, code, and dashboard names may be visible in a shared workspace",
    ],
    [
      "Yes — it must be isolated from other tenants",
      "Yes — code, notebook or dashboard names or contents must be hidden",
    ],
    ["Not sure", "Not sure — ask EDP staff to assess"],
  ])("maps the stored isolation value %s to a current option", (stored, shown) => {
    const values = intakeAnswers({
      initiativeName: "Case signals",
      businessCase: "Find emerging fraud patterns.",
      annualBenefit: 500000,
      levers: ["fraud"],
      datasets: [],
      workspaceNeeds: { isolation: stored, teamSize: 4 },
      answers: {},
    });
    expect(values["isolation"]).toBe(shown);
  });

  it.each([
    ["Light", "Light — copy, filter, or rename"],
    ["Moderate", "Moderate — joins and recurring business rules"],
    ["Heavy", "Heavy — many joins, large aggregations, or frequent recomputation"],
    ["Very heavy / ML features", "Machine learning — feature engineering or model workloads"],
  ])("maps the older complexity value %s to the current option", (stored, shown) => {
    const values = intakeAnswers({
      initiativeName: "Case signals",
      businessCase: "Find emerging fraud patterns.",
      annualBenefit: 500000,
      levers: ["fraud"],
      datasets: [],
      workspaceNeeds: { isolation: "Not sure", teamSize: 4 },
      answers: { complexity: stored },
    });

    expect(values["complexity"]).toBe(shown);
  });

  it("keeps a completed sizing estimate across repeated resubmission round trips", () => {
    const original = {
      initiativeName: "Case signals",
      businessCase: "Find emerging fraud patterns.",
      annualBenefit: 500000,
      levers: ["fraud"],
      datasets: [],
      workspaceNeeds: { isolation: "Not sure", teamSize: 4 },
      answers: { estimated: true },
    };

    const once = toOnboardingIntake(intakeAnswers(original));
    const twice = toOnboardingIntake(intakeAnswers(once));

    expect(once.answers["estimated"]).toBe(true);
    expect(twice.answers["estimated"]).toBe(true);
  });

  it("copies older initiative source and domain answers onto datasets that lack them", () => {
    const values = intakeAnswers({
      initiativeName: "Case signals",
      businessCase: "Find emerging fraud patterns.",
      annualBenefit: 500000,
      levers: ["fraud"],
      datasets: [
        {
          id: "ds-1",
          name: "Case signals",
          domain: "",
          ingestionMethod: "eftu",
          datasetTag: "case_signals",
          owners: [],
        },
      ],
      workspaceNeeds: { isolation: "Not sure", teamSize: 4 },
      answers: {
        sourceSystem: "IMF / Individual Master File",
        domain: "individual-filing",
      },
    });

    expect(values["datasets"]).toEqual([
      expect.objectContaining({
        id: "ds-1",
        sourceSystem: "IMF / Individual Master File",
        domain: "individual-filing",
      }),
    ]);
    expect(values).toMatchObject({
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
    });
  });

  it("records both legacy values copied onto a dataset, using the ingestion label", () => {
    const stored = {
      initiativeName: "Case signals",
      businessCase: "Find emerging fraud patterns.",
      annualBenefit: 500000,
      levers: ["fraud"],
      datasets: [
        {
          id: "ds-1",
          name: "Case signals",
          domain: "individual-filing",
          datasetTag: "case_signals",
          owners: [],
        },
      ],
      workspaceNeeds: { isolation: "Not sure — ask EDP staff to assess", teamSize: 4 },
      answers: {
        sourceSystem: "IMF / Individual Master File",
        pattern: "eftu",
      },
    };
    const upgraded = toOnboardingIntake(intakeAnswers(stored));

    expect(resubmissionChanges(stored, upgraded)).toEqual(
      expect.arrayContaining([
        {
          field: "Dataset 1 source system",
          before: "",
          after: "IMF / Individual Master File",
        },
        {
          field: "Dataset 1 ingestion method",
          before: "",
          after: "Enterprise File Transfer Utility (EFTU)",
        },
      ]),
    );
  });
});
