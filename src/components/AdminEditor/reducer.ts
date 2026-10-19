// Pure schema-edit transforms for the EDP admin editor (docs/build-plan-p1.md
// §2). Every action returns a NEW IntakeSchema (edits are applied to a deep
// clone), so the loaded/original schema is never mutated and the diff base
// stays intact. The React editor drives these through useReducer; they're also
// unit-tested directly.

import { cloneSchema } from "../../schema/store";
import type { IntakeSchema, LeverOption, PatternOption } from "../../schema";

/** The card option-lists that share the PatternOption shape. */
export type PatternListName = "ingestPatterns" | "accessPatterns" | "engModels" | "source";
export type PatternTextField = "name" | "desc" | "box";
export type LeverTextField = "name" | "measure" | "icon";
export type SizingGroup = "freqFactor" | "cplxFactor";

export type EditAction =
  | {
      kind: "setPatternText";
      list: PatternListName;
      id: string;
      field: PatternTextField;
      value: string;
    }
  | { kind: "setPatternApproved"; list: PatternListName; id: string; value: boolean }
  | { kind: "setPatternPlatform"; id: string; value: boolean }
  | { kind: "addPattern"; list: PatternListName }
  | { kind: "removePattern"; list: PatternListName; id: string }
  | { kind: "setLeverText"; id: string; field: LeverTextField; value: string }
  | { kind: "addLever" }
  | { kind: "removeLever"; id: string }
  | { kind: "setFieldLabel"; id: string; value: string }
  | { kind: "setFieldRequired"; id: string; value: boolean }
  | { kind: "setSizingCoeff"; group: SizingGroup; key: string; value: number }
  | { kind: "reset"; schema: IntakeSchema };

/** First `${prefix}-N` (N starting at 1) not already used in `existing`. */
function nextId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let k = 1;
  while (taken.has(`${prefix}-${k}`)) k++;
  return `${prefix}-${k}`;
}

/** Pure schema-edit transform: returns a NEW schema, never mutating `schema`. */
export function applyEdit(schema: IntakeSchema, action: EditAction): IntakeSchema {
  if (action.kind === "reset") return cloneSchema(action.schema);

  const next = cloneSchema(schema);
  switch (action.kind) {
    case "setPatternText": {
      const opt = next.optionLists[action.list].find((o) => o.id === action.id);
      if (opt) opt[action.field] = action.value;
      return next;
    }
    case "setPatternApproved": {
      const opt = next.optionLists[action.list].find((o) => o.id === action.id);
      if (opt) opt.approved = action.value;
      return next;
    }
    case "setPatternPlatform": {
      const opt = next.optionLists.engModels.find((o) => o.id === action.id);
      if (opt) opt.platform = action.value;
      return next;
    }
    case "addPattern": {
      const list = next.optionLists[action.list];
      const opt: PatternOption = {
        id: nextId(
          list.map((o) => o.id),
          `new-${action.list}`,
        ),
        name: "New option",
        desc: "",
        approved: true,
        box: "New",
      };
      // engineering models carry a platform flag; ingest/access patterns don't.
      if (action.list === "engModels") opt.platform = false;
      list.push(opt);
      return next;
    }
    case "removePattern": {
      next.optionLists[action.list] = next.optionLists[action.list].filter(
        (o) => o.id !== action.id,
      );
      return next;
    }
    case "setLeverText": {
      const lever = next.optionLists.roiLevers.find((l) => l.id === action.id);
      if (lever) lever[action.field] = action.value;
      return next;
    }
    case "addLever": {
      const lever: LeverOption = {
        id: nextId(
          next.optionLists.roiLevers.map((l) => l.id),
          "new-lever",
        ),
        name: "New lever",
        icon: "star",
        measure: "",
      };
      next.optionLists.roiLevers.push(lever);
      return next;
    }
    case "removeLever": {
      next.optionLists.roiLevers = next.optionLists.roiLevers.filter((l) => l.id !== action.id);
      return next;
    }
    case "setFieldLabel": {
      const field = next.fields.find((f) => f.id === action.id);
      if (field) field.label = action.value;
      return next;
    }
    case "setFieldRequired": {
      const field = next.fields.find((f) => f.id === action.id);
      if (field) field.required = action.value;
      return next;
    }
    case "setSizingCoeff": {
      next.sizing[action.group][action.key] = action.value;
      return next;
    }
    default:
      return next;
  }
}
