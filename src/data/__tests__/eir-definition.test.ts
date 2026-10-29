import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { readBootstrapEirSource } from "../eir/definition/bootstrap-source";
import { loadDefinition } from "../eir/definition/load";
import { runScenarios } from "../eir/definition/scenarios";

/**
 * The first bootstrap EIR definition (#200, `bootstrap-1`), at its public seam: `loadDefinition`
 * turns YAML text into a typed definition or refuses it with diagnostics.
 */
const BOOTSTRAP = readBootstrapEirSource("bootstrap")!;

function loaded(text: string = BOOTSTRAP) {
  const result = loadDefinition(text);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
  return result.definition;
}

describe("EIR definition loader", () => {
  it.each([
    ["bootstrap", "3af890f8c065f1de3d5549ff07ac2d37a4d030e26e569a643d96ca418a75b82d"],
    ["bootstrap-2", "35d2aac1e3e5134d67886de746e9ae67e803195b33e8be09c2185b7a01fc2b8c"],
  ] as const)("keeps the %s source text byte-identical", (name, expectedHash) => {
    const source = readBootstrapEirSource(name);
    expect(source).toBeDefined();
    expect(createHash("sha256").update(source!).digest("hex")).toBe(expectedHash);
  });

  it("bootstrap definition loads into a typed definition, named by the identity it's given", () => {
    expect(loaded().form.version).toBe("unpublished");
    const definition = loadDefinition(BOOTSTRAP, "bootstrap");
    if (!definition.ok) throw new Error("expected the bootstrap to load");
    expect(definition.definition.form.version).toBe("bootstrap");
    expect(definition.definition.form.title).toBe(
      "Enterprise Data Platform - Employee Identity Record (EIR)",
    );
  });

  it("the bootstrap YAML names no version of its own (#224)", () => {
    expect(BOOTSTRAP).not.toMatch(/^definitionVersion:/m);
    expect(BOOTSTRAP).not.toMatch(/^ {2}version:/m);
  });
});

/**
 * Form 1.3 as `config.ts` encoded it before #200, copied by hand: the
 * independent truth the bootstrap YAML must reproduce. Not derived from the
 * loader. Each row: id, label, type, required, and the rule, flag, help,
 * prefill, maxLength and size it had.
 */
const FORM_1_3_FIELDS = [
  [
    "user",
    "userId",
    "User ID",
    "text",
    true,
    {
      rule: "irs-id",
      help: "Your IRS user ID (SEID), not your Databricks account ID.",
      maxLength: 12,
      size: "short",
    },
  ],
  ["user", "firstName", "First name", "text", true, { prefill: "first-name" }],
  ["user", "lastName", "Last name", "text", true, { prefill: "last-name" }],
  ["user", "workEmail", "Work email", "email", true, { prefill: "email" }],
  ["user", "team", "Team or project", "text", true, {}],
  ["user", "subTeam", "Sub-team or sub-project", "text", false, {}],
  [
    "user",
    "contractingCompany",
    "Contracting company",
    "text",
    false,
    { help: "Leave blank if you aren't a contractor." },
  ],
  ["manager", "managerFirstName", "Manager's first name", "text", true, {}],
  ["manager", "managerLastName", "Manager's last name", "text", true, {}],
  [
    "manager",
    "managerId",
    "Manager's user ID",
    "text",
    true,
    { rule: "irs-id", maxLength: 12, size: "short" },
  ],
  ["manager", "managerEmail", "Manager's work email", "email", true, {}],
  [
    "compliance",
    "unauthorizedAccessTrainingDate",
    "Unauthorized Access training date",
    "date",
    true,
    { rule: "within-timeline:form-started:years:0:1", size: "short" },
  ],
  [
    "compliance",
    "privacyTrainingDate",
    "Privacy training date",
    "date",
    true,
    { rule: "within-timeline:form-started:years:0:1", size: "short" },
  ],
  [
    "compliance",
    "cyberAwarenessTrainingDate",
    "Cyber Awareness training date",
    "date",
    true,
    { rule: "within-timeline:form-started:years:0:1", size: "short" },
  ],
  [
    "compliance",
    "irmAcknowledged",
    "Have you read, acknowledged and signed the IRM 10.5.8 manual transmittal?",
    "yes-no",
    true,
    { flagWhen: "no", flagText: "IRM 10.5.8 not acknowledged" },
  ],
  [
    "compliance",
    "ndaSigned",
    "Have you agreed to and signed the IRS non-disclosure agreement (NDA)?",
    "yes-no",
    true,
    { flagWhen: "no", flagText: "IRS NDA not signed" },
  ],
  [
    "compliance",
    "mbiInitialDate",
    "MBI or staff-like access start date",
    "date",
    true,
    { rule: "not-future", size: "short" },
  ],
  [
    "compliance",
    "mbiExpirationDate",
    "MBI or staff-like access expiration date",
    "date",
    true,
    { rule: "on-or-after:mbiInitialDate", size: "short" },
  ],
  [
    "compliance",
    "mbiPreliminary",
    "Does your MBI or staff-like access show a preliminary or incomplete background investigation?",
    "yes-no",
    true,
    { flagWhen: "yes", flagText: "Preliminary or incomplete background investigation" },
  ],
] as const;

/** Form 1.3's section help and layout, and the values around it, as `config.ts` had them. */
const TRAINING_HINT =
  "Training is yearly: each date should be within the year before you started this form, and not in the future.";
const FORM_1_3_SECTIONS = [
  {
    id: "user",
    title: "User details",
    help: "Your identity at the IRS. We filled in what we could from your sign-in.",
    layout: [
      {
        rows: [
          ["userId"],
          ["firstName", "lastName"],
          ["workEmail"],
          ["team", "subTeam"],
          ["contractingCompany"],
        ],
      },
    ],
  },
  {
    id: "manager",
    title: "Your manager",
    help: "Your current manager: an IRS full-time employee who can confirm your identity.",
    layout: [
      {
        rows: [
          ["managerFirstName", "managerLastName"],
          ["managerId", "managerEmail"],
        ],
      },
    ],
  },
  {
    id: "compliance",
    title: "Compliance",
    help: "Checked before you can enter a sensitive environment such as preprod or prod. A No doesn't stop you submitting.",
    layout: [
      {
        legend: "Training certificates",
        hint: TRAINING_HINT,
        rows: [
          ["unauthorizedAccessTrainingDate", "privacyTrainingDate", "cyberAwarenessTrainingDate"],
        ],
      },
      { rows: [["irmAcknowledged"], ["ndaSigned"]] },
      {
        legend: "MBI or staff-like access",
        hint: "From your MBI or staff-like access record.",
        rows: [["mbiInitialDate", "mbiExpirationDate"], ["mbiPreliminary"]],
      },
    ],
  },
];

describe("bootstrap definition reproduces form 1.3", () => {
  it("bootstrap definition lists exactly the current fields in order with their required flags", () => {
    const { form } = loaded();
    const fields = form.sections.flatMap((section) =>
      section.fields.map((field) => [
        section.id,
        field.id,
        field.label,
        field.kind,
        field.required,
      ]),
    );
    expect(fields).toEqual(FORM_1_3_FIELDS.map((row) => row.slice(0, 5)));
    for (const [, id, , , , extra] of FORM_1_3_FIELDS) {
      const field = form.sections.flatMap((s) => s.fields).find((f) => f.id === id)!;
      const { ruleId: _r, disposition: _d, reasonCode: _c, ...shown } = field;
      expect(shown, id).toEqual({
        id,
        label: field.label,
        kind: field.kind,
        required: field.required,
        ...extra,
      });
    }
  });

  it("carries form 1.3's sections, layout, declaration, validity and review SLA", () => {
    const definition = loaded();
    expect(
      definition.form.sections.map(({ id, title, help, layout }) => ({ id, title, help, layout })),
    ).toEqual(FORM_1_3_SECTIONS);
    expect(definition.form.intro).toBe(
      "EDP will use this document and the answers you provide to establish your identity, and to align you and any access requests you submit.",
    );
    expect(definition.form.trainingRule).toBe(TRAINING_HINT);
    expect(definition.form.declaration).toEqual({
      text: "I hereby declare that the information submitted is accurate and complete to the best of my knowledge. I understand that any false statement, omission, or misrepresentation may result in disciplinary action and could lead to the suspension or revocation of any access, entitlements, or permissions granted based on this submission.",
      attestation: { id: "declarationAgreed", label: "I agree" },
    });
    expect(definition.validityDays).toBe(365);
    expect(definition.reviewSlaBusinessDays).toBe(3);
    expect(definition.timelines).toEqual([
      { id: "training-certificate", anchor: "form-started", unit: "years", min: 0, max: 1 },
    ]);
  });

  it("gives every rule the bootstrap disposition: ID checks block, compliance answers never do", () => {
    const dispositions = Object.fromEntries(
      loaded().rules.map((rule) => [rule.field, [rule.operator, rule.disposition]]),
    );
    expect(dispositions).toEqual({
      userId: ["irs-id", "blocking"],
      managerId: ["irs-id", "blocking"],
      unauthorizedAccessTrainingDate: ["within-timeline", "manual-review"],
      privacyTrainingDate: ["within-timeline", "manual-review"],
      cyberAwarenessTrainingDate: ["within-timeline", "manual-review"],
      irmAcknowledged: ["equals", "manual-review"],
      ndaSigned: ["equals", "manual-review"],
      mbiInitialDate: ["not-future", "warning"],
      mbiExpirationDate: ["on-or-after", "warning"],
      mbiPreliminary: ["equals", "manual-review"],
    });
  });
});

/** The bootstrap YAML with one exact piece of text replaced (which must be there). */
function edited(from: string, to: string): string {
  expect(BOOTSTRAP).toContain(from);
  return BOOTSTRAP.replace(from, to);
}

function refused(text: string) {
  const result = loadDefinition(text);
  if (result.ok) throw new Error("expected the definition to be refused");
  return result.diagnostics;
}

describe("EIR definition schema allowlist", () => {
  it("unknown top-level key is refused with a diagnostic naming the key", () => {
    const diagnostics = refused(`${BOOTSTRAP}\nscript: run-me\n`);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unknown-key",
        path: ["script"],
        message: 'Unknown key "script".',
      }),
    ]);
  });

  it.each([
    ["definitionVersion", "definitionVersion: safeguards-2\n", ["definitionVersion"]],
    ["form.version", 'form:\n  version: "2.0"\n', ["form", "version"]],
  ] as const)(
    "refuses an authored %s: the server numbers each publish (#224)",
    (_key, add, path) => {
      const text = add.startsWith("form:") ? BOOTSTRAP.replace("form:\n", add) : add + BOOTSTRAP;
      expect(refused(text)).toEqual([
        expect.objectContaining({
          code: "server-assigned-version",
          path,
          line: expect.any(Number),
          message: `Remove "${path.join(".")}": the server numbers each published version, so a definition doesn't name its own.`,
        }),
      ]);
    },
  );

  it("unknown key inside a field is refused with its location", () => {
    const diagnostics = refused(
      edited("        - id: team\n", "        - id: team\n          onChange: alert(1)\n"),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unknown-key",
        path: ["form", "sections", 0, "fields", 4, "onChange"],
        line: expect.any(Number),
      }),
    ]);
  });

  it("unknown field type is refused", () => {
    const diagnostics = refused(
      edited(
        "          label: Team or project\n          type: text\n",
        "          label: Team or project\n          type: html\n",
      ),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-value",
        path: ["form", "sections", 0, "fields", 4, "type"],
        message:
          "form.sections.0.fields.4.type: Invalid enum value. Expected 'text' | 'email' | 'date' | 'yes-no', received 'html'",
      }),
    ]);
  });

  it("keeps Zod 3's exact missing-value diagnostic", () => {
    const diagnostics = refused(BOOTSTRAP.replace(/^validityDays:.*\n/m, ""));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid-value",
        path: ["validityDays"],
        message: "validityDays: Required",
      }),
    );
  });

  it("keeps Zod 3's exact numeric bound diagnostics", () => {
    expect(refused(BOOTSTRAP.replace("validityDays: 365", "validityDays: 99999"))).toContainEqual(
      expect.objectContaining({
        path: ["validityDays"],
        message: "validityDays: Number must be less than or equal to 3650",
      }),
    );
    expect(refused(BOOTSTRAP.replace("maxLength: 12", "maxLength: 0"))).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Number must be greater than 0"),
      }),
    );
  });

  it("keeps Zod 3's record wording for scenario answers", () => {
    const diagnostics = refused(
      BOOTSTRAP.replace(/    answers:\n(?:      .*\n)+/, "    answers: 5\n"),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        path: ["scenarios", 0, "answers"],
        message: "scenarios.0.answers: Expected object, received number",
      }),
    );
  });

  it("unknown rule operator is refused", () => {
    const diagnostics = refused(
      edited(
        "    field: mbiInitialDate\n    operator: not-future\n",
        "    field: mbiInitialDate\n    operator: javascript\n",
      ),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-value", path: ["rules", 7, "operator"] }),
    ]);
  });

  it("unknown disposition is refused", () => {
    const diagnostics = refused(
      edited(
        "    operator: not-future\n    disposition: warning\n",
        "    operator: not-future\n    disposition: auto-approve\n",
      ),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-value", path: ["rules", 7, "disposition"] }),
    ]);
  });
});

describe("EIR definition is parsed as data only", () => {
  it.each([
    [
      "an anchor and alias",
      edited("  title: Enterprise Data Platform", "  title: &title Enterprise Data Platform") +
        "\nextraTitle: *title\n",
      /Aliases aren't allowed|Anchors aren't allowed/,
    ],
    [
      "a merge key",
      edited(
        "        - id: team\n",
        "        - <<: {required: false}\n          id: team2\n        - id: team\n",
      ),
      /Merge keys/,
    ],
    [
      "a custom tag",
      edited("validityDays: 365", "validityDays: !!js/function 'return 365'"),
      /Tags aren't allowed/,
    ],
    ["a core tag", edited("validityDays: 365", "validityDays: !!int 365"), /Tags aren't allowed/],
    [
      "an environment-style value",
      edited("validityDays: 365", "validityDays: ${EIR_VALIDITY_DAYS}"),
      /Environment-style values/,
    ],
    ["a second document", `${BOOTSTRAP}\n---\nvalidityDays: 1\n`, /exactly one YAML document/],
    ["YAML that doesn't parse", edited("form:\n", "form: [\n"), /./],
  ])(
    "YAML anchors, merge keys, custom tags, and env-style interpolation are refused: %s",
    (_name, text, message) => {
      const diagnostics = refused(text);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every((d) => d.code === "unsafe-yaml" || d.code === "parse-error")).toBe(
        true,
      );
      expect(diagnostics.map((d) => d.message).join(" ")).toMatch(message);
    },
  );

  it("YAML 1.1 forms stay plain strings: yes is not true, a date is not a Date", () => {
    const { scenarios } = loaded();
    expect(scenarios[0]!.answers["irmAcknowledged"]).toBe("yes");
    expect(scenarios[0]!.formStartedAt).toBe("2026-09-01");
  });
});

describe("EIR definition semantic validation", () => {
  it("duplicate field id is refused", () => {
    const diagnostics = refused(edited("        - id: subTeam\n", "        - id: team\n"));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate-id",
        message: 'Duplicate field ID "team".',
        path: ["form", "sections", 0, "fields", 5, "id"],
      }),
    );
  });

  it("rule referencing a missing field is refused", () => {
    const diagnostics = refused(edited("    field: ndaSigned\n", "    field: ndaSignedd\n"));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "missing-reference",
        message: 'Rule "nda-signed" checks "ndaSignedd", which isn\'t a field.',
        path: ["rules", 6, "field"],
      }),
    ]);
  });

  it("rule referencing a missing timeline or comparison field is refused", () => {
    expect(
      refused(
        edited(
          "    timeline: training-certificate\n    disposition: manual-review\n    reasonCode: EIR-PRIVACY",
          "    timeline: training-cert\n    disposition: manual-review\n    reasonCode: EIR-PRIVACY",
        ),
      ),
    ).toEqual([
      expect.objectContaining({ code: "missing-reference", path: ["rules", 3, "timeline"] }),
    ]);
    expect(refused(edited("    otherField: mbiInitialDate\n", "    otherField: team\n"))).toEqual([
      expect.objectContaining({ code: "missing-reference", path: ["rules", 8, "otherField"] }),
    ]);
  });

  it("timeline with min > max is refused", () => {
    const diagnostics = refused(edited("    min: 0\n    max: 1\n", "    min: 2\n    max: 1\n"));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "timeline-bounds",
        message: 'Timeline "training-certificate" has min 2 after max 1.',
        path: ["timelines", 0],
      }),
    ]);
  });

  it("a rule whose disposition contradicts what it checks is refused", () => {
    // #217: any operator but irs-id can be any disposition (eir-blocking-rules.test.ts);
    // an ID that isn't one is a form error, so irs-id can only block.
    expect(
      refused(
        edited(
          "    operator: irs-id\n    disposition: blocking\n    reasonCode: EIR-USER",
          "    operator: irs-id\n    disposition: warning\n    reasonCode: EIR-USER",
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        code: "inconsistent-disposition",
        path: ["rules", 0, "disposition"],
      }),
    ]);
  });

  it("a duplicate rule ID or reason code is refused", () => {
    expect(
      refused(
        edited(
          "  - id: privacy-training-current\n",
          "  - id: unauthorized-access-training-current\n",
        ),
      ),
    ).toEqual([expect.objectContaining({ code: "duplicate-id", path: ["rules", 3, "id"] })]);
    expect(
      refused(
        edited("    reasonCode: EIR-MANAGER-ID-FORMAT\n", "    reasonCode: EIR-USER-ID-FORMAT\n"),
      ),
    ).toEqual([
      expect.objectContaining({ code: "duplicate-id", path: ["rules", 1, "reasonCode"] }),
    ]);
  });

  it.each(["pass", "blocking", "warning", "manual-review"])(
    "definition missing a scenario for any of pass/blocking/warning/manual-review is refused: %s",
    (outcome) => {
      // Relabel the one scenario that expects it, so none does.
      const text = edited(
        `    expect: ${outcome}\n`,
        `    expect: ${outcome === "pass" ? "blocking" : "pass"}\n`,
      );
      const diagnostics = refused(text);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "missing-scenario",
          message: `No scenario expects ${outcome}: add one.`,
        }),
      );
    },
  );

  it("a scenario answering a field the form doesn't have is refused", () => {
    expect(refused(edited("      userId: not an id!\n", "      userID: not an id!\n"))).toEqual([
      expect.objectContaining({
        code: "missing-reference",
        path: ["scenarios", 1, "answers", "userID"],
      }),
    ]);
  });
});

describe("EIR definition scenarios", () => {
  it("every scenario in the bootstrap definition produces its declared outcome", () => {
    const results = runScenarios(loaded());
    expect(results.map(({ id, expected, actual, ok }) => ({ id, expected, actual, ok }))).toEqual([
      { id: "pass", expected: "pass", actual: "pass", ok: true },
      { id: "blocking-user-id", expected: "blocking", actual: "blocking", ok: true },
      { id: "warning-mbi-dates", expected: "warning", actual: "warning", ok: true },
      { id: "manual-review-nda", expected: "manual-review", actual: "manual-review", ok: true },
    ]);
    expect(results.find((r) => r.id === "blocking-user-id")?.reasons).toEqual([
      expect.objectContaining({
        field: "userId",
        disposition: "blocking",
        reasonCode: "EIR-USER-ID-FORMAT",
      }),
    ]);
    expect(results.find((r) => r.id === "manual-review-nda")?.reasons).toEqual([
      {
        field: "ndaSigned",
        disposition: "manual-review",
        reasonCode: "EIR-NDA-NOT-SIGNED",
        message: "IRS NDA not signed",
      },
    ]);
  });

  it("runs the same way every time: each run gives the outcomes bootstrap-1.eir.yaml declares", () => {
    // Written out by hand from bootstrap-1.eir.yaml's scenarios, not from the runner.
    const declared = [
      { id: "pass", actual: "pass", reasons: [] },
      { id: "blocking-user-id", actual: "blocking", reasons: ["userId"] },
      { id: "warning-mbi-dates", actual: "warning", reasons: ["mbiExpirationDate"] },
      { id: "manual-review-nda", actual: "manual-review", reasons: ["ndaSigned"] },
    ];
    // Freshly loaded each time, so nothing carries over between runs.
    for (let run = 0; run < 3; run++) {
      expect(
        runScenarios(loaded()).map(({ id, actual, reasons }) => ({
          id,
          actual,
          reasons: reasons.map((reason) => reason.field),
        })),
        `run ${run + 1}`,
      ).toEqual(declared);
    }
  });

  it("reports a scenario whose declared outcome isn't what the rules produce", () => {
    const definition = loaded(edited('      ndaSigned: "no"\n', '      ndaSigned: "yes"\n'));
    expect(runScenarios(definition).filter((r) => !r.ok)).toEqual([
      expect.objectContaining({
        id: "manual-review-nda",
        expected: "manual-review",
        actual: "pass",
      }),
    ]);
  });
});
