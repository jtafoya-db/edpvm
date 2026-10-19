// @vitest-environment node
/**
 * The in-app EIR definition schema reference (#219), at its public seam:
 * `eirSchemaReference()` builds it from the checker's own schema and tables
 * plus their descriptions. Expected key paths, values and codes are written
 * out from the ticket and the checker, never recomputed from the schema.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BOOTSTRAP_EIR_DEFINITIONS } from "@/data/eir/repository";
import { evaluateEirRules } from "@/data/eir/evaluation";
import { EIR_DEFINITION_SCHEMA, fieldRule, loadDefinition } from "@/data/eir/definition/load";
import {
  eirReferenceKeyFor,
  eirSchemaReference,
  type EirOperatorExample,
} from "@/data/eir/definition/reference";
import { runScenarios } from "@/data/eir/definition/scenarios";
import type { EirDefinition, EirDisposition } from "@/data/eir/definition/types";
import type { EirFormValues } from "@/data/eir/types";
import {
  APPLICANT,
  createClock,
  memoryImplementation,
  pdf,
} from "../../server/delta/__tests__/eir-harness.ts";

/** Every key a definition can have, at every level, as the reference names it. */
const KEYS = [
  "validityDays",
  "reviewSlaBusinessDays",
  "form",
  "form.title",
  "form.intro",
  "form.trainingRule",
  "form.sections",
  "form.sections[].id",
  "form.sections[].title",
  "form.sections[].help",
  "form.sections[].fields",
  "form.sections[].fields[].id",
  "form.sections[].fields[].label",
  "form.sections[].fields[].type",
  "form.sections[].fields[].required",
  "form.sections[].fields[].help",
  "form.sections[].fields[].prefill",
  "form.sections[].fields[].maxLength",
  "form.sections[].fields[].size",
  "form.sections[].layout",
  "form.sections[].layout[].legend",
  "form.sections[].layout[].hint",
  "form.sections[].layout[].rows",
  "form.declaration",
  "form.declaration.text",
  "form.declaration.attestation",
  "form.declaration.attestation.id",
  "form.declaration.attestation.label",
  "timelines",
  "timelines[].id",
  "timelines[].anchor",
  "timelines[].unit",
  "timelines[].min",
  "timelines[].max",
  "rules",
  "rules[].id",
  "rules[].field",
  "rules[].operator",
  "rules[].disposition",
  "rules[].reasonCode",
  "rules[].guidance",
  "rules[].value",
  "rules[].message",
  "rules[].timeline",
  "rules[].otherField",
  "scenarios",
  "scenarios[].id",
  "scenarios[].expect",
  "scenarios[].extends",
  "scenarios[].reasonCode",
  "scenarios[].formStartedAt",
  "scenarios[].submittedAt",
  "scenarios[].answers",
];

describe("EIR definition schema reference (#219)", () => {
  it("covers every key at every level, each with a plain-language meaning", () => {
    const { keys } = eirSchemaReference();
    expect(keys.map((key) => key.path)).toEqual(KEYS);
    for (const key of keys) expect(key.meaning, key.path).toMatch(/\w/);
  });

  it("says what leaving out each optional key does, and marks required ones", () => {
    const { keys } = eirSchemaReference();
    const byPath = new Map(keys.map((key) => [key.path, key]));
    expect(byPath.get("validityDays")).toMatchObject({
      required: true,
      type: "Whole number from 1 to 3650",
    });
    expect(byPath.get("form.sections[].fields[].maxLength")).toMatchObject({
      required: false,
      whenOmitted: "254 characters for an email question, 200 for any other.",
    });
    for (const key of keys.filter((k) => !k.required)) {
      expect(key.whenOmitted, key.path).toMatch(/\w/);
    }
  });

  it("lists every allowed value with its meaning, straight from the schema", () => {
    const values = (path: string) =>
      eirSchemaReference()
        .keys.find((key) => key.path === path)
        ?.values?.map((v) => [v.value, Boolean(v.meaning)]);
    expect(values("form.sections[].fields[].type")).toEqual([
      ["text", true],
      ["email", true],
      ["date", true],
      ["yes-no", true],
    ]);
    expect(values("form.sections[].fields[].prefill")).toEqual([
      ["email", true],
      ["first-name", true],
      ["last-name", true],
    ]);
    expect(values("form.sections[].fields[].size")).toEqual([["short", true]]);
    expect(values("timelines[].anchor")).toEqual([
      ["form-started", true],
      ["evaluated", true],
    ]);
    expect(values("timelines[].unit")).toEqual([
      ["years", true],
      ["months", true],
      ["days", true],
    ]);
    expect(values("rules[].operator")).toEqual(
      ["irs-id", "equals", "within-timeline", "not-future", "not-past", "on-or-after"].map((v) => [
        v,
        true,
      ]),
    );
    expect(values("rules[].disposition")).toEqual(
      ["blocking", "warning", "manual-review"].map((v) => [v, true]),
    );
    expect(values("scenarios[].expect")).toEqual(
      ["pass", "blocking", "warning", "manual-review"].map((v) => [v, true]),
    );
  });

  it("refuses to build when the schema gains a key or value with no meaning", () => {
    expect(() =>
      eirSchemaReference(
        EIR_DEFINITION_SCHEMA.extend({ owner: EIR_DEFINITION_SCHEMA.shape.form.shape.title }),
      ),
    ).toThrow("no meaning for key owner");
    // A new timeline unit changes the reference: it won't build until it's described.
    const timeline = EIR_DEFINITION_SCHEMA.shape.timelines.element;
    const withMonths = EIR_DEFINITION_SCHEMA.extend({
      timelines: timeline.extend({ unit: z.enum(["years", "months", "days", "weeks"]) }).array(),
    });
    expect(() => eirSchemaReference(withMonths)).toThrow(
      'no meaning for timelines[].unit value "weeks"',
    );
  });

  it("explains every diagnostic and refusal code", () => {
    const { codes } = eirSchemaReference();
    expect(codes.map((c) => [c.code, c.kind])).toEqual([
      ["parse-error", "check"],
      ["unsafe-yaml", "check"],
      ["unknown-key", "check"],
      ["server-assigned-version", "check"],
      ["invalid-value", "check"],
      ["duplicate-id", "check"],
      ["missing-reference", "check"],
      ["timeline-bounds", "check"],
      ["inconsistent-disposition", "check"],
      ["missing-scenario", "check"],
      ["missing-guidance", "check"],
      ["unavailable", "check"],
      ["definition-too-large", "publish"],
      ["definition-invalid", "publish"],
      ["scenarios-failed", "publish"],
      ["already-published", "publish"],
      ["definition-unloadable", "publish"],
      ["already-active", "publish"],
      ["version-conflict", "publish"],
      ["idempotency-key-reused", "publish"],
      ["not-found", "publish"],
      ["forbidden", "publish"],
      ["eir-unavailable", "publish"],
    ]);
    for (const code of codes) expect(code.meaning, code.code).toMatch(/\w/);
  });

  it("states the size limit, and that the server assigns the version, from the checker", () => {
    const rules = eirSchemaReference().definitionRules;
    expect(rules).toContainEqual(
      expect.objectContaining({
        code: "definition-too-large",
        text: expect.stringContaining("256 KB"),
      }),
    );
    expect(rules).toContainEqual({
      text: "No definitionVersion or form.version: the server assigns the version.",
      code: "server-assigned-version",
    });
  });

  it("lists no version keys, and the checker refuses each as server-assigned (#224)", () => {
    const paths = eirSchemaReference().keys.map((key) => key.path);
    expect(paths).not.toContain("definitionVersion");
    expect(paths).not.toContain("form.version");
    expect(eirSchemaReference().example).not.toMatch(/version/i);
    const stale = eirSchemaReference()
      .example.replace("validityDays:", "definitionVersion: example-1\nvalidityDays:")
      .replace("form:\n", 'form:\n  version: "9.0"\n');
    const loaded = loadDefinition(stale);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual(
      expect.arrayContaining([
        ["server-assigned-version", "definitionVersion"],
        ["server-assigned-version", "form.version"],
      ]),
    );
    expect(loaded.diagnostics).toHaveLength(2);
    expect(meaningOf("server-assigned-version")).toBe(
      "The YAML names its own version (definitionVersion or form.version). The server assigns the version: delete the key, and publishing numbers the definition for you.",
    );
  });

  it("explains how versions work: numbered on publish, drafts pinned, built-ins reserved, one number (#224)", () => {
    const { versions } = eirSchemaReference();
    expect(versions.map((v) => [v.topic, v.title])).toEqual([
      ["numbered-on-publish", "Each publish is numbered automatically"],
      ["drafts-keep-their-version", "A draft keeps the version it started on"],
      ["built-in-names", "Built-in definitions have reserved names"],
      ["one-version-number", "There is only one version number"],
    ]);
    const text = Object.fromEntries(versions.map((v) => [v.topic, v.text]));
    expect(text["numbered-on-publish"]).toContain("1, 2, 3 and so on");
    expect(text["drafts-keep-their-version"]).toContain(
      "stays on the definition version that was active when they started it",
    );
    expect(text["built-in-names"]).toContain(
      "shown as bootstrap (version 0) and bootstrap-2 (version 0)",
    );
    expect(text["built-in-names"]).toContain("can never assign one of these");
    expect(text["built-in-names"]).toContain("new drafts use bootstrap-2 (version 0)");
    expect(text["one-version-number"]).toContain(
      "used to have a definition version and a separate form version. That distinction is gone",
    );
    expect(text["one-version-number"]).toContain(
      "still has definitionVersion or form.version is refused until you delete it",
    );
  });

  it("says a timeline's anchor defaults to form-started, as the checker does", () => {
    const anchorKey = eirSchemaReference().keys.find((key) => key.path === "timelines[].anchor");
    expect(anchorKey).toMatchObject({
      required: false,
      whenOmitted: "form-started: max counts back from the day the employee started the form.",
    });
    const loaded = loadDefinition(
      eirSchemaReference().example.replace(
        "timelines: []",
        "timelines:\n  - id: yearly\n    unit: years\n    min: 0\n    max: 1",
      ),
    );
    expect(loaded.ok && loaded.definition.timelines).toEqual([
      { id: "yearly", anchor: "form-started", unit: "years", min: 0, max: 1 },
    ]);
  });

  it("warns that only max follows the anchor, and a long-open draft's window can narrow", () => {
    const byPath = new Map(eirSchemaReference().keys.map((key) => [key.path, key]));
    for (const path of ["timelines[].anchor", "timelines[].min"]) {
      const meaning = byPath.get(path)?.meaning;
      expect(meaning, path).toContain(
        "Only max follows the anchor: min always counts back from the day the EIR is checked.",
      );
      expect(meaning, path).toContain(
        "With anchor form-started and a min above 0, a draft left open a long time sees its window narrow, and it can close entirely.",
      );
    }
  });

  it("gives each operator's stored rule string, as the checker writes it", () => {
    const recorded = Object.fromEntries(
      eirSchemaReference().operators.map((o) => [o.name, o.recordedAs]),
    );
    expect(recorded).toEqual({
      "irs-id": "irs-id",
      equals: "none: a yes-no flag on the question",
      "within-timeline": "within-timeline:<anchor>:<unit>:<min>:<max>",
      "not-future": "not-future",
      "not-past": "not-past",
      "on-or-after": "on-or-after:<otherField>",
    });
    const timeline = { id: "t", anchor: "evaluated", unit: "months", min: 0, max: 6 } as const;
    expect(fieldRule({ operator: "within-timeline", timeline: "t" }, [timeline])).toBe(
      "within-timeline:evaluated:months:0:6",
    );
    expect(
      fieldRule({ operator: "within-timeline", timeline: "t" }, [
        { ...timeline, anchor: undefined },
      ]),
    ).toBe("within-timeline:form-started:months:0:6");
    expect(fieldRule({ operator: "on-or-after", otherField: "start" })).toBe("on-or-after:start");
    expect(fieldRule({ operator: "equals" })).toBeUndefined();
  });

  it("states the timeline limits and that every scenario needs its days (#217 fix)", () => {
    const byPath = new Map(eirSchemaReference().keys.map((key) => [key.path, key]));
    expect(byPath.get("timelines[].max")?.constraints).toContainEqual({
      text: "At most 10 years, 120 months or 3660 days.",
      code: "timeline-bounds",
    });
    for (const path of ["scenarios[].formStartedAt", "scenarios[].submittedAt"]) {
      expect(byPath.get(path)?.constraints, path).toContainEqual({
        text: "Given, or inherited from the scenario it extends.",
        code: "invalid-value",
      });
    }
    // The checker agrees: a scenario with no days is refused, not run.
    const noDays = eirSchemaReference().example.replace(
      '    formStartedAt: "2026-10-14"\n    submittedAt: "2026-10-14"\n',
      "",
    );
    const loaded = loadDefinition(noDays);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["invalid-value", "scenarios.0.formStartedAt"],
      ["invalid-value", "scenarios.0.submittedAt"],
      ["invalid-value", "scenarios.1.formStartedAt"],
      ["invalid-value", "scenarios.1.submittedAt"],
    ]);
  });

  it("marks the bootstrap's non-production MVP defaults (#148) with their values", () => {
    const mvp = Object.fromEntries(
      eirSchemaReference()
        .keys.filter((key) => key.mvpDefault)
        .map((key) => [key.path, key.mvpDefault]),
    );
    expect(mvp).toMatchObject({
      validityDays: "365 days",
      reviewSlaBusinessDays: "3 business days",
      timelines: "training-certificate: 0 to 1 years, anchored evaluated",
      rules: "11 rules (11 blocking), with placeholder guidance",
    });
  });

  it("gives a minimal example that loads and whose scenarios all produce their outcome", () => {
    const loaded = loadDefinition(eirSchemaReference().example);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(runScenarios(loaded.definition).map((s) => [s.id, s.ok])).toEqual([
      ["passes", true],
      ["bad-user-id", true],
    ]);
  });

  it("maps a diagnostic's path to the key it's about", () => {
    expect(eirReferenceKeyFor(["rules", 3, "operator"])).toBe("rules[].operator");
    expect(eirReferenceKeyFor(["form", "sections", 0, "fields", 2, "type"])).toBe(
      "form.sections[].fields[].type",
    );
    expect(eirReferenceKeyFor(["timelines", 0])).toBe("timelines");
    expect(eirReferenceKeyFor(["scenarios", 1, "answers", "userId"])).toBe("scenarios[].answers");
    expect(eirReferenceKeyFor(["name"])).toBeUndefined();
    expect(eirReferenceKeyFor([])).toBeUndefined();
  });
});

/** The minimal example with `timelines` replaced, or a rule added. */
const exampleWith = (edit: (yaml: string) => string) => edit(eirSchemaReference().example);
const codesOf = (yaml: string) => {
  const loaded = loadDefinition(yaml);
  return loaded.ok ? [] : loaded.diagnostics.map((d) => d.code);
};
const meaningOf = (code: string) =>
  eirSchemaReference().codes.find((entry) => entry.code === code)?.meaning;

describe("diagnostic meanings match what raises them (#219 review)", () => {
  it("timeline-bounds: min over max, or max over the per-unit cap, each really raises it", () => {
    expect(meaningOf("timeline-bounds")).toBe(
      "A timeline's min is more than its max, or its max goes back further than the app supports: more than 10 years, 120 months or 3660 days.",
    );
    const timeline = (unit: string, min: number, max: number) =>
      exampleWith((y) =>
        y.replace(
          "timelines: []",
          `timelines:\n  - id: t\n    unit: ${unit}\n    min: ${min}\n    max: ${max}`,
        ),
      );
    expect(codesOf(timeline("years", 2, 1))).toEqual(["timeline-bounds"]);
    expect(codesOf(timeline("years", 0, 11))).toEqual(["timeline-bounds"]);
    expect(codesOf(timeline("months", 0, 121))).toEqual(["timeline-bounds"]);
    expect(codesOf(timeline("days", 0, 3661))).toEqual(["timeline-bounds"]);
    // The caps themselves are allowed.
    expect(codesOf(timeline("years", 0, 10))).toEqual([]);
    expect(codesOf(timeline("months", 0, 120))).toEqual([]);
    expect(codesOf(timeline("days", 0, 3660))).toEqual([]);
  });

  it("missing-guidance: a blocking rule with no or blank guidance raises it; irs-id is exempt", () => {
    expect(meaningOf("missing-guidance")).toBe(
      "A blocking rule has no guidance telling the employee what to do. Guidance that's only spaces counts as none. irs-id rules are exempt: their form error already says what to do.",
    );
    const withRule = (guidance: string) =>
      exampleWith((y) =>
        y
          .replace(
            "          required: true\n",
            "          required: true\n        - id: agreed\n          label: Agreed\n          type: yes-no\n          required: false\n",
          )
          .replace(
            "scenarios:\n",
            `  - id: must-agree\n    field: agreed\n    operator: equals\n    value: "no"\n    message: Not agreed\n    disposition: blocking\n    reasonCode: NOT-AGREED\n${guidance}scenarios:\n`,
          ),
      );
    expect(codesOf(withRule(""))).toEqual(["missing-guidance"]);
    expect(codesOf(withRule('    guidance: "   "\n'))).toEqual(["missing-guidance"]);
    expect(codesOf(withRule("    guidance: Agree to it.\n"))).toEqual([]);
    // The example's own blocking irs-id rule has no guidance, and loads.
    expect(eirSchemaReference().example).not.toContain("guidance");
    expect(codesOf(eirSchemaReference().example)).toEqual([]);
  });

  it("unavailable: never raised by Validate; raised when the app can't read its own bootstrap file", async () => {
    expect(meaningOf("unavailable")).toBe(
      "Validate and publishing never raise this. The app raises it when it can't read its own bootstrap definition file: the EIR form is then unavailable to employees. Nothing you wrote caused it: tell the EDP team.",
    );
    vi.resetModules();
    vi.doMock("@/data/eir/definition/bootstrap-source", () => ({
      readBootstrapEirSource: () => undefined,
    }));
    try {
      const { ACTIVE_EIR_DEFINITION } = await import("@/data/eir/definition/active");
      expect(ACTIVE_EIR_DEFINITION).toEqual({
        ok: false,
        diagnostics: [
          {
            code: "unavailable",
            message: "The bootstrap EIR definition couldn't be read.",
            path: [],
          },
        ],
      });
    } finally {
      vi.doUnmock("@/data/eir/definition/bootstrap-source");
      vi.resetModules();
    }
  });
});

/** A definition with one rule of `operator`, on a question its examples answer. */
function definitionWith(operator: string, example: EirOperatorExample): EirDefinition {
  const field = operator === "irs-id" ? "userId" : operator === "equals" ? "answer" : "day";
  const extra =
    operator === "equals"
      ? `    value: "${example.value}"\n    message: Flagged\n`
      : operator === "within-timeline"
        ? "    timeline: yearly\n"
        : operator === "on-or-after"
          ? "    otherField: otherDay\n"
          : "";
  const disposition = operator === "irs-id" ? "blocking" : "warning";
  const timeline = example.timeline ?? { anchor: "evaluated", unit: "years", min: 0, max: 1 };
  const yaml = eirSchemaReference()
    .example.replace(
      "          required: true\n",
      `          required: true
        - id: answer
          label: Answer
          type: yes-no
          required: false
        - id: day
          label: Day
          type: date
          required: false
        - id: otherDay
          label: Other day
          type: date
          required: false
`,
    )
    .replace(
      "timelines: []",
      `timelines:\n  - id: yearly\n    anchor: ${timeline.anchor}\n    unit: ${timeline.unit}\n    min: ${timeline.min}\n    max: ${timeline.max}`,
    )
    .replace(
      /rules:\n[\s\S]*?scenarios:\n/,
      `rules:
  - id: under-test
    field: ${field}
    operator: ${operator}
    disposition: ${disposition}
    reasonCode: UNDER-TEST
    guidance: Do this.
${extra}scenarios:
  - id: warned
    expect: warning
    formStartedAt: "2026-10-14"
    submittedAt: "2026-10-14"
    answers: {}
`,
    );
  const loaded = loadDefinition(yaml);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.definition;
}

describe("operator meanings match the evaluator (#219)", () => {
  const { operators } = eirSchemaReference();

  it("not-past: a date on the day it's checked meets it; the day before fails", () => {
    const notPast = operators.find((o) => o.name === "not-past")!;
    expect(notPast.examples).toEqual([
      expect.objectContaining({ answer: "2026-10-19", submittedAt: "2026-10-20", meets: false }),
      expect.objectContaining({ answer: "2026-10-20", submittedAt: "2026-10-20", meets: true }),
    ]);
    expect(notPast.checks).toContain("something expiring today is still in date");
  });

  it("lists each operator's field types and dispositions from the checker's table", () => {
    expect(operators.map((o) => [o.name, o.fieldTypes, o.dispositions])).toEqual([
      ["irs-id", ["text"], ["blocking"]],
      ["equals", ["yes-no"], ["blocking", "warning", "manual-review"]],
      ["within-timeline", ["date"], ["blocking", "warning", "manual-review"]],
      ["not-future", ["date"], ["blocking", "warning", "manual-review"]],
      ["not-past", ["date"], ["blocking", "warning", "manual-review"]],
      ["on-or-after", ["date"], ["blocking", "warning", "manual-review"]],
    ]);
  });

  const examples = operators.flatMap((o) =>
    o.examples.map((example) => [o.name, example.answer, example] as const),
  );
  it.each(examples)("%s with %s does what its example says", (operator, _answer, example) => {
    const definition = definitionWith(operator, example);
    const answers: EirFormValues = {
      userId: "A1B2C",
      declarationAgreed: "yes",
      answer: "",
      day: "",
      otherDay: example.otherAnswer ?? "",
      [operator === "irs-id" ? "userId" : operator === "equals" ? "answer" : "day"]: example.answer,
    };
    const evaluated = evaluateEirRules({
      definition,
      values: answers,
      draftStartedAt: example.formStartedAt,
      effectiveAt: example.submittedAt,
    });
    const fired = evaluated.outcomes.some((outcome) => outcome.reasonCode === "UNDER-TEST");
    expect(fired).toBe(!example.meets);
  });
});

/** Synthetic answers meeting every bootstrap-2 rule on the harness clock (2026-10-01). */
const PASSING: EirFormValues = {
  userId: "TST0001",
  firstName: "Test",
  lastName: "Person",
  workEmail: "test.person@example.gov",
  team: "Synthetic Team",
  subTeam: "",
  contractingCompany: "",
  managerFirstName: "Sample",
  managerLastName: "Manager",
  managerId: "TST0002",
  managerEmail: "sample.manager@example.gov",
  unauthorizedAccessTrainingDate: "2026-06-01",
  privacyTrainingDate: "2026-06-01",
  cyberAwarenessTrainingDate: "2026-06-01",
  irmAcknowledged: "yes",
  ndaSigned: "yes",
  mbiInitialDate: "2025-01-15",
  mbiExpirationDate: "2030-01-15",
  mbiPreliminary: "no",
  declarationAgreed: "yes",
};

/** bootstrap-2 with its NDA rule given `disposition`. */
function ndaRuleAs(disposition: EirDisposition): EirDefinition {
  const bootstrap = BOOTSTRAP_EIR_DEFINITIONS.active()!;
  return {
    ...bootstrap,
    rules: bootstrap.rules.map((rule) =>
      rule.id === "nda-signed" ? { ...rule, disposition } : rule,
    ),
  };
}

describe("disposition meanings match the repository (#219)", () => {
  const { dispositions } = eirSchemaReference();

  it("blocking refuses the PDF and the upload and is never eligible for automatic validity", () => {
    expect(dispositions.find((d) => d.name === "blocking")).toMatchObject({
      pdf: "refused",
      upload: "refused",
      automaticValidityEligible: false,
    });
  });

  it.each(dispositions.map((d) => [d.name, d] as const))(
    "a %s rule does to the PDF, upload and automatic validity what the reference says",
    async (name, effect) => {
      const definition = ndaRuleAs(name);
      const impl = memoryImplementation(createClock(), {
        definitions: {
          active: () => definition,
          byId: (id) => (id === definition.form.version ? definition : undefined),
        },
        shownFormVersion: definition.form.version,
      });
      const repository = impl.as(APPLICANT);
      const values = { ...PASSING, ndaSigned: "no" };
      await repository.saveDraft(APPLICANT.principalId, values);
      expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
        outcome: name,
        automaticValidityEligible: effect.automaticValidityEligible,
      });
      const generated = repository.generatePdf(APPLICANT.principalId);
      if (effect.pdf === "refused") await expect(generated).rejects.toThrow("Sign the IRS NDA");
      else await expect(generated).resolves.toBeInstanceOf(Uint8Array);
      const uploaded = repository.submitWithFile({
        principalId: APPLICANT.principalId,
        personName: APPLICANT.displayName,
        file: pdf(),
        values,
      });
      if (effect.upload === "refused") await expect(uploaded).rejects.toThrow("Sign the IRS NDA");
      else await expect(uploaded).resolves.toMatchObject({ stage: "submitted" });
    },
  );
});
