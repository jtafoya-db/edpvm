/**
 * The instant pre-check behind Download PDF to sign (#235): the shared rule
 * engine ({@link evaluateEirDraft}) run in the browser on the answers on
 * screen, against the definition the draft is pinned to, before anything is
 * sent. It only ever says "blocking": the server stays the authority, and
 * everything else (a pass, a warning, manual review, a definition it doesn't
 * have, a rule it can't run) goes to the server, which saves, evaluates and
 * makes the PDF in one call (`EirRepository.preparePdf`).
 *
 * The clock is the server's, as nearly as the browser can know it:
 *
 * - `effectiveAt` is one UTC instant captured at the click. An `evaluated`
 *   timeline (bootstrap-2) and the not-past/not-future checks count from it.
 * - `draftStartedAt` is the saved draft's start when it has saved answers,
 *   as the server keeps it; otherwise the save this Download makes starts the
 *   draft, so the server will use its own clock, and the provisional start is
 *   `effectiveAt`. A `form-started` timeline counts from it.
 *
 * The browser's clock may be a little off the server's. A date check is
 * day-granular, so the same answers are checked again at `effectiveAt` moved
 * by {@link CLOCK_TOLERANCE_MS} either way (with a provisional start moved
 * with it); only when all three block with the same rules is the block
 * certain. Near midnight UTC an answer can pass on one side and block on the
 * other: that goes to the server.
 */
import type { EirFormConfig } from "./config.ts";
import { evaluateEirDraft } from "./evaluation.ts";
import { builtInById } from "./definition/built-in.ts";
import { publishedVersionNumber } from "./definition/identity.ts";
import type { EirPreflightRules } from "./definition/preflight-rules.ts";
import type { EirDefinition } from "./definition/types.ts";
import type { EirEvaluation, EirFormValues } from "./types.ts";

/** How far the browser's clock may be from the server's and still decide a block alone. */
export const CLOCK_TOLERANCE_MS = 10 * 60 * 1000;

export type EirPreflight =
  | { outcome: "blocking"; evaluation: EirEvaluation }
  | { outcome: "server"; reason: "no-definition" | "not-blocking" | "uncertain" | "error" };

/**
 * The definition behind `form` (the one the draft's next save uses), as far
 * as the browser has it: a published one's rules from the forms read, or a
 * built-in shipped with the app. Undefined otherwise: the server decides.
 */
export function preflightDefinitionFor(
  form: EirFormConfig,
  rules: Record<string, EirPreflightRules> | undefined,
): EirDefinition | undefined {
  const id = form.version;
  if (publishedVersionNumber(id) === undefined) {
    const builtIn = builtInById(id);
    return builtIn?.form.version === id ? builtIn : undefined;
  }
  const sent = rules?.[id];
  if (!sent || sent.id !== id) return undefined;
  // Only what the rule engine reads; scenarios and service levels stay on the server.
  return {
    form,
    rules: sent.rules,
    timelines: sent.timelines,
    scenarios: [],
    validityDays: 0,
    reviewSlaBusinessDays: 0,
  };
}

export function preflightEir(input: {
  /** The draft's pinned definition (its rules and timelines); undefined when the browser doesn't have it. */
  definition: EirDefinition | undefined;
  values: EirFormValues;
  /** The saved draft's start, when the draft has saved answers. */
  savedDraftStartedAt?: string;
  /** The draft version the screen read. */
  draftVersion: number;
  /** The click: captured once. */
  now: Date;
}): EirPreflight {
  const { definition } = input;
  if (!definition) return { outcome: "server", reason: "no-definition" };
  const at = (shift: number) => {
    const effectiveAt = new Date(input.now.getTime() + shift).toISOString();
    return evaluateEirDraft({
      definition,
      values: input.values,
      draftVersion: input.draftVersion,
      draftStartedAt: input.savedDraftStartedAt ?? effectiveAt,
      effectiveAt,
    });
  };
  try {
    const evaluation = at(0);
    if (evaluation.outcome !== "blocking") return { outcome: "server", reason: "not-blocking" };
    const blocked = (item: EirEvaluation) =>
      item.outcomes
        .filter((outcome) => outcome.disposition === "blocking")
        .map((outcome) => outcome.ruleId)
        .join("\u0000");
    const certain = [at(-CLOCK_TOLERANCE_MS), at(CLOCK_TOLERANCE_MS)].every(
      (other) => other.outcome === "blocking" && blocked(other) === blocked(evaluation),
    );
    return certain
      ? { outcome: "blocking", evaluation }
      : { outcome: "server", reason: "uncertain" };
  } catch {
    return { outcome: "server", reason: "error" };
  }
}
