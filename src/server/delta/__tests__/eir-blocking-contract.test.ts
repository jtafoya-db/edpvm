// @vitest-environment node
/**
 * #217 at the EIR repository seam, on both adapters (memory, and browser
 * client → Delta API → `eir` area → SQLite fake warehouse) with their real
 * default definitions: the current bootstrap, bootstrap-2, blocks on every
 * rule with guidance that says what to go do, and a draft started under
 * bootstrap-1's form 1.3 keeps bootstrap-1. Expected values are written by
 * hand from the ticket.
 */
import { describe, expect, it } from "vitest";

import { BOOTSTRAP_EIR_DEFINITIONS, type EirDefinitionLookup } from "../../../data/eir/repository";
import type { EirDefinition } from "../../../data/eir/definition/types.ts";
import { loadDefinition } from "../../../data/eir/definition/load.ts";
import { withId } from "../../../data/eir/definition/built-in.ts";
import { readBootstrapEirSource } from "../../../data/eir/definition/bootstrap-source.ts";

const BOOTSTRAP_2_YAML = readBootstrapEirSource("bootstrap-2")!;
import type { EirFormValues } from "../../../data/eir/types";
import {
  APPLICANT,
  bootstrap1,
  createClock,
  deltaImplementation,
  memoryImplementation,
  pdf,
  type EirImplementation,
} from "./eir-harness.ts";
import {
  definitionImplementation,
  memoryDefinitions,
  nextDefinitionYaml,
  SAFEGUARDS,
} from "./eir-definition-harness.ts";

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

const G = "[Placeholder wording] ";

/** One failing answer per bootstrap-2 rule: its field, reason code and guidance. */
const EACH_RULE: [string, Record<string, string>, string, string][] = [
  [
    "user ID format",
    { userId: "not an id!" },
    "EIR-USER-ID-FORMAT",
    `${G}Enter your IRS user ID (SEID): 3 to 12 letters and numbers, like A1B2C.`,
  ],
  [
    "manager ID format",
    { managerId: "bad id!" },
    "EIR-MANAGER-ID-FORMAT",
    `${G}Enter your manager's IRS user ID (SEID): 3 to 12 letters and numbers, like A1B2C.`,
  ],
  [
    "Unauthorized Access training out of date",
    { unauthorizedAccessTrainingDate: "2025-09-01" },
    "EIR-UA-TRAINING-NOT-CURRENT",
    `${G}Complete your Unauthorized Access training, then enter its completion date.`,
  ],
  [
    "Privacy training out of date",
    { privacyTrainingDate: "2025-09-01" },
    "EIR-PRIVACY-TRAINING-NOT-CURRENT",
    `${G}Complete your Privacy training, then enter its completion date.`,
  ],
  [
    "Cyber Awareness training out of date",
    { cyberAwarenessTrainingDate: "2025-09-01" },
    "EIR-CYBER-TRAINING-NOT-CURRENT",
    `${G}Complete your Cyber Awareness training, then enter its completion date.`,
  ],
  [
    "IRM 10.5.8 not acknowledged",
    { irmAcknowledged: "no" },
    "EIR-IRM-NOT-ACKNOWLEDGED",
    `${G}Read, acknowledge and sign the IRM 10.5.8 manual transmittal, then answer Yes.`,
  ],
  [
    "IRS NDA not signed",
    { ndaSigned: "no" },
    "EIR-NDA-NOT-SIGNED",
    `${G}Sign the IRS NDA, then answer Yes.`,
  ],
  [
    "MBI start in the future",
    { mbiInitialDate: "2026-12-01" },
    "EIR-MBI-START-IN-FUTURE",
    `${G}Enter the start date shown on your MBI or staff-like access record. It can't be in the future.`,
  ],
  [
    "MBI expiration before its start",
    { mbiInitialDate: "2026-01-15", mbiExpirationDate: "2025-12-31" },
    "EIR-MBI-EXPIRES-BEFORE-START",
    `${G}Check your MBI or staff-like access record: enter its expiration date, which is after the start date.`,
  ],
  [
    "MBI already expired",
    { mbiExpirationDate: "2026-09-30" },
    "EIR-MBI-EXPIRED",
    `${G}Your MBI or staff-like access has expired. Renew it, then enter the new expiration date.`,
  ],
  [
    "MBI investigation preliminary",
    { mbiPreliminary: "yes" },
    "EIR-MBI-PRELIMINARY",
    `${G}Wait until your background investigation is complete, then answer No.`,
  ],
];

const DAY = 86_400_000;

function upload(impl: EirImplementation, values: EirFormValues) {
  return impl.as(APPLICANT).submitWithFile({
    principalId: APPLICANT.principalId,
    personName: APPLICANT.displayName,
    file: pdf(),
    values,
  });
}

describe.each([
  ["memory", () => memoryImplementation(createClock())],
  ["delta", () => deltaImplementation(createClock())],
] as const)("every bootstrap-2 rule is a hard fail (#217): %s", (_name, make) => {
  it.each(EACH_RULE)(
    "%s blocks PDF generation and upload on the server, with its reason code and guidance",
    async (_label, changed, reasonCode, guidance) => {
      const impl = make();
      const repository = impl.as(APPLICANT);
      const values = { ...PASSING, ...changed };
      await repository.saveDraft(APPLICANT.principalId, values);

      const evaluation = await repository.evaluateDraft(APPLICANT.principalId);
      expect(evaluation).toMatchObject({
        // The fallback built-in's reserved identity (#224), not form 2.0.
        definitionVersion: "bootstrap-2",
        formVersion: "bootstrap-2",
        outcome: "blocking",
        automaticValidityEligible: false,
      });
      expect(evaluation.outcomes).toContainEqual(
        expect.objectContaining({ reasonCode, disposition: "blocking", guidance }),
      );
      await expect(repository.generatePdf(APPLICANT.principalId)).rejects.toThrow(guidance);
      await expect(upload(impl, values)).rejects.toThrow(guidance);
      expect(await repository.get(APPLICANT.principalId)).toMatchObject({
        stage: "not-started",
        submissions: [],
      });
    },
  );

  it("an expired MBI blocks with guidance to renew it, on the evaluation date", async () => {
    const impl = make();
    const repository = impl.as(APPLICANT);
    // Expires 2026-10-05: in date on 2026-10-01, expired once the clock passes it.
    const values = { ...PASSING, mbiExpirationDate: "2026-10-05" };
    await repository.saveDraft(APPLICANT.principalId, values);
    expect((await repository.evaluateDraft(APPLICANT.principalId)).outcome).toBe("pass");

    impl.clock.advance(10 * DAY);
    await repository.saveDraft(APPLICANT.principalId, values);
    expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
      effectiveAt: "2026-10-11T12:00:00.000Z",
      outcome: "blocking",
      outcomes: [
        {
          ruleId: "mbi-not-expired",
          field: "mbiExpirationDate",
          reasonCode: "EIR-MBI-EXPIRED",
          disposition: "blocking",
          guidance: `${G}Your MBI or staff-like access has expired. Renew it, then enter the new expiration date.`,
        },
      ],
    });
    await expect(repository.generatePdf(APPLICANT.principalId)).rejects.toThrow(
      "Renew it, then enter the new expiration date.",
    );
  });

  it("all-passing answers pass, the PDF downloads, and the signed copy uploads", async () => {
    const impl = make();
    const repository = impl.as(APPLICANT);
    await repository.saveDraft(APPLICANT.principalId, PASSING);
    expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
      definitionVersion: "bootstrap-2",
      formVersion: "bootstrap-2",
      outcome: "pass",
      outcomes: [],
      automaticValidityEligible: true,
    });
    const text = new TextDecoder().decode(await repository.generatePdf(APPLICANT.principalId));
    // #224's one version line, naming the reserved built-in.
    expect(text).toContain("(EIR definition: bootstrap-2 \\(version 0\\))");
    expect(text).not.toMatch(/Form version|Definition version/);
    await expect(upload(impl, PASSING)).resolves.toMatchObject({
      stage: "submitted",
      formVersion: "bootstrap-2",
    });
  });
});

/**
 * Memory: the app's own default lookup (the built-in definitions), while the
 * active one is the bootstrap definition, then the fallback bootstrap-2, as a
 * deploy of #217 does.
 */
function bootstrapsSwitchingTo(pinned = "bootstrap"): {
  definitions: EirDefinitionLookup;
  ship(): void;
} {
  // Before #224 the bootstrap's identity was its form version, 1.3.
  let active: EirDefinition | undefined = withId(bootstrap1(), pinned);
  return {
    definitions: {
      active: () => active,
      byId: (id) => BOOTSTRAP_EIR_DEFINITIONS.byId(id),
    },
    ship: () => {
      active = BOOTSTRAP_EIR_DEFINITIONS.active();
    },
  };
}

describe("a draft pinned to the bootstrap definition keeps its rules (#217, #224 pin)", () => {
  const nda = { ...PASSING, ndaSigned: "no" };

  /** `pinned`: the identity the draft was stored under, `bootstrap` or its old label 1.3. */
  async function expectBootstrapRules(impl: EirImplementation, pinned: string, label: string) {
    const repository = impl.as(APPLICANT);
    expect(await repository.get(APPLICANT.principalId)).toMatchObject({ draftFormVersion: pinned });
    // The bootstrap's NDA rule is manual-review, not bootstrap-2's blocking one.
    expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
      definitionVersion: pinned,
      formVersion: pinned,
      outcome: "manual-review",
      outcomes: [{ reasonCode: "EIR-NDA-NOT-SIGNED", disposition: "manual-review" }],
    });
    const text = new TextDecoder().decode(await repository.generatePdf(APPLICANT.principalId));
    // A PDF string escapes its parentheses.
    expect(text).toContain(`(EIR definition: ${label.replace(/[()]/g, "\\$&")})`);
    expect(text).not.toContain("bootstrap-2");
  }

  it.each([
    ["bootstrap", "bootstrap (version 0)"],
    ["1.3", "form 1.3"],
  ])("memory, through the app's default built-in lookup: pinned to %s", async (pinned, label) => {
    const store = bootstrapsSwitchingTo(pinned);
    const impl = memoryImplementation(createClock(), { definitions: store.definitions });
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, nda, undefined, pinned);
    store.ship();
    await expectBootstrapRules(impl, pinned, label);
    // A new draft starts on the fallback built-in, bootstrap-2.
    expect(BOOTSTRAP_EIR_DEFINITIONS.active()?.form.version).toBe("bootstrap-2");
  });

  it.each([
    ["bootstrap", "bootstrap (version 0)"],
    ["1.3", "form 1.3"],
  ])("delta, through the store's real definition resolver: pinned to %s", async (pinned, label) => {
    const impl = deltaImplementation(createClock());
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, nda);
    // As saved before bootstrap-2 shipped: the same answers, under the older identity.
    impl.warehouse.query(`UPDATE "eir__eir_drafts" SET form_version = '${pinned}'`);
    await expectBootstrapRules(impl, pinned, label);
  });
});

describe.each([
  ["memory", () => memoryImplementation(createClock())],
  ["delta", () => deltaImplementation(createClock())],
] as const)(
  "a field with several rules saves only its current reasons (#217 review): %s",
  (name, make) => {
    /** The persisted evaluation's reason codes, read back as a reload would. */
    async function savedReasons(impl: EirImplementation) {
      const reader =
        name === "delta"
          ? (impl as ReturnType<typeof deltaImplementation>).fresh(APPLICANT)
          : impl.as(APPLICANT);
      const record = await reader.get(APPLICANT.principalId);
      return (record.evaluation?.outcomes ?? []).map((o) => o.reasonCode).sort();
    }

    it.each([
      ["blank", "", "Enter MBI or staff-like access expiration date."],
      ["malformed", "2026-02-30", "MBI or staff-like access expiration date: enter a real date."],
    ])(
      "a %s MBI expiration blocks with the form's code, not a rule's",
      async (_l, value, guidance) => {
        const impl = make();
        const repository = impl.as(APPLICANT);
        await repository.saveDraft(APPLICANT.principalId, { ...PASSING, mbiExpirationDate: value });
        expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
          outcome: "blocking",
          outcomes: [
            {
              ruleId: "form-mbiExpirationDate",
              field: "mbiExpirationDate",
              reasonCode: "EIR-FORM-MBIEXPIRATIONDATE-INVALID",
              disposition: "blocking",
              guidance,
            },
          ],
        });
        expect(await savedReasons(impl)).toEqual(["EIR-FORM-MBIEXPIRATIONDATE-INVALID"]);
        await expect(repository.generatePdf(APPLICANT.principalId)).rejects.toThrow(guidance);
      },
    );

    it("an MBI expiring exactly on the evaluation date passes", async () => {
      const impl = make();
      const repository = impl.as(APPLICANT);
      await repository.saveDraft(APPLICANT.principalId, {
        ...PASSING,
        mbiExpirationDate: "2026-10-01",
      });
      expect((await repository.evaluateDraft(APPLICANT.principalId)).outcome).toBe("pass");
      await expect(repository.generatePdf(APPLICANT.principalId)).resolves.toBeInstanceOf(
        Uint8Array,
      );
    });

    it("switching between expired and before-start saves only the current reasons, across a reload", async () => {
      const impl = make();
      const repository = impl.as(APPLICANT);
      const expiredOnly = { ...PASSING, mbiExpirationDate: "2026-09-30" };
      const beforeStart = {
        ...PASSING,
        mbiInitialDate: "2026-01-15",
        mbiExpirationDate: "2025-12-31",
      };
      const evaluate = async (values: EirFormValues) => {
        await repository.saveDraft(APPLICANT.principalId, values);
        await repository.evaluateDraft(APPLICANT.principalId);
        return savedReasons(impl);
      };
      expect(await evaluate(expiredOnly)).toEqual(["EIR-MBI-EXPIRED"]);
      expect(await evaluate(beforeStart)).toEqual([
        "EIR-MBI-EXPIRED",
        "EIR-MBI-EXPIRES-BEFORE-START",
      ]);
      expect(await evaluate(expiredOnly)).toEqual(["EIR-MBI-EXPIRED"]);
      expect(await evaluate(PASSING)).toEqual([]);
    });
  },
);

describe.each([
  ["memory", memoryDefinitions],
  ["delta", definitionImplementation],
] as const)(
  "publishing refuses a blocking rule without guidance (#217 review, #201): %s",
  (_n, make) => {
    it("refuses it as an invalid definition and stores nothing; with guidance it publishes", async () => {
      const repo = make().as(SAFEGUARDS);
      // A synthetic next definition from bootstrap-1 whose NDA rule blocks.
      const ndaBlocking = (guidance: string) =>
        nextDefinitionYaml(2)
          .replace(
            "    message: IRS NDA not signed\n    disposition: manual-review\n",
            `    message: IRS NDA not signed\n    disposition: blocking\n${guidance}`,
          )
          .replace(
            '  - id: manual-review-nda\n    expect: manual-review\n    extends: pass\n    answers:\n      ndaSigned: "no"\n',
            '  - id: manual-review-nda\n    expect: manual-review\n    extends: pass\n    answers:\n      mbiPreliminary: "yes"\n',
          );
      await expect(
        repo.publish({ sourceYaml: ndaBlocking(""), expectedVersion: 0 }),
      ).rejects.toMatchObject({ code: "definition-invalid", status: 400 });
      expect((await repo.history()).versions).toEqual([]);
      // Whitespace isn't guidance either (review 2).
      for (const blank of ['    guidance: "   "\n', '    guidance: "\t "\n']) {
        await expect(
          repo.publish({ sourceYaml: ndaBlocking(blank), expectedVersion: 0 }),
        ).rejects.toMatchObject({ code: "definition-invalid", status: 400 });
      }
      expect((await repo.history()).versions).toEqual([]);
      await expect(
        repo.publish({
          sourceYaml: ndaBlocking("    guidance: Sign the IRS NDA, then answer Yes.\n"),
          expectedVersion: 0,
        }),
      ).resolves.toMatchObject({ versionNumber: 1 });
    });
  },
);

/** bootstrap-2 published as version `10 + max` (#224), with its training timeline at `max` years. */
function timelineDefinition(max: number): EirDefinition {
  const text = BOOTSTRAP_2_YAML.replace(
    "    unit: years\n    min: 0\n    max: 1\n",
    `    unit: years\n    min: 0\n    max: ${max}\n`,
  );
  expect(BOOTSTRAP_2_YAML).toContain("    unit: years\n    min: 0\n    max: 1\n");
  const loaded = loadDefinition(text, String(10 + max));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.definition;
}
const storeOn = (definition: EirDefinition) => ({
  definitions: {
    active: () => definition,
    byId: (id: string) => (id === definition.form.version ? definition : undefined),
  },
  shownFormVersion: definition.form.version,
});

describe.each([
  ["memory", memoryImplementation],
  ["delta", deltaImplementation],
] as const)(
  "a definition's training timeline decides the outcome (#217 schema review): %s",
  (_n, make) => {
    // The harness clock: evaluated on 2026-10-01 (UTC).
    const outcome = async (max: number, privacyTrainingDate: string) => {
      const impl = make(createClock(), storeOn(timelineDefinition(max)));
      const repository = impl.as(APPLICANT);
      await repository.saveDraft(APPLICANT.principalId, { ...PASSING, privacyTrainingDate });
      return (await repository.evaluateDraft(APPLICANT.principalId)).outcome;
    };

    it("max 1 year: 2025-10-01 (exactly a year back) passes, 2025-09-30 blocks", async () => {
      expect(await outcome(1, "2025-10-01")).toBe("pass");
      expect(await outcome(1, "2025-09-30")).toBe("blocking");
    });

    it("max 2 years: 2025-06-01 passes, and 2024-09-30 blocks", async () => {
      expect(await outcome(1, "2025-06-01")).toBe("blocking");
      expect(await outcome(2, "2025-06-01")).toBe("pass");
      expect(await outcome(2, "2024-10-01")).toBe("pass");
      expect(await outcome(2, "2024-09-30")).toBe("blocking");
    });
  },
);

describe.each([
  ["memory", memoryDefinitions],
  ["delta", definitionImplementation],
] as const)(
  "a definition whose scenarios have no clocks (#217 schema review, #201): %s",
  (_n, make) => {
    const noClocks = () =>
      nextDefinitionYaml(2).replace(
        '    formStartedAt: "2026-09-01"\n    submittedAt: "2026-09-02"\n',
        "",
      );

    it("check returns a diagnostic and publish a 400, never a throw; nothing is stored", async () => {
      expect(noClocks()).not.toContain("formStartedAt");
      const repo = make().as(SAFEGUARDS);
      await expect(repo.check(noClocks())).resolves.toMatchObject({
        ok: false,
        publishable: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-value",
            path: ["scenarios", 0, "formStartedAt"],
          }),
        ]),
      });
      await expect(
        repo.publish({ sourceYaml: noClocks(), expectedVersion: 0 }),
      ).rejects.toMatchObject({ code: "definition-invalid", status: 400 });
      expect((await repo.history()).versions).toEqual([]);
    });
  },
);

/** bootstrap-2 published as version 8 or 9 (#224), with its training timeline anchored at `anchor`. */
function anchoredDefinition(anchor: "form-started" | "evaluated"): EirDefinition {
  expect(BOOTSTRAP_2_YAML).toContain("    anchor: evaluated\n");
  const text = BOOTSTRAP_2_YAML.replace("    anchor: evaluated\n", `    anchor: ${anchor}\n`);
  const loaded = loadDefinition(text, anchor === "evaluated" ? "8" : "9");
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.definition;
}

describe.each([
  ["memory", memoryImplementation],
  ["delta", deltaImplementation],
] as const)(
  "a timeline's anchor decides what the same date means (#217 review 4): %s",
  (_n, make) => {
    /**
     * Started 2026-10-01 (the first save), checked 100 days later on 2027-01-09.
     * form-started allows back to 2025-10-01; evaluated back to 2026-01-09.
     */
    const outcome = async (anchor: "form-started" | "evaluated", date: string) => {
      const impl = make(createClock(), storeOn(anchoredDefinition(anchor)));
      const repository = impl.as(APPLICANT);
      const values = {
        ...PASSING,
        unauthorizedAccessTrainingDate: date,
        privacyTrainingDate: date,
        cyberAwarenessTrainingDate: date,
      };
      await repository.saveDraft(APPLICANT.principalId, values);
      impl.clock.advance(100 * DAY);
      await repository.saveDraft(APPLICANT.principalId, { ...values, team: "Later edit" });
      const evaluation = await repository.evaluateDraft(APPLICANT.principalId);
      expect(evaluation.effectiveAt).toBe("2027-01-09T12:00:00.000Z");
      return evaluation.outcome;
    };

    it("form-started: 2025-12-01 passes; 2025-10-01 is the last day that does", async () => {
      expect(await outcome("form-started", "2025-12-01")).toBe("pass");
      expect(await outcome("form-started", "2025-10-01")).toBe("pass");
      expect(await outcome("form-started", "2025-09-30")).toBe("blocking");
    });

    it("evaluated: the same 2025-12-01 blocks; 2026-01-09 is the last day that passes", async () => {
      expect(await outcome("evaluated", "2025-12-01")).toBe("blocking");
      expect(await outcome("evaluated", "2026-01-09")).toBe("pass");
      expect(await outcome("evaluated", "2026-01-08")).toBe("blocking");
    });
  },
);
