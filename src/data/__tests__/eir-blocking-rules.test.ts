import { describe, expect, it } from "vitest";

import { EIR_FORM, EIR_FORMS } from "../eir/config";
import { ACTIVE_EIR_DEFINITION } from "../eir/definition/active";
import { builtInById } from "../eir/definition/built-in";
import {
  definitionLabel,
  FALLBACK_BUILT_IN_ID,
  isBuiltInDefinitionId,
  publishedVersionNumber,
} from "../eir/definition/identity";
import { readBootstrapEirSource } from "../eir/definition/bootstrap-source";
import { checkEirDefinition } from "../eir/definition/check";
import { loadDefinition } from "../eir/definition/load";
import { runScenarios } from "../eir/definition/scenarios";
import { evaluateEirRules } from "../eir/evaluation";

/**
 * #217: every EIR rule a hard fail with actionable guidance, at the
 * definition service's public seam (`loadDefinition`, `checkEirDefinition`,
 * `runScenarios`) and the shared rule engine (`evaluateEirRules`). Expected
 * values are written by hand from the ticket, not read back from the code.
 */
const BOOTSTRAP_1 = readBootstrapEirSource("bootstrap")!;
const BOOTSTRAP_2 = readBootstrapEirSource("bootstrap-2")!;

function loaded(text: string) {
  const result = loadDefinition(text);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
  return result.definition;
}

function refused(text: string) {
  const result = loadDefinition(text);
  if (result.ok) throw new Error("expected the definition to be refused");
  return result.diagnostics;
}

/** `text` with one exact piece replaced (which must be there). */
function edited(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

/** Synthetic answers that meet every bootstrap-2 rule on 2026-09-02 (form started 2026-09-01). */
const PASSING = {
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
  unauthorizedAccessTrainingDate: "2026-03-01",
  privacyTrainingDate: "2026-03-01",
  cyberAwarenessTrainingDate: "2026-03-01",
  irmAcknowledged: "yes",
  ndaSigned: "yes",
  mbiInitialDate: "2025-01-15",
  mbiExpirationDate: "2030-01-15",
  mbiPreliminary: "no",
  declarationAgreed: "yes",
};

describe("definition checker: any disposition for any operator (#217)", () => {
  it.each([
    ["equals", "    field: ndaSigned\n", "manual-review"],
    ["within-timeline", "    field: privacyTrainingDate\n", "manual-review"],
    ["not-future", "    field: mbiInitialDate\n", "warning"],
    ["on-or-after", "    field: mbiExpirationDate\n", "warning"],
  ])("accepts blocking for %s", (operator, fieldLine, was) => {
    // bootstrap-1 already has a blocking scenario; a blocking rule also needs guidance.
    const at = BOOTSTRAP_1.indexOf(fieldLine);
    const ruleText = BOOTSTRAP_1.slice(at, BOOTSTRAP_1.indexOf("  - id:", at));
    expect(ruleText).toContain(`operator: ${operator}`);
    const text = edited(
      BOOTSTRAP_1,
      ruleText,
      ruleText.replace(
        `disposition: ${was}`,
        "disposition: blocking\n    guidance: Synthetic guidance.",
      ),
    );
    const rule = loaded(text).rules.find((r) => r.field === fieldLine.trim().slice(7));
    expect(rule).toMatchObject({ operator, disposition: "blocking" });
  });

  it("keeps warning and manual-review valid: bootstrap-1 still loads with its mix", () => {
    expect(loaded(BOOTSTRAP_1).rules.map((r) => r.disposition)).toEqual([
      "blocking",
      "blocking",
      "manual-review",
      "manual-review",
      "manual-review",
      "manual-review",
      "manual-review",
      "warning",
      "warning",
      "manual-review",
    ]);
  });

  it("still refuses an unknown operator and an unknown disposition", () => {
    expect(
      refused(edited(BOOTSTRAP_2, "operator: not-past\n", "operator: not-in-past-maybe\n")),
    ).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
    expect(
      refused(
        edited(
          BOOTSTRAP_2,
          "operator: not-past\n    disposition: blocking\n",
          "operator: not-past\n    disposition: auto-approve\n",
        ),
      ),
    ).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
  });

  it("an ID-format rule can still only be blocking: its failure is a form error", () => {
    const text = edited(
      BOOTSTRAP_2,
      "    operator: irs-id\n    disposition: blocking\n",
      "    operator: irs-id\n    disposition: warning\n",
    );
    expect(refused(text)).toContainEqual(
      expect.objectContaining({
        code: "inconsistent-disposition",
        message: 'Rule "user-id-format": irs-id can\'t be warning (it can be blocking).',
      }),
    );
  });

  it("not-past only checks a date field", () => {
    const text = edited(
      BOOTSTRAP_2,
      "    field: mbiExpirationDate\n    operator: not-past\n",
      "    field: ndaSigned\n    operator: not-past\n",
    );
    expect(refused(text)).toContainEqual(
      expect.objectContaining({
        code: "invalid-value",
        message: 'Rule "mbi-not-expired": not-past can\'t check a yes-no field.',
      }),
    );
  });

  it("refuses two rules with the same operator on one field", () => {
    const text = edited(
      BOOTSTRAP_2,
      "    field: mbiExpirationDate\n    operator: not-past\n",
      "    field: mbiExpirationDate\n    operator: on-or-after\n    otherField: mbiInitialDate\n",
    );
    expect(refused(text)).toContainEqual(
      expect.objectContaining({
        code: "duplicate-id",
        message: 'Field "mbiExpirationDate" has more than one on-or-after rule.',
      }),
    );
  });

  it("an all-blocking definition needs only pass and blocking scenarios", () => {
    const definition = loaded(BOOTSTRAP_2);
    expect(new Set(definition.scenarios.map((s) => s.expect))).toEqual(
      new Set(["pass", "blocking"]),
    );
  });

  it("a definition with a warning rule still needs a warning scenario", () => {
    const text = edited(
      BOOTSTRAP_2,
      "    operator: not-future\n    disposition: blocking\n",
      "    operator: not-future\n    disposition: warning\n",
    );
    expect(refused(text)).toContainEqual(
      expect.objectContaining({
        code: "missing-scenario",
        message: "No scenario expects warning: add one.",
      }),
    );
  });

  it("a scenario's expected reason code must be among the reasons it produces", () => {
    const text = edited(
      BOOTSTRAP_2,
      "    reasonCode: EIR-NDA-NOT-SIGNED\n    answers:\n",
      "    reasonCode: EIR-IRM-NOT-ACKNOWLEDGED\n    answers:\n",
    );
    const failed = runScenarios(loaded(text)).filter((r) => !r.ok);
    expect(failed).toEqual([
      expect.objectContaining({
        id: "blocking-nda",
        expected: "blocking",
        actual: "blocking",
        expectedReasonCode: "EIR-IRM-NOT-ACKNOWLEDGED",
      }),
    ]);
  });

  it("publish check accepts a mix of dispositions, and scenarios still decide publishable", async () => {
    // bootstrap-1 with NDA blocking: blocking, warning and manual-review rules together.
    const mixed = edited(
      BOOTSTRAP_1,
      "    message: IRS NDA not signed\n    disposition: manual-review\n",
      "    message: IRS NDA not signed\n    disposition: blocking\n    guidance: Sign the IRS NDA, then answer Yes.\n",
    );
    const broken = await checkEirDefinition(mixed);
    // The manual-review-nda scenario now blocks, so the definition can't be published.
    expect(broken).toMatchObject({ ok: true, publishable: false });
    const fixed = await checkEirDefinition(
      edited(
        mixed,
        '  - id: manual-review-nda\n    expect: manual-review\n    extends: pass\n    answers:\n      ndaSigned: "no"\n',
        '  - id: manual-review-nda\n    expect: manual-review\n    extends: pass\n    answers:\n      mbiPreliminary: "yes"\n',
      ),
    );
    expect(fixed).toMatchObject({ ok: true, publishable: true });
  });
});

describe("not-past: an MBI already expired on the evaluation date (#217)", () => {
  const definition = loaded(BOOTSTRAP_2);
  const evaluate = (mbiExpirationDate: string, effectiveAt: string) =>
    evaluateEirRules({
      definition,
      values: { ...PASSING, mbiExpirationDate },
      draftStartedAt: "2026-09-01",
      effectiveAt,
    });

  it("blocks an expiration before the evaluation date, with renew guidance", () => {
    expect(evaluate("2026-09-01", "2026-09-02")).toEqual({
      outcome: "blocking",
      outcomes: [
        {
          ruleId: "mbi-not-expired",
          field: "mbiExpirationDate",
          reasonCode: "EIR-MBI-EXPIRED",
          disposition: "blocking",
          guidance:
            "[Placeholder wording] Your MBI or staff-like access has expired. Renew it, then enter the new expiration date.",
        },
      ],
    });
  });

  it("passes an expiration on the evaluation date itself", () => {
    expect(evaluate("2026-09-02", "2026-09-02").outcome).toBe("pass");
  });

  it("uses the evaluation clock, not the form's start: the same answers expire later", () => {
    expect(evaluate("2026-10-01", "2026-09-30T23:00:00.000Z").outcome).toBe("pass");
    expect(evaluate("2026-10-01", "2026-10-02T09:00:00.000Z").outcome).toBe("blocking");
  });
});

describe("bootstrap-2: every rule blocking, with actionable guidance (#217)", () => {
  const definition = loaded(BOOTSTRAP_2);

  it("names no version of its own: it's the built-in bootstrap-2 (version 0), the fallback for new drafts (#224)", () => {
    expect(BOOTSTRAP_2).not.toMatch(/^definitionVersion:/m);
    expect(BOOTSTRAP_2).not.toMatch(/^ {2}version:/m);
    expect(FALLBACK_BUILT_IN_ID).toBe("bootstrap-2");
    expect(ACTIVE_EIR_DEFINITION.ok && ACTIVE_EIR_DEFINITION.definition.form.version).toBe(
      "bootstrap-2",
    );
    expect(EIR_FORM.version).toBe("bootstrap-2");
    expect(builtInById("bootstrap-2")?.rules.every((r) => r.disposition === "blocking")).toBe(true);
    // A reserved name: shown as version 0, and never a number publish can assign.
    expect(definitionLabel("bootstrap-2")).toBe("bootstrap-2 (version 0)");
    expect(isBuiltInDefinitionId("bootstrap-2")).toBe(true);
    expect(publishedVersionNumber("bootstrap-2")).toBeUndefined();
    // A copy that names its own version is refused, as #224 refuses any.
    expect(refused(`definitionVersion: bootstrap-2\n${BOOTSTRAP_2}`)).toContainEqual(
      expect.objectContaining({ code: "server-assigned-version", path: ["definitionVersion"] }),
    );
  });

  it("keeps the bootstrap definition for drafts and EIRs given under it, or under its old label 1.3", () => {
    expect(builtInById("bootstrap")?.form.version).toBe("bootstrap");
    expect(builtInById("1.3")?.form.version).toBe("1.3");
    expect(Object.keys(EIR_FORMS).sort()).toEqual(["1.2", "1.3", "bootstrap", "bootstrap-2"]);
    for (const id of ["bootstrap", "1.3"]) {
      expect(EIR_FORMS[id]?.sections.find((s) => s.id === "compliance")?.help, id).toBe(
        "Checked before you can enter a sensitive environment such as preprod or prod. A No doesn't stop you submitting.",
      );
    }
    expect(builtInById("1.3")?.rules.find((r) => r.id === "nda-signed")?.disposition).toBe(
      "manual-review",
    );
  });

  it("has every listed rule, each blocking with its reason code", () => {
    expect(
      definition.rules.map((r) => [r.id, r.field, r.operator, r.disposition, r.reasonCode]),
    ).toEqual([
      ["user-id-format", "userId", "irs-id", "blocking", "EIR-USER-ID-FORMAT"],
      ["manager-id-format", "managerId", "irs-id", "blocking", "EIR-MANAGER-ID-FORMAT"],
      [
        "unauthorized-access-training-current",
        "unauthorizedAccessTrainingDate",
        "within-timeline",
        "blocking",
        "EIR-UA-TRAINING-NOT-CURRENT",
      ],
      [
        "privacy-training-current",
        "privacyTrainingDate",
        "within-timeline",
        "blocking",
        "EIR-PRIVACY-TRAINING-NOT-CURRENT",
      ],
      [
        "cyber-awareness-training-current",
        "cyberAwarenessTrainingDate",
        "within-timeline",
        "blocking",
        "EIR-CYBER-TRAINING-NOT-CURRENT",
      ],
      ["irm-acknowledged", "irmAcknowledged", "equals", "blocking", "EIR-IRM-NOT-ACKNOWLEDGED"],
      ["nda-signed", "ndaSigned", "equals", "blocking", "EIR-NDA-NOT-SIGNED"],
      [
        "mbi-start-not-future",
        "mbiInitialDate",
        "not-future",
        "blocking",
        "EIR-MBI-START-IN-FUTURE",
      ],
      [
        "mbi-expiration-after-start",
        "mbiExpirationDate",
        "on-or-after",
        "blocking",
        "EIR-MBI-EXPIRES-BEFORE-START",
      ],
      ["mbi-not-expired", "mbiExpirationDate", "not-past", "blocking", "EIR-MBI-EXPIRED"],
      ["mbi-investigation-complete", "mbiPreliminary", "equals", "blocking", "EIR-MBI-PRELIMINARY"],
    ]);
  });

  it("gives every rule guidance that says what to do, visibly placeholder wording", () => {
    expect(Object.fromEntries(definition.rules.map((r) => [r.id, r.guidance]))).toEqual({
      "user-id-format":
        "[Placeholder wording] Enter your IRS user ID (SEID): 3 to 12 letters and numbers, like A1B2C.",
      "manager-id-format":
        "[Placeholder wording] Enter your manager's IRS user ID (SEID): 3 to 12 letters and numbers, like A1B2C.",
      "unauthorized-access-training-current":
        "[Placeholder wording] Complete your Unauthorized Access training, then enter its completion date.",
      "privacy-training-current":
        "[Placeholder wording] Complete your Privacy training, then enter its completion date.",
      "cyber-awareness-training-current":
        "[Placeholder wording] Complete your Cyber Awareness training, then enter its completion date.",
      "irm-acknowledged":
        "[Placeholder wording] Read, acknowledge and sign the IRM 10.5.8 manual transmittal, then answer Yes.",
      "nda-signed": "[Placeholder wording] Sign the IRS NDA, then answer Yes.",
      "mbi-start-not-future":
        "[Placeholder wording] Enter the start date shown on your MBI or staff-like access record. It can't be in the future.",
      "mbi-expiration-after-start":
        "[Placeholder wording] Check your MBI or staff-like access record: enter its expiration date, which is after the start date.",
      "mbi-not-expired":
        "[Placeholder wording] Your MBI or staff-like access has expired. Renew it, then enter the new expiration date.",
      "mbi-investigation-complete":
        "[Placeholder wording] Wait until your background investigation is complete, then answer No.",
    });
  });

  it("declares pass plus one blocking scenario per rule, and each produces its reason code", () => {
    const results = runScenarios(definition);
    expect(
      results.map(({ id, expected, actual, ok, expectedReasonCode }) => ({
        id,
        expected,
        actual,
        ok,
        expectedReasonCode,
      })),
    ).toEqual([
      { id: "pass", expected: "pass", actual: "pass", ok: true, expectedReasonCode: undefined },
      ...[
        ["blocking-user-id", "EIR-USER-ID-FORMAT"],
        ["blocking-manager-id", "EIR-MANAGER-ID-FORMAT"],
        ["blocking-ua-training", "EIR-UA-TRAINING-NOT-CURRENT"],
        ["blocking-privacy-training", "EIR-PRIVACY-TRAINING-NOT-CURRENT"],
        ["blocking-cyber-training", "EIR-CYBER-TRAINING-NOT-CURRENT"],
        ["blocking-irm", "EIR-IRM-NOT-ACKNOWLEDGED"],
        ["blocking-nda", "EIR-NDA-NOT-SIGNED"],
        ["blocking-mbi-start-future", "EIR-MBI-START-IN-FUTURE"],
        ["blocking-mbi-expires-before-start", "EIR-MBI-EXPIRES-BEFORE-START"],
        ["blocking-mbi-expired", "EIR-MBI-EXPIRED"],
        ["blocking-mbi-preliminary", "EIR-MBI-PRELIMINARY"],
      ].map(([id, code]) => ({
        id,
        expected: "blocking",
        actual: "blocking",
        ok: true,
        expectedReasonCode: code,
      })),
    ]);
  });

  it("the shared engine gives each failed rule its guidance, not just what's wrong", () => {
    const guidanceFor = (changed: Record<string, string>) =>
      evaluateEirRules({
        definition,
        values: { ...PASSING, ...changed },
        draftStartedAt: "2026-09-01",
        effectiveAt: "2026-09-02",
      }).outcomes.map((o) => [o.reasonCode, o.guidance]);
    expect(guidanceFor({ privacyTrainingDate: "2025-08-01" })).toEqual([
      [
        "EIR-PRIVACY-TRAINING-NOT-CURRENT",
        "[Placeholder wording] Complete your Privacy training, then enter its completion date.",
      ],
    ]);
    // A blank answer is a form error, with the form's code, not a rule's.
    expect(guidanceFor({ privacyTrainingDate: "" })).toEqual([
      ["EIR-FORM-PRIVACYTRAININGDATE-INVALID", "Enter privacy training date."],
    ]);
    expect(guidanceFor({ ndaSigned: "no" })).toEqual([
      ["EIR-NDA-NOT-SIGNED", "[Placeholder wording] Sign the IRS NDA, then answer Yes."],
    ]);
    expect(guidanceFor({ mbiPreliminary: "yes" })).toEqual([
      [
        "EIR-MBI-PRELIMINARY",
        "[Placeholder wording] Wait until your background investigation is complete, then answer No.",
      ],
    ]);
  });

  it("all-passing answers pass", () => {
    expect(
      evaluateEirRules({
        definition,
        values: PASSING,
        draftStartedAt: "2026-09-01",
        effectiveAt: "2026-09-02",
      }),
    ).toEqual({ outcome: "pass", outcomes: [] });
  });

  it("bootstrap-1 rules are unchanged: an NDA No is still manual-review there", () => {
    expect(
      evaluateEirRules({
        definition: loaded(BOOTSTRAP_1),
        values: { ...PASSING, ndaSigned: "no" },
        draftStartedAt: "2026-09-01",
        effectiveAt: "2026-09-02",
      }),
    ).toEqual({
      outcome: "manual-review",
      outcomes: [
        {
          ruleId: "nda-signed",
          field: "ndaSigned",
          reasonCode: "EIR-NDA-NOT-SIGNED",
          disposition: "manual-review",
          guidance: "IRS NDA not signed",
        },
      ],
    });
  });
});

/** bootstrap-2 with the two MBI expiration rules in the other order. */
const REORDERED = (() => {
  const after = BOOTSTRAP_2.slice(
    BOOTSTRAP_2.indexOf("  - id: mbi-expiration-after-start\n"),
    BOOTSTRAP_2.indexOf("  - id: mbi-not-expired\n"),
  );
  const expired = BOOTSTRAP_2.slice(
    BOOTSTRAP_2.indexOf("  - id: mbi-not-expired\n"),
    BOOTSTRAP_2.indexOf("  - id: mbi-investigation-complete\n"),
  );
  return edited(BOOTSTRAP_2, after + expired, expired + after);
})();

describe("a field with several rules: deterministic reasons (#217 review)", () => {
  const evaluate = (text: string, changed: Record<string, string>) =>
    evaluateEirRules({
      definition: loaded(text),
      values: { ...PASSING, ...changed },
      draftStartedAt: "2026-09-01",
      effectiveAt: "2026-09-02",
    }).outcomes.map((o) => [o.ruleId, o.reasonCode, o.guidance]);

  it.each([
    ["blank", "", "Enter MBI or staff-like access expiration date."],
    ["malformed", "2026-02-30", "MBI or staff-like access expiration date: enter a real date."],
  ])(
    "a %s MBI expiration is a form error, whatever order its rules are in",
    (_l, value, message) => {
      const expected = [["form-mbiExpirationDate", "EIR-FORM-MBIEXPIRATIONDATE-INVALID", message]];
      expect(evaluate(BOOTSTRAP_2, { mbiExpirationDate: value })).toEqual(expected);
      expect(evaluate(REORDERED, { mbiExpirationDate: value })).toEqual(expected);
    },
  );

  it("an ID that isn't one still gets its irs-id rule's code and guidance; a blank one is a form error", () => {
    expect(evaluate(BOOTSTRAP_2, { userId: "not an id!" })).toEqual([
      [
        "user-id-format",
        "EIR-USER-ID-FORMAT",
        "[Placeholder wording] Enter your IRS user ID (SEID): 3 to 12 letters and numbers, like A1B2C.",
      ],
    ]);
    expect(evaluate(BOOTSTRAP_2, { userId: "" })).toEqual([
      ["form-userId", "EIR-FORM-USERID-INVALID", "Enter user ID."],
    ]);
  });

  it("each failing rule reports itself, in either order", () => {
    const both = { mbiInitialDate: "2026-01-15", mbiExpirationDate: "2025-12-31" };
    const codes = (text: string) =>
      evaluate(text, both)
        .map(([, code]) => code)
        .sort();
    expect(codes(BOOTSTRAP_2)).toEqual(["EIR-MBI-EXPIRED", "EIR-MBI-EXPIRES-BEFORE-START"]);
    expect(codes(REORDERED)).toEqual(["EIR-MBI-EXPIRED", "EIR-MBI-EXPIRES-BEFORE-START"]);
  });
});

describe("guidance is required on blocking rules (#217 review)", () => {
  /** bootstrap-2 with one rule's guidance line taken out. */
  const withoutGuidance = (ruleId: string) => {
    const at = BOOTSTRAP_2.indexOf(`  - id: ${ruleId}\n`);
    const start = BOOTSTRAP_2.indexOf("    guidance: ", at);
    const end = BOOTSTRAP_2.indexOf("\n", start) + 1;
    return BOOTSTRAP_2.slice(0, start) + BOOTSTRAP_2.slice(end);
  };

  it("refuses a blocking rule with no guidance, naming it, in the definition service and its check", async () => {
    const text = withoutGuidance("nda-signed");
    expect(refused(text)).toEqual([
      expect.objectContaining({
        code: "missing-guidance",
        message:
          'Rule "nda-signed" is blocking, so it needs guidance: what the employee should do to meet it.',
        path: ["rules", 6, "guidance"],
      }),
    ]);
    expect(await checkEirDefinition(text)).toMatchObject({
      ok: false,
      publishable: false,
      diagnostics: [expect.objectContaining({ code: "missing-guidance" })],
    });
  });

  it.each([
    ["spaces", '"   "'],
    ["a tab and spaces", '"\t  "'],
  ])("refuses a blocking rule whose guidance is only %s (review 2)", async (_label, blank) => {
    const at = BOOTSTRAP_2.indexOf("  - id: nda-signed\n");
    const start = BOOTSTRAP_2.indexOf("    guidance: ", at);
    const end = BOOTSTRAP_2.indexOf("\n", start);
    const text = BOOTSTRAP_2.slice(0, start) + `    guidance: ${blank}` + BOOTSTRAP_2.slice(end);
    expect(refused(text)).toEqual([
      expect.objectContaining({
        code: "missing-guidance",
        message:
          'Rule "nda-signed" is blocking, so it needs guidance: what the employee should do to meet it.',
        path: ["rules", 6, "guidance"],
      }),
    ]);
    expect(await checkEirDefinition(text)).toMatchObject({ ok: false, publishable: false });
  });

  it("an irs-id rule may leave guidance out: its form error already says what to do", () => {
    const definition = loaded(withoutGuidance("user-id-format"));
    expect(definition.rules[0]).not.toHaveProperty("guidance");
    expect(
      evaluateEirRules({
        definition,
        values: { ...PASSING, userId: "not an id!" },
        draftStartedAt: "2026-09-01",
        effectiveAt: "2026-09-02",
      }).outcomes.map((o) => o.guidance),
    ).toEqual(["User ID: use 3 to 12 letters and numbers, like A1B2C."]);
  });

  it("warning and manual-review rules may leave guidance out (bootstrap-1 has none)", () => {
    expect(loaded(BOOTSTRAP_1).rules.filter((r) => r.guidance)).toEqual([]);
  });
});

/** bootstrap-2 with its training timeline replaced. */
const withTimeline = (unit: string, min: number, max: number) =>
  edited(
    BOOTSTRAP_2,
    "    unit: years\n    min: 0\n    max: 1\n",
    `    unit: ${unit}\n    min: ${min}\n    max: ${max}\n`,
  );

describe("configurable training timelines (#217 schema review)", () => {
  /** The outcome with the training dates on `date`, evaluated on `day` (UTC). */
  const privacy = (text: string, date: string, day = "2026-09-02", started = "2026-09-01") =>
    evaluateEirRules({
      definition: loaded(text),
      // All three trainings on `date`, so only the window decides.
      values: {
        ...PASSING,
        unauthorizedAccessTrainingDate: date,
        privacyTrainingDate: date,
        cyberAwarenessTrainingDate: date,
      },
      draftStartedAt: started,
      effectiveAt: `${day}T15:00:00.000Z`,
    }).outcome;

  it("max 1 year: the day exactly a year before the evaluation day passes, the day before it blocks", () => {
    const text = withTimeline("years", 0, 1);
    expect(privacy(text, "2025-09-02")).toBe("pass");
    expect(privacy(text, "2025-09-01")).toBe("blocking");
  });

  it("max 2 years changes the outcome: 2025-09-01 passes, and the 2-year boundary is exact", () => {
    const text = withTimeline("years", 0, 2);
    expect(privacy(text, "2025-09-01")).toBe("pass");
    expect(privacy(text, "2024-09-02")).toBe("pass");
    expect(privacy(text, "2024-09-01")).toBe("blocking");
  });

  it("min 0: the evaluation day itself passes, the next day blocks", () => {
    const text = withTimeline("years", 0, 1);
    expect(privacy(text, "2026-09-02")).toBe("pass");
    expect(privacy(text, "2026-09-03")).toBe("blocking");
  });

  it("months: max 6 months before 2026-09-02 is 2026-03-02", () => {
    const text = withTimeline("months", 0, 6);
    expect(privacy(text, "2026-03-02")).toBe("pass");
    expect(privacy(text, "2026-03-01")).toBe("blocking");
  });

  it("days: min 1 day, max 30 days — not the evaluation day, back to 2026-08-03", () => {
    const text = withTimeline("days", 1, 30);
    expect(privacy(text, "2026-09-02")).toBe("blocking");
    expect(privacy(text, "2026-09-01")).toBe("pass");
    expect(privacy(text, "2026-08-03")).toBe("pass");
    expect(privacy(text, "2026-08-02")).toBe("blocking");
  });

  it("a day the target month doesn't have clamps to its last day (29 Feb, 31 Aug)", () => {
    expect(privacy(withTimeline("years", 0, 1), "2027-02-28", "2028-02-29")).toBe("pass");
    expect(privacy(withTimeline("years", 0, 1), "2027-02-27", "2028-02-29")).toBe("blocking");
    // 6 months before 2026-08-31 is 2026-02-28.
    expect(privacy(withTimeline("months", 0, 6), "2026-02-28", "2026-08-31")).toBe("pass");
    expect(privacy(withTimeline("months", 0, 6), "2026-02-27", "2026-08-31")).toBe("blocking");
  });

  it("counts back from the evaluation day, not from when the form was started", () => {
    // Started 2026-01-01; checked 2026-09-02. A year before the start would allow 2025-06-01.
    expect(privacy(withTimeline("years", 0, 1), "2025-06-01", "2026-09-02", "2026-01-01")).toBe(
      "blocking",
    );
  });

  it("says what the window is when a date falls outside it (rule with no guidance)", () => {
    // The other trainings sit inside every window here, so only Privacy is flagged.
    const flags = (text: string, date: string) =>
      evaluateEirRules({
        definition: loaded(text),
        values: {
          ...PASSING,
          unauthorizedAccessTrainingDate: "2026-08-20",
          cyberAwarenessTrainingDate: "2026-08-20",
          privacyTrainingDate: date,
        },
        draftStartedAt: "2026-09-01",
        effectiveAt: "2026-09-02",
      }).outcomes.map((o) => o.guidance);
    const b1 = edited(
      BOOTSTRAP_1,
      "    unit: years\n    min: 0\n    max: 1\n",
      "    anchor: evaluated\n    unit: years\n    min: 0\n    max: 2\n",
    );
    expect(flags(b1, "2024-08-01")).toEqual([
      "More than 2 years before the day it was checked: it should be dated 9/2/2024 or later",
    ]);
    expect(flags(b1, "2026-09-05")).toEqual(["Dated after the day it was checked (9/2/2026)"]);
    const days = edited(
      BOOTSTRAP_1,
      "    unit: years\n    min: 0\n    max: 1\n",
      "    anchor: evaluated\n    unit: days\n    min: 1\n    max: 30\n",
    );
    expect(flags(days, "2026-09-02")).toEqual([
      "Dated after 9/1/2026: it should be at least 1 day before the day it was checked",
    ]);
  });

  it.each([
    ["an unknown unit", "weeks", 0, 1, "invalid-value"],
    ["min after max", "years", 2, 1, "timeline-bounds"],
    ["more than 10 years", "years", 0, 11, "timeline-bounds"],
    ["more than 120 months", "months", 0, 121, "timeline-bounds"],
    ["more than 3660 days", "days", 0, 3661, "timeline-bounds"],
  ] as const)("refuses %s with a diagnostic", (_label, unit, min, max, code) => {
    expect(refused(withTimeline(unit, min, max))).toContainEqual(expect.objectContaining({ code }));
  });

  it("the normalized field carries the timeline it checks", () => {
    const field = loaded(withTimeline("months", 1, 6))
      .form.sections.flatMap((s) => s.fields)
      .find((f) => f.id === "privacyTrainingDate");
    expect(field?.rule).toBe("within-timeline:evaluated:months:1:6");
  });
});

describe("scenario clocks are required (#217 schema review)", () => {
  const PASS_CLOCKS = '    formStartedAt: "2026-09-01"\n    submittedAt: "2026-09-02"\n';

  it("refuses a scenario with no clocks, its own or inherited, instead of throwing", async () => {
    const text = edited(BOOTSTRAP_2, PASS_CLOCKS, "");
    const diagnostics = refused(text);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid-value",
        path: ["scenarios", 0, "formStartedAt"],
        message:
          'Scenario "pass" needs formStartedAt (its own, or from the scenario it extends): rules are checked on its dates.',
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-value", path: ["scenarios", 0, "submittedAt"] }),
    );
    await expect(checkEirDefinition(text)).resolves.toMatchObject({ ok: false });
  });

  it("refuses a clock that isn't a real date", () => {
    const text = edited(
      BOOTSTRAP_2,
      '    submittedAt: "2026-09-02"\n',
      '    submittedAt: "2026-02-30"\n',
    );
    expect(refused(text)).toContainEqual(
      expect.objectContaining({ code: "invalid-value", path: ["scenarios", 0, "submittedAt"] }),
    );
  });
});

describe("normalized field metadata on a field with several rules (#217 schema review)", () => {
  const fields = () => loaded(BOOTSTRAP_2).form.sections.flatMap((s) => s.fields);

  it("a multi-rule field lists its rules and carries no single rule's ID, disposition or code", () => {
    const expiration = fields().find((f) => f.id === "mbiExpirationDate")!;
    expect(expiration.rules).toEqual(["on-or-after:mbiInitialDate", "not-past"]);
    expect(expiration).not.toHaveProperty("ruleId");
    expect(expiration).not.toHaveProperty("disposition");
    expect(expiration).not.toHaveProperty("reasonCode");
  });

  it("a single-rule field keeps its rule's ID, disposition and code", () => {
    expect(fields().find((f) => f.id === "ndaSigned")).toMatchObject({
      ruleId: "nda-signed",
      disposition: "blocking",
      reasonCode: "EIR-NDA-NOT-SIGNED",
    });
  });
});

describe("timeline anchors: form-started (default) and evaluated (#217 review 4)", () => {
  /** bootstrap-2 with its timeline anchored at `anchor`, or with no anchor key. */
  const anchored = (anchor: "form-started" | "evaluated" | undefined) =>
    edited(BOOTSTRAP_2, "    anchor: evaluated\n", anchor ? `    anchor: ${anchor}\n` : "");
  /** Started 2026-01-01, checked 2026-09-02 (UTC); all three trainings on `date`. */
  const outcome = (text: string, date: string) =>
    evaluateEirRules({
      definition: loaded(text),
      values: {
        ...PASSING,
        unauthorizedAccessTrainingDate: date,
        privacyTrainingDate: date,
        cyberAwarenessTrainingDate: date,
      },
      draftStartedAt: "2026-01-01T09:00:00.000Z",
      effectiveAt: "2026-09-02T15:00:00.000Z",
    }).outcome;

  it("bootstrap-2 is evaluated; bootstrap-1, with no anchor key, is form-started", () => {
    expect(loaded(BOOTSTRAP_2).timelines).toEqual([
      { id: "training-certificate", anchor: "evaluated", unit: "years", min: 0, max: 1 },
    ]);
    expect(BOOTSTRAP_1).not.toContain("anchor:");
    expect(loaded(BOOTSTRAP_1).timelines).toEqual([
      { id: "training-certificate", anchor: "form-started", unit: "years", min: 0, max: 1 },
    ]);
    const rule = (text: string) =>
      loaded(text)
        .form.sections.flatMap((section) => section.fields)
        .find((field) => field.id === "privacyTrainingDate")?.rule;
    expect(rule(BOOTSTRAP_1)).toBe("within-timeline:form-started:years:0:1");
    expect(rule(BOOTSTRAP_2)).toBe("within-timeline:evaluated:years:0:1");
  });

  it("form-started: counts max back from the form's start, 2025-01-01 is the boundary", () => {
    const text = anchored("form-started");
    expect(outcome(text, "2025-01-01")).toBe("pass");
    expect(outcome(text, "2024-12-31")).toBe("blocking");
    expect(outcome(text, "2025-06-01")).toBe("pass");
  });

  it("evaluated: the same dates count back from the day it's checked, 2025-09-02 is the boundary", () => {
    const text = anchored("evaluated");
    expect(outcome(text, "2025-06-01")).toBe("blocking");
    expect(outcome(text, "2025-09-02")).toBe("pass");
    expect(outcome(text, "2025-09-01")).toBe("blocking");
  });

  it("both: no later than the day it's checked (min 0)", () => {
    for (const anchor of ["form-started", "evaluated"] as const) {
      expect(outcome(anchored(anchor), "2026-09-02"), anchor).toBe("pass");
      expect(outcome(anchored(anchor), "2026-09-03"), anchor).toBe("blocking");
    }
  });

  it("an omitted anchor is form-started", () => {
    expect(outcome(anchored(undefined), "2025-06-01")).toBe("pass");
    expect(outcome(anchored(undefined), "2024-12-31")).toBe("blocking");
  });

  it("refuses an unknown anchor", () => {
    expect(
      refused(edited(BOOTSTRAP_2, "    anchor: evaluated\n", "    anchor: whenever\n")),
    ).toContainEqual(
      expect.objectContaining({ code: "invalid-value", path: ["timelines", 0, "anchor"] }),
    );
  });

  it("form-started keeps form 1.3's flag wording (bootstrap-1, unchanged)", () => {
    const guidance = (date: string) =>
      evaluateEirRules({
        definition: loaded(BOOTSTRAP_1),
        values: { ...PASSING, privacyTrainingDate: date },
        draftStartedAt: "2026-01-01",
        effectiveAt: "2026-09-02",
      }).outcomes.map((o) => o.guidance);
    expect(guidance("2024-12-31")).toEqual([
      "More than a year before the form was started: training is yearly, so it should be dated 1/1/2025 or later",
    ]);
    expect(guidance("2026-09-03")).toEqual(["Dated after the form was submitted (9/2/2026)"]);
  });
});
