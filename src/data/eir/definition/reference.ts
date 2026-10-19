/**
 * The EIR definition schema reference (#219): what can go in an EIR
 * definition and what each value means, for Safeguards, in the app.
 *
 * It's generated from the checker's own schema (`EIR_DEFINITION_SCHEMA`),
 * operator table (`EIR_RULE_OPERATORS`) and code lists, so it can't drift
 * from what's enforced: paths, types, required or optional, allowed values,
 * number bounds, the field types and dispositions each operator accepts,
 * the size limit, the keys the server now assigns and the built-in
 * definitions' reserved names all come from them.
 * Only the plain-language meanings live here, beside them, typed so a key,
 * value, operator, disposition or code without one doesn't compile, and
 * checked again when the reference is built (a gap throws).
 *
 * The operator and disposition meanings carry their behaviour as data
 * (worked examples, what each outcome does to the PDF and upload), and the
 * tests run that data through the real evaluator and repository.
 */
import { z } from "zod";

import { ACTIVE_EIR_DEFINITION } from "./active.ts";
import { MAX_EIR_DEFINITION_BYTES } from "./check.ts";
import { BUILT_IN_DEFINITION_IDS, definitionLabel, FALLBACK_BUILT_IN_ID } from "./identity.ts";
import {
  EIR_DEFINITION_SCALARS,
  EIR_DEFINITION_SCHEMA,
  EIR_RULE_OPERATORS,
  EIR_SERVER_ASSIGNED_KEYS,
  EIR_TIMELINE_LIMITS,
  type EirDefinitionSource,
} from "./load.ts";
import {
  EIR_DEFINITION_DIAGNOSTIC_CODES,
  EIR_DEFINITION_REFUSAL_CODES,
  type EirDefinition,
  type EirDefinitionDiagnosticCode,
  type EirDefinitionRefusalCode,
  type EirDisposition,
  type EirRuleOperator,
} from "./types.ts";

type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;
/** Every key path in a definition: `form.sections[].fields[].id`. A map's own keys aren't schema keys. */
type KeyPaths<T, P extends string = ""> = T extends readonly (infer E)[]
  ? KeyPaths<E, `${P}[]`>
  : T extends object
    ? string extends keyof T
      ? never
      : {
          [K in keyof T & string]-?: Join<P, K> | KeyPaths<NonNullable<T[K]>, Join<P, K>>;
        }[keyof T & string]
    : never;

export type EirDefinitionKeyPath = KeyPaths<EirDefinitionSource>;

/** A code the reference explains: a check's diagnostic, or a publish or activate refusal. */
export type EirReferenceCode = EirDefinitionDiagnosticCode | EirDefinitionRefusalCode;

/** A rule beyond a key's type, and the code raised when it's broken. */
export interface EirReferenceConstraint {
  text: string;
  code: EirReferenceCode;
}

interface KeyInfo {
  /** What the key is, for Safeguards. */
  meaning: string;
  /** What happens when an optional key is left out. */
  whenOmitted?: string;
  /** Rules beyond its type and bounds, each with the code raised when broken. */
  constraints?: readonly EirReferenceConstraint[];
  /** The bootstrap's value is a non-production MVP default pending Safeguards (#148). */
  mvpDefault?: (bootstrap: EirDefinition) => string;
}

const ID_CODES = "letters, numbers and dashes, starting with a letter";
/** The checker's longest timeline per unit, in words: "10 years, 120 months or 3660 days". */
const TIMELINE_CAPS = (() => {
  const caps = Object.entries(EIR_TIMELINE_LIMITS).map(([unit, limit]) => `${limit} ${unit}`);
  return caps.length > 1 ? `${caps.slice(0, -1).join(", ")} or ${caps.at(-1)}` : caps.join("");
})();

/** What Safeguards should know about a timeline's anchor and min (#217). */
const ANCHOR_CAVEATS =
  "Only max follows the anchor: min always counts back from the day the EIR is checked. With anchor form-started and a min above 0, a draft left open a long time sees its window narrow, and it can close entirely.";
const SEE_OPERATOR = "Which operators take it, and need it, is listed under Rule operators.";

const KEYS: Record<EirDefinitionKeyPath, KeyInfo> = {
  validityDays: {
    meaning: "How many days an EIR stays valid once it's accepted.",
    mvpDefault: (b) => `${b.validityDays} days`,
  },
  reviewSlaBusinessDays: {
    meaning: "How many business days Safeguards has to review a submitted EIR.",
    mvpDefault: (b) => `${b.reviewSlaBusinessDays} business days`,
  },
  form: { meaning: "The form employees fill in: its wording, sections and declaration." },
  "form.title": { meaning: "The form's title, at the top of the form and the PDF." },
  "form.intro": { meaning: "The introduction under the title: why EDP asks for this record." },
  "form.trainingRule": {
    meaning:
      "The sentence that explains the training-date rule to employees. It's wording only: the rules themselves are in rules.",
  },
  "form.sections": { meaning: "The form's sections, in the order they appear." },
  "form.sections[].id": {
    meaning: "The section's ID.",
    constraints: [{ text: "Unique among sections.", code: "duplicate-id" }],
  },
  "form.sections[].title": { meaning: "The section's heading." },
  "form.sections[].help": {
    meaning: "Help text under the section's heading.",
    whenOmitted: "No help text.",
  },
  "form.sections[].fields": { meaning: "The questions in the section, in order." },
  "form.sections[].fields[].id": {
    meaning: "The question's ID: what rules and scenario answers refer to.",
    constraints: [
      {
        text: "Unique among every question on the form, the declaration's agreement included.",
        code: "duplicate-id",
      },
    ],
  },
  "form.sections[].fields[].label": {
    meaning: "The question as employees read it, on the form and the PDF.",
  },
  "form.sections[].fields[].type": { meaning: "What kind of answer the question takes." },
  "form.sections[].fields[].required": {
    meaning:
      "true: the question must be answered (a yes-no question needs an explicit Yes or No). A missing answer always blocks the PDF.",
  },
  "form.sections[].fields[].help": {
    meaning: "Help text under the question.",
    whenOmitted: "No help text.",
  },
  "form.sections[].fields[].prefill": {
    meaning: "Fill the answer in from the employee's sign-in. They can still change it.",
    whenOmitted: "Starts blank.",
  },
  "form.sections[].fields[].maxLength": {
    meaning: "The longest answer allowed, in characters. A longer answer blocks the PDF.",
    whenOmitted: "254 characters for an email question, 200 for any other.",
  },
  "form.sections[].fields[].size": {
    meaning: "How wide the answer box is. It doesn't change what's accepted.",
    whenOmitted: "Full width.",
  },
  "form.sections[].layout": {
    meaning:
      "How the section's questions are grouped and placed side by side. Each question is placed once.",
    whenOmitted: "One question per row, in order.",
    constraints: [
      {
        text: "Places every question of this section, and only this section's questions.",
        code: "missing-reference",
      },
      { text: "Places each question once.", code: "duplicate-id" },
    ],
  },
  "form.sections[].layout[].legend": {
    meaning: "A heading for the group of questions.",
    whenOmitted: "No heading.",
  },
  "form.sections[].layout[].hint": {
    meaning: "A hint under the group's heading.",
    whenOmitted: "No hint.",
  },
  "form.sections[].layout[].rows": {
    meaning:
      "The group's rows, each a list of question IDs. A row's questions sit side by side on a wide screen and stack on a narrow one.",
  },
  "form.declaration": { meaning: "The declaration employees agree to before they submit." },
  "form.declaration.text": { meaning: "The declaration's wording." },
  "form.declaration.attestation": {
    meaning: "The agreement checkbox. It must be answered yes before the PDF can be generated.",
  },
  "form.declaration.attestation.id": {
    meaning: "The agreement's ID, used in scenario answers.",
    constraints: [{ text: "Unique among every question on the form.", code: "duplicate-id" }],
  },
  "form.declaration.attestation.label": { meaning: "The agreement checkbox's label." },
  timelines: {
    meaning: "Named date windows that within-timeline rules check training dates against.",
    mvpDefault: (b) =>
      b.timelines
        .map((t) => `${t.id}: ${t.min} to ${t.max} ${t.unit}, anchored ${t.anchor}`)
        .join("; ") || "none",
  },
  "timelines[].id": {
    meaning: "The window's ID: what a within-timeline rule's timeline refers to.",
    constraints: [{ text: "Unique among timelines.", code: "duplicate-id" }],
  },
  "timelines[].anchor": {
    meaning: `The day max counts back from: the day the employee started the form, or the day the EIR is checked. ${ANCHOR_CAVEATS}`,
    whenOmitted: "form-started: max counts back from the day the employee started the form.",
  },
  "timelines[].unit": { meaning: "What min and max count in." },
  "timelines[].min": {
    meaning: `The latest a date can be: this many units before the day the EIR is checked, that day included. 0 means up to and including the day it's checked. ${ANCHOR_CAVEATS}`,
  },
  "timelines[].max": {
    meaning:
      "The earliest a date can be: this many units before the timeline's anchor (see anchor), that day included.",
    constraints: [
      { text: "At least min.", code: "timeline-bounds" },
      {
        text: `At most ${TIMELINE_CAPS}.`,
        code: "timeline-bounds",
      },
    ],
  },
  rules: {
    meaning:
      "The checks run on the answers before the PDF can be generated. Each names a question, an operator and a disposition.",
    mvpDefault: (b) => {
      const counts = new Map<string, number>();
      for (const rule of b.rules)
        counts.set(rule.disposition, (counts.get(rule.disposition) ?? 0) + 1);
      const list = [...counts].map(([d, n]) => `${n} ${d}`).join(", ");
      return `${b.rules.length} rules (${list}), with placeholder guidance`;
    },
  },
  "rules[].id": {
    meaning: "The rule's ID.",
    constraints: [{ text: "Unique among rules.", code: "duplicate-id" }],
  },
  "rules[].field": {
    meaning: "The question the rule checks.",
    constraints: [
      {
        text: "A question on the form (not the declaration's agreement).",
        code: "missing-reference",
      },
      {
        text: "A question can have several rules, but only one of each operator.",
        code: "duplicate-id",
      },
      { text: "The question's type must be one the operator accepts.", code: "invalid-value" },
    ],
  },
  "rules[].operator": { meaning: "What the rule checks." },
  "rules[].disposition": {
    meaning: "What happens when the answer doesn't meet the rule.",
    constraints: [
      {
        text: "One the operator allows. Every operator can be blocking; irs-id can only be blocking.",
        code: "inconsistent-disposition",
      },
    ],
  },
  "rules[].reasonCode": {
    meaning:
      "A stable code for this rule's outcome, recorded with the evaluation and named by scenarios.",
    constraints: [
      {
        text: "Capital letters, numbers and dashes, starting with a letter.",
        code: "invalid-value",
      },
      { text: "Unique among rules.", code: "duplicate-id" },
    ],
  },
  "rules[].guidance": {
    meaning:
      "What the employee should go do when the answer doesn't meet the rule. Shown beside the question and in the summary.",
    whenOmitted:
      "A blocking rule (other than irs-id) can't leave it out. On any other rule, the rule's message, or what's wrong, is shown instead.",
    constraints: [
      {
        text: "Required, and not just spaces, on a blocking rule other than irs-id.",
        code: "missing-guidance",
      },
    ],
    mvpDefault: () =>
      'Bootstrap guidance starts "[Placeholder wording]" until Safeguards supplies it',
  },
  "rules[].value": {
    meaning: 'equals only: the answer that fires the rule, "yes" or "no".',
    whenOmitted: SEE_OPERATOR,
    constraints: [
      { text: 'Exactly "yes" or "no".', code: "invalid-value" },
      { text: "Only on an equals rule.", code: "unknown-key" },
    ],
  },
  "rules[].message": {
    meaning: "equals only: what the flag says when the rule fires.",
    whenOmitted: SEE_OPERATOR,
    constraints: [{ text: "Only on an equals rule.", code: "unknown-key" }],
  },
  "rules[].timeline": {
    meaning: "within-timeline only: the timeline the date must fall in.",
    whenOmitted: SEE_OPERATOR,
    constraints: [
      { text: "A timeline defined under timelines.", code: "missing-reference" },
      { text: "Only on a within-timeline rule.", code: "unknown-key" },
    ],
  },
  "rules[].otherField": {
    meaning: "on-or-after only: the date question this date must not be before.",
    whenOmitted: SEE_OPERATOR,
    constraints: [
      { text: "A date question on the form.", code: "missing-reference" },
      { text: "Only on an on-or-after rule.", code: "unknown-key" },
    ],
  },
  scenarios: {
    meaning:
      "Synthetic test cases: answers, and the outcome they must produce. A definition can't be published until every scenario produces its declared outcome.",
    constraints: [
      {
        text: "At least one scenario expecting pass, one expecting blocking, and one for each disposition a rule uses.",
        code: "missing-scenario",
      },
      { text: "Every scenario produces its declared outcome.", code: "scenarios-failed" },
    ],
  },
  "scenarios[].id": {
    meaning: "The scenario's ID.",
    constraints: [{ text: "Unique among scenarios.", code: "duplicate-id" }],
  },
  "scenarios[].expect": {
    meaning:
      "The overall outcome the answers must produce: the most serious one of any rule they fail.",
  },
  "scenarios[].extends": {
    meaning:
      "Start from an earlier scenario's answers and days, then change only what this one lists.",
    whenOmitted: "Every answer not listed is blank.",
    constraints: [{ text: "An earlier scenario in the list.", code: "missing-reference" }],
  },
  "scenarios[].reasonCode": {
    meaning:
      "A reason code the outcome must include, so the scenario proves which rule fired, not just the outcome.",
    whenOmitted: "Only the outcome is checked.",
  },
  "scenarios[].formStartedAt": {
    meaning:
      "The day the employee started the form (a real YYYY-MM-DD date). Timelines anchored form-started count max back from it.",
    whenOmitted: "The day from the scenario it extends. A scenario that extends none must give it.",
    constraints: [
      { text: "Given, or inherited from the scenario it extends.", code: "invalid-value" },
      { text: "A real calendar date.", code: "invalid-value" },
    ],
  },
  "scenarios[].submittedAt": {
    meaning:
      "The day the answers are checked (a real YYYY-MM-DD date): what not-future, not-past, every timeline's min and evaluated-anchored timelines' max count from. Fixed, so a scenario's outcome doesn't depend on when it runs.",
    whenOmitted: "The day from the scenario it extends. A scenario that extends none must give it.",
    constraints: [
      { text: "Given, or inherited from the scenario it extends.", code: "invalid-value" },
      { text: "A real calendar date.", code: "invalid-value" },
    ],
  },
  "scenarios[].answers": {
    meaning: "The answers, by question ID. Dates are YYYY-MM-DD; yes-no answers are yes or no.",
    constraints: [
      {
        text: "Each key is a question's ID or the declaration agreement's.",
        code: "missing-reference",
      },
    ],
  },
};

type FieldSource = EirDefinitionSource["form"]["sections"][number]["fields"][number];
type ScenarioSource = EirDefinitionSource["scenarios"][number];

/** Each allowed value's meaning, by the key that takes it. */
const VALUES: Partial<Record<EirDefinitionKeyPath, Readonly<Record<string, string>>>> = {
  "form.sections[].fields[].type": {
    text: "Free text.",
    email: "An email address, like name@example.gov.",
    date: "A real calendar date.",
    "yes-no": "Yes or No.",
  } satisfies Record<FieldSource["type"], string>,
  "form.sections[].fields[].prefill": {
    email: "The employee's email address.",
    "first-name": "The employee's first name.",
    "last-name": "The employee's last name.",
  } satisfies Record<NonNullable<FieldSource["prefill"]>, string>,
  "form.sections[].fields[].size": {
    short: "A narrow box, for short answers like IDs.",
  } satisfies Record<NonNullable<FieldSource["size"]>, string>,
  "timelines[].anchor": {
    "form-started":
      "max counts back from the day the employee started the form (a scenario's formStartedAt).",
    evaluated: "max counts back from the day the EIR is checked (a scenario's submittedAt).",
  } satisfies Record<NonNullable<EirDefinitionSource["timelines"][number]["anchor"]>, string>,
  "timelines[].unit": {
    years:
      "Calendar years: the same day of the month, or the month's last day when it has none (29 February a year back is 28 February).",
    months:
      "Calendar months: the same day of the month, or the month's last day when it has none (31 August six months back is 28 February).",
    days: "Days.",
  } satisfies Record<EirDefinitionSource["timelines"][number]["unit"], string>,
  "scenarios[].expect": {
    pass: "No rule fires.",
    blocking: "At least one blocking rule fires, or an answer is missing or malformed.",
    warning: "The most serious rule that fires is a warning.",
    "manual-review": "The most serious rule that fires is manual-review.",
  } satisfies Record<ScenarioSource["expect"], string>,
};

/** A worked example of an operator, run through the real evaluator by the tests. */
export interface EirOperatorExample {
  answer: string;
  /** on-or-after: the other date question's answer. */
  otherAnswer?: string;
  /** equals: the rule's value. */
  value?: "yes" | "no";
  /** within-timeline: the rule's timeline. */
  timeline?: {
    anchor: "form-started" | "evaluated";
    unit: "years" | "months" | "days";
    min: number;
    max: number;
  };
  formStartedAt: string;
  submittedAt: string;
  meets: boolean;
}

interface OperatorInfo {
  checks: string;
  /** The keys the operator needs besides id, field, operator, disposition and reason code. */
  needs: string;
  /** The rule string stored on each question it checks (the evaluator's form, `fieldRule`). */
  recordedAs: string;
  examples: readonly EirOperatorExample[];
}

const DAY = { formStartedAt: "2026-10-14", submittedAt: "2026-10-20" } as const;
const YEARLY = { anchor: "evaluated", unit: "years", min: 0, max: 1 } as const;
const YEARLY_FROM_START = { anchor: "form-started", unit: "years", min: 0, max: 1 } as const;

const OPERATORS: Record<EirRuleOperator, OperatorInfo> = {
  "irs-id": {
    checks:
      "The answer is an IRS user ID: 3 to 12 letters and numbers. An answer that isn't one is a form error, so it always blocks.",
    needs: "Nothing else.",
    recordedAs: "irs-id",
    examples: [
      { answer: "A1", ...DAY, meets: false },
      { answer: "A1B", ...DAY, meets: true },
      { answer: "A1B-2", ...DAY, meets: false },
    ],
  },
  equals: {
    checks:
      "Fires when the answer is the rule's value: value is the answer that needs attention, not the one required.",
    needs: "value (yes or no) and message.",
    recordedAs: "none: a yes-no flag on the question",
    examples: [
      { answer: "yes", value: "yes", ...DAY, meets: false },
      { answer: "no", value: "yes", ...DAY, meets: true },
    ],
  },
  "within-timeline": {
    checks:
      "The date falls inside the rule's timeline: no later than min units before the day the EIR is checked, and no earlier than max units before the timeline's anchor. Both ends count as inside. A blank date fires the rule.",
    needs: "timeline.",
    recordedAs: "within-timeline:<anchor>:<unit>:<min>:<max>",
    examples: [
      { answer: "2025-10-19", ...DAY, timeline: YEARLY, meets: false },
      { answer: "2025-10-20", ...DAY, timeline: YEARLY, meets: true },
      { answer: "2026-10-20", ...DAY, timeline: YEARLY, meets: true },
      { answer: "2026-10-21", ...DAY, timeline: YEARLY, meets: false },
      { answer: "2025-10-13", ...DAY, timeline: YEARLY_FROM_START, meets: false },
      { answer: "2025-10-14", ...DAY, timeline: YEARLY_FROM_START, meets: true },
      { answer: "2026-10-21", ...DAY, timeline: YEARLY_FROM_START, meets: false },
      {
        answer: "2026-02-27",
        formStartedAt: "2026-08-31",
        submittedAt: "2026-08-31",
        timeline: { anchor: "evaluated", unit: "months", min: 0, max: 6 },
        meets: false,
      },
      {
        answer: "2026-02-28",
        formStartedAt: "2026-08-31",
        submittedAt: "2026-08-31",
        timeline: { anchor: "evaluated", unit: "months", min: 0, max: 6 },
        meets: true,
      },
    ],
  },
  "not-future": {
    checks: "The date isn't after the day the EIR is checked. That day itself meets it.",
    needs: "Nothing else.",
    recordedAs: "not-future",
    examples: [
      { answer: "2026-10-20", ...DAY, meets: true },
      { answer: "2026-10-21", ...DAY, meets: false },
    ],
  },
  "not-past": {
    checks:
      "The date isn't before the day the EIR is checked: an expiry date that day or later meets it, so something expiring today is still in date.",
    needs: "Nothing else.",
    recordedAs: "not-past",
    examples: [
      { answer: "2026-10-19", ...DAY, meets: false },
      { answer: "2026-10-20", ...DAY, meets: true },
    ],
  },
  "on-or-after": {
    checks:
      "The date isn't before another date question's answer. The same day meets it. If the other answer isn't a date, this rule doesn't fire.",
    needs: "otherField.",
    recordedAs: "on-or-after:<otherField>",
    examples: [
      { answer: "2026-01-09", otherAnswer: "2026-01-10", ...DAY, meets: false },
      { answer: "2026-01-10", otherAnswer: "2026-01-10", ...DAY, meets: true },
    ],
  },
};

/** What a disposition does, as data the tests check against the repository. */
export interface EirDispositionEffect {
  pdf: "refused" | "allowed";
  upload: "refused" | "allowed";
  automaticValidityEligible: boolean;
}

interface DispositionInfo extends EirDispositionEffect {
  meaning: string;
}

const DISPOSITIONS: Record<EirDisposition, DispositionInfo> = {
  blocking: {
    meaning:
      "A hard stop. The employee sees the rule's guidance beside the question and must change the answer before going on.",
    pdf: "refused",
    upload: "refused",
    automaticValidityEligible: false,
  },
  "manual-review": {
    meaning: "The employee can go on, but a Safeguards validator must look at the EIR.",
    pdf: "allowed",
    upload: "allowed",
    automaticValidityEligible: false,
  },
  warning: {
    meaning: "Recorded and shown, but doesn't stop anything.",
    pdf: "allowed",
    upload: "allowed",
    automaticValidityEligible: true,
  },
};

const DIAGNOSTICS: Record<EirDefinitionDiagnosticCode, string> = {
  "parse-error":
    "The YAML can't be read: a syntax error, a key written twice, or more (or less) than one document.",
  "unsafe-yaml":
    "The YAML uses a feature that's refused: an anchor (&), alias (*), merge key (<<), tag (!) or ${...} value. Write the values out.",
  "unknown-key":
    "A key this reference doesn't list, or a rule key its operator doesn't take (value on a not-past rule, say).",
  "server-assigned-version": `The YAML names its own version (${EIR_SERVER_ASSIGNED_KEYS.join(" or ")}). The server assigns the version: delete the key, and publishing numbers the definition for you.`,
  "invalid-value":
    "A required key is missing, or a value is the wrong type, isn't an allowed value, or is out of range. Also: a rule on a question type its operator can't check, or missing a key its operator needs.",
  "duplicate-id":
    "An ID or reason code is used twice, a layout places a question twice, or a question has two rules with the same operator.",
  "missing-reference":
    "Something refers to what isn't there: a rule's question, timeline or other date; a layout's question; a scenario's extends or answer.",
  "timeline-bounds": `A timeline's min is more than its max, or its max goes back further than the app supports: more than ${TIMELINE_CAPS}.`,
  "inconsistent-disposition": "A rule's disposition is one its operator doesn't allow.",
  "missing-scenario": "No scenario expects one of the outcomes the definition can produce.",
  "missing-guidance":
    "A blocking rule has no guidance telling the employee what to do. Guidance that's only spaces counts as none. irs-id rules are exempt: their form error already says what to do.",
  unavailable:
    "Validate and publishing never raise this. The app raises it when it can't read its own bootstrap definition file: the EIR form is then unavailable to employees. Nothing you wrote caused it: tell the EDP team.",
};

const REFUSALS: Record<EirDefinitionRefusalCode, string> = {
  "definition-too-large": `The YAML is over ${MAX_EIR_DEFINITION_BYTES / 1024} KB (UTF-8). It isn't checked or published.`,
  "definition-invalid": "Publish refused: the definition has problems. Validate it to see them.",
  "scenarios-failed":
    "Publish or activate refused: a scenario doesn't produce its declared outcome.",
  "already-published": "Publish refused: exactly this YAML is already a published version.",
  "definition-unloadable":
    "Activate refused: the stored version no longer loads, or no longer matches what was published.",
  "already-active": "Activate refused: that version is already active.",
  "version-conflict":
    "Someone else published or activated since you opened the page. Reload to see the latest.",
  "idempotency-key-reused":
    "A retried request asked for something different. Reload and try again.",
  "not-found": "That published version doesn't exist.",
  forbidden: "Only Safeguards can publish or activate. EDP staff can read.",
  "eir-unavailable": "EIR definitions can't be reached right now. Try again later.",
};

/** What there is to know about versions (#224), none of it a key. */
export const EIR_VERSION_TOPICS = [
  "numbered-on-publish",
  "drafts-keep-their-version",
  "built-in-names",
  "one-version-number",
] as const;
export type EirVersionTopic = (typeof EIR_VERSION_TOPICS)[number];

const builtInNames = BUILT_IN_DEFINITION_IDS.map(definitionLabel);
const listed = (items: readonly string[], conjunction = "and") =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`
    : items.join("");

const VERSIONS: Record<EirVersionTopic, { title: string; text: string }> = {
  "numbered-on-publish": {
    title: "Each publish is numbered automatically",
    text: "The server numbers every published version in order: 1, 2, 3 and so on. You don't choose the number and the YAML doesn't name one.",
  },
  "drafts-keep-their-version": {
    title: "A draft keeps the version it started on",
    text: "An employee's EIR draft stays on the definition version that was active when they started it, even after another version is activated. Only new drafts use the newly active version.",
  },
  "built-in-names": {
    title: "Built-in definitions have reserved names",
    text: `The app ships with built-in definitions, shown as ${listed(builtInNames)}. Version 0 means built in, never published. Publishing numbers from 1, so it can never assign one of these. While no published version is active, new drafts use ${definitionLabel(FALLBACK_BUILT_IN_ID)}.`,
  },
  "one-version-number": {
    title: "There is only one version number",
    text: `Definitions used to have a definition version and a separate form version. That distinction is gone: the number publishing assigns is the only one, and it's what the form and the PDF show. A definition that still has ${listed(EIR_SERVER_ASSIGNED_KEYS, "or")} is refused until you delete it.`,
  },
};

/** A minimal valid definition. The tests load it and run its scenarios. */
const EXAMPLE = `validityDays: 365
reviewSlaBusinessDays: 3
form:
  title: Example EIR
  intro: Why we ask.
  trainingRule: Training is yearly.
  sections:
    - id: user
      title: User details
      fields:
        - id: userId
          label: User ID
          type: text
          required: true
  declaration:
    text: I declare these answers are true.
    attestation:
      id: declarationAgreed
      label: I agree
timelines: []
rules:
  - id: user-id-format
    field: userId
    operator: irs-id
    disposition: blocking
    reasonCode: EIR-USER-ID-FORMAT
scenarios:
  - id: passes
    expect: pass
    formStartedAt: "2026-10-14"
    submittedAt: "2026-10-14"
    answers:
      userId: A1B2C
      declarationAgreed: "yes"
  - id: bad-user-id
    expect: blocking
    extends: passes
    reasonCode: EIR-USER-ID-FORMAT
    answers:
      userId: A1
`;

export interface EirReferenceValue {
  value: string;
  meaning: string;
  /** An operator or disposition's own entry. */
  anchor?: string;
}

export interface EirReferenceKey {
  path: string;
  anchor: string;
  /** In words: "Text", "Whole number from 1 to 3650", "List of …". */
  type: string;
  required: boolean;
  meaning: string;
  whenOmitted?: string;
  values?: EirReferenceValue[];
  constraints: EirReferenceConstraint[];
  /** The bootstrap's value, when it's a non-production MVP default (#148). */
  mvpDefault?: string;
}

export interface EirReferenceOperator {
  name: EirRuleOperator;
  anchor: string;
  checks: string;
  fieldTypes: readonly string[];
  dispositions: readonly EirDisposition[];
  needs: string;
  recordedAs: string;
  examples: readonly EirOperatorExample[];
}

export interface EirReferenceDisposition extends EirDispositionEffect {
  name: EirDisposition;
  anchor: string;
  meaning: string;
}

export interface EirReferenceVersionNote {
  topic: EirVersionTopic;
  anchor: string;
  title: string;
  text: string;
}

export interface EirReferenceCodeEntry {
  code: EirReferenceCode;
  anchor: string;
  /** check: shown under the editor by Validate; publish: refuses a publish or activate. */
  kind: "check" | "publish";
  meaning: string;
}

export interface EirSchemaReference {
  keys: EirReferenceKey[];
  operators: EirReferenceOperator[];
  dispositions: EirReferenceDisposition[];
  codes: EirReferenceCodeEntry[];
  /** Rules for the definition as a whole. */
  definitionRules: EirReferenceConstraint[];
  /** How versions are numbered and kept (#224). */
  versions: EirReferenceVersionNote[];
  example: string;
}

const slug = (text: string) => text.replace(/\[\]/g, "").replace(/[^A-Za-z0-9-]+/g, "-");

export const eirReferenceKeyAnchor = (path: string) => `eir-ref-key-${slug(path)}`;
export const eirReferenceCodeAnchor = (code: string) => `eir-ref-code-${code}`;
const operatorAnchor = (name: string) => `eir-ref-operator-${name}`;
const dispositionAnchor = (name: string) => `eir-ref-disposition-${name}`;
const versionAnchor = (topic: string) => `eir-ref-version-${topic}`;

/** The key a diagnostic's path is about (`["rules", 3, "operator"]` → `rules[].operator`), if any. */
export function eirReferenceKeyFor(path: readonly (string | number)[]): string | undefined {
  let found: string | undefined;
  let current = "";
  for (const part of path) {
    current = typeof part === "number" ? `${current}[]` : current ? `${current}.${part}` : part;
    if (current in KEYS) found = current;
    else if (typeof part !== "number") break;
  }
  return found;
}

type Schema = z.ZodTypeAny;

const unwrap = (schema: Schema): { schema: Schema; optional: boolean } =>
  schema instanceof z.ZodOptional
    ? { schema: unwrap(schema.unwrap()).schema, optional: true }
    : { schema, optional: false };

function bounds(schema: z.ZodNumber): string {
  let min: number | undefined;
  let max: number | undefined;
  for (const check of schema._def.checks) {
    if (check.kind === "min") min = check.inclusive ? check.value : check.value + 1;
    if (check.kind === "max") max = check.inclusive ? check.value : check.value - 1;
  }
  if (min !== undefined && max !== undefined) return ` from ${min} to ${max}`;
  if (min !== undefined) return ` of ${min} or more`;
  return "";
}

function typeOf(schema: Schema): string {
  const inner = unwrap(schema).schema;
  if (inner === EIR_DEFINITION_SCALARS.id) return `ID (${ID_CODES})`;
  if (inner === EIR_DEFINITION_SCALARS.day) return "Date, YYYY-MM-DD";
  if (inner === EIR_DEFINITION_SCALARS.reasonCode) return "Reason code";
  if (inner instanceof z.ZodString) return "Text";
  if (inner instanceof z.ZodBoolean) return "true or false";
  if (inner instanceof z.ZodNumber) {
    const whole = inner._def.checks.some((check) => check.kind === "int");
    return `${whole ? "Whole number" : "Number"}${bounds(inner)}`;
  }
  if (inner instanceof z.ZodEnum) return "One of the values below";
  if (inner instanceof z.ZodObject) return "Group of keys";
  if (inner instanceof z.ZodRecord) return "Map of question ID to answer";
  if (inner instanceof z.ZodArray) {
    const element = typeOf(inner.element);
    const atLeastOne = inner._def.minLength?.value ? ", at least one" : "";
    return `List${atLeastOne} of: ${element.charAt(0).toLowerCase()}${element.slice(1)}`;
  }
  throw new Error(`The schema reference can't describe this type (${inner.constructor.name}).`);
}

function valuesOf(path: string, schema: Schema): EirReferenceValue[] | undefined {
  const inner = unwrap(schema).schema;
  if (!(inner instanceof z.ZodEnum)) return undefined;
  const options = inner.options as string[];
  const meaningOf = (value: string): EirReferenceValue => {
    if (path === "rules[].operator") {
      const operator = OPERATORS[value as EirRuleOperator];
      if (operator) return { value, meaning: operator.checks, anchor: operatorAnchor(value) };
    }
    if (path === "rules[].disposition") {
      const disposition = DISPOSITIONS[value as EirDisposition];
      if (disposition) {
        return { value, meaning: disposition.meaning, anchor: dispositionAnchor(value) };
      }
    }
    const meaning = VALUES[path as EirDefinitionKeyPath]?.[value];
    if (!meaning)
      throw new Error(`The schema reference has no meaning for ${path} value "${value}".`);
    return { value, meaning };
  };
  return options.map(meaningOf);
}

/** The schema's keys, depth first in schema order, each with its meaning. */
function keysOf(schema: z.AnyZodObject, bootstrap: EirDefinition | undefined): EirReferenceKey[] {
  const keys: EirReferenceKey[] = [];
  const walk = (object: z.AnyZodObject, prefix: string) => {
    for (const [name, child] of Object.entries(object.shape as Record<string, Schema>)) {
      const path = prefix ? `${prefix}.${name}` : name;
      const info = (KEYS as Record<string, KeyInfo | undefined>)[path];
      if (!info) throw new Error(`The schema reference has no meaning for key ${path}.`);
      const { schema: inner, optional } = unwrap(child);
      if (optional && !info.whenOmitted) {
        throw new Error(`The schema reference doesn't say what leaving out ${path} does.`);
      }
      const values = valuesOf(path, child);
      const typed: EirReferenceConstraint[] =
        inner instanceof z.ZodNumber && bounds(inner)
          ? [{ text: `A whole number${bounds(inner)}.`, code: "invalid-value" }]
          : [];
      keys.push({
        path,
        anchor: eirReferenceKeyAnchor(path),
        type: typeOf(child),
        required: !optional,
        meaning: info.meaning,
        ...(info.whenOmitted ? { whenOmitted: info.whenOmitted } : {}),
        ...(values ? { values } : {}),
        constraints: [...typed, ...(info.constraints ?? [])],
        ...(info.mvpDefault && bootstrap ? { mvpDefault: info.mvpDefault(bootstrap) } : {}),
      });
      if (inner instanceof z.ZodObject) walk(inner, path);
      if (inner instanceof z.ZodArray && inner.element instanceof z.ZodObject) {
        walk(inner.element, `${path}[]`);
      }
    }
  };
  walk(schema, "");
  return keys;
}

/**
 * The schema reference, built from the checker's schema and tables. Throws
 * if any key, value, operator, disposition or code has no meaning.
 */
export function eirSchemaReference(
  schema: z.AnyZodObject = EIR_DEFINITION_SCHEMA,
): EirSchemaReference {
  const bootstrap = ACTIVE_EIR_DEFINITION.ok ? ACTIVE_EIR_DEFINITION.definition : undefined;
  const versions = EIR_VERSION_TOPICS.map((topic): EirReferenceVersionNote => {
    const note = VERSIONS[topic];
    if (!note) throw new Error(`The schema reference has no meaning for version topic ${topic}.`);
    return { topic, anchor: versionAnchor(topic), ...note };
  });
  const operators = (Object.keys(EIR_RULE_OPERATORS) as EirRuleOperator[]).map((name) => {
    const info = OPERATORS[name];
    if (!info) throw new Error(`The schema reference has no meaning for operator ${name}.`);
    return {
      name,
      anchor: operatorAnchor(name),
      checks: info.checks,
      fieldTypes: EIR_RULE_OPERATORS[name].types,
      dispositions: EIR_RULE_OPERATORS[name].dispositions,
      needs: info.needs,
      recordedAs: info.recordedAs,
      examples: info.examples,
    };
  });
  const describe = <C extends EirReferenceCode>(
    codes: readonly C[],
    meanings: Record<C, string>,
    kind: EirReferenceCodeEntry["kind"],
  ) =>
    codes.map((code): EirReferenceCodeEntry => {
      if (!meanings[code]) throw new Error(`The schema reference has no meaning for code ${code}.`);
      return { code, anchor: eirReferenceCodeAnchor(code), kind, meaning: meanings[code] };
    });
  return {
    keys: keysOf(schema, bootstrap),
    operators,
    dispositions: (Object.keys(DISPOSITIONS) as EirDisposition[]).map((name) => ({
      name,
      anchor: dispositionAnchor(name),
      ...DISPOSITIONS[name],
    })),
    codes: [
      ...describe(EIR_DEFINITION_DIAGNOSTIC_CODES, DIAGNOSTICS, "check"),
      ...describe(EIR_DEFINITION_REFUSAL_CODES, REFUSALS, "publish"),
    ],
    definitionRules: [
      {
        text: `At most ${MAX_EIR_DEFINITION_BYTES / 1024} KB of YAML (UTF-8). The bootstrap is about 10 KB.`,
        code: "definition-too-large",
      },
      { text: "Exactly one YAML document, with no key written twice.", code: "parse-error" },
      {
        text: "Plain data only: no anchors (&), aliases (*), merge keys (<<), tags (!) or ${...} values.",
        code: "unsafe-yaml",
      },
      { text: "Only the keys listed here.", code: "unknown-key" },
      {
        text: "IDs unique within their kind: sections; questions with the declaration's agreement; timelines; rules; reason codes; scenarios.",
        code: "duplicate-id",
      },
      {
        text: "Every reference resolves: a rule's question, timeline and other date; a layout's questions; a scenario's extends and answers.",
        code: "missing-reference",
      },
      { text: "Every blocking rule (other than irs-id) has guidance.", code: "missing-guidance" },
      {
        text: "Scenarios for pass, blocking and each disposition a rule uses.",
        code: "missing-scenario",
      },
      { text: "Every scenario produces its declared outcome.", code: "scenarios-failed" },
      {
        text: `No ${listed(EIR_SERVER_ASSIGNED_KEYS, "or")}: the server assigns the version.`,
        code: "server-assigned-version",
      },
    ],
    versions,
    example: EXAMPLE,
  };
}
