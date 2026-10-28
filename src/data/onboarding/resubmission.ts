/**
 * What a resubmission changed (#221), worked out the same way by both
 * backends so the reviewer the request returns to sees what's new since the
 * send-back, and the newest response a reviewer is reading. A resubmission
 * can edit the whole intake and add or remove datasets and owner contacts
 * (#222); the rules for that (which record IDs a browser may name, how the
 * whole intake is re-validated, what the decision log says) live here too.
 */
import { findDatasetTagProblem, loadSchema, readNumber, validateStep } from "../../schema/index.ts";
import type { FieldDef, IntakeSchema } from "../../schema/types.ts";
import { routedDomainIds } from "../domain-owners.ts";
import { intakeAnswers, withoutIds } from "./intake.ts";
import { initiativeOwnerText, normalizeInitiativeOwner } from "./owners.ts";
import type {
  DatasetOwnerContact,
  InitiativeOwner,
  IntakeDataset,
  OnboardingDecision,
  OnboardingIntake,
  OnboardingIntakeChange,
  OnboardingRequest,
  OnboardingResubmissionRecord,
  OnboardingReviewStage,
} from "./types.ts";

/** The change-record name of a dataset's own field, or of the whole dataset: "Dataset 1 dataset tag", "Dataset 3 added". */
export function datasetChangeField(
  index: number,
  part:
    | "name"
    | "source system"
    | "domain"
    | "ingestion method"
    | "ingestion details"
    | "dataset tag"
    | "added"
    | "removed",
): string {
  return `Dataset ${index + 1} ${part}`;
}

/** The change-record name of a dataset owner's field, or of the whole contact: "Dataset 1 owner 2 email". */
export function ownerChangeField(
  index: number,
  owner: number,
  part: "name" | "email" | "added" | "removed",
): string {
  return `Dataset ${index + 1} owner ${owner + 1} ${part}`;
}

/** The change-record names of intake fields named other than by their wizard label, by schema field id. */
export const INTAKE_CHANGE_FIELD = {
  isolation: "Workspace isolation",
  teamSize: "Team size",
} as const;

/** The change-record name of a wizard field that isn't the dataset list. */
export function intakeChangeField(field: Pick<FieldDef, "id" | "label">): string {
  return (INTAKE_CHANGE_FIELD as Record<string, string>)[field.id] ?? field.label;
}

/** A refusal both backends raise, each with its own error type. */
export interface IntakeProblem {
  code: string;
  message: string;
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function email(value: unknown): string {
  return trim(value).toLowerCase();
}

/** The intake as the store keeps it: text trimmed, owner emails lower-cased, record IDs kept. */
export function normalizeIntake(intake: OnboardingIntake): OnboardingIntake {
  const owner = normalizeInitiativeOwner(intake.initiativeOwner);
  return {
    initiativeName: trim(intake.initiativeName),
    businessCase: trim(intake.businessCase),
    annualBenefit: intake.annualBenefit,
    levers: [...intake.levers],
    datasets: intake.datasets.map((dataset) => ({
      ...(dataset.id ? { id: dataset.id } : {}),
      name: trim(dataset.name),
      sourceSystem: trim(dataset.sourceSystem),
      domain: trim(dataset.domain),
      ...(dataset.ingestionMethod !== undefined
        ? { ingestionMethod: trim(dataset.ingestionMethod) }
        : {}),
      ...(dataset.ingestionDetails !== undefined
        ? { ingestionDetails: trim(dataset.ingestionDetails) }
        : {}),
      datasetTag: trim(dataset.datasetTag),
      owners: dataset.owners.map((owner) => ({
        ...(owner.id ? { id: owner.id } : {}),
        ...(owner.self === true ? { self: true as const } : {}),
        name: trim(owner.name),
        email: email(owner.email),
      })),
    })),
    workspaceNeeds: {
      isolation: trim(intake.workspaceNeeds.isolation),
      teamSize: intake.workspaceNeeds.teamSize,
    },
    ...(owner ? { initiativeOwner: owner } : {}),
    answers: structuredClone(
      "datasets" in intake.answers
        ? { ...intake.answers, datasets: withoutIds(intake.answers["datasets"]) }
        : intake.answers,
    ),
  };
}

/**
 * Answers the intake no longer asks for (#103): an older request keeps its
 * own, read-only, and the browser can neither set one nor change it. The
 * accountable data steward went when the initiative owner came in.
 */
export const RETIRED_ANSWERS: readonly string[] = ["steward", "priority"];

/** A new request's answers, without any retired answer the browser sent. */
export function submittedAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).filter(([id]) => !RETIRED_ANSWERS.includes(id)),
  );
}

/** A resubmission's answers: the browser's, with each retired answer as the request stored it. */
export function resubmittedAnswers(
  sent: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...submittedAnswers(sent),
    ...Object.fromEntries(
      RETIRED_ANSWERS.filter((id) => stored[id] !== undefined).map((id) => [id, stored[id]]),
    ),
  };
}

/** A new request names no record IDs: the server gives every dataset and owner contact its own. */
export function findSubmittedIdProblem(intake: OnboardingIntake): IntakeProblem | null {
  const named = intake.datasets.some(
    (dataset) => dataset.id !== undefined || dataset.owners.some((owner) => owner.id !== undefined),
  );
  return named
    ? {
        code: "invalid-intake",
        message:
          "A new onboarding request can't name dataset or owner record IDs; they're given when it's saved.",
      }
    : null;
}

/**
 * Whether a resubmitted intake names only record IDs the stored request has:
 * a dataset ID must be one of its datasets, an owner ID one of that same
 * dataset's owner contacts, and none twice. Anything else would let the
 * browser pick a row's ID, so it's refused before any write.
 */
export function findResubmittedIdProblem(
  stored: OnboardingIntake,
  sent: OnboardingIntake,
): IntakeProblem | null {
  const owners = new Map(
    stored.datasets.flatMap((dataset) =>
      dataset.id ? [[dataset.id, new Set(dataset.owners.map((owner) => owner.id))] as const] : [],
    ),
  );
  const seenDatasets = new Set<string>();
  const seenOwners = new Set<string>();
  const refuse = (message: string): IntakeProblem => ({ code: "invalid-intake", message });
  for (const [i, dataset] of sent.datasets.entries()) {
    if (dataset.id !== undefined) {
      if (!owners.has(dataset.id))
        return refuse(`Dataset ${i + 1} names a dataset record this request doesn't have.`);
      if (seenDatasets.has(dataset.id))
        return refuse(`Dataset ${i + 1} repeats a dataset record another dataset already uses.`);
      seenDatasets.add(dataset.id);
    }
    for (const [j, owner] of dataset.owners.entries()) {
      if (owner.id === undefined) continue;
      if (dataset.id === undefined || !owners.get(dataset.id)?.has(owner.id))
        return refuse(
          `Dataset ${i + 1} owner ${j + 1} names an owner record that isn't on that dataset.`,
        );
      if (seenOwners.has(owner.id))
        return refuse(`Dataset ${i + 1} owner ${j + 1} repeats an owner record.`);
      seenOwners.add(owner.id);
    }
  }
  return null;
}

/**
 * A dataset whose ingestion method or domain isn't one the app knows, which
 * only a client bypassing the wizard can send. Submit and resubmit refuse it
 * the same way in both backends, so no stored request names an id the
 * screens can't draw. "other" is a known choice for both; a blank answer
 * is left to the required-answer rules.
 */
export function findDatasetOptionIdProblem(
  intake: Pick<OnboardingIntake, "datasets">,
  schema: IntakeSchema = loadSchema(),
): IntakeProblem | null {
  const ingestionMethods = new Set(schema.optionLists.ingestPatterns.map(({ id }) => id));
  const domains = new Set([...routedDomainIds(), "other"]);
  for (const [index, dataset] of intake.datasets.entries()) {
    const ingestionMethod = dataset.ingestionMethod ?? "";
    if (ingestionMethod && !ingestionMethods.has(ingestionMethod))
      return {
        code: "invalid-intake",
        message: `Dataset ${index + 1} has an unknown ingestionMethod: ${ingestionMethod}`,
      };
    if (dataset.domain && !domains.has(dataset.domain))
      return {
        code: "invalid-intake",
        message: `Dataset ${index + 1} has an unknown domain: ${dataset.domain}`,
      };
  }
  return null;
}

/**
 * What's wrong with a whole intake against the intake schema: the dataset
 * tag rule first (#131, its own refusal code), then every step's rules over
 * every answer, as the wizard checks them before it lets the provider submit.
 * Only rules on intake fields count; the wizard's own gates (the sizing
 * estimate having been run) aren't part of the intake.
 */
export function wholeIntakeProblem(
  intake: OnboardingIntake,
  schema: IntakeSchema = loadSchema(),
  /**
   * Fields the stored request may lack because it predates them: an
   * answer-only resubmission of a request made before #103 has no initiative
   * owner, and the provider isn't asked for one until they edit the intake.
   */
  predates: ReadonlySet<string> = new Set(),
): IntakeProblem | null {
  const tagProblem = findDatasetTagProblem(intake.datasets);
  if (tagProblem) return tagProblem;
  const idProblem = findDatasetOptionIdProblem(intake, schema);
  if (idProblem) return idProblem;
  const state = intakeAnswers(intake);
  const fields = new Set(
    schema.fields
      .filter((field) => !(predates.has(field.id) && state[field.id] === undefined))
      .map((field) => field.id),
  );
  const issues = schema.steps
    .flatMap((step) => validateStep(schema, step.id, state))
    .filter((issue) => fields.has(issue.field))
    .map((issue) => issue.message);
  return issues.length
    ? { code: "invalid-intake", message: `Onboarding request is incomplete: ${issues.join(" ")}` }
    : null;
}

/** An answer as the change record shows it: option names, not ids; numbers as the wizard shows them. */
function answerText(schema: IntakeSchema, field: FieldDef, answer: unknown): string {
  if (answer === undefined || answer === null) return "";
  switch (field.type) {
    case "number": {
      const n = readNumber(answer);
      if (n === undefined) return "";
      if (Number.isNaN(n)) return trim(answer);
      // Exact, not the wizard's rounded "$1.3M": a change record says precisely what it was.
      return field.numberFormat === "currency"
        ? n.toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          })
        : n.toLocaleString("en-US");
    }
    case "select":
      // A domain stays its id: the screens name it from the catalog.
      return field.optionsFrom
        ? (schema.optionLists[field.optionsFrom].find((o) => o.id === answer)?.name ?? trim(answer))
        : trim(answer);
    case "card-select":
    case "multi-card": {
      const list: Array<{ id: string; name: string }> = field.optionList
        ? schema.optionLists[field.optionList]
        : [];
      const ids = Array.isArray(answer) ? answer.map(String) : [String(answer)];
      return ids.map((id) => list.find((o) => o.id === id)?.name ?? id).join("; ");
    }
    default:
      return trim(answer);
  }
}

function ownerText(owner: DatasetOwnerContact): string {
  return `${trim(owner.name)} (${email(owner.email)})`;
}

function datasetText(dataset: IntakeDataset): string {
  const owners = dataset.owners.map(ownerText).join(", ");
  return `${trim(dataset.name)} (${trim(dataset.datasetTag)})${owners ? `; owners: ${owners}` : ""}`;
}

/** The stored dataset a resubmitted one keeps, by record ID; undefined for a new one. */
function keptFrom(before: readonly IntakeDataset[], dataset: IntakeDataset) {
  return dataset.id === undefined ? undefined : before.find((old) => old.id === dataset.id);
}

/**
 * Every intake field that differs between `before` and `after`, in wizard
 * order, compared as the store keeps them (trimmed; owner emails
 * lower-cased), so a stray space or capital doesn't show as a change.
 * Datasets and owner contacts are matched by record ID: one without a stored
 * ID is added, and a stored one that's gone is removed. An edited dataset's
 * changes are named by where it is now; a removed one by where it was.
 */
export function resubmissionChanges(
  before: OnboardingIntake,
  after: OnboardingIntake,
  schema: IntakeSchema = loadSchema(),
  /** The stored initiative owners, so Myself is named; the answers alone say only "Myself". */
  owners?: { before: InitiativeOwner | null; after: InitiativeOwner | null },
): OnboardingIntakeChange[] {
  const changes: OnboardingIntakeChange[] = [];
  const compare = (field: string, was: string, now: string) => {
    if (was !== now) changes.push({ field, before: was, after: now });
  };
  const [was, now] = [intakeAnswers(before), intakeAnswers(after)];
  for (const step of schema.steps) {
    for (const field of schema.fields.filter((f) => f.step === step.id)) {
      if (field.type === "dataset-list") {
        datasetChanges(before.datasets, after.datasets, changes, schema);
        continue;
      }
      if (field.type === "initiative-owner") {
        compare(
          intakeChangeField(field),
          initiativeOwnerText(owners ? owners.before : before.initiativeOwner),
          initiativeOwnerText(owners ? owners.after : after.initiativeOwner),
        );
        continue;
      }
      compare(
        intakeChangeField(field),
        answerText(schema, field, was[field.id]),
        answerText(schema, field, now[field.id]),
      );
    }
  }
  return changes;
}

function datasetChanges(
  before: readonly IntakeDataset[],
  after: readonly IntakeDataset[],
  changes: OnboardingIntakeChange[],
  schema: IntakeSchema,
): void {
  const compare = (field: string, was: string, now: string) => {
    if (was !== now) changes.push({ field, before: was, after: now });
  };
  after.forEach((dataset, i) => {
    const old = keptFrom(before, dataset);
    if (!old) {
      changes.push({
        field: datasetChangeField(i, "added"),
        before: "",
        after: datasetText(dataset),
        kind: "added",
      });
      return;
    }
    compare(datasetChangeField(i, "name"), trim(old.name), trim(dataset.name));
    compare(datasetChangeField(i, "domain"), trim(old.domain), trim(dataset.domain));
    compare(
      datasetChangeField(i, "source system"),
      trim(old.sourceSystem),
      trim(dataset.sourceSystem),
    );
    compare(
      datasetChangeField(i, "ingestion method"),
      schema.optionLists.ingestPatterns.find(({ id }) => id === trim(old.ingestionMethod))?.name ??
        trim(old.ingestionMethod),
      schema.optionLists.ingestPatterns.find(({ id }) => id === trim(dataset.ingestionMethod))
        ?.name ?? trim(dataset.ingestionMethod),
    );
    compare(
      datasetChangeField(i, "ingestion details"),
      trim(old.ingestionDetails),
      trim(dataset.ingestionDetails),
    );
    compare(datasetChangeField(i, "dataset tag"), trim(old.datasetTag), trim(dataset.datasetTag));
    dataset.owners.forEach((owner, j) => {
      const was = owner.id === undefined ? undefined : old.owners.find((o) => o.id === owner.id);
      if (!was) {
        changes.push({
          field: ownerChangeField(i, j, "added"),
          before: "",
          after: ownerText(owner),
          kind: "added",
        });
        return;
      }
      compare(ownerChangeField(i, j, "name"), trim(was.name), trim(owner.name));
      compare(ownerChangeField(i, j, "email"), email(was.email), email(owner.email));
    });
    old.owners.forEach((owner, j) => {
      if (owner.id !== undefined && dataset.owners.some((o) => o.id === owner.id)) return;
      changes.push({
        field: ownerChangeField(i, j, "removed"),
        before: ownerText(owner),
        after: "",
        kind: "removed",
      });
    });
  });
  before.forEach((dataset, i) => {
    if (dataset.id !== undefined && after.some((d) => d.id === dataset.id)) return;
    changes.push({
      field: datasetChangeField(i, "removed"),
      before: datasetText(dataset),
      after: "",
      kind: "removed",
    });
  });
}

/**
 * The resubmission's decision-log note: the provider's answer, each dataset
 * tag that changed (#215), and each dataset and owner contact removed (#222),
 * so the log says what was taken out of the request even without the
 * field-by-field record.
 */
export function resubmitNote(
  answer: string,
  before: OnboardingIntake,
  after: OnboardingIntake,
): string {
  const tags = after.datasets.flatMap((dataset) => {
    const old = keptFrom(before.datasets, dataset);
    const [was, now] = [trim(old?.datasetTag), trim(dataset.datasetTag)];
    return old && was !== now ? [`Dataset tag changed: ${was} -> ${now}.`] : [];
  });
  const removed = before.datasets.flatMap((dataset) => {
    const kept = after.datasets.find((d) => dataset.id !== undefined && d.id === dataset.id);
    if (!kept) return [`Removed dataset: ${trim(dataset.name)} (${trim(dataset.datasetTag)}).`];
    return dataset.owners
      .filter((owner) => owner.id === undefined || !kept.owners.some((o) => o.id === owner.id))
      .map((owner) => `Removed owner from ${trim(kept.name)}: ${ownerText(owner)}.`);
  });
  return [answer, ...tags, ...removed].filter(Boolean).join(" ");
}

/** A new response waiting on a reviewer: their send-back and the resubmission that answered it. */
export interface PendingResubmission {
  /** The send-back this resubmission answers. */
  sendBack: OnboardingDecision;
  resubmittedAt: string;
  providerName: string;
  /** The answer and changes; for a resubmission stored before #221, just the note as the answer. */
  record: OnboardingResubmissionRecord & { changesRecorded: boolean };
}

/**
 * The resubmission a reviewer at `stage` is now reading, or null when the
 * request didn't come back to them from the data provider. Only the latest
 * decision counts: once the reviewer decides again, the response isn't new.
 */
export function pendingResubmission(
  request: Pick<OnboardingRequest, "decisions">,
  stage: OnboardingReviewStage,
): PendingResubmission | null {
  const last = request.decisions.at(-1);
  if (!last || last.kind !== "resubmit" || last.to !== stage) return null;
  const sendBack = [...request.decisions].reverse().find(({ kind }) => kind === "send-back");
  if (!sendBack) return null;
  return {
    sendBack,
    resubmittedAt: last.at,
    providerName: last.actorName,
    record: last.resubmission
      ? { ...last.resubmission, changesRecorded: true }
      : { answer: last.note, changes: [], changesRecorded: false },
  };
}
