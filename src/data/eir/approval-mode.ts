/**
 * The EIR approval mode (#204): what happens after an employee uploads the
 * signed PDF of a draft whose latest pre-check doesn't block.
 *
 * - `manual-validator` (the default): the EIR is `submitted` and waits for a
 *   Safeguards validator, as before.
 * - `automatic`: the upload runs the pre-check again, at the upload, on the
 *   published definition the draft is pinned to. When that result is one the
 *   deploy names as qualifying, the same transaction records the system's
 *   validity decision and the EIR is `valid` at once. Anything else (a
 *   result the deploy doesn't name, `manual-review`, a built-in or missing
 *   definition, an evaluator failure) takes the manual path.
 *
 * Both settings are deploy-time configuration, resolved on the server
 * (`src/server/eir-approval-mode.ts`); no client sends them. Which results
 * qualify is the human's decision on #148 (2026-10-24): `pass` only by
 * default, so a `warning` goes to a validator, and never `blocking`.
 * Setting `automatic` is not Safeguards authorization: production stays on
 * `manual-validator` for the first pilot until Safeguards signs off.
 */
import { publishedVersionNumber } from "./definition/identity.ts";
import type { EirEvaluation } from "./types.ts";

export const EIR_APPROVAL_MODES = ["manual-validator", "automatic"] as const;
export type EirApprovalMode = (typeof EIR_APPROVAL_MODES)[number];

/** The pre-check results a deploy may name as qualifying: never `blocking`, never `manual-review`. */
export const EIR_AUTOMATIC_VALIDITY_OUTCOMES = ["pass", "warning"] as const;
export type EirAutomaticValidityOutcome = (typeof EIR_AUTOMATIC_VALIDITY_OUTCOMES)[number];

export interface EirApprovalConfig {
  mode: EirApprovalMode;
  /** The results that make an EIR valid automatically, in automatic mode. */
  automaticValidityOutcomes: readonly EirAutomaticValidityOutcome[];
}

export const DEFAULT_EIR_APPROVAL_CONFIG: EirApprovalConfig = Object.freeze({
  mode: "manual-validator",
  automaticValidityOutcomes: Object.freeze(["pass"] as const),
});

/** The mode from its setting: exactly one of the two values; unset is `manual-validator`. */
export function parseEirApprovalMode(raw: string | undefined, name: string): EirApprovalMode {
  if (raw === undefined) return DEFAULT_EIR_APPROVAL_CONFIG.mode;
  const mode = EIR_APPROVAL_MODES.find((candidate) => candidate === raw.trim());
  if (!mode) {
    throw new Error(`${name} must be "manual-validator" or "automatic".`);
  }
  return mode;
}

/**
 * The qualifying results from their setting: a comma-separated list of
 * `pass` and `warning`, with no empty item; unset is `pass`. `blocking` and `manual-review` are
 * refused by name, so a deploy can never make them qualify.
 */
export function parseAutomaticValidityOutcomes(
  raw: string | undefined,
  name: string,
): readonly EirAutomaticValidityOutcome[] {
  if (raw === undefined) return DEFAULT_EIR_APPROVAL_CONFIG.automaticValidityOutcomes;
  if (!raw.trim()) throw new Error(`${name} must name pass, warning, or both.`);
  const parts = raw.split(",").map((part) => part.trim());
  // A malformed list (`pass,`, `,pass`, `pass,,warning`) never quietly means a shorter one.
  if (parts.some((part) => !part)) throw new Error(`${name} must not have an empty item.`);
  const outcomes: EirAutomaticValidityOutcome[] = [];
  for (const part of parts) {
    if (part === "blocking" || part === "block") {
      throw new Error(`${name} can never include blocking.`);
    }
    if (part === "manual-review") {
      throw new Error(`${name} can't include manual-review: it always goes to a validator.`);
    }
    const outcome = EIR_AUTOMATIC_VALIDITY_OUTCOMES.find((candidate) => candidate === part);
    if (!outcome) throw new Error(`${name} must name pass, warning, or both.`);
    if (!outcomes.includes(outcome)) outcomes.push(outcome);
  }
  return outcomes;
}

/** Whether `outcome` is one the deploy names as qualifying (it never can be blocking or manual-review). */
export function isQualifyingOutcome(
  outcome: EirEvaluation["outcome"],
  config: Pick<EirApprovalConfig, "automaticValidityOutcomes">,
): boolean {
  return config.automaticValidityOutcomes.some((qualifying) => qualifying === outcome);
}

/**
 * Whether an upload may make the EIR valid with no validator. All of these
 * must hold, or it's the manual path:
 * - the mode is `automatic`;
 * - `atUpload` is the pre-check run at the upload itself, and its result is
 *   one the deploy names (`pass` by default);
 * - it ran on a published definition (a server-assigned version number,
 *   #224) that loads now. A built-in definition (`bootstrap`, `bootstrap-2`)
 *   or a legacy form version never qualifies: nobody published it, and
 *   there's no fallback to one.
 */
export function qualifiesForAutomaticValidity(input: {
  config: EirApprovalConfig;
  atUpload: Pick<EirEvaluation, "outcome" | "definitionVersion">;
  /** Whether the definition `atUpload` names loaded for this upload. */
  definitionLoaded: boolean;
}): boolean {
  const { config, atUpload } = input;
  if (config.mode !== "automatic") return false;
  if (!isQualifyingOutcome(atUpload.outcome, config)) return false;
  if (publishedVersionNumber(atUpload.definitionVersion) === undefined) return false;
  return input.definitionLoaded;
}

/**
 * What the system's validity action records of the decision it rests on
 * (#204): the upload-time pre-check, and the setting it qualified under.
 * Stored as the action's payload; set only by the server.
 */
export interface EirAutomaticValidity {
  /**
   * The upload-time pre-check's ID: its `eir_evaluations` row on Delta, which
   * also holds its place in the draft's evaluation sequence.
   */
  evaluationId: string;
  evaluatedAt: string;
  definitionVersion: string;
  formVersion: string;
  outcome: EirAutomaticValidityOutcome;
  reasonCodes: string[];
  /** The deploy's qualifying results when it was decided. */
  qualifyingOutcomes: EirAutomaticValidityOutcome[];
}

/** The provenance of an automatic validity decision on `atUpload`, which qualified. */
export function automaticValidityOf(
  atUpload: EirEvaluation,
  evaluationId: string,
  config: EirApprovalConfig,
): EirAutomaticValidity {
  return {
    evaluationId,
    evaluatedAt: atUpload.effectiveAt,
    definitionVersion: atUpload.definitionVersion,
    formVersion: atUpload.formVersion,
    outcome: atUpload.outcome as EirAutomaticValidityOutcome,
    reasonCodes: atUpload.outcomes.map((outcome) => outcome.reasonCode),
    qualifyingOutcomes: [...config.automaticValidityOutcomes],
  };
}
