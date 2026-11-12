import {
  computeRoi,
  estimateSizing,
  fmtUsd,
  loadSchema,
  readNumber,
  resolveSelections,
  type FieldDef,
  type IntakeSchema,
} from "../../schema";
import { intakeAnswers } from "./intake";
import { initiativeOwnerText } from "./owners";
import { onboardingStageLabel, REVIEWER_LABEL } from "./lifecycle";
import type { OnboardingDecisionKind, OnboardingRequest } from "./types";

export interface OnboardingMarkdownExportOptions {
  schema?: IntakeSchema;
  domainName?: (id: string) => string;
}

const DECISION_LABEL: Record<OnboardingDecisionKind, string> = {
  submit: "Submitted",
  forward: "Forwarded",
  approve: "Approved",
  "send-back": "Sent back",
  reject: "Rejected",
  withdraw: "Withdrawn",
  resubmit: "Resubmitted",
};

function portable(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/([*_\[\]`#!])/g, "\\$1")
    .trim();
}

function isBlank(answer: unknown): boolean {
  return (
    answer === undefined ||
    answer === null ||
    (typeof answer === "string" && answer.trim() === "") ||
    (Array.isArray(answer) && answer.length === 0)
  );
}

function formatAnswer(
  schema: IntakeSchema,
  field: FieldDef,
  answer: unknown,
  domainName: (id: string) => string,
): string {
  if (isBlank(answer)) return "Not answered";
  if (field.type === "initiative-owner") return initiativeOwnerText(answer as never);
  if (field.type === "number") {
    const number = readNumber(answer);
    if (number === undefined || Number.isNaN(number)) return String(answer);
    return field.numberFormat === "currency"
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(number)
      : number.toLocaleString("en-US");
  }
  if (field.type === "select") {
    const id = String(answer);
    if (field.dynamicOptions === "domains") return domainName(id);
    if (field.optionsFrom) {
      return schema.optionLists[field.optionsFrom].find((option) => option.id === id)?.name ?? id;
    }
    return id;
  }
  if (field.type === "card-select" || field.type === "multi-card") {
    const options = field.optionList ? schema.optionLists[field.optionList] : [];
    const ids = Array.isArray(answer) ? answer.map(String) : [String(answer)];
    return ids.map((id) => options.find((option) => option.id === id)?.name ?? id).join("; ");
  }
  return String(answer);
}

function routedTeams(request: OnboardingRequest): string | undefined {
  if (request.stage === "business-roi-review") return REVIEWER_LABEL["business-office"];
  if (request.stage === "ccb") return REVIEWER_LABEL.ccb;
  if (request.stage === "standup") return "EDP staff";
  return undefined;
}

function tableRow(label: string, value: unknown): string {
  return `| ${portable(label)} | ${portable(value)} |`;
}

function ownerState(request: OnboardingRequest, ownerId: string | undefined): string {
  if (!ownerId) return "";
  const match = request.ownerMatches.find((candidate) => candidate.ownerId === ownerId);
  if (match?.state === "onboarding-requested") return "Not a Databricks user yet";
  if (match?.state === "matched") {
    return match.matchedBy?.kind === "staff"
      ? "Matched by EDP staff, not verified"
      : "Verified: signed-in account";
  }
  if (ownerId === "initiative" && request.initiativeOwner?.verification === "verified") {
    return "Verified: signed-in account";
  }
  return request.ownerVerification[ownerId] === "verified"
    ? "Verified: signed-in account"
    : "Not verified";
}

function orderedFields(schema: IntakeSchema, stepId: string): FieldDef[] {
  const fields = schema.fields.filter((field) => field.step === stepId);
  const step = schema.steps.find((candidate) => candidate.id === stepId);
  const laidOut = (step?.layout ?? []).flat();
  const ordered = laidOut
    .map((id) => fields.find((field) => field.id === id))
    .filter((field): field is FieldDef => field !== undefined);
  return [...ordered, ...fields.filter((field) => !ordered.includes(field))];
}

function derivedRows(
  stepId: string,
  request: OnboardingRequest,
  schema: IntakeSchema,
  domainName: (id: string) => string,
): string[] {
  const answers = intakeAnswers(request.intake);
  if (stepId === "delivery" && !isBlank(answers["engModel"])) {
    const { engDef } = resolveSelections(schema, answers);
    return [
      tableRow(
        "Delivery review",
        engDef.platform
          ? "EDP platform engineering requested; data engineering capacity review is required."
          : "Tenant-built with approved patterns; no platform engineering requested.",
      ),
    ];
  }
  if (stepId === "datasets" && !isBlank(answers["access"])) {
    const { accessDef } = resolveSelections(schema, answers);
    const patterns = request.intake.datasets.map((dataset) =>
      schema.optionLists.ingestPatterns.find((pattern) => pattern.id === dataset.ingestionMethod),
    );
    if (
      request.intake.datasets.length === 0 ||
      patterns.some((pattern) => !pattern) ||
      request.intake.datasets.some((dataset) => !dataset.sourceSystem || !dataset.domain)
    )
      return [];
    const outside = [
      ...patterns.filter((pattern) => pattern && !pattern.approved),
      ...(!accessDef.approved ? [accessDef] : []),
    ];
    return [
      ...request.intake.datasets.map((dataset, index) =>
        tableRow(
          `Architecture ${index + 1}`,
          `${dataset.sourceSystem} → ${patterns[index]!.name} → ${domainName(dataset.domain)} → ${accessDef.name}`,
        ),
      ),
      tableRow(
        "Architecture review",
        outside.length
          ? `Requires an EDP architecture consultation. Outside the approved patterns: ${outside.map((option) => option!.name).join("; ")}.`
          : "Approved patterns only; no architecture consultation is needed.",
      ),
    ];
  }
  if (stepId === "sizing") {
    const ids = ["sizeGb", "freq", "complexity", "users"];
    if (ids.some((id) => isBlank(answers[id]))) return [];
    const sizing = estimateSizing(schema, {
      sizeGb: readNumber(answers["sizeGb"]) || 0,
      freq: String(answers["freq"]),
      complexity: String(answers["complexity"]),
      users: readNumber(answers["users"]) || 0,
    });
    const roi = computeRoi(readNumber(answers["annualBenefit"]) || 0, sizing.annualCost);
    const payback =
      typeof roi.paybackMonths === "number"
        ? `pays back in ${roi.paybackMonths} month${roi.paybackMonths === 1 ? "" : "s"}`
        : "no payback estimate";
    return [
      tableRow(
        "Sizing estimate",
        `${sizing.tier} · ${sizing.storageTb} TB managed storage · ${sizing.dbu.toLocaleString("en-US")} DBU/month · ${fmtUsd(sizing.monthlyCost)}/month, ${fmtUsd(sizing.annualCost)}/year · ROI ${roi.ratio}x, ${payback}`,
      ),
    ];
  }
  return [];
}

/** Export the current reviewer-visible intake package without mutating or publishing it. */
export function exportOnboardingPackageMarkdown(
  request: OnboardingRequest,
  options: OnboardingMarkdownExportOptions = {},
): string {
  const schema = options.schema ?? loadSchema();
  const domainName = options.domainName ?? ((id: string) => id);
  const answers = intakeAnswers(request.intake);
  const priority =
    typeof request.intake.answers["priority"] === "string"
      ? request.intake.answers["priority"].trim()
      : "";
  const route = routedTeams(request);
  const lines = [
    `# ${portable(request.title)}`,
    "",
    "## Jira-ready fields",
    "",
    `- **Summary:** ${portable(request.title)}`,
    ...(!isBlank(request.intake.businessCase)
      ? [`- **Description:** ${portable(request.intake.businessCase)}`]
      : []),
    ...(priority ? [`- **Priority:** ${portable(priority)}`] : []),
    ...(route ? [`- **Routed teams:** ${portable(route)}`] : []),
    "",
    "> **Provisional Confluence ordering:** Section order will follow the onboarding team's governed template when available.",
    "",
    "## Request details",
    "",
    "| Field | Value |",
    "| --- | --- |",
    tableRow("Request", request.id),
    tableRow("Data provider", request.providerName),
    tableRow("Submitted", request.submittedAt),
    tableRow("Current stage", onboardingStageLabel(request.stage)),
  ];

  for (const step of schema.steps.filter((candidate) => candidate.id !== "review")) {
    const fields = orderedFields(schema, step.id);
    if (fields.length === 0) continue;
    lines.push("", `## ${portable(step.label)}`, "", "| Field | Answer |", "| --- | --- |");
    for (const field of fields) {
      if (field.type === "dataset-list") {
        lines.push(
          tableRow(
            field.label,
            `${request.intake.datasets.length} dataset${request.intake.datasets.length === 1 ? "" : "s"}`,
          ),
        );
      } else if (!isBlank(answers[field.id])) {
        const answer =
          field.type === "initiative-owner" && request.initiativeOwner
            ? `${request.initiativeOwner.name} (${request.initiativeOwner.email})${ownerState(request, "initiative") ? ` — ${ownerState(request, "initiative")}` : ""}`
            : formatAnswer(schema, field, answers[field.id], domainName);
        lines.push(tableRow(field.label, answer));
      }
    }
    if (
      step.id === "source" &&
      !isBlank(answers["steward"]) &&
      !fields.some((field) => field.id === "steward")
    ) {
      lines.push(tableRow("Accountable data steward (older requests)", answers["steward"]));
    }
    for (const [index, dataset] of request.intake.datasets.entries()) {
      if (!fields.some((field) => field.type === "dataset-list")) break;
      const ingestion = schema.optionLists.ingestPatterns.find(
        (pattern) => pattern.id === dataset.ingestionMethod,
      );
      lines.push(
        "",
        `### Dataset ${index + 1}: ${portable(dataset.name)}`,
        "",
        "| Field | Answer |",
        "| --- | --- |",
        ...(dataset.sourceSystem ? [tableRow("Source system", dataset.sourceSystem)] : []),
        ...(dataset.domain ? [tableRow("Domain", domainName(dataset.domain))] : []),
        ...(dataset.ingestionMethod
          ? [tableRow("Ingestion method", ingestion?.name ?? dataset.ingestionMethod)]
          : []),
        ...(dataset.ingestionDetails
          ? [tableRow("Ingestion details", dataset.ingestionDetails)]
          : []),
        ...(dataset.datasetTag ? [tableRow("Dataset tag", dataset.datasetTag)] : []),
        ...(dataset.owners.length
          ? [
              tableRow(
                "Dataset owners",
                dataset.owners
                  .map((owner) => {
                    const state = ownerState(request, owner.id);
                    return `${owner.name} (${owner.email})${state ? ` — ${state}` : ""}`;
                  })
                  .join("; "),
              ),
            ]
          : []),
      );
    }
    const reviewOutputs = derivedRows(step.id, request, schema, domainName);
    if (reviewOutputs.length) {
      lines.push(
        "",
        "### Review outputs",
        "",
        "| Review | Result |",
        "| --- | --- |",
        ...reviewOutputs,
      );
    }
  }

  lines.push(
    "",
    "## Attachments",
    "",
    "Attachments cannot be added to an intake package yet.",
    "",
    "## Decision record",
    "",
    "| Decision | By | When | Note |",
    "| --- | --- | --- | --- |",
    ...request.decisions.map(
      (decision) =>
        `| ${portable(`${DECISION_LABEL[decision.kind]} → ${onboardingStageLabel(decision.to)}`)} | ${portable(decision.actorName)} | ${portable(decision.at)} | ${portable(decision.note)} |`,
    ),
    "",
  );
  let resubmissionNumber = 0;
  for (const decision of request.decisions) {
    if (!decision.resubmission) continue;
    resubmissionNumber += 1;
    lines.push(
      `### Resubmission ${resubmissionNumber}`,
      "",
      portable(decision.resubmission.answer),
      "",
      ...(decision.resubmission.changes.length
        ? [
            "| Changed field | Before | After |",
            "| --- | --- | --- |",
            ...decision.resubmission.changes.map(
              (change) =>
                `| ${portable(change.field)} | ${portable(change.before)} | ${portable(change.after)} |`,
            ),
            "",
          ]
        : []),
    );
  }
  return lines.join("\n");
}
