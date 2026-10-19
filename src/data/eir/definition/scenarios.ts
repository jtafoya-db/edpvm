/**
 * Runs an EIR definition's synthetic scenarios (#200) through the same rules
 * the screens and repository use (`form.ts`), on the definition's own form.
 *
 * A scenario's outcome: the most serious disposition among the form errors
 * (always blocking) and the rules it fails (`blocking` over `manual-review`
 * over `warning`), else `pass`. A scenario that names a reason code is only
 * met when that code is among the reasons (#217).
 */
import { evaluateEirRules } from "../evaluation.ts";
import type { EirDefinition, EirDisposition, EirOutcome } from "./types.ts";

export interface EirScenarioReason {
  field: string;
  disposition: EirDisposition;
  /** The field's rule's reason code, when the reason is that rule. */
  reasonCode?: string;
  message: string;
}

export interface EirScenarioResult {
  id: string;
  expected: EirOutcome;
  /** A reason code the scenario says its outcome must include (#217). */
  expectedReasonCode?: string;
  actual: EirOutcome;
  ok: boolean;
  reasons: EirScenarioReason[];
}

export function runScenarios(definition: EirDefinition): EirScenarioResult[] {
  return definition.scenarios.map((scenario) => {
    const evaluated = evaluateEirRules({
      definition,
      values: scenario.answers,
      draftStartedAt: scenario.formStartedAt,
      effectiveAt: scenario.submittedAt,
    });
    const reasons: EirScenarioReason[] = evaluated.outcomes.map((outcome) => ({
      field: outcome.field,
      disposition: outcome.disposition,
      reasonCode: outcome.reasonCode,
      message: outcome.guidance,
    }));
    const actual: EirOutcome = evaluated.outcome;
    const hasReason =
      !scenario.reasonCode || reasons.some((reason) => reason.reasonCode === scenario.reasonCode);
    return {
      id: scenario.id,
      expected: scenario.expect,
      ...(scenario.reasonCode ? { expectedReasonCode: scenario.reasonCode } : {}),
      actual,
      ok: actual === scenario.expect && hasReason,
      reasons,
    };
  });
}
