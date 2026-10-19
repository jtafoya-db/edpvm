export const MOCK_DATA = {
  "llm-challenger": {
    sectionId: "source-profile",
    sectionLabel: "Source profile",
    suggestions: [
      {
        kind: "expand",
        fieldId: "businessJustification",
        proposedValue:
          "Quantify the current manual review hours and identify the baseline period used for the estimate.",
        rationale: "The stated benefit needs a measurable baseline before EDP can score it.",
        citation: "You estimated a $750K annual benefit from reduced manual review.",
      },
      {
        kind: "challenge",
        fieldId: "safeguards",
        proposedValue:
          "Document how Pub 1075 controls apply to FTI in transit, at rest, and in the target workspace.",
        rationale: "The request identifies FTI but does not yet describe its safeguards path.",
        citation: "You classified the source as SBU (FTI).",
      },
    ],
  },
  "jira-create": {
    ticket: "EDP-1042",
    status: "Created",
    createdAt: "2026-09-18T14:32:00Z",
    url: "https://jira.example.gov/browse/EDP-1042",
  },
  "request-status-tracking": {
    requestId: "REQ-2026-0142",
    overallStatus: "In review",
    currentStage: "EDP architecture review",
    updatedAt: "2026-09-22T16:05:00Z",
    stages: [
      { label: "Submitted", status: "complete" },
      { label: "Domain owner review", status: "complete" },
      { label: "EDP review", status: "active" },
      { label: "Provisioning", status: "pending" },
    ],
  },
} as const;

export type MockCapabilityId = keyof typeof MOCK_DATA;
export type FeatureMockData = (typeof MOCK_DATA)[MockCapabilityId];

export function getMockData(id: string): FeatureMockData | undefined {
  return MOCK_DATA[id as MockCapabilityId];
}
