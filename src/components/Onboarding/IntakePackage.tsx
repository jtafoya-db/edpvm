// The whole intake package (#229): every answer the data provider gave in the
// onboarding wizard, step by step under the wizard's own step names and field
// labels, for the business & ROI reviewer, the CCB and the provider. It is
// driven by the IntakeSchema, so a field added to the wizard shows here too.

import React from "react";

import {
  datasetChangeField,
  intakeAnswers,
  initiativeOwnerText,
  intakeChangeField,
  ownerChangeField,
  INITIATIVE_OWNER_ID,
  type InitiativeOwner,
  type OnboardingIntakeChange,
  type OnboardingOwnerMatch,
  type OwnerVerification,
  type OnboardingRequest,
  useCatalog,
} from "@/data";
import { FeatureGate } from "@/features/FeatureGate";
import {
  computeRoi,
  estimateSizing,
  fmtUsd,
  OTHER_DOMAIN,
  loadSchema,
  readNumber,
  resolveSelections,
  type FieldDef,
  type IntakeDatasetInput,
  type IntakeSchema,
  type IntakeState,
  type StepDef,
} from "@/schema";
import { ArchDiagram } from "../SchemaForm/atoms";
import { useChrome } from "./chrome";
import { OwnerMatchMark } from "./OwnerMatching";
import { Mono } from "./shared";
import { TONE, banner, detailLabel, linkBtn } from "./styles";

const SCHEMA = loadSchema();

const NOT_ANSWERED = "Not answered";

/** A domain's name from the catalog, for a domain id in an intake answer. */
function useDomainName(): (id: string) => string {
  const catalog = useCatalog();
  return (id) => {
    if (id === OTHER_DOMAIN) return "Other";
    return catalog.data?.domains.find((d) => d.id === id)?.name ?? id;
  };
}

const body: React.CSSProperties = {
  fontSize: "var(--font-size-2xs)",
  color: "var(--color-gray-cool-70)",
  lineHeight: 1.55,
  margin: 0,
};

const term: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  color: "var(--text-default)",
};

const value: React.CSSProperties = { ...body, color: "var(--text-default)", margin: 0 };

const unanswered: React.CSSProperties = {
  ...body,
  fontStyle: "italic",
  color: "var(--text-muted)",
};

const rowGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(160px, 1fr) 2fr",
  gap: "4px 16px",
  padding: "8px 0",
  borderBottom: "1px solid var(--border-default)",
};

/** Whether an answer is blank: what the wizard shows as an empty field. */
function isBlank(answer: unknown): boolean {
  if (answer === undefined || answer === null) return true;
  if (typeof answer === "string") return answer.trim() === "";
  if (Array.isArray(answer)) return answer.length === 0;
  return false;
}

/**
 * Answers the wizard no longer asks for, shown read-only on the requests that
 * have one, under the step that asked and a label saying so. The accountable
 * data steward went when the initiative owner came in (#103).
 */
const OLDER_ANSWERS: ReadonlyArray<{ id: string; step: string; label: string }> = [
  { id: "steward", step: "source", label: "Accountable data steward (older requests)" },
];

/** The fields of a step in the order the wizard lays them out, then any the layout leaves out. */
function stepFields(schema: IntakeSchema, step: StepDef): FieldDef[] {
  const own = schema.fields.filter((field) => field.step === step.id);
  const laidOut = (step.layout ?? []).flat();
  const ordered = laidOut
    .map((id) => own.find((field) => field.id === id))
    .filter((field): field is FieldDef => field !== undefined);
  return [...ordered, ...own.filter((field) => !ordered.includes(field))];
}

/**
 * An answer as the wizard's review step shows it: option labels, not ids;
 * money as the wizard rounds it; numbers with separators. A value no longer
 * among the options shows as given rather than being dropped.
 */
function formatAnswer(
  schema: IntakeSchema,
  field: FieldDef,
  answer: unknown,
  domainName: (id: string) => string,
): string {
  if (isBlank(answer)) return NOT_ANSWERED;
  switch (field.type) {
    case "number": {
      const n = readNumber(answer);
      if (n === undefined || Number.isNaN(n)) return String(answer);
      return field.numberFormat === "currency" ? fmtUsd(n) : n.toLocaleString("en-US");
    }
    case "select": {
      const text = String(answer);
      if (field.dynamicOptions === "domains") return domainName(text);
      if (field.optionsFrom) {
        return schema.optionLists[field.optionsFrom].find((o) => o.id === text)?.name ?? text;
      }
      return text;
    }
    case "card-select":
    case "multi-card": {
      const list: Array<{ id: string; name: string }> = field.optionList
        ? schema.optionLists[field.optionList]
        : [];
      const ids = Array.isArray(answer) ? answer.map(String) : [String(answer)];
      return ids.map((id) => list.find((o) => o.id === id)?.name ?? id).join("; ");
    }
    default:
      return String(answer).trim();
  }
}

/** Marks an answer the provider changed in their resubmission, saying what it was. */
function ChangedMark({ before }: { before: string }) {
  return (
    <ResubmissionMark>Changed in the resubmission, was “{before || "blank"}”</ResubmissionMark>
  );
}

/** The resubmission's mark on an answer, a dataset or an owner contact. */
function ResubmissionMark({ children }: { children: React.ReactNode }) {
  const { Icon } = useChrome();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        marginLeft: 8,
        padding: "1px 8px",
        borderRadius: "var(--radius-pill)",
        background: TONE.warning.bg,
        border: `1px solid ${TONE.warning.border}`,
        color: TONE.warning.fg,
        fontSize: "var(--font-size-3xs)",
        fontWeight: 700,
        // It sits in labels styled as uppercase eyebrows too; it reads as a sentence.
        textTransform: "none",
        letterSpacing: "normal",
      }}
    >
      <Icon name="edit" size={14} color={TONE.warning.fg} />
      {children}
    </span>
  );
}

/** An owner's match (#103), by owner ID (`initiative` for the initiative owner); none on a draft. */
type MatchOf = (ownerId: string | undefined) => OnboardingOwnerMatch | undefined;

/** One question and its answer. */
function AnswerRow({
  label,
  answer,
  change,
  fieldId,
}: {
  label: string;
  answer: React.ReactNode;
  change?: OnboardingIntakeChange | undefined;
  fieldId?: string;
}) {
  const blank = answer === NOT_ANSWERED;
  return (
    <div style={rowGrid} data-intake-field={fieldId}>
      <dt style={term}>{label}</dt>
      <dd style={{ margin: 0 }}>
        <span style={blank ? unanswered : value}>{answer}</span>
        {change ? <ChangedMark before={change.before} /> : null}
      </dd>
    </div>
  );
}

/** Every dataset with its domain, tag and owners, each part marked if the resubmission changed it. */
function DatasetsAnswer({
  field,
  datasets,
  changes,
  domainName,
  ownerVerification,
  matchOf,
}: {
  field: FieldDef;
  datasets: IntakeDatasetInput[];
  changes: readonly OnboardingIntakeChange[];
  domainName: (id: string) => string;
  ownerVerification: Readonly<Record<string, OwnerVerification>> | undefined;
  matchOf: MatchOf;
}) {
  const changeOf = (name: string) => changes.find((change) => change.field === name);
  // Removed records aren't in the request any more: list them where they were.
  const removedDatasets = changes.filter(
    (change) => change.kind === "removed" && /^Dataset \d+ removed$/.test(change.field),
  );
  const removedOwners = (i: number) =>
    changes.filter(
      (change) => change.kind === "removed" && change.field.startsWith(`Dataset ${i + 1} owner `),
    );
  const removedList = removedDatasets.length ? (
    <div
      style={{
        border: `1px dashed ${TONE.warning.border}`,
        borderRadius: "var(--radius-md)",
        padding: "8px 14px",
      }}
    >
      <div style={detailLabel}>Removed in the resubmission</div>
      <ul style={{ ...body, margin: "6px 0 0", paddingLeft: 18 }}>
        {removedDatasets.map((change) => (
          <li key={change.field}>
            <del>{change.before}</del>
          </li>
        ))}
      </ul>
    </div>
  ) : null;
  if (datasets.length === 0) {
    return (
      <>
        <AnswerRow label={field.label} answer={NOT_ANSWERED} fieldId={field.id} />
        {removedList}
      </>
    );
  }
  const domainChange = (name: string) => {
    const change = changeOf(name);
    return change ? { ...change, before: change.before && domainName(change.before) } : undefined;
  };
  return (
    <div data-intake-field={field.id} style={{ display: "grid", gap: 12, paddingTop: 8 }}>
      {datasets.map((dataset, i) => (
        <div
          key={i}
          style={{
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: "4px 14px 8px",
          }}
        >
          <div style={{ ...detailLabel, marginTop: 8 }}>
            {field.label}: {i + 1} of {datasets.length}
            {changeOf(datasetChangeField(i, "added")) ? (
              <ResubmissionMark>Added in the resubmission</ResubmissionMark>
            ) : null}
          </div>
          <dl style={{ margin: 0 }}>
            <AnswerRow
              label="Dataset name"
              answer={dataset.name || NOT_ANSWERED}
              change={changeOf(datasetChangeField(i, "name"))}
            />
            <AnswerRow
              label="Source system"
              answer={dataset.sourceSystem || NOT_ANSWERED}
              change={changeOf(datasetChangeField(i, "source system"))}
            />
            <AnswerRow
              label="Domain"
              answer={dataset.domain ? domainName(dataset.domain) : NOT_ANSWERED}
              change={domainChange(datasetChangeField(i, "domain"))}
            />
            <AnswerRow
              label="Ingestion method"
              answer={
                ingestionPatternLabel(dataset.ingestionMethod) ||
                dataset.ingestionMethod ||
                NOT_ANSWERED
              }
            />
            {dataset.ingestionDetails ? (
              <AnswerRow label="Proposed ingestion approach" answer={dataset.ingestionDetails} />
            ) : null}
            <AnswerRow
              label="Dataset tag"
              answer={dataset.datasetTag ? <Mono>{dataset.datasetTag}</Mono> : NOT_ANSWERED}
              change={changeOf(datasetChangeField(i, "dataset tag"))}
            />
            {dataset.owners.length === 0 ? (
              <AnswerRow label="Dataset owner" answer={NOT_ANSWERED} />
            ) : (
              dataset.owners.map((owner, j) => {
                const change =
                  changeOf(ownerChangeField(i, j, "name")) ??
                  changeOf(ownerChangeField(i, j, "email"));
                const added = changeOf(ownerChangeField(i, j, "added"));
                return (
                  <AnswerRow
                    key={j}
                    label={`Dataset owner ${j + 1}`}
                    answer={
                      <>
                        {`${owner.name} (${owner.email})`}
                        {owner.id && (matchOf(owner.id) || ownerVerification?.[owner.id]) ? (
                          <OwnerMatchMark
                            match={matchOf(owner.id)}
                            verification={ownerVerification?.[owner.id]}
                          />
                        ) : null}
                        {added ? (
                          <ResubmissionMark>Added in the resubmission</ResubmissionMark>
                        ) : null}
                      </>
                    }
                    change={change}
                  />
                );
              })
            )}
            {removedOwners(i).map((change) => (
              <AnswerRow
                key={change.field}
                label="Removed owner"
                answer={
                  <>
                    <del>{change.before}</del>
                    <ResubmissionMark>Removed in the resubmission</ResubmissionMark>
                  </>
                }
              />
            ))}
          </dl>
        </div>
      ))}
      {removedList}
    </div>
  );
}

function ingestionPatternLabel(id: string | undefined): string {
  if (!id) return "";
  return SCHEMA.optionLists.ingestPatterns.find((pattern) => pattern.id === id)?.name ?? id;
}

/** What a step's widgets tell a reviewer, worked out from the answers as the wizard does. */
type PackageWidget = React.ComponentType<{
  schema: IntakeSchema;
  answers: IntakeState;
  domainName: (id: string) => string;
}>;

function Flag({
  tone,
  children,
}: {
  tone: "warning" | "success" | "info";
  children: React.ReactNode;
}) {
  const { Icon } = useChrome();
  return (
    <div style={{ ...banner(tone), marginTop: 10 }}>
      <Icon name={TONE[tone].icon} size={18} color={TONE[tone].fg} />
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

const ArchitectureDiagram: PackageWidget = ({ schema, answers, domainName }) => {
  const { Icon } = useChrome();
  if (isBlank(answers["access"])) return null;
  const { accessDef } = resolveSelections(schema, answers);
  const datasets = Array.isArray(answers["datasets"])
    ? (answers["datasets"] as IntakeDatasetInput[])
    : [];
  const complete =
    datasets.length > 0 &&
    datasets.every((dataset) => dataset.sourceSystem?.trim() && dataset.ingestionMethod?.trim());
  if (!complete)
    return (
      <p style={body}>
        The architecture diagram appears once each dataset has a source system and ingestion method.
      </p>
    );
  return (
    <div style={{ marginTop: 12 }}>
      <div style={detailLabel}>Architecture diagram</div>
      {datasets.map((dataset) => {
        const ingest = schema.optionLists.ingestPatterns.find(
          (pattern) => pattern.id === dataset.ingestionMethod,
        );
        if (!ingest) return null;
        return (
          <div key={dataset.id ?? dataset.datasetTag} style={{ marginTop: 12 }}>
            <ArchDiagram
              source={dataset.sourceSystem!}
              ingest={ingest}
              domainName={dataset.domain ? domainName(dataset.domain) : NOT_ANSWERED}
              access={accessDef}
              Icon={Icon}
            />
          </div>
        );
      })}
    </div>
  );
};

/** The wizard's architecture note: whether the design needs an EDP architecture consultation. */
const ArchitectureConsultation: PackageWidget = ({ schema, answers }) => {
  if (isBlank(answers["access"])) return null;
  const { accessDef } = resolveSelections(schema, answers);
  const datasets = Array.isArray(answers["datasets"])
    ? (answers["datasets"] as IntakeDatasetInput[])
    : [];
  if (
    !datasets.length ||
    datasets.some((dataset) => !dataset.sourceSystem?.trim() || !dataset.ingestionMethod?.trim())
  )
    return null;
  const ingestion = datasets.flatMap((dataset) => {
    const pattern = schema.optionLists.ingestPatterns.find(
      (candidate) => candidate.id === dataset.ingestionMethod,
    );
    return pattern && !pattern.approved ? [pattern] : [];
  });
  const outside = [...ingestion, ...(!accessDef.approved ? [accessDef] : [])];
  const needsConsult = outside.length > 0;
  if (!needsConsult) {
    return (
      <Flag tone="success">Approved patterns only, so no architecture consultation is needed.</Flag>
    );
  }
  return (
    <Flag tone="warning">
      <strong style={{ color: "var(--text-default)" }}>
        Requires an EDP architecture consultation.
      </strong>{" "}
      Outside the approved patterns: {outside.map((option) => option.name).join("; ")}.
    </Flag>
  );
};

/** The wizard's delivery note: whether EDP platform engineering is requested. */
const DeliveryEngagement: PackageWidget = ({ schema, answers }) => {
  if (isBlank(answers["engModel"])) return null;
  const { engDef } = resolveSelections(schema, answers);
  return engDef.platform ? (
    <Flag tone="info">
      EDP platform engineering requested, so a data engineering capacity review is part of the
      approval path.
    </Flag>
  ) : (
    <Flag tone="success">Tenant-built with the approved patterns; no platform engineering.</Flag>
  );
};

/** The wizard's sizing estimate, worked out from the sizing answers the same way. */
const SizingEstimate: PackageWidget = ({ schema, answers }) => {
  const ids = ["sizeGb", "freq", "complexity", "users"];
  if (ids.some((id) => isBlank(answers[id]))) return null;
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
  return (
    <dl style={{ margin: 0 }}>
      <AnswerRow
        label="Sizing estimate"
        answer={`${sizing.tier} · ${sizing.storageTb} TB managed storage · ${sizing.dbu.toLocaleString("en-US")} DBU/month · ${fmtUsd(sizing.monthlyCost)}/month, ${fmtUsd(sizing.annualCost)}/year · ROI ${roi.ratio}x, ${payback}`}
      />
    </dl>
  );
};

/** The wizard widgets that carry something a reviewer needs, by their layout id. */
const PACKAGE_WIDGETS: Record<string, PackageWidget> = {
  archDiagram: ArchitectureDiagram,
  architectureNote: ArchitectureConsultation,
  deliveryNote: DeliveryEngagement,
  sizingEstimator: SizingEstimate,
};

/** The names the change record gives a field's changes, so they can be marked where it shows. */
function changeNamesFor(field: FieldDef): (name: string) => boolean {
  if (field.type === "dataset-list") return (name) => /^Dataset \d+ /.test(name);
  const own = intakeChangeField(field);
  return (name) => name === own;
}

/** One wizard step's answers and what its widgets show. */
function StepAnswers({
  schema,
  step,
  answers,
  changes,
  domainName,
  initiativeOwner,
  ownerVerification,
  matchOf,
}: {
  schema: IntakeSchema;
  step: StepDef;
  answers: IntakeState;
  changes: readonly OnboardingIntakeChange[];
  domainName: (id: string) => string;
  initiativeOwner: InitiativeOwner | null | undefined;
  ownerVerification: Readonly<Record<string, OwnerVerification>> | undefined;
  matchOf: MatchOf;
}) {
  const changeOf = (name: string) => changes.find((change) => change.field === name);
  const fields = stepFields(schema, step);
  const layout = (step.layout ?? []).flat();
  const widgets = layout.filter((id) => PACKAGE_WIDGETS[id]);
  const plain = fields.filter((field) => field.type !== "dataset-list");
  const older = OLDER_ANSWERS.filter(
    (answer) =>
      answer.step === step.id &&
      !fields.some((field) => field.id === answer.id) &&
      !isBlank(answers[answer.id]),
  );
  const lists = fields.filter((field) => field.type === "dataset-list");
  return (
    <div>
      {plain.length || older.length ? (
        <dl style={{ margin: 0 }}>
          {plain.map((field) => {
            const change = changeOf(intakeChangeField(field));
            if (field.type === "initiative-owner") {
              return (
                <AnswerRow
                  key={field.id}
                  fieldId={field.id}
                  label={field.label}
                  answer={
                    initiativeOwner ? (
                      <>
                        {`${initiativeOwner.name} (${initiativeOwner.email})`}
                        <OwnerMatchMark
                          match={matchOf(INITIATIVE_OWNER_ID)}
                          verification={initiativeOwner.verification}
                        />
                      </>
                    ) : (
                      // Not stored yet (a draft package): the answer as given, unverified or not.
                      initiativeOwnerText(
                        answers[field.id] as Parameters<typeof initiativeOwnerText>[0],
                      ) || NOT_ANSWERED
                    )
                  }
                  change={change}
                />
              );
            }
            return (
              <AnswerRow
                key={field.id}
                fieldId={field.id}
                label={field.label}
                answer={formatAnswer(schema, field, answers[field.id], domainName)}
                // A domain is stored by id; name it as the answer is.
                change={
                  change && field.dynamicOptions === "domains" && change.before
                    ? { ...change, before: domainName(change.before) }
                    : change
                }
              />
            );
          })}
          {older.map((answer) => (
            <AnswerRow
              key={answer.id}
              fieldId={answer.id}
              label={answer.label}
              answer={String(answers[answer.id]).trim()}
            />
          ))}
        </dl>
      ) : null}
      {lists.map((field) => (
        <DatasetsAnswer
          key={field.id}
          field={field}
          datasets={
            Array.isArray(answers[field.id]) ? (answers[field.id] as IntakeDatasetInput[]) : []
          }
          changes={changes}
          domainName={domainName}
          ownerVerification={ownerVerification}
          matchOf={matchOf}
        />
      ))}
      {widgets.map((id) => {
        const Widget = PACKAGE_WIDGETS[id]!;
        return <Widget key={id} schema={schema} answers={answers} domainName={domainName} />;
      })}
    </div>
  );
}

/**
 * The full intake package, one collapsible section per wizard step. `changes`
 * are the fields the provider's resubmission changed (#227): each is marked
 * where it shows, and its step opens on its own.
 */
export function IntakePackage({
  request,
  changes = [],
  schema = SCHEMA,
}: {
  request: Pick<OnboardingRequest, "id" | "intake"> &
    Partial<Pick<OnboardingRequest, "initiativeOwner" | "ownerVerification" | "ownerMatches">>;
  changes?: readonly OnboardingIntakeChange[] | undefined;
  schema?: IntakeSchema;
}) {
  const { Accordion } = useChrome();
  const domainName = useDomainName();
  const answers = intakeAnswers(request.intake);
  const steps = schema.steps.filter((step) => schema.fields.some((f) => f.step === step.id));
  const sectionId = (step: StepDef) => `${request.id}-package-${step.id}`;
  const changedIn = (step: StepDef) =>
    stepFields(schema, step).some((field) => changes.some((c) => changeNamesFor(field)(c.field)));
  const changedSteps = steps.filter(changedIn).map(sectionId);
  // null: as first shown (changed steps open); otherwise every step open or closed.
  const [allOpen, setAllOpen] = React.useState<boolean | null>(null);
  const headingId = `${request.id}-package`;
  const matchOf: MatchOf = (ownerId) =>
    ownerId ? request.ownerMatches?.find((owner) => owner.ownerId === ownerId) : undefined;

  return (
    <section aria-labelledby={headingId} style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h3
          id={headingId}
          style={{
            margin: 0,
            fontSize: "var(--font-size-2xs)",
            fontWeight: 700,
            color: "var(--text-default)",
          }}
        >
          Intake package
        </h3>
        <button type="button" style={linkBtn} onClick={() => setAllOpen(!allOpen)}>
          {allOpen ? "Close all steps" : "Open all steps"}
        </button>
      </div>
      <p style={body}>
        Every answer the data provider gave in the onboarding wizard, by wizard step.
        {changes.length ? " Steps with answers changed in the resubmission are open." : ""}
      </p>
      <Accordion
        key={String(allOpen)}
        multiselectable
        defaultOpen={allOpen === null ? changedSteps : allOpen ? steps.map(sectionId) : []}
        items={steps.map((step) => {
          const fields = stepFields(schema, step);
          const answered = fields.filter((field) => !isBlank(answers[field.id])).length;
          return {
            id: sectionId(step),
            title: (
              <>
                {step.label}{" "}
                <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
                  · {answered} of {fields.length} answered
                  {changedIn(step) ? " · changed in the resubmission" : ""}
                </span>
              </>
            ),
            content: (
              <StepAnswers
                schema={schema}
                step={step}
                answers={answers}
                changes={changes}
                domainName={domainName}
                initiativeOwner={request.initiativeOwner}
                ownerVerification={request.ownerVerification}
                matchOf={matchOf}
              />
            ),
          };
        })}
      />
      <section aria-labelledby={`${headingId}-attachments`} style={{ display: "grid", gap: 6 }}>
        <h4
          id={`${headingId}-attachments`}
          style={{ margin: 0, fontSize: "var(--font-size-2xs)", fontWeight: 700 }}
        >
          Attachments
        </h4>
        <FeatureGate id="intake-attachments" presentation="notice" />
      </section>
    </section>
  );
}
