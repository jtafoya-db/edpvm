/**
 * Map the extended intake wizard's values (the IntakeSchema's field ids) onto
 * the intake package an onboarding request carries (#86).
 */
import { loadSchema, readNumbers } from "../../schema/index.ts";
import type {
  IntakeDatasetInput,
  IntakeInitiativeOwner,
  IntakeSchema,
  IntakeState,
} from "../../schema/types.ts";
import { normalizeInitiativeOwner } from "./owners.ts";
import type { OnboardingIntake } from "./types.ts";

/** Answers the request keeps in its own columns rather than in the raw answers (#103). */
const OWN_COLUMN_ANSWERS = new Set(["initiativeOwner"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Number fields arrive as the text typed into them and leave as numbers. */
export function toOnboardingIntake(
  input: IntakeState,
  schema: IntakeSchema = loadSchema(),
): OnboardingIntake {
  const values = readNumbers(schema, input);
  const datasets = Array.isArray(values["datasets"])
    ? (values["datasets"] as IntakeDatasetInput[])
    : [];
  return {
    initiativeName: text(values["dataName"]),
    businessCase: text(values["useCase"]),
    annualBenefit: Number(values["annualBenefit"]) || 0,
    levers: Array.isArray(values["levers"]) ? [...(values["levers"] as string[])] : [],
    // A stored dataset or owner keeps its ID, so a resubmission edits that record (#222).
    datasets: datasets.map((dataset) => ({
      ...(dataset.id ? { id: dataset.id } : {}),
      name: text(dataset.name),
      domain: text(dataset.domain),
      datasetTag: text(dataset.datasetTag),
      owners: dataset.owners.map((owner) => ({
        ...(owner.id ? { id: owner.id } : {}),
        // Myself sends no identity: the server fills it from the session (#103).
        ...(owner.self === true
          ? { self: true as const, name: "", email: "" }
          : { name: text(owner.name), email: text(owner.email) }),
      })),
    })),
    workspaceNeeds: {
      isolation: text(values["isolation"]),
      teamSize: Number(values["teamSize"]) || 0,
    },
    ...withInitiativeOwner(values["initiativeOwner"] as IntakeInitiativeOwner | undefined),
    // A cleared optional field is unanswered, so it is left out rather than stored.
    // The record IDs live on the datasets above, never in the raw answers.
    answers: structuredClone(
      Object.fromEntries(
        Object.entries(values)
          .filter(([id, value]) => value !== undefined && !OWN_COLUMN_ANSWERS.has(id))
          .map(([id, value]) => [id, id === "datasets" ? withoutIds(value) : value]),
      ),
    ),
  };
}

function withInitiativeOwner(choice: IntakeInitiativeOwner | undefined) {
  const owner = normalizeInitiativeOwner(choice);
  return owner ? { initiativeOwner: owner } : {};
}

/** A dataset list's answer without its stored record IDs, or the wizard's own Someone else mark. */
export function withoutIds(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((dataset: Partial<IntakeDatasetInput>) => {
    const { id: _id, owners, ...rest } = dataset;
    return {
      ...rest,
      ...(Array.isArray(owners)
        ? {
            owners: owners.map(({ id: _ownerId, self, ...owner }) =>
              self === true ? { self, ...owner } : owner,
            ),
          }
        : {}),
    };
  });
}

/**
 * Every answer in an intake package, keyed by the IntakeSchema's field ids, as
 * the reviewers and the provider read it (#229). The raw answers are what the
 * wizard held at submit; the fields the request keeps on their own (the ones a
 * resubmission can correct) come from the request, so a correction shows.
 */
export function intakeAnswers(intake: OnboardingIntake): IntakeState {
  const answers: IntakeState = { ...intake.answers };
  const set = (id: string, value: unknown) => {
    if (value !== undefined && value !== null) answers[id] = value;
  };
  set("dataName", intake.initiativeName);
  set("useCase", intake.businessCase);
  set("annualBenefit", intake.annualBenefit);
  set("levers", intake.levers);
  set("datasets", intake.datasets);
  set("isolation", intake.workspaceNeeds?.isolation);
  set("teamSize", intake.workspaceNeeds?.teamSize);
  set("initiativeOwner", intake.initiativeOwner);
  return answers;
}
