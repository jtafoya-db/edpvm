/**
 * The EIR form's rules, read from its configuration (`config.ts`). Pure, so
 * the screen, the in-memory repository and the server's submit command all
 * run exactly the same checks.
 *
 * - {@link validateEirAnswers}: what refuses a submission: a required answer
 *   missing (a compliance item is required, meaning answered: a date, or an
 *   explicit Yes or No), an email, ID or date that isn't one, an unknown
 *   answer, or the declaration not agreed.
 * - {@link eirFlags}: what a compliance answer's rules flag: any "no", a
 *   preliminary background investigation, a missing training date, a
 *   training date outside the year before the form was started (or after the
 *   day it was submitted), MBI dates in the wrong order or the future, and an
 *   MBI already expired. The definition gives each its disposition
 *   (`evaluation.ts`): flagged for the validator under `bootstrap` (form 1.3),
 *   blocking under `bootstrap-2` (#217).
 * - {@link answerSections}: the answers as labelled rows, for any stored form
 *   version, including legacy ones.
 *
 * Submitting and drafting use the current form; flags and answers follow the
 * version the answers were given under (`EIR_FORMS`).
 */
import {
  EIR_FORM,
  EIR_FORMS,
  LEGACY_EIR_FORMS,
  type EirFieldConfig,
  type EirFieldRule,
  type EirFormConfig,
  type EirSectionConfig,
} from "./config.ts";
import type { EirFormValues } from "./types.ts";
import { definitionLabel, eirFormName } from "./definition/identity.ts";

const SECTIONS: readonly EirSectionConfig[] = EIR_FORM.sections;
export const EIR_ATTESTATION_ID: string = EIR_FORM.declaration.attestation.id;

export const EIR_FIELDS: readonly EirFieldConfig[] = SECTIONS.flatMap((s) => s.fields);

/** Every answer the current form stores: its fields and the attestation. */
export const EIR_FIELD_IDS: readonly string[] = [
  ...EIR_FIELDS.map((field) => field.id),
  EIR_ATTESTATION_ID,
];

const FIELD_BY_ID = new Map(EIR_FIELDS.map((field) => [field.id, field]));
export const eirField = (id: string): EirFieldConfig | undefined => FIELD_BY_ID.get(id);

/** Forms from published EIR definitions (#201), as the server sent them. */
const PUBLISHED_FORMS = new Map<string, EirFormConfig>();

/** The structured form a version's answers were given under (1.2 or later), if any. */
export const eirFormFor = (version: string | undefined): EirFormConfig | undefined =>
  version ? (EIR_FORMS[version] ?? PUBLISHED_FORMS.get(version)) : undefined;

/**
 * Make a published definition's form known by its identity (its version
 * number, #224), so answers given under it show with its labels. A number
 * names one definition for good, so the server's latest answer only ever
 * replaces a form with itself; where a store starts over (a preview reset,
 * a test's fresh store) it's the latest answer that's true. The app's own
 * forms are never replaced.
 */
export function registerEirForm(form: EirFormConfig): void {
  if (!EIR_FORMS[form.version]) PUBLISHED_FORMS.set(form.version, form);
}

/** Answers under a structured form version, which the current form can open. */
export const isStructuredEirVersion = (version: string | undefined): boolean =>
  Boolean(eirFormFor(version));

const fieldsOf = (form: EirFormConfig): readonly EirFieldConfig[] =>
  form.sections.flatMap((section) => section.fields);

/** The answer IDs `form` stores: its fields, then the attestation. */
export const answerIdsOn = (form: EirFormConfig): string[] => [
  ...fieldsOf(form).map((field) => field.id),
  form.declaration.attestation.id,
];

/** A blank current form. */
export function emptyEirAnswers(): EirFormValues {
  return Object.fromEntries(EIR_FIELD_IDS.map((id) => [id, ""]));
}

/** What the session (SCIM `/Me`) knows about the signed-in person. */
export interface EirSessionPrefill {
  name?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
}

/**
 * A blank form with what the session knows: the work email and the first and
 * last name (SCIM's name parts, else the display name split at its first
 * space). All stay editable.
 */
export function prefilledEirAnswers(session: EirSessionPrefill): EirFormValues {
  return prefilledAnswersOn(EIR_FORM, session);
}

/** A blank `form` (#201: a published definition's, say). */
export function emptyAnswersOn(form: EirFormConfig): EirFormValues {
  return Object.fromEntries(
    [...fieldsOf(form).map((field) => field.id), form.declaration.attestation.id].map((id) => [
      id,
      "",
    ]),
  );
}

/** {@link prefilledEirAnswers} on a given form. */
export function prefilledAnswersOn(form: EirFormConfig, session: EirSessionPrefill): EirFormValues {
  const answers = emptyAnswersOn(form);
  const words = session.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const first = session.givenName?.trim() || words[0] || "";
  const last = session.familyName?.trim() || (session.givenName ? "" : words.slice(1).join(" "));
  for (const field of fieldsOf(form)) {
    if (field.prefill === "email" && session.email) answers[field.id] = session.email;
    if (field.prefill === "first-name") answers[field.id] = first;
    if (field.prefill === "last-name") answers[field.id] = last;
  }
  return answers;
}

/** The answers as they're stored: every current-form key, trimmed. */
export function normalizeEirAnswers(values: EirFormValues): EirFormValues {
  const answers = emptyEirAnswers();
  for (const id of EIR_FIELD_IDS) answers[id] = (values[id] ?? "").trim();
  return answers;
}

/** {@link normalizeEirAnswers} on a given form: one a published EIR definition (#201) supplies. */
export function normalizeAnswersOn(form: EirFormConfig, values: EirFormValues): EirFormValues {
  const ids = [...fieldsOf(form).map((field) => field.id), form.declaration.attestation.id];
  return Object.fromEntries(ids.map((id) => [id, (values[id] ?? "").trim()]));
}

export interface EirFieldError {
  field: string;
  message: string;
  /** Set when a field rule (not a blank or malformed answer) refused it: `irs-id`. */
  rule?: EirFieldRule;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IRS_ID = /^[A-Za-z0-9]{3,12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` in UTC. */
export function isoDay(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDay(parsed) === value;
}

type TimelineUnit = "years" | "months" | "days";

type TimelineAnchor = "form-started" | "evaluated";

/** A training rule's window and anchor; form 1.2's `training-date` is a year from the form's start. */
function timelineOf(
  rule: EirFieldRule,
): { anchor: TimelineAnchor; unit: TimelineUnit; min: number; max: number } | undefined {
  if (rule === "training-date") return { anchor: "form-started", unit: "years", min: 0, max: 1 };
  const match = /^within-timeline:(form-started|evaluated):(years|months|days):(\d+):(\d+)$/.exec(
    rule,
  );
  return match
    ? {
        anchor: match[1] as TimelineAnchor,
        unit: match[2] as TimelineUnit,
        min: Number(match[3]),
        max: Number(match[4]),
      }
    : undefined;
}

/** "1 day", "2 years". */
const count = (n: number, unit: TimelineUnit) => `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;

/**
 * `day` moved back `n` units (UTC). Years and months keep the day of the
 * month, or the target month's last day when it has none (29 February a year
 * back is 28 February; 31 August six months back is 28 February).
 */
export function daysBefore(day: string, n: number, unit: TimelineUnit): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  if (unit === "days") return isoDay(new Date(Date.UTC(year, month - 1, date - n)));
  const months = unit === "years" ? n * 12 : n;
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date, last));
  return isoDay(target);
}

/** The same calendar day one year earlier (29 February → 28 February). */
export function oneYearBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const candidate = new Date(Date.UTC(year - 1, month - 1, date));
  if (candidate.getUTCMonth() !== month - 1) candidate.setUTCDate(0);
  return isoDay(candidate);
}

/** A `YYYY-MM-DD` day as people read it (always the same day, whatever the time zone). */
export const formatEirDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC" });

/** A label inside a sentence: "Team or Project" → "team or project", keeping acronyms ("User ID" → "user ID"). */
const inSentence = (text: string) =>
  text
    .split(" ")
    .map((word) => (/^[A-Z0-9]{2,}\b/.test(word) ? word : word.toLowerCase()))
    .join(" ");

/**
 * Every reason the answers can't be submitted on the current form, in form order. Empty
 * means they can be. Unknown answers are refused, so an out-of-date client
 * can't store fields the form doesn't have.
 */
export function validateEirAnswers(values: EirFormValues): EirFieldError[] {
  return validateAnswersOn(EIR_FORM, values);
}

/** {@link validateEirAnswers} on a given form: an EIR definition's scenarios run on their own. */
export function validateAnswersOn(form: EirFormConfig, values: EirFormValues): EirFieldError[] {
  const fields = fieldsOf(form);
  const attestationId = form.declaration.attestation.id;
  const ids = [...fields.map((field) => field.id), attestationId];
  const errors: EirFieldError[] = [];
  for (const key of Object.keys(values)) {
    if (!ids.includes(key)) {
      errors.push({
        field: key,
        message: `${key} isn't on the EIR form for ${definitionLabel(form.version)}.`,
      });
    }
  }
  const answers = Object.fromEntries(ids.map((id) => [id, (values[id] ?? "").trim()]));
  for (const field of fields) {
    const value = answers[field.id] ?? "";
    const fail = (message: string, rule?: EirFieldRule) =>
      errors.push({ field: field.id, message, ...(rule ? { rule } : {}) });
    if (!value) {
      if (field.required) {
        // Required means answered: a yes/no needs an explicit choice.
        fail(
          field.kind === "yes-no"
            ? `Choose Yes or No: ${field.label}`
            : `Enter ${inSentence(field.label)}.`,
        );
      }
      continue;
    }
    if (value.length > (field.maxLength ?? (field.kind === "email" ? 254 : 200))) {
      fail(`${field.label} is too long.`);
    } else if (field.kind === "email" && !EMAIL.test(value)) {
      fail(`${field.label}: enter an email address like name@example.gov.`);
    } else if (field.kind === "yes-no" && value !== "yes" && value !== "no") {
      fail(`${field.label}: choose yes or no.`);
    } else if (field.kind === "date" && !isRealDate(value)) {
      fail(`${field.label}: enter a real date.`);
    } else if (field.rule === "irs-id" && !IRS_ID.test(value)) {
      fail(`${field.label}: use 3 to 12 letters and numbers, like A1B2C.`, "irs-id");
    }
  }
  if (answers[attestationId] !== "yes") {
    errors.push({
      field: attestationId,
      message: "Agree to the declaration before you submit.",
    });
  }
  return errors;
}

/** The refusal the server and the in-memory store give for invalid answers. */
export function describeEirErrors(errors: EirFieldError[]): string {
  return `Check these answers: ${errors.map((error) => error.message).join(" ")}`;
}

export interface EirFlag {
  field: string;
  label: string;
  text: string;
  /** The field rule that raised it; none for a yes/no answer's `flagWhen`. */
  rule?: EirFieldRule;
}

/** Every rule a field has: one, several (#217), or none. */
const rulesOf = (field: EirFieldConfig): readonly EirFieldRule[] =>
  field.rules ?? (field.rule ? [field.rule] : []);

/** When the answers were given: the form's start (the training rule) and the submission. */
export interface EirFlagContext {
  /** When the person started this form; the training rule counts back a year from it. */
  formStartedAt?: string | undefined;
  /** When the answers were submitted (or now, for a draft): "not in the future". */
  submittedAt?: string | undefined;
}

/**
 * What the validator view highlights in structured answers (form 1.2 or
 * later), by their own version's fields. Legacy answers have no compliance
 * questions, so no flags.
 */
export function eirFlags(
  values: EirFormValues | undefined,
  version: string | undefined,
  context: EirFlagContext,
): EirFlag[] {
  const form = eirFormFor(version);
  if (!values || !form) return [];
  return flagsOn(form, values, context);
}

/** {@link eirFlags} on a given form: an EIR definition's scenarios run on their own. */
export function flagsOn(
  form: EirFormConfig,
  values: EirFormValues,
  context: EirFlagContext,
): EirFlag[] {
  const fields = fieldsOf(form);
  const submitted = isoDay(context.submittedAt ?? new Date());
  const started = isoDay(context.formStartedAt ?? context.submittedAt ?? new Date());
  const flags: EirFlag[] = [];
  for (const field of fields) {
    const value = values[field.id] ?? "";
    if (field.kind === "yes-no" && field.flagWhen && value === field.flagWhen) {
      flags.push({
        field: field.id,
        label: field.label,
        text: field.flagText ?? `Answered ${value}`,
      });
    }
    if (field.kind !== "date") continue;
    for (const rule of rulesOf(field)) {
      const flag = (text: string) =>
        flags.push({ field: field.id, label: field.label, text, rule });
      const window = timelineOf(rule);
      if (window && !value) {
        flag("No training date given");
        continue;
      }
      if (!isRealDate(value)) continue;
      if (window) {
        // Both ends included (UTC): `max` back from the anchor, `min` back from the day it's checked.
        const fromStart = window.anchor === "form-started";
        const earliest = daysBefore(fromStart ? started : submitted, window.max, window.unit);
        const latest = daysBefore(submitted, window.min, window.unit);
        const checked = fromStart ? "the form was submitted" : "the day it was checked";
        if (value > latest) {
          flag(
            window.min === 0
              ? `Dated after ${checked} (${formatEirDay(submitted)})`
              : `Dated after ${formatEirDay(latest)}: it should be at least ${count(window.min, window.unit)} before ${checked}`,
          );
        } else if (value < earliest) {
          flag(
            fromStart && window.unit === "years" && window.max === 1
              ? `More than a year before the form was started: training is yearly, so it should be dated ${formatEirDay(earliest)} or later`
              : `More than ${count(window.max, window.unit)} before ${fromStart ? "the form was started" : "the day it was checked"}: it should be dated ${formatEirDay(earliest)} or later`,
          );
        }
      } else if (rule === "not-future" && value > submitted) {
        flag(`Dated after the form was submitted (${formatEirDay(submitted)})`);
      } else if (rule === "not-past" && value < submitted) {
        flag(`Expired: dated before the day it was checked (${formatEirDay(submitted)})`);
      } else if (rule.startsWith("on-or-after:")) {
        const otherId = rule.slice("on-or-after:".length);
        const other = values[otherId] ?? "";
        if (isRealDate(other) && value < other) {
          const otherLabel = fields.find((other) => other.id === otherId)?.label ?? otherId;
          flag(`Before the ${inSentence(otherLabel.replace(/^Your /, ""))}`);
        }
      }
    }
  }
  return flags;
}

export interface EirAnswerRow {
  field: string;
  label: string;
  value: string;
  flags: string[];
}

export interface EirAnswerSection {
  id: string;
  title: string;
  rows: EirAnswerRow[];
}

/** How an answer reads on screen and in the PDF. */
export function displayAnswer(
  field: Pick<EirFieldConfig, "kind"> | undefined,
  value: string,
): string {
  if (!value) return "Not answered";
  if (field?.kind === "yes-no") return value === "yes" ? "Yes" : value === "no" ? "No" : value;
  if (field?.kind === "date" && isRealDate(value)) return formatEirDay(value);
  return value;
}

export interface EirAnswers {
  version: string;
  legacy: boolean;
  /** "EIR form 1.2", "EIR definition version 7", or a legacy version's name. */
  name: string;
  sections: EirAnswerSection[];
}

/**
 * Answers as labelled sections for any stored form version. A structured
 * version (1.2 or later) follows its own sections and labels and ends with
 * the declaration; pass `flags` to mark the rows
 * the validator should look at. A legacy version shows its own labels, and an
 * answer no version knows is listed as it was stored.
 */
export function answerSections(
  values: EirFormValues,
  version: string | undefined,
  options: { flags?: EirFlag[]; form?: EirFormConfig } = {},
): EirAnswers {
  // A published definition's form (#201) can be passed whole: the server knows no registry.
  const form = options.form?.version === version ? options.form : eirFormFor(version);
  if (version && form) {
    const flagsOf = (id: string) =>
      (options.flags ?? []).filter((flag) => flag.field === id).map((flag) => flag.text);
    const sections: EirAnswerSection[] = form.sections.map((section) => ({
      id: section.id,
      title: section.title,
      rows: section.fields.map((field) => ({
        field: field.id,
        label: field.label,
        value: displayAnswer(field, values[field.id] ?? ""),
        flags: flagsOf(field.id),
      })),
    }));
    sections.push({
      id: "declaration",
      title: "Declaration",
      rows: [
        {
          field: form.declaration.attestation.id,
          label: form.declaration.attestation.label,
          value: values[form.declaration.attestation.id] === "yes" ? "Yes" : "Not agreed",
          flags: [],
        },
      ],
    });
    return { version, legacy: false, name: eirFormName(version), sections };
  }
  const legacy = version ? LEGACY_EIR_FORMS[version] : undefined;
  const known = new Set(legacy?.fields.map((field) => field.id));
  const rows: EirAnswerRow[] = [
    ...(legacy?.fields ?? []).map((field) => ({
      field: field.id,
      label: field.label,
      value: displayAnswer(undefined, values[field.id] ?? ""),
      flags: [],
    })),
    ...Object.entries(values)
      .filter(([id]) => !known.has(id))
      .map(([id, value]) => ({
        field: id,
        label: id,
        value: displayAnswer(undefined, value),
        flags: [],
      })),
  ];
  return {
    version: version ?? "unknown",
    legacy: true,
    name: legacy
      ? `${legacy.name}, form ${version}`
      : `Unknown form version ${version ?? ""}`.trim(),
    sections: [{ id: "legacy", title: "Legacy answers", rows }],
  };
}
