/**
 * A validated EIR definition (#200): what `loadDefinition` turns YAML into.
 * Screens, the PDF and the rules read only this, never the YAML.
 */
import type { EirFormConfig } from "../config.ts";

/** What a rule's outcome does to a submission. */
export type EirDisposition = "blocking" | "warning" | "manual-review";

/** A scenario's expected overall outcome: no rule fired, or the worst one that did. */
export type EirOutcome = "pass" | EirDisposition;

export type EirRuleOperator =
  "irs-id" | "equals" | "within-timeline" | "not-future" | "not-past" | "on-or-after";

export interface EirRuleDefinition {
  id: string;
  field: string;
  operator: EirRuleOperator;
  disposition: EirDisposition;
  /** Stable code for the outcome, for records and later inspection. */
  reasonCode: string;
  /** What the employee should go do when the rule fails (#217): shown by the field and in the summary. */
  guidance?: string;
  /** `equals`: the answer that fires the rule. */
  value?: string;
  /** `equals`: what the flag says. */
  message?: string;
  /** `within-timeline`: the timeline's ID. */
  timeline?: string;
  /** `on-or-after`: the date field it must not be before. */
  otherField?: string;
}

/**
 * A date window, in whole units, both ends included (UTC). A date passes when
 * it's no less than `min` units before the day it's checked, and no more than
 * `max` units before the anchor: the day the form was started (`form-started`,
 * the default, what `bootstrap` and form 1.2 mean) or the day it's checked
 * (`evaluated`, bootstrap-2). A day the target month doesn't have (29
 * February, 31 August minus 6 months) is that month's last day.
 */
export interface EirTimeline {
  id: string;
  anchor: "form-started" | "evaluated";
  unit: "years" | "months" | "days";
  min: number;
  max: number;
}

export interface EirScenario {
  id: string;
  expect: EirOutcome;
  formStartedAt: string;
  submittedAt: string;
  /** A reason code the outcome must include (#217). */
  reasonCode?: string;
  /** Every current-form answer, resolved (an `extends` scenario's answers merged in). */
  answers: Record<string, string>;
}

export interface EirDefinition {
  validityDays: number;
  reviewSlaBusinessDays: number;
  /** The form as the screens and PDF render it, each field carrying its rule. */
  form: EirFormConfig;
  timelines: readonly EirTimeline[];
  rules: readonly EirRuleDefinition[];
  scenarios: readonly EirScenario[];
}

/** Every code a definition check can raise; the schema reference (#219) explains each. */
export const EIR_DEFINITION_DIAGNOSTIC_CODES = [
  "parse-error",
  "unsafe-yaml",
  "unknown-key",
  "server-assigned-version",
  "invalid-value",
  "duplicate-id",
  "missing-reference",
  "timeline-bounds",
  "inconsistent-disposition",
  "missing-scenario",
  "missing-guidance",
  "unavailable",
] as const;

export type EirDefinitionDiagnosticCode = (typeof EIR_DEFINITION_DIAGNOSTIC_CODES)[number];

/** Every code publishing or activating a definition can be refused with (#201). */
export const EIR_DEFINITION_REFUSAL_CODES = [
  "definition-too-large",
  "definition-invalid",
  "scenarios-failed",
  "already-published",
  "definition-unloadable",
  "already-active",
  "version-conflict",
  "idempotency-key-reused",
  "not-found",
  "forbidden",
  "eir-unavailable",
] as const;

export type EirDefinitionRefusalCode = (typeof EIR_DEFINITION_REFUSAL_CODES)[number];

/** Why a definition was refused, and where (a path into the YAML, and its line when known). */
export interface EirDefinitionDiagnostic {
  code: EirDefinitionDiagnosticCode;
  message: string;
  path: (string | number)[];
  line?: number;
}

export type EirDefinitionResult =
  { ok: true; definition: EirDefinition } | { ok: false; diagnostics: EirDefinitionDiagnostic[] };
