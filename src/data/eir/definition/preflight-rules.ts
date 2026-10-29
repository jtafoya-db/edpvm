/**
 * A published EIR definition's rules and timelines as the employee's browser
 * gets them (#235), for the instant pre-check only: the server still saves,
 * evaluates and decides. The forms read (`eir-definitions/forms`) sends one
 * per published identity it answers for; the built-in definitions ship with
 * the app, so they're never sent.
 *
 * Only what the rule engine needs: no YAML, scenarios, or who published it.
 * Bounded both ways: a definition too big to send isn't sent, and an answer
 * that doesn't check out is dropped, so the browser just asks the server.
 */
import { z } from "zod";

import type { EirDefinition, EirRuleDefinition, EirTimeline } from "./types.ts";

export interface EirPreflightRules {
  /** The definition's identity (`identity.ts`): a published version never changes. */
  id: string;
  rules: EirRuleDefinition[];
  timelines: EirTimeline[];
}

const MAX_RULES = 100;
const MAX_TIMELINES = 20;
const text = (max: number) => z.string().max(max);

const ruleSchema = z
  .object({
    id: text(100),
    field: text(100),
    operator: z.enum([
      "irs-id",
      "equals",
      "within-timeline",
      "not-future",
      "not-past",
      "on-or-after",
    ]),
    disposition: z.enum(["blocking", "warning", "manual-review"]),
    reasonCode: text(100),
    guidance: text(1000).optional(),
    value: text(1000).optional(),
    message: text(1000).optional(),
    timeline: text(100).optional(),
    otherField: text(100).optional(),
  })
  .strict();

const timelineSchema = z
  .object({
    id: text(100),
    anchor: z.enum(["form-started", "evaluated"]),
    unit: z.enum(["years", "months", "days"]),
    min: z.number().int().min(0).max(1000),
    max: z.number().int().min(0).max(1000),
  })
  .strict();

const preflightSchema = z
  .object({
    id: text(32),
    rules: z.array(ruleSchema).max(MAX_RULES),
    timelines: z.array(timelineSchema).max(MAX_TIMELINES),
  })
  .strict();

/** What the server sends for `definition`, or undefined when it's too big to send. */
export function preflightRulesOf(definition: EirDefinition): EirPreflightRules | undefined {
  const parsed = preflightSchema.safeParse({
    id: definition.form.version,
    rules: definition.rules.map((rule) => ({
      id: rule.id,
      field: rule.field,
      operator: rule.operator,
      disposition: rule.disposition,
      reasonCode: rule.reasonCode,
      ...(rule.guidance !== undefined ? { guidance: rule.guidance } : {}),
      ...(rule.value !== undefined ? { value: rule.value } : {}),
      ...(rule.message !== undefined ? { message: rule.message } : {}),
      ...(rule.timeline !== undefined ? { timeline: rule.timeline } : {}),
      ...(rule.otherField !== undefined ? { otherField: rule.otherField } : {}),
    })),
    timelines: definition.timelines.map(({ id, anchor, unit, min, max }) => ({
      id,
      anchor,
      unit,
      min,
      max,
    })),
  });
  return parsed.success ? (parsed.data as EirPreflightRules) : undefined;
}

/** The entries of a forms answer's `rules` that check out, keyed by their own identity. */
export function checkedPreflightRules(value: unknown): Record<string, EirPreflightRules> {
  if (!value || typeof value !== "object") return {};
  const checked: Record<string, EirPreflightRules> = {};
  for (const [id, entry] of Object.entries(value).slice(0, 20)) {
    const parsed = preflightSchema.safeParse(entry);
    if (parsed.success && parsed.data.id === id) checked[id] = parsed.data as EirPreflightRules;
  }
  return checked;
}

/**
 * The published definitions among `ids` (the active one's and the ones a
 * screen asked about) whose rules can be sent.
 */
export function preflightRulesFor(
  ids: readonly string[],
  byId: (id: string) => EirDefinition | null | undefined,
  isPublished: (id: string) => boolean,
): Record<string, EirPreflightRules> {
  const sent: Record<string, EirPreflightRules> = {};
  for (const id of new Set(ids)) {
    if (!isPublished(id)) continue;
    const definition = byId(id);
    const rules = definition ? preflightRulesOf(definition) : undefined;
    if (rules && rules.id === id) sent[id] = rules;
  }
  return sent;
}
