/**
 * The EIR form, as configuration: EDP's "Employee Identity Record (EIR)" form.
 * Sections, labels, help text, required flags, validation rules and the
 * layout all come from here; the screens, the generated PDF, the validator
 * view and the server's submit command read it (through `form.ts`). The
 * current form is the fallback built-in EIR definition's
 * (`definition/bootstrap-2.eir.yaml`, #217), under its reserved identity
 * `bootstrap-2` (#224): the bootstrap definition's questions with every rule
 * blocking. The bootstrap definition (`definition/bootstrap.eir.yaml`, #200,
 * identity `bootstrap`; form 1.3 before #224) stays loaded for its drafts.
 * Earlier versions are below.
 *
 * Decisions (human, 2026-10-06): the header shows only the Record ID and the
 * form version; the person types their manager; there's no alternative
 * manager and no live-data-waiver question (submitting the EIR is the
 * waiver); and the signed PDF and the attestation stay. A compliance
 * answer that fails its rule is flagged (`flagWhen`, and the date rules in
 * `form.ts`) with its definition's disposition: under form 1.3 the validator
 * sees it; under `bootstrap-2` every rule blocks (#217).
 *
 * Form 1.3 (human, UAT round 5): Contracting Company is optional (not everyone
 * is a contractor), and every compliance item is required, meaning answered:
 * a date given, or an explicit Yes or No. Under form 1.3 a "No" or an old
 * training date still submits, flagged for the validator. Labels are in
 * sentence case.
 *
 * Answers are stored with the identity of the definition they were given
 * under (`eir_submissions.form_version`, `definition/identity.ts`): a
 * published version's number, `bootstrap`, or a form version from before
 * #224. So older answers keep showing with their own labels and rules
 * (`EIR_FORMS`, `LEGACY_EIR_FORMS`, and the published forms the server sends).
 */

import { ACTIVE_EIR_DEFINITION, BUILT_IN_DEFINITIONS } from "./definition/active.ts";
import { BOOTSTRAP_DEFINITION_ID, LEGACY_BOOTSTRAP_FORM_VERSION } from "./definition/identity.ts";
import type { EirDefinitionDiagnostic, EirDisposition } from "./definition/types.ts";

export type EirFieldKind = "text" | "email" | "date" | "yes-no";

/**
 * How a field is checked beyond required and kind:
 * - `irs-id` (refused if wrong): an IRS user ID (SEID-style: short, letters
 *   and numbers).
 * - The date rules, flagged with the disposition their definition gives
 *   them (#217: blocking, in bootstrap-2): `within-timeline:<anchor>:<unit>:<min>:<max>`,
 *   a certificate dated from `max` units before the anchor (the form's start,
 *   or the day it's checked) up to `min` units before the day it's checked
 *   (`training-date`, form 1.2's, is form-started years 0 to 1); the day
 *   it was submitted; `not-future`; `not-past`, not before the day it's
 *   checked (an expired MBI); and `on-or-after:<field>`, not before another
 *   date.
 */
export type EirFieldRule =
  | "irs-id"
  | "training-date"
  | `within-timeline:${"form-started" | "evaluated"}:${"years" | "months" | "days"}:${number}:${number}`
  | "not-future"
  | "not-past"
  | `on-or-after:${string}`;

export interface EirFieldConfig {
  id: string;
  label: string;
  kind: EirFieldKind;
  required: boolean;
  help?: string;
  rule?: EirFieldRule;
  /** Every rule on the field, when it has more than one (`rule` is the first). */
  rules?: readonly EirFieldRule[];
  /** A yes/no answer that's flagged, with its definition's disposition. */
  flagWhen?: "yes" | "no";
  /** What the flag says. */
  flagText?: string;
  /** Pre-filled from the signed-in session. */
  prefill?: "email" | "first-name" | "last-name";
  maxLength?: number;
  /** A short answer (an ID, a date): its input isn't stretched across the row. */
  size?: "short";
  /** From an EIR definition (#200): the rule on this field, its disposition and reason code. */
  ruleId?: string;
  disposition?: EirDisposition;
  reasonCode?: string;
}

/**
 * How a section's fields sit on the page: blocks of rows, each row's fields
 * side by side on a wide screen and stacked on a narrow one. A block with a
 * legend is its own group (a fieldset), with one hint for all its fields.
 */
export interface EirLayoutBlock {
  legend?: string;
  hint?: string;
  rows: readonly (readonly string[])[];
}

export interface EirSectionConfig {
  id: string;
  title: string;
  help?: string;
  fields: readonly EirFieldConfig[];
  layout?: readonly EirLayoutBlock[];
}

export interface EirFormConfig {
  version: string;
  title: string;
  intro: string;
  trainingRule: string;
  sections: readonly EirSectionConfig[];
  declaration: { text: string; attestation: { id: string; label: string } };
}

// Form 1.2's training help, shown on each date.
const TRAINING_HELP =
  "Training is required every year: the certificate date should be within the year before you started this form, and not in the future.";

/** Form 1.2, as it was: answers given under it show with these labels and rules. */
export const EIR_FORM_1_2 = {
  version: "1.2",
  title: "Enterprise Data Platform - Employee Identity Record (EIR)",
  intro:
    "EDP will use this document and the answers you provide to establish your identity, and to align you and any access requests you submit.",
  trainingRule: TRAINING_HELP,
  sections: [
    {
      id: "user",
      title: "User details",
      fields: [
        {
          id: "userId",
          label: "User ID",
          kind: "text",
          required: true,
          rule: "irs-id",
          help: "Your IRS user ID (SEID). This isn't your Databricks account ID.",
          maxLength: 12,
        },
        {
          id: "workEmail",
          label: "Work Email",
          kind: "email",
          required: true,
          prefill: "email",
        },
        {
          id: "firstName",
          label: "First Name",
          kind: "text",
          required: true,
          prefill: "first-name",
        },
        { id: "lastName", label: "Last Name", kind: "text", required: true, prefill: "last-name" },
        { id: "team", label: "Team or Project", kind: "text", required: true },
        { id: "subTeam", label: "Sub-Team / Sub-Project", kind: "text", required: false },
        { id: "contractingCompany", label: "Contracting Company", kind: "text", required: true },
      ],
    },
    {
      id: "manager",
      title: "Listed manager",
      help: "Enter your current manager. They must be an IRS full-time employee who can certify your identity.",
      fields: [
        {
          id: "managerId",
          label: "Manager's ID",
          kind: "text",
          required: true,
          rule: "irs-id",
          maxLength: 12,
        },
        { id: "managerEmail", label: "Manager's Email", kind: "email", required: true },
        { id: "managerFirstName", label: "Manager's First Name", kind: "text", required: true },
        { id: "managerLastName", label: "Manager's Last Name", kind: "text", required: true },
      ],
    },
    {
      id: "compliance",
      title: "Compliance",
      help: "Compliance documents must be checked before you can be authorized to use EDP environments such as FIT/PreProd or Prod.",
      fields: [
        {
          id: "unauthorizedAccessTrainingDate",
          label: "Unauthorized Access training certificate date",
          kind: "date",
          required: false,
          rule: "training-date",
          help: TRAINING_HELP,
        },
        {
          id: "privacyTrainingDate",
          label: "Privacy training certificate date",
          kind: "date",
          required: false,
          rule: "training-date",
          help: TRAINING_HELP,
        },
        {
          id: "cyberAwarenessTrainingDate",
          label: "Cyber Awareness training certificate date",
          kind: "date",
          required: false,
          rule: "training-date",
          help: TRAINING_HELP,
        },
        {
          id: "irmAcknowledged",
          label: "I have read, acknowledged and signed the IRM 10.5.8 manual transmittal document",
          kind: "yes-no",
          required: false,
          flagWhen: "no",
          flagText: "IRM 10.5.8 not acknowledged",
        },
        {
          id: "mbiInitialDate",
          label: "Your contractor MBI / staff-like access initial date",
          kind: "date",
          required: false,
          rule: "not-future",
        },
        {
          id: "mbiPreliminary",
          label:
            "Does your MBI / staff-like access show a preliminary or incomplete background investigation status?",
          kind: "yes-no",
          required: false,
          flagWhen: "yes",
          flagText: "Preliminary or incomplete background investigation",
        },
        {
          id: "mbiExpirationDate",
          label: "Your contractor MBI / staff-like access expiration date (not always listed)",
          kind: "date",
          required: false,
          rule: "on-or-after:mbiInitialDate",
        },
        {
          id: "ndaSigned",
          label: "I have agreed to, and signed, the IRS NDA",
          kind: "yes-no",
          required: false,
          flagWhen: "no",
          flagText: "IRS NDA not signed",
        },
      ],
    },
  ],
  declaration: {
    text: "I hereby declare that the information submitted is accurate and complete to the best of my knowledge. I understand that any false statement, omission, or misrepresentation may result in disciplinary action and could lead to the suspension or revocation of any access, entitlements, or permissions granted based on this submission.",
    attestation: { id: "declarationAgreed", label: "I agree" },
  },
} as const satisfies EirFormConfig;

/**
 * The current form: every new answer is given under it. It's the active EIR
 * definition's (`definition/bootstrap-2.eir.yaml`, #217), validated and typed
 * before anything reads it. When that definition can't be loaded the form is
 * empty and {@link EIR_FORM_UNAVAILABLE} says why: the screen shows the EIR as
 * unavailable and every employee command refuses, rather than guess rules.
 */
export const EIR_FORM: EirFormConfig = ACTIVE_EIR_DEFINITION.ok
  ? ACTIVE_EIR_DEFINITION.definition.form
  : {
      version: "unavailable",
      title: "Employee Identity Record (EIR)",
      intro: "",
      trainingRule: "",
      sections: [],
      declaration: { text: "", attestation: { id: "declarationAgreed", label: "I agree" } },
    };

/** Why the current form can't be used, or undefined when it can. */
export const EIR_FORM_UNAVAILABLE: readonly EirDefinitionDiagnostic[] | undefined =
  ACTIVE_EIR_DEFINITION.ok ? undefined : ACTIVE_EIR_DEFINITION.diagnostics;

export type EirFormVersion = typeof EIR_FORM.version;

/**
 * Every structured form version, by version: answers stored under any of them
 * show with that version's sections, labels and flags. Their field IDs are
 * shared, so a draft or EIR given under an earlier one opens in the current
 * form with its answers (nothing is filled in for a field it left blank).
 */
export const EIR_FORMS: Record<string, EirFormConfig> = {
  [EIR_FORM_1_2.version]: EIR_FORM_1_2,
  // Every built-in definition's form (#217: bootstrap and bootstrap-2), and form
  // 1.3, the bootstrap's content under the label its answers were stored with.
  ...Object.fromEntries([...BUILT_IN_DEFINITIONS].map(([id, definition]) => [id, definition.form])),
  ...(BUILT_IN_DEFINITIONS.has(BOOTSTRAP_DEFINITION_ID)
    ? {
        [LEGACY_BOOTSTRAP_FORM_VERSION]: {
          ...BUILT_IN_DEFINITIONS.get(BOOTSTRAP_DEFINITION_ID)!.form,
          version: LEGACY_BOOTSTRAP_FORM_VERSION,
        },
      }
    : {}),
};

/**
 * Answers stored under earlier form versions, shown read-only with their own
 * labels. `0.1` is the interim checklist #98 shipped before form 1.2 existed;
 * its records were migrated from the volume under that version (#126). Its
 * questions aren't form 1.2's or later, so they're listed as stored.
 */
export const LEGACY_EIR_FORMS: Record<
  string,
  { name: string; fields: { id: string; label: string }[] }
> = {
  "0.1": {
    name: "Interim checklist (before EIR form 1.2)",
    fields: [
      { id: "fullName", label: "Full legal name" },
      { id: "organization", label: "Organization" },
      { id: "jobTitle", label: "Job title" },
      { id: "businessNeed", label: "Business need for Federal Tax Information (FTI)" },
    ],
  },
};

/** The version given to #98's interim records, which stored none. */
export const LEGACY_EIR_FORM_VERSION = "0.1";

/** The active definition's validity period and review SLA; undefined when it's unavailable. */
export const EIR_VALIDITY_DAYS: number | undefined = ACTIVE_EIR_DEFINITION.ok
  ? ACTIVE_EIR_DEFINITION.definition.validityDays
  : undefined;
export const EIR_REVIEW_SLA_BUSINESS_DAYS: number | undefined = ACTIVE_EIR_DEFINITION.ok
  ? ACTIVE_EIR_DEFINITION.definition.reviewSlaBusinessDays
  : undefined;
