import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { exportOnboardingPackageMarkdown, type OnboardingRequest } from "@/data";
import { completeIntake } from "@/data/onboarding/intake.fixtures";
import { loadSchema } from "@/schema";

const request: OnboardingRequest = {
  id: "ONB-7K3QFD",
  version: 2,
  title: "Collections case signals",
  providerId: "synthetic-provider",
  providerName: "Pat Provider",
  submittedAt: "2026-10-21T14:00:00.000Z",
  stage: "business-roi-review",
  stageEnteredAt: "2026-10-21T14:00:00.000Z",
  intake: (() => {
    const intake = completeIntake();
    const { priority: _retiredPriority, ...answers } = intake.answers;
    return {
      ...intake,
      answers,
      datasets: intake.datasets.map((dataset) => ({
        ...dataset,
        id: "dataset-1",
        owners: dataset.owners.map((owner) => ({ ...owner, id: "owner-1" })),
      })),
    };
  })(),
  openSendBack: null,
  decisions: [
    {
      kind: "submit",
      from: null,
      to: "submitted",
      actorId: "synthetic-provider",
      actorName: "Pat Provider",
      at: "2026-10-21T14:00:00.000Z",
      note: "",
    },
    {
      kind: "forward",
      from: "submitted",
      to: "business-roi-review",
      actorId: "system",
      actorName: "EDP Vending Machine",
      at: "2026-10-21T14:00:01.000Z",
      note: "Ready for review",
    },
  ],
  initiativeOwner: {
    kind: "self",
    name: "Pat Provider",
    email: "pat.provider@example.gov",
    principalId: "synthetic-provider",
    verification: "verified",
  },
  ownerVerification: { "owner-1": "not-verified" },
  ownerMatches: [
    {
      ownerId: "initiative",
      role: "initiative",
      datasetId: null,
      name: "Pat Provider",
      email: "pat.provider@example.gov",
      state: "matched",
      principalId: "synthetic-provider",
      matchedBy: { kind: "self" },
      onboardingEntryId: null,
    },
  ],
  sla: null,
};

describe("Confluence-compatible onboarding package export", () => {
  it("exports the current full package and decision record as portable CommonMark", () => {
    const markdown = exportOnboardingPackageMarkdown(request, {
      domainName: (id) => (id === "individual-filing" ? "Individual Filing" : id),
    });

    expect(markdown).toContain("# Collections case signals");
    expect(markdown).toContain("- **Summary:** Collections case signals");
    expect(markdown).toContain(
      "- **Description:** Prioritize balance-due cases across treatment streams.",
    );
    expect(markdown).toContain("- **Routed teams:** EDP business office");
    expect(markdown).not.toContain("**Priority:**");
    expect(markdown).toContain(
      "> **Provisional Confluence ordering:** Section order will follow the onboarding team's governed template when available.",
    );
    expect(markdown).toContain("## Initiative");
    expect(markdown).toContain(
      "| Initiative point of contact | Pat Provider (pat.provider@example.gov) — Verified: signed-in account |",
    );
    expect(markdown).toContain("## Architecture");
    expect(markdown).toContain("## Delivery support");
    expect(markdown).toContain("## Business case");
    expect(markdown).toContain("## Datasets");
    expect(markdown).toContain("### Dataset 1: Case signals");
    expect(markdown).toContain("| Domain | Individual Filing |");
    expect(markdown).toContain("| Ingestion method | Enterprise File Transfer Utility (EFTU) |");
    expect(markdown).not.toContain("Not answered");
    expect(markdown).not.toContain("synthetic-provider");
    expect(markdown).toContain("| Delivery review | Tenant-built with approved patterns");
    expect(markdown).toContain(
      "| Architecture 1 | IMF / Individual Master File → Enterprise File Transfer Utility (EFTU)",
    );
    expect(markdown).toContain("| Architecture review | Approved patterns only");
    expect(markdown).toContain("| Sizing estimate |");
    expect(markdown).toContain("## Workspace");
    expect(markdown).toContain("## Sizing");
    expect(markdown).toContain("## Attachments");
    expect(markdown).toContain("Attachments cannot be added to an intake package yet.");
    expect(markdown).toContain("## Decision record");
    expect(markdown).toContain("| Forwarded → Business &amp; ROI review");
    expect(markdown).not.toMatch(/<[^>]+>/);
    // Pins every byte of the real-schema export; the readable assertions above explain key rows.
    expect(createHash("sha256").update(markdown).digest("hex")).toBe(
      "8398c1604b5e51eb0ac9f071ccb7173f3fc40b5bb111a161b0f74bce31295481",
    );
    expect(
      exportOnboardingPackageMarkdown(structuredClone(request), {
        domainName: (id) => (id === "individual-filing" ? "Individual Filing" : id),
      }),
    ).toBe(markdown);
  });

  it("matches an independently authored whole-document golden", () => {
    const base = loadSchema();
    const schema = {
      ...base,
      steps: [base.steps.find((step) => step.id === "source")!],
      fields: base.fields.filter((field) => field.step === "source"),
    };
    const markdown = exportOnboardingPackageMarkdown(
      { ...request, intake: { ...request.intake, datasets: [] } },
      { schema },
    );
    expect(markdown).toBe(`# Collections case signals

## Jira-ready fields

- **Summary:** Collections case signals
- **Description:** Prioritize balance-due cases across treatment streams.
- **Routed teams:** EDP business office

> **Provisional Confluence ordering:** Section order will follow the onboarding team's governed template when available.

## Request details

| Field | Value |
| --- | --- |
| Request | ONB-7K3QFD |
| Data provider | Pat Provider |
| Submitted | 2026-10-21T14:00:00.000Z |
| Current stage | Business &amp; ROI review |

## Initiative

| Field | Answer |
| --- | --- |
| Initiative name | Collections case signals |
| Initiative point of contact | Pat Provider (pat.provider@example.gov) — Verified: signed-in account |
| Data sensitivity | SBU (FTI) |

## Attachments

Attachments cannot be added to an intake package yet.

## Decision record

| Decision | By | When | Note |
| --- | --- | --- | --- |
| Submitted → Submitted | Pat Provider | 2026-10-21T14:00:00.000Z |  |
| Forwarded → Business &amp; ROI review | EDP Vending Machine | 2026-10-21T14:00:01.000Z | Ready for review |
`);
  });

  it("escapes table and active Markdown syntax while flattening multiline answers", () => {
    const unsafe = structuredClone(request);
    unsafe.intake.businessCase =
      "First line | measured\nSecond line <review> [link](https://x.test)";
    const markdown = exportOnboardingPackageMarkdown(unsafe);
    expect(markdown).toContain(
      "First line \\| measured Second line &lt;review&gt; \\[link\\](https://x.test)",
    );
    expect(markdown).not.toContain("<review>");
  });
});
