// Declarative intake-schema contract.
//
// This is the deep-module seam described in docs/build-plan-p1.md §0: the
// onboarding wizard (and, later, the admin editor and LLM challenger) read all
// of their structure from here instead of hardcoding it. The concrete data
// lives in ./intake.config.json and is obtained ONLY through loadSchema().

/**
 * Ordered content for a step. Each entry is either a single block (a field id
 * or a widget id) or a nested array of field ids rendered together as a
 * responsive grid. A token that matches a field in the step renders that field;
 * anything else is looked up in the renderer's widget registry. When `layout`
 * is omitted the step falls back to rendering its fields in declaration order.
 */
export type StepBlock = string | string[];

/** A wizard step. `label` is the StepIndicator caption; `title`/`eyebrow` head the panel. */
export interface StepDef {
  id: string;
  label: string;
  title: string;
  eyebrow: string;
  /** ordered fields/widgets for the step; see StepBlock */
  layout?: StepBlock[];
}

export type FieldType =
  | "text"
  | "textarea"
  | "select"
  | "number"
  | "card-select"
  | "multi-card"
  | "dataset-list"
  | "initiative-owner";

export type NumberFormat = "integer" | "decimal" | "currency";

/** A single input in the wizard. Type-specific keys are optional. */
export interface FieldDef {
  id: string;
  /** id of the owning step */
  step: string;
  type: FieldType;
  label: string;
  required: boolean;
  default: string | number | string[] | null;
  placeholder?: string;
  help?: string;
  /** rows for a textarea */
  rows?: number;
  /** min attribute for a number input */
  min?: number;
  /** step attribute for a number input */
  increment?: number;
  /**
   * What a number field accepts: whole numbers (the default), decimals, or a
   * currency amount, which also takes cents and a leading "$".
   */
  numberFormat?: NumberFormat;
  /** static string options for a plain select */
  options?: string[];
  /** key into schema.optionLists for card-select / multi-card fields */
  optionList?: OptionListName;
  /** an option list whose entries become {value:id, label:name} select options */
  optionsFrom?: OptionListName;
  /** options resolved at runtime from app data (e.g. domains) */
  dynamicOptions?: "domains";
}

/** The domain value a dataset uses when none of the governed domains fits. */
export const OTHER_DOMAIN = "other";

/**
 * Contact details for a person the provider names as a dataset owner at intake.
 * This is intake contact data, NOT an ownership record: before durable dataset
 * ownership is created (standup, #89) each contact must be resolved to the
 * person's stable SCIM id, which is what ownership is keyed by.
 */
export interface IntakeOwnerContact {
  /** The stored owner contact's ID, set by the server; absent on one not saved yet. */
  id?: string | undefined;
  /**
   * Myself or Someone else, as the initiative owner is chosen (#103). `true`:
   * the provider picked themselves, and the server fills the name, email and
   * principal from the signed-in session, whatever the browser sends.
   * `false`: Someone else was chosen in the wizard; it never leaves it (the
   * intake sends a typed contact with no `self`). Absent: a stored contact, or
   * a wizard row with nothing chosen yet.
   */
  self?: boolean | undefined;
  name: string;
  email: string;
}

/**
 * Who owns the initiative, as the intake answers it (#103). Myself carries
 * nothing: the server takes the identity from the signed-in session. Someone
 * else is a name and email, display and matching data only, never an actor
 * key (ADR-0006).
 */
export type IntakeInitiativeOwner =
  { kind: "self" } | { kind: "someone-else"; name: string; email: string };

/** One dataset in the intake package: a `dataset-list` field holds an array of these. */
export interface IntakeDatasetInput {
  /** The stored dataset's ID, set by the server; absent on one not saved yet. */
  id?: string | undefined;
  name: string;
  /** a BusinessDomain.id, or {@link OTHER_DOMAIN} */
  domain: string;
  datasetTag: string;
  owners: IntakeOwnerContact[];
}

/** A display-only overview of the standard compute policy shown at intake. */
export interface ComputePolicyOverview {
  title: string;
  summary: string;
  items: Array<{ label: string; value: string }>;
  changeNote: string;
}

/** A card option (ingest/access pattern, engineering model). */
export interface PatternOption {
  id: string;
  name: string;
  desc: string;
  approved: boolean;
  box: string;
  /** engineering models only: whether platform engineering is engaged */
  platform?: boolean;
}

/** An ROI lever option. */
export interface LeverOption {
  id: string;
  name: string;
  icon: string;
  measure: string;
}

export type OptionListName =
  "engModels" | "ingestPatterns" | "accessPatterns" | "source" | "roiLevers";

export interface OptionLists {
  engModels: PatternOption[];
  ingestPatterns: PatternOption[];
  accessPatterns: PatternOption[];
  /** curated source-system catalog (editable via the admin editor, GitHub #5) */
  source: PatternOption[];
  roiLevers: LeverOption[];
}

/** Declarative per-field validation rule. `min` is the exclusive lower bound
 * (predicate is strictly greater-than), matching the original `> N` gates. */
export interface ValidationRule {
  type:
    | "minTrimmedLength"
    | "truthy"
    | "minNumber"
    | "minCount"
    | "isTrue"
    | "datasets"
    | "initiativeOwner";
  field: string;
  min?: number;
  /** shown when the rule fails; a message derived from the field label is used otherwise */
  message?: string;
}

/** One failed validation rule on a step, as shown to the person filling it in. */
export interface StepIssue {
  field: string;
  /**
   * For a `datasets` rule, the part of the list the problem is about (see
   * `datasetIssues`); for an `initiativeOwner` rule, `kind`, `name` or `email`.
   */
  key?: string;
  message: string;
}

export interface SizingConfig {
  freqFactor: Record<string, number>;
  cplxFactor: Record<string, number>;
}

/** A value that is either a template string or a flag-driven then/else choice. */
export interface ConditionalTemplate {
  /** name of a boolean flag in the interpreter context (e.g. needsConsult, platform) */
  when: string;
  then: string;
  else: string;
}

export type TemplateValue = string | ConditionalTemplate;

/** Declarative spec for one request `item` (all items are always included). */
export interface RequestItemSpec {
  kind: string;
  label: string;
  sub: TemplateValue;
}

/** Declarative spec for one `subRequest`; `when` gates conditional inclusion. */
export interface SubRequestSpec {
  when?: string;
  system: string;
  status: TemplateValue;
  detail: string;
}

/**
 * Fully declarative request-assembly spec. assembleRequest is a pure
 * interpreter over this — id/prefix, templates, item/subrequest structure,
 * conditional inclusion + statuses, and the field->context mapping all live in
 * the config, not in code. Template strings interpolate `{name}` tokens from
 * the interpreter context.
 */
export interface RequestConfig {
  idPrefix: string;
  submittedAt: string;
  status: string;
  overall: string;
  stageIndex: number;
  titleTemplate: string;
  purposeTemplate: string;
  /** maps a context variable name -> the field id whose raw value feeds it */
  fieldMap: Record<string, string>;
  items: RequestItemSpec[];
  subRequests: SubRequestSpec[];
}

export interface IntakeSchema {
  version: number;
  steps: StepDef[];
  fields: FieldDef[];
  optionLists: OptionLists;
  validation: Record<string, ValidationRule[]>;
  sizing: SizingConfig;
  request: RequestConfig;
  /** shown by the `computePolicyOverview` widget */
  computePolicy?: ComputePolicyOverview;
}

// ---- helper I/O shapes ---------------------------------------------------

export interface SizingInput {
  sizeGb: number;
  freq: string;
  complexity: string;
  users: number;
}

export interface SizingResult {
  storageTb: number;
  dbu: number;
  monthlyCost: number;
  annualCost: number;
  tier: string;
  cluster: string;
  warehouse: string;
  confidence: number;
}

export interface RoiResult {
  ratio: number;
  paybackMonths: number | string;
}

/** The raw field values collected by the wizard (plus the `estimated` gate). */
export type IntakeState = Record<string, unknown>;

export interface ResolvedSelections {
  patternDef: PatternOption;
  accessDef: PatternOption;
  engDef: PatternOption;
  outcomeDef: LeverOption;
  leverLabels: string[];
  needsConsult: boolean;
}

export interface RequestItem {
  kind: string;
  label: string;
  sub: string;
}

export interface SubRequest {
  system: string;
  status: string;
  detail: string;
}

export interface OnboardingRequest {
  id: string;
  title: string;
  submittedAt: string;
  status: string;
  overall: string;
  purpose: string;
  items: RequestItem[];
  subRequests: SubRequest[];
  stageIndex: number;
}

export interface AssembleInput {
  values: IntakeState;
  domainName: string;
  num: number;
}
