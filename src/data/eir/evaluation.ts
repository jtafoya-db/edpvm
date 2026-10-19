import { fieldRule } from "./definition/load";
import type { EirDefinition, EirDisposition, EirRuleDefinition } from "./definition/types";
import { EIR_FORM } from "./config";
import { flagsOn, validateAnswersOn } from "./form";
import type { EirEvaluation, EirFormValues, EirRuleOutcome } from "./types";

const rank: Record<"pass" | EirDisposition, number> = {
  pass: 0,
  warning: 1,
  "manual-review": 2,
  blocking: 3,
};

const HANDLED_OPERATORS = new Set([
  "irs-id",
  "equals",
  "within-timeline",
  "not-future",
  "not-past",
  "on-or-after",
]);

/** A rule's own guidance, when it has some that isn't blank. */
const guidanceOf = (rule: EirRuleDefinition | undefined): string | undefined =>
  rule?.guidance?.trim() ? rule.guidance : undefined;

/** Field-labelled guidance shared by every memory, client, and server refusal. */
export function blockingGuidance(outcomes: EirEvaluation["outcomes"]): string {
  const labels = new Map(
    EIR_FORM.sections.flatMap((section) => section.fields).map((field) => [field.id, field.label]),
  );
  return outcomes
    .filter((item) => item.disposition === "blocking")
    .map((item) => {
      const label = labels.get(item.field) ?? item.field;
      return item.guidance.startsWith(`${label}:`) ? item.guidance : `${label}: ${item.guidance}`;
    })
    .join(" ");
}

/**
 * The one EIR rule engine used by definition scenarios and persisted draft
 * evaluation. A form error always blocks. A blank or malformed answer gets the
 * form's own reason code, whatever rules its field has; only a field rule's
 * own refusal (an ID that isn't one: `irs-id`) gets that rule's. A flag
 * carries the disposition of the rule that raised it. Either way the outcome's guidance is the rule's own
 * (what to go do, #217) when the definition gives one, else what's wrong.
 * A typed definition is still checked defensively at runtime so an unknown
 * publication fails closed.
 */
export function evaluateEirRules(input: {
  definition: EirDefinition;
  values: EirFormValues;
  draftStartedAt: string;
  effectiveAt: string;
}): { outcome: "pass" | EirDisposition; outcomes: EirRuleOutcome[] } {
  const { definition, values } = input;
  for (const rule of definition.rules) {
    if (!HANDLED_OPERATORS.has(rule.operator)) {
      throw new Error(`Unhandled EIR rule operator: ${String(rule.operator)}`);
    }
  }
  const fields = new Map(
    definition.form.sections.flatMap((section) => section.fields).map((field) => [field.id, field]),
  );
  const rulesOn = (fieldId: string): EirRuleDefinition[] =>
    definition.rules.filter((rule) => rule.field === fieldId);
  const errors = validateAnswersOn(definition.form, values);
  const outcomes: EirRuleOutcome[] = errors.map((error) => {
    // Order-independent: the rule that refused the answer, never just the field's first.
    const blockingRule = error.rule
      ? rulesOn(error.field).find(
          (rule) =>
            rule.disposition === "blocking" && fieldRule(rule, definition.timelines) === error.rule,
        )
      : undefined;
    return {
      ruleId: blockingRule?.id ?? `form-${error.field}`,
      field: error.field,
      reasonCode: blockingRule?.reasonCode ?? `EIR-FORM-${error.field.toUpperCase()}-INVALID`,
      disposition: "blocking",
      guidance: guidanceOf(blockingRule) ?? error.message,
    };
  });
  if (!outcomes.length) {
    for (const flag of flagsOn(definition.form, values, {
      formStartedAt: input.draftStartedAt,
      submittedAt: input.effectiveAt,
    })) {
      // The rule that raised it: same field and check (a yes/no flag is its `equals` rule).
      const rule = rulesOn(flag.field).find(
        (candidate) => fieldRule(candidate, definition.timelines) === flag.rule,
      );
      const field = fields.get(flag.field);
      outcomes.push({
        ruleId: rule?.id ?? `form-${flag.field}`,
        field: flag.field,
        reasonCode: rule?.reasonCode ?? `EIR-FORM-${flag.field.toUpperCase()}-REVIEW`,
        disposition: rule?.disposition ?? "manual-review",
        guidance: guidanceOf(rule) ?? (flag.text || `${field?.label ?? flag.field} needs review.`),
      });
    }
  }
  const outcome = outcomes.reduce<"pass" | EirDisposition>(
    (overall, item) => (rank[item.disposition] > rank[overall] ? item.disposition : overall),
    "pass",
  );
  return { outcome, outcomes };
}

/** Evaluate only an already validated, typed definition and a versioned persisted draft. */
export function evaluateEirDraft(input: {
  definition: EirDefinition;
  values: EirFormValues;
  draftVersion: number;
  draftStartedAt: string;
  effectiveAt: string;
}): EirEvaluation {
  const evaluated = evaluateEirRules(input);
  return {
    // Its identity (#224): a published version's number, or a built-in's name.
    definitionVersion: input.definition.form.version,
    formVersion: input.definition.form.version,
    effectiveAt: input.effectiveAt,
    evaluatedDraftVersion: input.draftVersion,
    outcome: evaluated.outcome,
    outcomes: evaluated.outcomes,
    automaticValidityEligible: evaluated.outcome === "pass" || evaluated.outcome === "warning",
    actorPrincipalId: "system",
    actorDisplay: "EDP Vending Machine",
    actorApp: "system",
  };
}

/** Safe fallback for definition/evaluator failures: a person must handle it; it is never blocking or valid. */
export function manualHandlingEvaluation(input: {
  draftVersion: number;
  effectiveAt: string;
  formVersion: string;
  definitionVersion?: string;
}): EirEvaluation {
  return {
    definitionVersion: input.definitionVersion ?? "unavailable",
    formVersion: input.formVersion,
    effectiveAt: input.effectiveAt,
    evaluatedDraftVersion: input.draftVersion,
    outcome: "manual-review",
    outcomes: [
      {
        ruleId: "evaluation-unavailable",
        field: "system",
        reasonCode: "EIR-EVALUATION-UNAVAILABLE",
        disposition: "manual-review",
        guidance:
          "The automated pre-check was unavailable. Safeguards must handle this EIR manually.",
      },
    ],
    automaticValidityEligible: false,
    actorPrincipalId: "system",
    actorDisplay: "EDP Vending Machine",
    actorApp: "system",
  };
}
