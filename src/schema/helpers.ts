// Small pure interpreters over the IntakeSchema. These replace the logic that
// used to live inline in onboarding.jsx (canNext, estimateSizing, computeRoi,
// the selection lookups, and the launch request assembly) so that behavior is
// driven by the declarative schema, not hardcoded JSX.

import { datasetTagError } from "./dataset-tag.ts";
import type {
  AssembleInput,
  FieldDef,
  IntakeDatasetInput,
  IntakeInitiativeOwner,
  IntakeSchema,
  IntakeState,
  LeverOption,
  OnboardingRequest,
  OptionListName,
  PatternOption,
  ResolvedSelections,
  RoiResult,
  SizingInput,
  SizingResult,
  StepDef,
  StepIssue,
  TemplateValue,
  ValidationRule,
} from "./types";

/** Look up a field definition by id. */
export function getField(schema: IntakeSchema, id: string): FieldDef | undefined {
  return schema.fields.find((f) => f.id === id);
}

/** Look up a step definition by id. */
export function getStep(schema: IntakeSchema, id: string): StepDef | undefined {
  return schema.steps.find((s) => s.id === id);
}

/** The card-option list for pattern/access/engineering-model fields. */
export function getPatternList(schema: IntakeSchema, name: OptionListName): PatternOption[] {
  if (name === "roiLevers") return [];
  return schema.optionLists[name];
}

// ---- validation (canNext parity) -----------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An empty dataset row with one empty owner, as a `dataset-list` field starts. */
export function blankDataset(): IntakeDatasetInput {
  return {
    name: "",
    sourceSystem: "",
    domain: "",
    ingestionMethod: "",
    ingestionDetails: "",
    datasetTag: "",
    owners: [{ name: "", email: "" }],
  };
}

function blank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Every problem with a `dataset-list` value, in reading order. An empty result
 * means the list holds at least one dataset and each has a name, a domain (or
 * "other"), a dataset tag and at least one owner with a name and valid email.
 */
export function validateDatasets(value: unknown): string[] {
  return datasetIssues(value).map((issue) => issue.message);
}

/**
 * {@link validateDatasets} with the part of the list each problem is about:
 * `add` (the list is empty), or `<dataset index>:<part>` where part is `name`,
 * `domain`, `tag`, `owners` (none named), `owner<j>:name` or `owner<j>:email`.
 */
export function datasetIssues(value: unknown): Array<{ key: string; message: string }> {
  const datasets = Array.isArray(value) ? (value as Partial<IntakeDatasetInput>[]) : [];
  if (datasets.length === 0) return [{ key: "add", message: "Add at least one dataset." }];
  const issues: Array<{ key: string; message: string }> = [];
  const tags = new Map<string, number>();
  datasets.forEach((dataset, i) => {
    const at = `Dataset ${i + 1}`;
    const push = (part: string, message: string) => issues.push({ key: `${i}:${part}`, message });
    if (blank(dataset.name)) push("name", `${at}: enter a dataset name.`);
    if (blank(dataset.sourceSystem)) push("sourceSystem", `${at}: enter a source system.`);
    if (blank(dataset.domain)) push("domain", `${at}: choose a domain, or "Other".`);
    if (blank(dataset.ingestionMethod))
      push("ingestionMethod", `${at}: choose how this dataset gets into EDP.`);
    // The tag becomes a UC tag value and group names, so it must be identifier-safe
    // and unique within the request (dataset-tag.ts).
    const tag = typeof dataset.datasetTag === "string" ? dataset.datasetTag.trim() : "";
    const tagError = tag ? datasetTagError(tag) : null;
    const usedBy = tags.get(tag);
    if (!tag) push("tag", `${at}: enter a dataset tag.`);
    else if (tagError) push("tag", `${at}: ${tagError}`);
    else if (usedBy !== undefined)
      push("tag", `${at}: dataset ${usedBy + 1} already uses the tag ${tag}. Use a different tag.`);
    else tags.set(tag, i);
    const owners = Array.isArray(dataset.owners) ? dataset.owners : [];
    if (owners.length === 0) push("owners", `${at}: name at least one dataset owner.`);
    // Each owner is Myself or Someone else, as the initiative owner is (#103).
    const myself = owners.findIndex((owner) => owner?.self === true);
    owners.forEach((owner, j) => {
      if (owner?.self === true) {
        // Myself: the server fills the name and email from the session. Once per dataset.
        if (j !== myself)
          push(
            `owner${j}:kind`,
            `${at}, owner ${j + 1}: Myself is already owner ${myself + 1} of this dataset.`,
          );
        return;
      }
      // Nothing chosen and nothing typed: the row asks for a choice first.
      if (owner?.self !== false && blank(owner?.name) && blank(owner?.email)) {
        push(`owner${j}:kind`, `${at}, owner ${j + 1}: choose Myself or Someone else.`);
        return;
      }
      if (blank(owner?.name))
        push(`owner${j}:name`, `${at}, owner ${j + 1}: enter the owner's name.`);
      if (typeof owner?.email !== "string" || !EMAIL.test(owner.email.trim())) {
        push(`owner${j}:email`, `${at}, owner ${j + 1}: enter a valid email address.`);
      }
    });
  });
  return issues;
}

/**
 * Every problem with an `initiative-owner` value (#103): `kind` when neither
 * Myself nor Someone else is chosen, else Someone else's `name` and `email`.
 * Myself needs nothing typed.
 */
export function initiativeOwnerIssues(value: unknown): Array<{ key: string; message: string }> {
  const owner = (value ?? {}) as Partial<IntakeInitiativeOwner> & {
    name?: unknown;
    email?: unknown;
  };
  if (owner.kind === "self") return [];
  if (owner.kind !== "someone-else")
    return [{ key: "kind", message: "Choose who owns the initiative." }];
  const issues: Array<{ key: string; message: string }> = [];
  if (blank(owner.name))
    issues.push({ key: "name", message: "Enter the initiative point of contact's name." });
  if (typeof owner.email !== "string" || !EMAIL.test(owner.email.trim()))
    issues.push({
      key: "email",
      message: "Enter a valid email address for the initiative point of contact.",
    });
  return issues;
}

// ---- number fields --------------------------------------------------------
//
// A number field holds whatever the user typed (a text box, not a spinner), or
// a number from the schema default or a saved request. It becomes a number
// only here: for validation, and when the values leave the form.

// Digits with an optional decimal part. The whole-number part is plain digits,
// or digits grouped in threes by commas or by spaces (one kind per number).
const NUMBER_TEXT = /^-?(?:(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+|\d+)(?:\.\d+)?|\.\d+)$/;
// "1,5" or "12,50": a decimal comma, which would otherwise read as a malformed group.
const COMMA_DECIMAL = /^-?\d+,\d{1,2}$/;

type ParsedNumber =
  | { kind: "blank" }
  | { kind: "number"; value: number }
  | { kind: "invalid"; reason: "format" | "commaDecimal" | "tooLarge" };

function parseNumber(value: unknown): ParsedNumber {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { kind: "number", value } : { kind: "blank" };
  }
  if (typeof value !== "string" || value.trim() === "") return { kind: "blank" };
  const text = value
    .trim()
    .replace(/^\$\s*/, "")
    .replace(/^\u2212/, "-")
    .replace(/[\u00a0\u202f]/g, " ");
  if (!NUMBER_TEXT.test(text)) {
    return { kind: "invalid", reason: COMMA_DECIMAL.test(text) ? "commaDecimal" : "format" };
  }
  const n = Number(text.replace(/[, ]/g, ""));
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    return { kind: "invalid", reason: "tooLarge" };
  }
  return { kind: "number", value: n };
}

/**
 * The number a number field's value holds: `undefined` when it is blank, `NaN`
 * when its text isn't a number. A leading "$" and thousands separators in
 * groups of three ("1,200", "1 200") are allowed; anything else, including a
 * decimal comma or a number too large to hold exactly, is `NaN`.
 */
export function readNumber(value: unknown): number | undefined {
  const parsed = parseNumber(value);
  if (parsed.kind === "blank") return undefined;
  return parsed.kind === "number" ? parsed.value : Number.NaN;
}

/** The values with every number field read as a number; a blank one becomes `undefined`. */
export function readNumbers(schema: IntakeSchema, values: IntakeState): IntakeState {
  const out: IntakeState = { ...values };
  for (const field of schema.fields) {
    if (field.type !== "number" || !(field.id in out)) continue;
    const n = readNumber(out[field.id]);
    out[field.id] = n === undefined || Number.isNaN(n) ? undefined : n;
  }
  return out;
}

/** Why a number field's text isn't an acceptable number, if it isn't. */
function numberFormatMessage(field: FieldDef, value: unknown): string | undefined {
  const format = field.numberFormat ?? "integer";
  const parsed = parseNumber(value);
  if (parsed.kind === "blank") return undefined;
  const dollar = typeof value === "string" && value.trim().startsWith("$");
  if (parsed.kind === "invalid" && parsed.reason === "commaDecimal") {
    return `${field.label} must be a number. Use a full stop for decimals, like 1.5.`;
  }
  if (parsed.kind === "invalid" && parsed.reason === "tooLarge") {
    return `${field.label} is too large.`;
  }
  if (parsed.kind === "invalid" || (dollar && format !== "currency")) {
    return `${field.label} must be a number.`;
  }
  if (format === "integer" && !Number.isInteger(parsed.value)) {
    return `${field.label} must be a whole number.`;
  }
  return undefined;
}

function rulePasses(rule: ValidationRule, value: unknown): boolean {
  const min = rule.min ?? 0;
  switch (rule.type) {
    case "minTrimmedLength":
      return typeof value === "string" && value.trim().length > min;
    case "truthy":
      return !!value;
    case "minNumber": {
      const n = readNumber(value);
      return n !== undefined && n > min;
    }
    case "minCount":
      return Array.isArray(value) && value.length > min;
    case "isTrue":
      return value === true;
    case "datasets":
      return validateDatasets(value).length === 0;
    case "initiativeOwner":
      return initiativeOwnerIssues(value).length === 0;
    default:
      return true;
  }
}

function ruleMessage(schema: IntakeSchema, rule: ValidationRule, value: unknown): string {
  if (rule.message) return rule.message;
  const label = getField(schema, rule.field)?.label ?? rule.field;
  const min = rule.min ?? 0;
  switch (rule.type) {
    case "minTrimmedLength":
      return min === 0 ? `${label} is required.` : `${label} needs more than ${min} characters.`;
    case "minNumber":
      return readNumber(value) === undefined
        ? `${label} is required.`
        : `${label} must be more than ${min}.`;
    case "minCount":
      return `${label}: select at least ${min + 1}.`;
    default:
      return `${label} is required.`;
  }
}

/**
 * Interpret a step's declarative validation rules against the current wizard
 * state. Mirrors the original `canNext` gates exactly; unknown / ungated steps
 * (e.g. review) return true.
 */
export function canAdvance(schema: IntakeSchema, stepId: string, state: IntakeState): boolean {
  return validateStep(schema, stepId, state).length === 0;
}

/**
 * The validation errors a step shows for the current state: one per failed
 * rule, or one per problem for a `datasets` rule. Empty exactly when
 * {@link canAdvance} is true.
 */
export function validateStep(
  schema: IntakeSchema,
  stepId: string,
  state: IntakeState,
): StepIssue[] {
  const rules = schema.validation[stepId] ?? [];
  // A number field whose text isn't a number gets that one issue, in place of
  // its rules' (with a rule's own message, if it has one).
  const notNumbers = new Map<string, string>();
  for (const field of schema.fields) {
    if (field.step !== stepId || field.type !== "number") continue;
    const message = numberFormatMessage(field, state[field.id]);
    if (message) notNumbers.set(field.id, message);
  }
  const ruleIssues = rules.flatMap((rule): StepIssue[] => {
    const value = state[rule.field];
    if (rule.type === "datasets") {
      return datasetIssues(value).map(({ key, message }) => ({ field: rule.field, key, message }));
    }
    if (rule.type === "initiativeOwner") {
      return initiativeOwnerIssues(value).map(({ key, message }) => ({
        field: rule.field,
        key,
        message,
      }));
    }
    const notNumber = notNumbers.get(rule.field);
    if (notNumber) {
      notNumbers.delete(rule.field);
      return [{ field: rule.field, message: rule.message ?? notNumber }];
    }
    return rulePasses(rule, value)
      ? []
      : [{ field: rule.field, message: ruleMessage(schema, rule, value) }];
  });
  return [...ruleIssues, ...[...notNumbers].map(([field, message]) => ({ field, message }))];
}

// ---- sizing (estimateSizing parity) --------------------------------------

/** Hand-wavy but deterministic "AI-assisted" sizing heuristic. */
export function estimateSizing(schema: IntakeSchema, input: SizingInput): SizingResult {
  const gb = Math.max(1, Number(input.sizeGb) || 1);
  const u = Math.max(1, Number(input.users) || 1);
  const f = schema.sizing.freqFactor[input.freq] ?? 1;
  const complexityKey = input.complexity.startsWith("Light —")
    ? "Light"
    : input.complexity.startsWith("Moderate —")
      ? "Moderate"
      : input.complexity.startsWith("Heavy —")
        ? "Heavy"
        : input.complexity.startsWith("Machine learning —")
          ? "Very heavy / ML features"
          : input.complexity;
  const c = schema.sizing.cplxFactor[complexityKey] ?? 1;

  const storageTb = Math.max(0.1, Math.round(((gb * 1.6) / 1024) * 10) / 10); // bronze/silver/gold copies
  const dbu = Math.round((gb / 100) * f * c * 60 + u * 8 + 120);
  const monthlyCost = Math.round((dbu * 3.5 + storageTb * 28 + u * 45) / 10) * 10;
  const annualCost = monthlyCost * 12;

  const load = dbu;
  const tier =
    load < 600
      ? "Small — shared capacity"
      : load < 2000
        ? "Medium — dedicated pipeline"
        : load < 6000
          ? "Large — dedicated pipeline + autoscale"
          : "Extra large — reserved capacity";
  const cluster =
    load < 600
      ? "2 × Standard_DS4"
      : load < 2000
        ? "4 × Standard_DS5"
        : load < 6000
          ? "8 × Standard_DS5 (autoscale)"
          : "16 × Standard_DS5 (reserved)";
  const warehouse =
    u < 15
      ? "2X-Small serverless"
      : u < 50
        ? "Small serverless"
        : u < 150
          ? "Medium serverless"
          : "Large serverless";
  const confidence = Math.max(62, 92 - (c > 1.5 ? 12 : 0) - (f > 1.5 ? 8 : 0));

  return { storageTb, dbu, monthlyCost, annualCost, tier, cluster, warehouse, confidence };
}

export function computeRoi(benefit: number, annualCost: number): RoiResult {
  const b = Math.max(0, Number(benefit) || 0);
  const cost = Math.max(1, annualCost);
  const ratio = Math.round((b / cost) * 10) / 10;
  const paybackMonths = b > 0 ? Math.max(1, Math.round((cost / b) * 12)) : "—";
  return { ratio, paybackMonths };
}

export function fmtUsd(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1000000) return "$" + Math.round(v / 100000) / 10 + "M";
  if (v >= 1000) return "$" + Math.round(v / 1000) + "K";
  return "$" + v;
}

// ---- selection resolution -------------------------------------------------

function findPattern(list: PatternOption[], id: unknown): PatternOption {
  return (
    list.find((p) => p.id === id) ?? {
      id: "",
      name: "Not chosen",
      desc: "No option was chosen.",
      approved: false,
      box: "",
    }
  );
}

/**
 * Resolve the option objects the wizard needs from the current field values,
 * mirroring the `.find(...) || LIST[0]` fallbacks in the original component.
 */
export function resolveSelections(schema: IntakeSchema, values: IntakeState): ResolvedSelections {
  const { ingestPatterns, accessPatterns, engModels, roiLevers } = schema.optionLists;
  const datasets = Array.isArray(values["datasets"])
    ? (values["datasets"] as IntakeDatasetInput[])
    : [];
  const datasetPatterns = datasets
    .map((dataset) => ingestPatterns.find((pattern) => pattern.id === dataset.ingestionMethod))
    .filter((pattern): pattern is PatternOption => Boolean(pattern));
  const patternDef = datasetPatterns[0] ?? findPattern(ingestPatterns, values["pattern"]);
  const accessDef = findPattern(accessPatterns, values["access"]);
  const engDef = findPattern(engModels, values["engModel"]);
  const outcomeDef = roiLevers.find((l) => l.id === values["outcome"]) ?? null;
  const levers = Array.isArray(values["levers"]) ? (values["levers"] as string[]) : [];
  const leverLabels = roiLevers.filter((l) => levers.includes(l.id)).map((l) => l.name);
  const needsConsult =
    datasetPatterns.some((pattern) => !pattern.approved) ||
    (!datasetPatterns.length && !patternDef.approved) ||
    !accessDef.approved;
  return { patternDef, accessDef, engDef, outcomeDef, leverLabels, needsConsult };
}

// ---- request assembly (declarative interpreter, launch parity) -----------

type Ctx = Record<string, string | number>;
type Flags = Record<string, boolean>;

/** Substitute `{name}` tokens in a template from the context (single pass;
 * replacement text is not re-scanned, so field values are inserted verbatim). */
function interpolate(template: string, ctx: Ctx): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = ctx[key];
    return v === undefined ? whole : String(v);
  });
}

/** Resolve a template-or-conditional value against the context and flags. */
function resolveTemplate(value: TemplateValue, ctx: Ctx, flags: Flags): string {
  if (typeof value === "string") return interpolate(value, ctx);
  return interpolate(flags[value.when] ? value.then : value.else, ctx);
}

/**
 * Build the intake request object by INTERPRETING the declarative
 * `schema.request` spec (id/prefix, templates, item/subrequest structure,
 * conditional inclusion + statuses, and the field->context mapping). This is
 * the pure core of the original `launch()`: side effects (submitRequest, flash,
 * navigation) and the random request number stay in the component; the caller
 * passes `num` and the resolved `domainName`. Output is identical to the
 * previous hardcoded assembly.
 */
export function assembleRequest(schema: IntakeSchema, input: AssembleInput): OnboardingRequest {
  const { values, domainName, domainNames = {}, num } = input;
  const req = schema.request;
  const sel = resolveSelections(schema, values);

  // Pull the raw scalar inputs through the declarative field->context mapping.
  const fm = req.fieldMap;
  const raw = (name: string): unknown => values[fm[name] ?? name];
  const annualBenefit = readNumber(raw("annualBenefit")) || 0;
  const sizeGb = readNumber(raw("sizeGb")) || 0;
  const users = readNumber(raw("users")) || 0;
  const freq = String(raw("freq") ?? "");
  const complexity = String(raw("complexity") ?? "");
  const sizing = estimateSizing(schema, { sizeGb, freq, complexity, users });
  const roi = computeRoi(annualBenefit, sizing.annualCost);
  const datasets = Array.isArray(values["datasets"])
    ? (values["datasets"] as IntakeDatasetInput[])
    : [];
  const ingestionNames = datasets.flatMap((dataset) => {
    const pattern = schema.optionLists.ingestPatterns.find(
      (candidate) => candidate.id === dataset.ingestionMethod,
    );
    return pattern ? [pattern.name] : [];
  });
  const sourceSystems = [
    ...new Set(datasets.map((dataset) => dataset.sourceSystem?.trim()).filter(Boolean)),
  ];
  const datasetDomains = [
    ...new Set(
      datasets
        .map((dataset) => domainNames[dataset.domain ?? ""]?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const resolvedDomains = datasetDomains.length ? datasetDomains : domainName ? [domainName] : [];

  // Interpolation context: raw scalars + values derived from the selections
  // and computed sizing/ROI. Template tokens in the config resolve from here.
  const ctx: Ctx = {
    dataName: String(raw("dataName") ?? ""),
    sourceSystem: sourceSystems.length
      ? sourceSystems.join("; ")
      : String(raw("sourceSystem") ?? ""),
    useCase: String(raw("useCase") ?? ""),
    freq,
    complexity,
    sizeGb,
    users,
    domainName,
    domainPhrase:
      resolvedDomains.length === 1
        ? `the ${resolvedDomains[0]} domain`
        : resolvedDomains.length > 1
          ? `the ${resolvedDomains.join("; ")} domains`
          : "domains not chosen",
    patternName: ingestionNames.length ? ingestionNames.join("; ") : sel.patternDef.name,
    accessName: sel.accessDef.name,
    engName: sel.engDef.name,
    outcomeName: sel.outcomeDef?.name ?? "not chosen",
    outcomeSummary: sel.outcomeDef?.name ?? "Primary outcome: not chosen",
    leverLabelsComma: sel.leverLabels.join(", "),
    leverLabelsDot: sel.leverLabels.join(" · "),
    sizingTier: sizing.tier,
    dbu: sizing.dbu,
    storageTb: sizing.storageTb,
    annualCostUsd: fmtUsd(sizing.annualCost),
    annualBenefitUsd: fmtUsd(annualBenefit),
    roiRatio: roi.ratio,
  };
  const flags: Flags = {
    needsConsult: sel.needsConsult,
    platform: !!sel.engDef.platform,
  };

  const items = req.items.map((it) => ({
    kind: it.kind,
    label: interpolate(it.label, ctx),
    sub: resolveTemplate(it.sub, ctx, flags),
  }));

  const subRequests = req.subRequests
    .filter((sr) => sr.when === undefined || flags[sr.when])
    .map((sr) => ({
      system: interpolate(sr.system, ctx),
      status: resolveTemplate(sr.status, ctx, flags),
      detail: interpolate(sr.detail, ctx),
    }));

  return {
    id: req.idPrefix + num,
    title: interpolate(req.titleTemplate, ctx),
    submittedAt: req.submittedAt,
    status: req.status,
    overall: req.overall,
    purpose: interpolate(req.purposeTemplate, ctx),
    items,
    subRequests,
    stageIndex: req.stageIndex,
  };
}
