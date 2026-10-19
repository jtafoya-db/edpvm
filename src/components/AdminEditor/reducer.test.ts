import { describe, expect, it } from "vitest";
import { applyEdit } from "./reducer";
import { loadSchema, type IntakeSchema } from "../../schema";

const base: IntakeSchema = loadSchema();

describe("applyEdit — purity", () => {
  it("never mutates the input schema", () => {
    const before = JSON.stringify(base);
    applyEdit(base, { kind: "setFieldLabel", id: "dataName", value: "X" });
    applyEdit(base, { kind: "addPattern", list: "ingestPatterns" });
    applyEdit(base, { kind: "setSizingCoeff", group: "freqFactor", key: "Daily", value: 9 });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("applyEdit — option lists", () => {
  it("edits a pattern's text field in place without touching siblings", () => {
    const next = applyEdit(base, {
      kind: "setPatternText",
      list: "ingestPatterns",
      id: "eftu",
      field: "name",
      value: "EFTU (renamed)",
    });
    expect(next.optionLists.ingestPatterns.find((o) => o.id === "eftu")?.name).toBe(
      "EFTU (renamed)",
    );
    // a sibling is untouched
    expect(next.optionLists.ingestPatterns.find((o) => o.id === "epz")?.name).toBe(
      base.optionLists.ingestPatterns.find((o) => o.id === "epz")?.name,
    );
  });

  it("toggles the approved flag", () => {
    const next = applyEdit(base, {
      kind: "setPatternApproved",
      list: "accessPatterns",
      id: "dbx",
      value: false,
    });
    expect(next.optionLists.accessPatterns.find((o) => o.id === "dbx")?.approved).toBe(false);
  });

  it("adds a pattern with a unique id (engModels gets platform, ingest does not)", () => {
    const eng = applyEdit(base, { kind: "addPattern", list: "engModels" });
    const addedEng = eng.optionLists.engModels.at(-1);
    expect(addedEng?.id).toBe("new-engModels-1");
    expect(addedEng?.platform).toBe(false);

    const ingest = applyEdit(base, { kind: "addPattern", list: "ingestPatterns" });
    const addedIngest = ingest.optionLists.ingestPatterns.at(-1);
    expect(addedIngest?.id).toBe("new-ingestPatterns-1");
    expect("platform" in (addedIngest ?? {})).toBe(false);
  });

  it("adds and edits a source system (source is an editable option-list)", () => {
    const added = applyEdit(base, { kind: "addPattern", list: "source" });
    expect(added.optionLists.source.at(-1)?.id).toBe("new-source-1");
    const renamed = applyEdit(added, {
      kind: "setPatternText",
      list: "source",
      id: "imf",
      field: "name",
      value: "IMF (renamed)",
    });
    expect(renamed.optionLists.source.find((o) => o.id === "imf")?.name).toBe("IMF (renamed)");
  });

  it("removes a pattern by id", () => {
    const next = applyEdit(base, { kind: "removePattern", list: "ingestPatterns", id: "other" });
    expect(next.optionLists.ingestPatterns.some((o) => o.id === "other")).toBe(false);
    expect(next.optionLists.ingestPatterns.length).toBe(base.optionLists.ingestPatterns.length - 1);
  });

  it("adds and removes ROI levers", () => {
    const added = applyEdit(base, { kind: "addLever" });
    expect(added.optionLists.roiLevers.at(-1)?.id).toBe("new-lever-1");
    const removed = applyEdit(added, { kind: "removeLever", id: "fraud" });
    expect(removed.optionLists.roiLevers.some((l) => l.id === "fraud")).toBe(false);
  });
});

describe("applyEdit — fields & sizing", () => {
  it("edits a field label and required flag", () => {
    const relabelled = applyEdit(base, {
      kind: "setFieldLabel",
      id: "sourceSystem",
      value: "Owner",
    });
    expect(relabelled.fields.find((f) => f.id === "sourceSystem")?.label).toBe("Owner");

    const optional = applyEdit(base, {
      kind: "setFieldRequired",
      id: "dataName",
      value: false,
    });
    expect(optional.fields.find((f) => f.id === "dataName")?.required).toBe(false);
  });

  it("edits a sizing coefficient", () => {
    const next = applyEdit(base, {
      kind: "setSizingCoeff",
      group: "cplxFactor",
      key: "Heavy",
      value: 3.3,
    });
    expect(next.sizing.cplxFactor["Heavy"]).toBe(3.3);
  });
});

describe("applyEdit — reset", () => {
  it("returns a fresh clone of the provided schema", () => {
    const edited = applyEdit(base, { kind: "setFieldLabel", id: "dataName", value: "X" });
    const reset = applyEdit(edited, { kind: "reset", schema: base });
    expect(reset).toEqual(base);
    expect(reset).not.toBe(base);
  });
});
