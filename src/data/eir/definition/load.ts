/**
 * The EIR definition service (#200): `loadDefinition(yamlText)` parses an EIR
 * definition authored as YAML and returns either a typed, validated
 * definition or every reason it's refused. Nothing else reads the YAML.
 *
 * Three passes, each refusing with diagnostics:
 * 1. Parse as data only: YAML 1.2's core schema, one document, and no
 *    anchors, aliases, merge keys, tags or `${...}` values.
 * 2. Shape: only the sections, keys, field types, rule operators and
 *    dispositions listed here; an unknown key is refused by name.
 * 3. Meaning: unique IDs, references that resolve, timeline bounds in order,
 *    each rule's disposition consistent with what it checks, and a synthetic
 *    scenario for `pass`, `blocking` and every disposition a rule has.
 */
import {
  isAlias,
  isCollection,
  isNode,
  isScalar,
  parseAllDocuments,
  visit,
  type Document,
} from "yaml";
import { z } from "zod";

import type { EirFieldConfig, EirFieldRule, EirFormConfig, EirSectionConfig } from "../config.ts";
import { UNPUBLISHED_DEFINITION_ID } from "./identity.ts";
import type {
  EirDefinition,
  EirDefinitionDiagnostic,
  EirDefinitionResult,
  EirRuleDefinition,
  EirScenario,
  EirTimeline,
} from "./types.ts";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/, "use letters, numbers and dashes");
const text = z.string().min(1);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use a YYYY-MM-DD date")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: "use a real calendar date" },
  );
const disposition = z.enum(["blocking", "warning", "manual-review"]);
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9-]*$/, "use capitals, numbers and dashes");

/** The shared kinds of value, so the schema reference (#219) can name them. */
export const EIR_DEFINITION_SCALARS = { id, text, day, reasonCode } as const;

const fieldSchema = z
  .object({
    id,
    label: text,
    type: z.enum(["text", "email", "date", "yes-no"]),
    required: z.boolean(),
    help: text.optional(),
    prefill: z.enum(["email", "first-name", "last-name"]).optional(),
    maxLength: z.number().int().positive().optional(),
    size: z.enum(["short"]).optional(),
  })
  .strict();

const layoutSchema = z
  .object({
    legend: text.optional(),
    hint: text.optional(),
    rows: z.array(z.array(id).min(1)).min(1),
  })
  .strict();

const sectionSchema = z
  .object({
    id,
    title: text,
    help: text.optional(),
    fields: z.array(fieldSchema).min(1),
    layout: z.array(layoutSchema).optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    id,
    field: id,
    operator: z.enum([
      "irs-id",
      "equals",
      "within-timeline",
      "not-future",
      "not-past",
      "on-or-after",
    ]),
    disposition,
    reasonCode,
    /** What the employee should go do when the rule fails (#217). */
    guidance: text.optional(),
    value: text.optional(),
    message: text.optional(),
    timeline: id.optional(),
    otherField: id.optional(),
  })
  .strict();

/** Every key a definition can have: the shape `loadDefinition` checks, and the reference (#219) lists. */
export const EIR_DEFINITION_SCHEMA = z
  .object({
    validityDays: z.number().int().min(1).max(3650),
    reviewSlaBusinessDays: z.number().int().min(1).max(60),
    form: z
      .object({
        title: text,
        intro: text,
        trainingRule: text,
        sections: z.array(sectionSchema).min(1),
        declaration: z
          .object({
            text,
            attestation: z.object({ id, label: text }).strict(),
          })
          .strict(),
      })
      .strict(),
    timelines: z.array(
      z
        .object({
          id,
          /** What `max` counts back from: the form's start (the default) or the day it's checked. */
          anchor: z.enum(["form-started", "evaluated"]).optional(),
          unit: z.enum(["years", "months", "days"]),
          min: z.number().int().min(0),
          max: z.number().int().min(0),
        })
        .strict(),
    ),
    rules: z.array(ruleSchema),
    scenarios: z.array(
      z
        .object({
          id,
          expect: z.enum(["pass", "blocking", "warning", "manual-review"]),
          extends: id.optional(),
          /** A reason code the outcome must include (#217). */
          reasonCode: reasonCode.optional(),
          formStartedAt: day.optional(),
          submittedAt: day.optional(),
          answers: z.record(z.string(), z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export type EirDefinitionSource = z.infer<typeof EIR_DEFINITION_SCHEMA>;
type DefinitionSource = EirDefinitionSource;
type Path = (string | number)[];

/** Parse as data: YAML 1.2 core, one document, nothing that refers, tags or interpolates. */
function parseData(
  yamlText: string,
  lineOf: (offset: number) => number,
): { data: unknown; document?: Document; diagnostics: EirDefinitionDiagnostic[] } {
  const diagnostics: EirDefinitionDiagnostic[] = [];
  const documents = parseAllDocuments(yamlText, {
    schema: "core",
    merge: false,
    uniqueKeys: true,
  });
  const list = Array.isArray(documents) ? documents : [documents];
  if (list.length !== 1) {
    return {
      data: undefined,
      diagnostics: [
        {
          code: "parse-error",
          message: "An EIR definition is exactly one YAML document.",
          path: [],
        },
      ],
    };
  }
  const document = list[0]!;
  const parseErrors = (errors: typeof document.errors) =>
    errors.map((error): EirDefinitionDiagnostic => ({
      code: "parse-error",
      message: error.message.split("\n")[0]!,
      path: [],
      line: lineOf(error.pos[0]),
    }));
  if (document.errors.length) return { data: undefined, diagnostics: parseErrors(document.errors) };
  const unsafe = (message: string, node: unknown, path: readonly unknown[]) =>
    diagnostics.push({
      code: "unsafe-yaml",
      message,
      path: pathOf(path, node),
      ...(isNode(node) && node.range ? { line: lineOf(node.range[0]) } : {}),
    });
  visit(document, {
    Alias(_key, node, path) {
      unsafe(`Aliases aren't allowed (*${node.source}): write the value out.`, node, path);
    },
    Node(_key, node, path) {
      if (node.anchor) {
        unsafe(`Anchors aren't allowed (&${node.anchor}): write the value out.`, node, path);
      }
      if (node.tag && !isAlias(node)) {
        unsafe(`Tags aren't allowed (${node.tag}): an EIR definition is plain data.`, node, path);
      }
      if (isScalar(node) && typeof node.value === "string" && /\$\{[^}]*\}/.test(node.value)) {
        unsafe(
          `Environment-style values aren't allowed (${node.value}): an EIR definition doesn't depend on where it runs.`,
          node,
          path,
        );
      }
    },
    Pair(_key, pair, path) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        unsafe("Merge keys (<<) aren't allowed: write the values out.", pair.key, [...path, pair]);
      }
    },
  });
  // A warning (an unresolved tag, say) is refused too, after the clearer reasons above.
  if (!diagnostics.length) diagnostics.push(...parseErrors(document.warnings));
  if (diagnostics.length) return { data: undefined, diagnostics };
  return { data: document.toJS({ maxAliasCount: 0 }), document, diagnostics };
}

/** A visitor's ancestry as a path of keys and indexes, ending at `node`. */
function pathOf(ancestry: readonly unknown[], node: unknown): Path {
  const path: Path = [];
  const chain = [...ancestry, node];
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i - 1];
    const child = chain[i];
    if (isCollection(parent) && "items" in parent) {
      const index = (parent.items as unknown[]).indexOf(child);
      if (index >= 0 && !(parent.items[index] as { key?: unknown })?.key) path.push(index);
    }
    if (child && typeof child === "object" && "key" in child && "value" in child) {
      const key = (child as { key: unknown }).key;
      if (isScalar(key)) path.push(String(key.value));
    }
  }
  return path;
}

/**
 * The keys a definition once named its own versions with (#224): the server
 * numbers each publish now, so a stale copy carrying one is refused by name
 * rather than published under an identifier it no longer means. The schema
 * reference (#219) lists them as gone.
 */
export const EIR_SERVER_ASSIGNED_KEYS = ["definitionVersion", "form.version"] as const;

const isServerAssigned = (path: Path): boolean =>
  (EIR_SERVER_ASSIGNED_KEYS as readonly string[]).includes(path.join("."));

/** Shape errors as diagnostics: an unknown key is named, the rest say what's wrong where. */
function shapeDiagnostics(error: z.ZodError, lineAt: (path: Path) => number | undefined) {
  const diagnostics: EirDefinitionDiagnostic[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = [...issue.path, key];
        const line = lineAt(path);
        if (isServerAssigned(path)) {
          diagnostics.push({
            code: "server-assigned-version",
            message: `Remove "${path.join(".")}": the server numbers each published version, so a definition doesn't name its own.`,
            path,
            ...(line ? { line } : {}),
          });
          continue;
        }
        diagnostics.push({
          code: "unknown-key",
          message: `Unknown key "${key}"${issue.path.length ? ` in ${issue.path.join(".")}` : ""}.`,
          path,
          ...(line ? { line } : {}),
        });
      }
      continue;
    }
    const line = lineAt(issue.path);
    diagnostics.push({
      code: "invalid-value",
      message: `${issue.path.join(".") || "The definition"}: ${issue.message}`,
      path: issue.path,
      ...(line ? { line } : {}),
    });
  }
  return diagnostics;
}

/**
 * The rule a field's existing evaluator runs (`form.ts`), from the rule
 * definition. `within-timeline` carries its timeline's window
 * (`within-timeline:<anchor>:<unit>:<min>:<max>`), so the evaluator applies the
 * definition's values; undefined when the timeline isn't defined.
 */
export function fieldRule(
  rule: {
    operator: EirRuleDefinition["operator"];
    otherField?: string | undefined;
    timeline?: string | undefined;
  },
  timelines: readonly (Omit<EirTimeline, "anchor"> & {
    anchor?: EirTimeline["anchor"] | undefined;
  })[] = [],
): EirFieldRule | undefined {
  switch (rule.operator) {
    case "irs-id":
      return "irs-id";
    case "within-timeline": {
      const timeline = timelines.find((t) => t.id === rule.timeline);
      return timeline
        ? `within-timeline:${timeline.anchor ?? "form-started"}:${timeline.unit}:${timeline.min}:${timeline.max}`
        : undefined;
    }
    case "not-future":
      return "not-future";
    case "not-past":
      return "not-past";
    case "on-or-after":
      return `on-or-after:${rule.otherField}`;
    case "equals":
      return undefined;
  }
}

/** The longest training window each unit supports. */
export const EIR_TIMELINE_LIMITS = { years: 10, months: 120, days: 3660 } as const;

/** What each operator checks, so a rule's field type and disposition can be checked against it. */
const ANY = ["blocking", "warning", "manual-review"] as const;
export const EIR_RULE_OPERATORS = {
  // A form error: an ID that isn't one can't be signed, so it can only block.
  "irs-id": { types: ["text"], dispositions: ["blocking"] },
  // The rest can be any disposition Safeguards chooses (#217).
  equals: { types: ["yes-no"], dispositions: ANY },
  "within-timeline": { types: ["date"], dispositions: ANY },
  "not-future": { types: ["date"], dispositions: ANY },
  "not-past": { types: ["date"], dispositions: ANY },
  "on-or-after": { types: ["date"], dispositions: ANY },
} as const satisfies Record<
  DefinitionSource["rules"][number]["operator"],
  { types: readonly string[]; dispositions: readonly string[] }
>;

function semanticDiagnostics(source: DefinitionSource): EirDefinitionDiagnostic[] {
  const diagnostics: EirDefinitionDiagnostic[] = [];
  const refuse = (code: EirDefinitionDiagnostic["code"], message: string, path: Path) =>
    diagnostics.push({ code, message, path });
  const unique = (ids: { id: string; path: Path }[], what: string) => {
    const seen = new Set<string>();
    for (const { id, path } of ids) {
      if (seen.has(id)) refuse("duplicate-id", `Duplicate ${what} ID "${id}".`, path);
      seen.add(id);
    }
  };

  const { form } = source;
  const fields = form.sections.flatMap((section, s) =>
    section.fields.map((field, f) => ({
      field,
      path: ["form", "sections", s, "fields", f] as Path,
    })),
  );
  unique(
    form.sections.map((section, s) => ({ id: section.id, path: ["form", "sections", s, "id"] })),
    "section",
  );
  unique(
    [
      ...fields.map(({ field, path }) => ({ id: field.id, path: [...path, "id"] })),
      {
        id: form.declaration.attestation.id,
        path: ["form", "declaration", "attestation", "id"],
      },
    ],
    "field",
  );
  const fieldById = new Map(fields.map(({ field }) => [field.id, field]));

  form.sections.forEach((section, s) => {
    const own = new Set(section.fields.map((field) => field.id));
    const placed: string[] = [];
    (section.layout ?? []).forEach((block, b) =>
      block.rows.forEach((row, r) =>
        row.forEach((fieldId, c) => {
          const path = ["form", "sections", s, "layout", b, "rows", r, c];
          if (!own.has(fieldId)) {
            refuse(
              "missing-reference",
              `Layout of section "${section.id}" places "${fieldId}", which isn't one of its fields.`,
              path,
            );
          } else if (placed.includes(fieldId)) {
            refuse("duplicate-id", `Layout places "${fieldId}" twice.`, path);
          }
          placed.push(fieldId);
        }),
      ),
    );
    if (section.layout) {
      for (const fieldId of own) {
        if (!placed.includes(fieldId)) {
          refuse(
            "missing-reference",
            `Layout of section "${section.id}" doesn't place "${fieldId}".`,
            ["form", "sections", s, "layout"],
          );
        }
      }
    }
  });

  source.timelines.forEach((timeline, t) => {
    if (timeline.min > timeline.max) {
      refuse(
        "timeline-bounds",
        `Timeline "${timeline.id}" has min ${timeline.min} after max ${timeline.max}.`,
        ["timelines", t],
      );
    } else if (timeline.max > EIR_TIMELINE_LIMITS[timeline.unit]) {
      // Counted back from the evaluation day (`form.ts`); a longer window isn't a training rule.
      refuse(
        "timeline-bounds",
        `Timeline "${timeline.id}" goes back ${timeline.max} ${timeline.unit}: at most ${EIR_TIMELINE_LIMITS[timeline.unit]} ${timeline.unit} is supported.`,
        ["timelines", t, "max"],
      );
    }
  });
  unique(
    source.timelines.map((timeline, t) => ({ id: timeline.id, path: ["timelines", t, "id"] })),
    "timeline",
  );
  const timelineIds = new Set(source.timelines.map((timeline) => timeline.id));

  unique(
    source.rules.map((rule, r) => ({ id: rule.id, path: ["rules", r, "id"] })),
    "rule",
  );
  unique(
    source.rules.map((rule, r) => ({ id: rule.reasonCode, path: ["rules", r, "reasonCode"] })),
    "reason code",
  );
  const ruled = new Set<string>();
  const ruleKey = (rule: { field: string; operator: string }) => `${rule.field} ${rule.operator}`;
  source.rules.forEach((rule, r) => {
    const path: Path = ["rules", r];
    const field = fieldById.get(rule.field);
    if (!field) {
      refuse(
        "missing-reference",
        `Rule "${rule.id}" checks "${rule.field}", which isn't a field.`,
        [...path, "field"],
      );
      return;
    }
    // A field can have several rules (#217), but one of each operator.
    if (ruled.has(ruleKey(rule))) {
      refuse("duplicate-id", `Field "${rule.field}" has more than one ${rule.operator} rule.`, [
        ...path,
        "field",
      ]);
    }
    ruled.add(ruleKey(rule));
    const operator = EIR_RULE_OPERATORS[rule.operator];
    if (!(operator.types as readonly string[]).includes(field.type)) {
      refuse(
        "invalid-value",
        `Rule "${rule.id}": ${rule.operator} can't check a ${field.type} field.`,
        [...path, "operator"],
      );
    }
    if (!(operator.dispositions as readonly string[]).includes(rule.disposition)) {
      refuse(
        "inconsistent-disposition",
        `Rule "${rule.id}": ${rule.operator} can't be ${rule.disposition} (it can be ${operator.dispositions.join(" or ")}).`,
        [...path, "disposition"],
      );
    }
    // A blocking rule must say what to go do (#217): text, not just whitespace.
    // An ID-format rule's form error already does.
    if (rule.disposition === "blocking" && rule.operator !== "irs-id" && !rule.guidance?.trim()) {
      refuse(
        "missing-guidance",
        `Rule "${rule.id}" is blocking, so it needs guidance: what the employee should do to meet it.`,
        [...path, "guidance"],
      );
    }
    const needs = (key: "value" | "message" | "timeline" | "otherField", wanted: boolean) => {
      if (wanted && rule[key] === undefined) {
        refuse("invalid-value", `Rule "${rule.id}": ${rule.operator} needs ${key}.`, [
          ...path,
          key,
        ]);
      } else if (!wanted && rule[key] !== undefined) {
        refuse("unknown-key", `Rule "${rule.id}": ${rule.operator} doesn't take ${key}.`, [
          ...path,
          key,
        ]);
      }
    };
    needs("value", rule.operator === "equals");
    needs("message", rule.operator === "equals");
    needs("timeline", rule.operator === "within-timeline");
    needs("otherField", rule.operator === "on-or-after");
    if (
      rule.operator === "equals" &&
      rule.value !== undefined &&
      !["yes", "no"].includes(rule.value)
    ) {
      refuse("invalid-value", `Rule "${rule.id}": a yes-no answer is "yes" or "no".`, [
        ...path,
        "value",
      ]);
    }
    if (rule.timeline !== undefined && !timelineIds.has(rule.timeline)) {
      refuse(
        "missing-reference",
        `Rule "${rule.id}" uses timeline "${rule.timeline}", which isn't defined.`,
        [...path, "timeline"],
      );
    }
    if (rule.otherField !== undefined && fieldById.get(rule.otherField)?.type !== "date") {
      refuse(
        "missing-reference",
        `Rule "${rule.id}" compares with "${rule.otherField}", which isn't a date field.`,
        [...path, "otherField"],
      );
    }
  });

  unique(
    source.scenarios.map((scenario, s) => ({ id: scenario.id, path: ["scenarios", s, "id"] })),
    "scenario",
  );
  const answerIds = new Set([...fieldById.keys(), form.declaration.attestation.id]);
  const earlier = new Set<string>();
  const clocks = new Map<
    string,
    { formStartedAt?: string | undefined; submittedAt?: string | undefined }
  >();
  source.scenarios.forEach((scenario, s) => {
    const path: Path = ["scenarios", s];
    if (scenario.extends !== undefined && !earlier.has(scenario.extends)) {
      refuse(
        "missing-reference",
        `Scenario "${scenario.id}" extends "${scenario.extends}", which isn't an earlier scenario.`,
        [...path, "extends"],
      );
    }
    for (const key of Object.keys(scenario.answers)) {
      if (!answerIds.has(key)) {
        refuse(
          "missing-reference",
          `Scenario "${scenario.id}" answers "${key}", which isn't a field.`,
          [...path, "answers", key],
        );
      }
    }
    // Rules are checked on a scenario's dates, so it must have them (its own, or
    // inherited): a default "today" would make the outcome depend on when it runs.
    const base = scenario.extends ? clocks.get(scenario.extends) : undefined;
    const own = {
      formStartedAt: scenario.formStartedAt ?? base?.formStartedAt,
      submittedAt: scenario.submittedAt ?? base?.submittedAt,
    };
    clocks.set(scenario.id, own);
    for (const key of ["formStartedAt", "submittedAt"] as const) {
      if (!own[key]) {
        refuse(
          "invalid-value",
          `Scenario "${scenario.id}" needs ${key} (its own, or from the scenario it extends): rules are checked on its dates.`,
          [...path, key],
        );
      }
    }
    earlier.add(scenario.id);
  });
  // Pass and blocking always happen (a form error blocks); the rest only if a rule can give them.
  const outcomes = new Set(["pass", "blocking", ...source.rules.map((rule) => rule.disposition)]);
  for (const outcome of ["pass", "blocking", "warning", "manual-review"].filter((o) =>
    outcomes.has(o),
  )) {
    if (!source.scenarios.some((scenario) => scenario.expect === outcome)) {
      refuse("missing-scenario", `No scenario expects ${outcome}: add one.`, ["scenarios"]);
    }
  }
  return diagnostics;
}

function normalize(source: DefinitionSource, identity: string): EirDefinition {
  const rulesFor = (fieldId: string) => source.rules.filter((rule) => rule.field === fieldId);
  const sections: EirSectionConfig[] = source.form.sections.map((section) => ({
    id: section.id,
    title: section.title,
    ...(section.help ? { help: section.help } : {}),
    fields: section.fields.map((field): EirFieldConfig => {
      const rules = rulesFor(field.id);
      const rule = rules[0];
      const evaluated = rules
        .map((r) => fieldRule(r, source.timelines))
        .filter((r): r is EirFieldRule => r !== undefined);
      const flagged = rules.find((r) => r.operator === "equals");
      return {
        id: field.id,
        label: field.label,
        kind: field.type,
        required: field.required,
        ...(field.help ? { help: field.help } : {}),
        ...(evaluated[0] ? { rule: evaluated[0] } : {}),
        ...(evaluated.length > 1 ? { rules: evaluated } : {}),
        ...(flagged ? { flagWhen: flagged.value as "yes" | "no", flagText: flagged.message! } : {}),
        ...(field.prefill ? { prefill: field.prefill } : {}),
        ...(field.maxLength ? { maxLength: field.maxLength } : {}),
        ...(field.size ? { size: field.size } : {}),
        // One rule's ID, disposition and code only on a single-rule field: a field
        // with several has no one of each (the evaluator reads `rules` instead).
        ...(rule && rules.length === 1
          ? { ruleId: rule.id, disposition: rule.disposition, reasonCode: rule.reasonCode }
          : {}),
      };
    }),
    ...(section.layout
      ? {
          layout: section.layout.map((block) => ({
            ...(block.legend ? { legend: block.legend } : {}),
            ...(block.hint ? { hint: block.hint } : {}),
            rows: block.rows,
          })),
        }
      : {}),
  }));
  const form: EirFormConfig = {
    version: identity,
    title: source.form.title,
    intro: source.form.intro,
    trainingRule: source.form.trainingRule,
    sections,
    declaration: source.form.declaration,
  };
  const answerIds = [
    ...sections.flatMap((section) => section.fields.map((field) => field.id)),
    form.declaration.attestation.id,
  ];
  const resolved = new Map<string, EirScenario>();
  const scenarios = source.scenarios.map((scenario): EirScenario => {
    const base = scenario.extends ? resolved.get(scenario.extends) : undefined;
    const answers = Object.fromEntries(answerIds.map((id) => [id, ""]));
    const result: EirScenario = {
      id: scenario.id,
      expect: scenario.expect,
      formStartedAt: scenario.formStartedAt ?? base?.formStartedAt ?? "",
      submittedAt: scenario.submittedAt ?? base?.submittedAt ?? "",
      ...(scenario.reasonCode ? { reasonCode: scenario.reasonCode } : {}),
      answers: { ...answers, ...base?.answers, ...scenario.answers },
    };
    resolved.set(scenario.id, result);
    return result;
  });
  return {
    validityDays: source.validityDays,
    reviewSlaBusinessDays: source.reviewSlaBusinessDays,
    form,
    // An omitted anchor is form-started: definitions written before #217 keep their meaning.
    timelines: source.timelines.map((timeline) => ({
      id: timeline.id,
      anchor: timeline.anchor ?? "form-started",
      unit: timeline.unit,
      min: timeline.min,
      max: timeline.max,
    })),
    // Optional keys a rule doesn't use are left off, not stored as undefined.
    rules: source.rules.map(
      (rule) =>
        Object.fromEntries(
          Object.entries(rule).filter(([, value]) => value !== undefined),
        ) as unknown as EirRuleDefinition,
    ),
    scenarios,
  };
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * Parse, shape-check and meaning-check an EIR definition's YAML. `identity`
 * is the one the server gave it (`identity.ts`): the YAML never names one.
 */
export function loadDefinition(
  yamlText: string,
  identity: string = UNPUBLISHED_DEFINITION_ID,
): EirDefinitionResult {
  const lineOf = (offset: number) => lineAt(yamlText, offset);
  const parsed = parseData(yamlText, lineOf);
  if (parsed.diagnostics.length) return { ok: false, diagnostics: parsed.diagnostics };
  const shaped = EIR_DEFINITION_SCHEMA.safeParse(parsed.data);
  if (!shaped.success) {
    return {
      ok: false,
      diagnostics: shapeDiagnostics(shaped.error, (path) => {
        const node = parsed.document?.getIn(path, true);
        return isNode(node) && node.range ? lineOf(node.range[0]) : undefined;
      }),
    };
  }
  const diagnostics = semanticDiagnostics(shaped.data);
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, definition: deepFreeze(normalize(shaped.data, identity)) };
}

/** The 1-based line of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}
