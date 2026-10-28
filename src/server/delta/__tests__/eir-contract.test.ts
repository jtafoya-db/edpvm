// @vitest-environment node
/**
 * The EIR repository contract (#98's rules), on bootstrap-1's form 1.3 rules
 * injected as the store's definition (#217: the current bootstrap blocks on
 * every rule; `eir-blocking-contract.test.ts` covers it), run against both repositories
 * the app has: the in-memory one and the Delta one (browser client → Delta
 * API → runner → `eir` area → SQLite fake warehouse). Each rule is one test,
 * run twice; the last test replays one long sequence of steps on both and
 * compares every answer.
 */
import { describe, expect, it, vi } from "vitest";

import type { EirDecision, EirFormValues } from "../../../data/eir/types";
import {
  APPLICANT,
  comparable,
  createClock,
  deltaImplementation,
  OTHER_PERSON,
  memoryImplementation,
  pdf,
  VAL,
  VALUES,
  VIC,
  bootstrap1,
  ON_BOOTSTRAP_1,
  type EirImplementation,
} from "./eir-harness.ts";
import type { SessionUser } from "../registry.ts";
import type { EirDefinition, EirRuleOperator } from "../../../data/eir/definition/types.ts";
import type { EirDefinitionLookup } from "../../../data/eir/repository.ts";
import { createDeltaSnapshotCache, SNAPSHOT_TABLES } from "../snapshot-cache.ts";
/** The bootstrap definition's `pass` scenario answers: synthetic, and every field it has. */
const BOOTSTRAP_PASS_ANSWERS: EirFormValues = {
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

/** bootstrap-1: this contract's rules are its form 1.3 ones (#217 moved the active bootstrap on). */
const bootstrap = (): EirDefinition => bootstrap1();

/**
 * The store's definitions (#201) with `active` active. A draft's form version
 * finds `byForm` (default: `active`, on its own form version): `undefined` when
 * no definition has it, `null` when it can't be loaded right now.
 */
const storeDefinitions = (
  active: EirDefinition,
  byForm?: EirDefinition | null,
): EirDefinitionLookup => ({
  active: () => active,
  byId: (version) =>
    byForm === undefined ? (version === active.form.version ? active : undefined) : byForm,
});

const definitionsWithUnhandledOperator = () =>
  storeDefinitions({
    ...bootstrap(),
    rules: bootstrap().rules.map((rule, index) =>
      index === 0 ? { ...rule, operator: "unhandled-test" as EirRuleOperator } : rule,
    ),
  });

/** A draft on the bootstrap that no definition in the store has any more. */
const definitionsWithoutTheDraftsForm = (): EirDefinitionLookup => ({
  active: bootstrap,
  byId: () => undefined,
});

/** The draft's definition is published but can't be loaded right now. */
const definitionsThatFailToLoad = () => storeDefinitions(bootstrap(), null);

const DAY = 86_400_000;

function steps(impl: EirImplementation) {
  return {
    submit: async (
      user: SessionUser,
      options: { values?: EirFormValues; response?: string } = {},
    ) => {
      const repository = impl.as(user);
      const values = options.values ?? VALUES;
      await repository.saveDraft(user.principalId, values);
      await repository.evaluateDraft(user.principalId);
      return repository.submitWithFile({
        principalId: user.principalId,
        personName: user.displayName,
        file: pdf(),
        values,
        ...(options.response ? { response: options.response } : {}),
      });
    },
    decide: (validator: SessionUser, of: SessionUser, decision: EirDecision, note?: string) =>
      impl
        .as(validator)
        .decide(of.principalId, decision, validator.principalId, note, validator.displayName),
    draft: (user: SessionUser, values: EirFormValues) =>
      impl.as(user).saveDraft(user.principalId, values),
    get: (user: SessionUser) => impl.as(user).get(user.principalId),
    evaluate: (user: SessionUser) => impl.as(user).evaluateDraft(user.principalId),
    generate: (user: SessionUser) => impl.as(user).generatePdf(user.principalId),
    inbox: (validator: SessionUser = VAL) => impl.as(validator).listValidatorInbox(),
  };
}

describe.each([
  ["memory", () => memoryImplementation(createClock(), ON_BOOTSTRAP_1)],
  ["delta", () => deltaImplementation(createClock(), ON_BOOTSTRAP_1)],
] as const)("EIR repository contract: %s", (_name, make) => {
  it.each([
    ["pass", "pass"],
    ["blocking-user-id", "blocking"],
    ["warning-mbi-dates", "warning"],
    ["manual-review-nda", "manual-review"],
  ] as const)(
    "bootstrap scenario %s evaluates to its literal %s outcome through the repository",
    async (scenarioId, expected) => {
      const scenario = bootstrap().scenarios.find((candidate) => candidate.id === scenarioId);
      if (!scenario) throw new Error(`Missing bootstrap scenario ${scenarioId}.`);
      const repository = make().as(APPLICANT);
      await repository.saveDraft(APPLICANT.principalId, scenario.answers);
      await expect(repository.evaluateDraft(APPLICANT.principalId)).resolves.toMatchObject({
        outcome: expected,
      });
    },
  );

  it("blank NDA is a form-blocking error with a form reason code, not the manual-review rule code", async () => {
    const impl = make();
    const { draft, evaluate } = steps(impl);
    await draft(APPLICANT, { ...BOOTSTRAP_PASS_ANSWERS, ndaSigned: "" });

    expect(await evaluate(APPLICANT)).toMatchObject({
      outcome: "blocking",
      outcomes: [
        {
          field: "ndaSigned",
          disposition: "blocking",
          reasonCode: "EIR-FORM-NDASIGNED-INVALID",
          ruleId: "form-ndaSigned",
        },
      ],
    });
  });

  it("answered out-of-window training is manual review with the configured training rule code", async () => {
    const impl = make();
    const { draft, evaluate } = steps(impl);
    await draft(APPLICANT, {
      ...BOOTSTRAP_PASS_ANSWERS,
      unauthorizedAccessTrainingDate: "2025-09-30",
    });

    expect(await evaluate(APPLICANT)).toMatchObject({
      outcome: "manual-review",
      outcomes: [
        {
          field: "unauthorizedAccessTrainingDate",
          disposition: "manual-review",
          reasonCode: "EIR-UA-TRAINING-NOT-CURRENT",
          ruleId: "unauthorized-access-training-current",
        },
      ],
    });
  });

  it("evaluating a passing draft records pass with definition version, effective date, draft version, system actor", async () => {
    const impl = make();
    const { draft, evaluate } = steps(impl);
    await draft(APPLICANT, BOOTSTRAP_PASS_ANSWERS);

    expect(await evaluate(APPLICANT)).toEqual({
      definitionVersion: "bootstrap",
      formVersion: "bootstrap",
      effectiveAt: "2026-10-01T12:00:00.000Z",
      evaluatedDraftVersion: 1,
      outcome: "pass",
      outcomes: [],
      automaticValidityEligible: true,
      // Its place among the draft's recorded pre-checks (#204).
      sequence: 1,
      actorPrincipalId: "system",
      actorDisplay: "EDP Vending Machine",
      actorApp: "system",
    });
  });

  it.each([
    ["blocking", { userId: "not an id!" }, "blocking", "EIR-USER-ID-FORMAT", "userId"],
    [
      "warning",
      { mbiExpirationDate: "2024-01-15" },
      "warning",
      "EIR-MBI-EXPIRES-BEFORE-START",
      "mbiExpirationDate",
    ],
    ["manual-review", { ndaSigned: "no" }, "manual-review", "EIR-NDA-NOT-SIGNED", "ndaSigned"],
  ] as const)(
    "each rule outcome carries a stable reason code and its configured %s disposition",
    async (_name, changed, outcome, reasonCode, field) => {
      const impl = make();
      const { draft, evaluate } = steps(impl);
      await draft(APPLICANT, { ...BOOTSTRAP_PASS_ANSWERS, ...changed });
      expect(await evaluate(APPLICANT)).toMatchObject({
        outcome,
        outcomes: [{ disposition: outcome, reasonCode, field }],
      });
    },
  );

  it.each([
    [
      "blocking over manual-review and warning",
      { userId: "bad!", ndaSigned: "no", mbiExpirationDate: "2024-01-15" },
      "blocking",
    ],
    [
      "manual-review over warning",
      { ndaSigned: "no", mbiExpirationDate: "2024-01-15" },
      "manual-review",
    ],
    ["warning over pass", { mbiExpirationDate: "2024-01-15" }, "warning"],
    ["pass with no outcomes", {}, "pass"],
  ] as const)("overall result gives precedence to %s", async (_name, changed, outcome) => {
    const impl = make();
    const { draft, evaluate } = steps(impl);
    await draft(APPLICANT, { ...BOOTSTRAP_PASS_ANSWERS, ...changed });
    expect((await evaluate(APPLICANT)).outcome).toBe(outcome);
  });

  it("blocking result refuses PDF generation and returns field-specific guidance", async () => {
    const impl = make();
    const { draft, evaluate, generate } = steps(impl);
    await draft(APPLICANT, { ...BOOTSTRAP_PASS_ANSWERS, userId: "bad!" });
    await evaluate(APPLICANT);
    await expect(generate(APPLICANT)).rejects.toThrow(
      /User ID: use 3 to 12 letters and numbers, like A1B2C/,
    );
  });

  // #148 (2026-10-24): only a pass qualifies by default; a warning goes to a validator.
  it.each([
    ["warning", { mbiExpirationDate: "2024-01-15" }, false],
    ["manual-review", { ndaSigned: "no" }, false],
  ] as const)(
    "%s result permits PDF generation and records automatic-validity eligibility",
    async (outcome, changed, automaticValidityEligible) => {
      const impl = make();
      const { draft, evaluate, generate } = steps(impl);
      await draft(APPLICANT, { ...BOOTSTRAP_PASS_ANSWERS, ...changed });
      expect(await evaluate(APPLICANT)).toMatchObject({ outcome, automaticValidityEligible });
      const text = new TextDecoder().decode(await generate(APPLICANT));
      // One version line (#224): the bootstrap's reserved identity.
      expect(text).toContain("(EIR definition: bootstrap \\(version 0\\))");
      expect(text).not.toContain("Form version");
    },
  );

  it("prints the started record's display code as the PDF's Record ID", async () => {
    const impl = make();
    const { draft, evaluate, generate } = steps(impl);
    const started = await impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName);
    expect(started.recordId).toMatch(/^EIR-[0-9A-Z]{6}$/);
    await draft(APPLICANT, BOOTSTRAP_PASS_ANSWERS);
    await evaluate(APPLICANT);
    const text = new TextDecoder().decode(await generate(APPLICANT));
    expect(text).toContain(`Record ID: ${started.recordId}`);
  });

  it("manual-review permits the signed-PDF upload workflow without automatic validity", async () => {
    const impl = make();
    const repository = impl.as(APPLICANT);
    const values = { ...BOOTSTRAP_PASS_ANSWERS, ndaSigned: "no" };
    await repository.saveDraft(APPLICANT.principalId, values);
    expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
      outcome: "manual-review",
      automaticValidityEligible: false,
    });
    await expect(repository.generatePdf(APPLICANT.principalId)).resolves.toBeInstanceOf(Uint8Array);

    await expect(
      repository.submitWithFile({
        principalId: APPLICANT.principalId,
        personName: APPLICANT.displayName,
        file: pdf(),
        values,
      }),
    ).resolves.toMatchObject({ stage: "submitted" });
  });

  it("editing the draft after evaluation makes PDF generation and upload ineligible until re-evaluated", async () => {
    const impl = make();
    const { draft, evaluate, generate } = steps(impl);
    await draft(APPLICANT, BOOTSTRAP_PASS_ANSWERS);
    await evaluate(APPLICANT);
    const changed = { ...BOOTSTRAP_PASS_ANSWERS, team: "Changed team" };
    await draft(APPLICANT, changed);
    await expect(generate(APPLICANT)).rejects.toThrow("draft changed after evaluation");
    await expect(
      impl.as(APPLICANT).submitWithFile({
        principalId: APPLICANT.principalId,
        personName: APPLICANT.displayName,
        file: pdf(),
        values: changed,
      }),
    ).rejects.toThrow("Evaluate the current saved draft");
    await evaluate(APPLICANT);
    await expect(generate(APPLICANT)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("starts not started, then keeps one EIR per person and every PDF it was given", async () => {
    const impl = make();
    const { submit, decide, get } = steps(impl);
    expect(await get(APPLICANT)).toMatchObject({
      stage: "not-started",
      submissions: [],
      actions: [],
    });
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "questions", "Answer this");
    impl.clock.advance(DAY);
    const eir = await submit(APPLICANT, { response: "Answers" });
    expect(eir.submissions.map((s) => s.kind)).toEqual(["first", "resubmission"]);
    expect(new Set(eir.submissions.map((s) => s.volumePath)).size).toBe(2);
    expect(eir.submissions[1]).toMatchObject({
      submittedAt: "2026-10-02T12:00:00.000Z",
      sizeBytes: pdf().size,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      formValues: VALUES,
    });
  });

  it("shows waiting EIRs with their SLA and records decisions, expiry and revocation", async () => {
    const impl = make();
    const { submit, decide, get, inbox } = steps(impl);
    await submit(APPLICANT);
    expect((await inbox())[0]?.sla).toMatchObject({ stage: "eir-validation", state: "on-track" });
    await decide(VAL, APPLICANT, "questions", "Clarify organization");
    await submit(APPLICANT, { response: "Research division" });
    const valid = await decide(VAL, APPLICANT, "valid");
    expect(valid.expiresAt).toBe(new Date(impl.clock.now.getTime() + 365 * DAY).toISOString());
    const revoked = await decide(VAL, APPLICANT, "revoked", "Access review");
    expect(revoked.actions.at(-1)).toMatchObject({
      kind: "revoked",
      actorScimId: VAL.principalId,
      actorName: VAL.displayName,
      note: "Access review",
      at: "2026-10-01T12:00:00.000Z",
    });
    expect(revoked.expiresAt).toBeUndefined();
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "valid");
    impl.clock.advance(366 * DAY);
    expect((await get(APPLICANT)).stage).toBe("expired");
  });

  it("starts again with a plain submission after a rejection or a revocation", async () => {
    const impl = make();
    const { submit, decide } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "rejected", "Not signed");
    const again = await submit(APPLICANT);
    expect(again.stage).toBe("submitted");
    expect(again.submissions.at(-1)?.kind).toBe("first");
    expect(again.actions.at(-1)?.kind).toBe("submitted");
    await decide(VAL, APPLICANT, "valid");
    await decide(VAL, APPLICANT, "revoked", "Left the team");
    const restarted = await submit(APPLICANT);
    expect(restarted.submissions.map((s) => s.kind)).toEqual(["first", "first", "first"]);
    expect(restarted.actions.map((a) => a.kind)).not.toContain("renewed");
  });

  it("requires and records an answer when the person resubmits after questions", async () => {
    const impl = make();
    const { submit, decide } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "questions", "Clarify the business need");
    await expect(submit(APPLICANT)).rejects.toThrow("answer");
    const resubmitted = await submit(APPLICANT, { response: "Quarterly compliance review" });
    expect(resubmitted.actions.slice(-2)).toEqual([
      expect.objectContaining({ kind: "questions", note: "Clarify the business need" }),
      expect.objectContaining({ kind: "submitted", response: "Quarterly compliance review" }),
    ]);
    expect(resubmitted.response).toBe("Quarterly compliance review");
    expect(resubmitted.questions).toBeUndefined();
  });

  it.each(["questions", "rejected"] as const)(
    "requires a validator note for a %s decision",
    async (decision) => {
      const impl = make();
      const { submit, decide, get } = steps(impl);
      await submit(APPLICANT);
      await expect(decide(VAL, APPLICANT, decision, "  ")).rejects.toThrow("note");
      expect((await get(APPLICANT)).stage).toBe("submitted");
    },
  );

  it("evaluates a renewal before keeping the current validity while it is pending", async () => {
    const impl = make();
    const { submit, decide, inbox } = steps(impl);
    await submit(APPLICANT);
    const valid = await decide(VAL, APPLICANT, "valid");
    const renewing = await submit(APPLICANT, { values: { ...VALUES, team: "Lead Team" } });
    expect(renewing).toMatchObject({
      stage: "valid",
      expiresAt: valid.expiresAt,
      formValues: VALUES,
      renewal: { stage: "submitted", formValues: { ...VALUES, team: "Lead Team" } },
    });
    expect(renewing.submissions.at(-1)?.kind).toBe("renewal");
    expect(renewing.actions.at(-1)).toMatchObject({ kind: "renewed", subject: "renewal" });
    await expect(submit(APPLICANT)).rejects.toThrow(
      /pending renewal|waits for a safeguards validator/,
    );
    expect((await inbox()).map((item) => item.renewal?.stage)).toEqual(["submitted"]);
  });

  it("replaces the expiry and the signed values when a pending renewal is approved", async () => {
    const impl = make();
    const { submit, decide } = steps(impl);
    await submit(APPLICANT);
    const first = await decide(VAL, APPLICANT, "valid");
    await submit(APPLICANT, { values: { ...VALUES, team: "Lead Team" } });
    impl.clock.advance(10 * DAY);
    const renewed = await decide(VAL, APPLICANT, "valid");
    expect(renewed.expiresAt).toBe("2027-10-11T12:00:00.000Z");
    expect(renewed.expiresAt).not.toBe(first.expiresAt);
    expect(renewed.renewal).toBeUndefined();
    expect(renewed.formValues?.["team"]).toBe("Lead Team");
    expect(renewed.actions.at(-1)).toMatchObject({ kind: "valid", subject: "renewal" });
  });

  it("keeps the old validity and expiry when a pending renewal is rejected", async () => {
    const impl = make();
    const { submit, decide } = steps(impl);
    await submit(APPLICANT);
    const first = await decide(VAL, APPLICANT, "valid");
    await submit(APPLICANT);
    const rejected = await decide(VAL, APPLICANT, "rejected", "Renewal signature is incomplete");
    expect(rejected).toMatchObject({
      stage: "valid",
      expiresAt: first.expiresAt,
      renewal: { stage: "rejected", note: "Renewal signature is incomplete" },
    });
    // A rejected renewal can be tried again.
    expect((await submit(APPLICANT)).renewal?.stage).toBe("submitted");
  });

  it("expires the current validity while leaving a pending renewal submitted", async () => {
    const impl = make();
    const { submit, decide, get, inbox } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "valid");
    await submit(APPLICANT);
    impl.clock.advance(366 * DAY);
    expect(await get(APPLICANT)).toMatchObject({
      stage: "expired",
      renewal: { stage: "submitted" },
    });
    expect((await inbox()).map((item) => item.stage)).toEqual(["expired"]);
    const renewed = await decide(VAL, APPLICANT, "valid");
    expect(renewed.stage).toBe("valid");
  });

  it("closes a pending renewal, by the app, when the current validity is revoked", async () => {
    const impl = make();
    const { submit, decide, inbox } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "valid");
    await submit(APPLICANT);
    const revoked = await decide(VAL, APPLICANT, "revoked", "Access review");
    expect(revoked).toMatchObject({ stage: "revoked" });
    expect(revoked.expiresAt).toBeUndefined();
    expect(revoked.renewal).toBeUndefined();
    expect(revoked.actions.slice(-2)).toEqual([
      expect.objectContaining({
        kind: "renewal-closed",
        actorScimId: "system",
        actorName: "EDP Vending Machine",
        subject: "renewal",
      }),
      expect.objectContaining({ kind: "revoked", actorScimId: VAL.principalId }),
    ]);
    expect(await inbox()).toEqual([]);
    await expect(decide(VAL, APPLICANT, "valid")).rejects.toThrow("Only submitted EIRs");
    const fresh = await submit(APPLICANT);
    expect(fresh.stage).toBe("submitted");
    expect(fresh.renewal).toBeUndefined();
    expect(fresh.submissions.at(-1)?.kind).toBe("first");
  });

  it("keeps the current expiry when a pending renewal is sent back, and needs an answer", async () => {
    const impl = make();
    const { submit, decide } = steps(impl);
    await submit(APPLICANT);
    const valid = await decide(VAL, APPLICANT, "valid");
    await submit(APPLICANT);
    const returned = await decide(VAL, APPLICANT, "questions", "Clarify the signature");
    expect(returned).toMatchObject({
      stage: "valid",
      expiresAt: valid.expiresAt,
      renewal: { stage: "questions", questions: "Clarify the signature" },
    });
    await expect(submit(APPLICANT)).rejects.toThrow("answer");
    const answered = await submit(APPLICANT, { response: "Signed again" });
    expect(answered.renewal).toMatchObject({ stage: "submitted", response: "Signed again" });
    expect(answered.renewal?.questions).toBeUndefined();
    const revoked = await decide(VAL, APPLICANT, "revoked");
    expect(revoked.actions.slice(-2).map((a) => a.kind)).toEqual(["renewal-closed", "revoked"]);
  });

  it("evaluates a correction draft before submitting it with the finalized values", async () => {
    const impl = make();
    const { submit, decide, draft } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "rejected", "Correct the signature");
    const corrected = { ...VALUES, team: "Senior Team" };
    const drafted = await draft(APPLICANT, corrected);
    expect(drafted.formValues).toEqual(VALUES);
    expect(drafted.draftValues).toEqual(corrected);
    expect(drafted.stage).toBe("rejected");
    const submitted = await submit(APPLICANT, { values: corrected });
    expect(submitted).toMatchObject({ stage: "submitted", formValues: corrected });
    expect(submitted.draftValues).toBeUndefined();
  });

  it("keeps a draft before the first submission and while answering questions", async () => {
    const impl = make();
    const { submit, decide, draft, get } = steps(impl);
    await draft(APPLICANT, { ...VALUES, firstName: "" });
    expect(await get(APPLICANT)).toMatchObject({
      stage: "not-started",
      draftValues: { ...VALUES, firstName: "" },
    });
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "questions", "Clarify");
    const drafted = await draft(APPLICANT, {
      ...VALUES,
      contractingCompany: "Example Division LLC",
    });
    expect(drafted.formValues).toEqual(VALUES);
    expect(drafted.draftValues?.["contractingCompany"]).toBe("Example Division LLC");
  });

  it("keeps the person's draft out of the validator inbox", async () => {
    const impl = make();
    const { submit, decide, draft, get, inbox } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "valid");
    await draft(APPLICANT, { ...VALUES, team: "Renewal correction" });
    expect((await get(APPLICANT)).draftValues?.["team"]).toBe("Renewal correction");
    const [item] = await inbox();
    expect(item).toMatchObject({ principalId: APPLICANT.principalId, stage: "valid" });
    for (const field of ["draftValues", "draftFormVersion", "draftStartedAt", "draftVersion"])
      expect(item, field).not.toHaveProperty(field);
  });

  it("keeps the person's draft out of a validator's decision, and keeps it for the person", async () => {
    const impl = make();
    const { submit, decide, draft, get } = steps(impl);
    await submit(APPLICANT);
    await decide(VAL, APPLICANT, "valid");
    await draft(APPLICANT, { ...VALUES, team: "Renewal correction" });
    const revoked = await decide(VAL, APPLICANT, "revoked");
    expect(revoked.stage).toBe("revoked");
    for (const field of ["draftValues", "draftFormVersion", "draftStartedAt", "draftVersion"])
      expect(revoked, field).not.toHaveProperty(field);
    expect((await get(APPLICANT)).draftValues?.["team"]).toBe("Renewal correction");
  });

  it("keeps a validator's own draft on their own (test mode) decision", async () => {
    const impl =
      _name === "memory"
        ? memoryImplementation(createClock(), {
            ...ON_BOOTSTRAP_1,
            selfDecisionTestMode: true,
          })
        : deltaImplementation(createClock(), {
            ...ON_BOOTSTRAP_1,
            selfDecisionTestMode: true,
          });
    const { submit, decide, draft } = steps(impl);
    await submit(VAL);
    await decide(VAL, VAL, "valid");
    await draft(VAL, { ...VALUES, team: "My correction" });
    const revoked = await decide(VAL, VAL, "revoked");
    expect(revoked).toMatchObject({ stage: "revoked", draftValues: { team: "My correction" } });
  });

  it("refuses a draft while the EIR or its renewal waits for a validator", async () => {
    const impl = make();
    const { submit, decide, draft, get } = steps(impl);
    await submit(APPLICANT);
    await expect(draft(APPLICANT, { ...VALUES, team: "Changed" })).rejects.toThrow(
      "waits for a safeguards validator",
    );
    await decide(VAL, APPLICANT, "valid");
    await submit(APPLICANT);
    await expect(draft(APPLICANT, { ...VALUES, team: "Changed" })).rejects.toThrow(
      "waits for a safeguards validator",
    );
    expect((await get(APPLICANT)).draftValues).toBeUndefined();
  });

  it("starts a record with a Record ID once, and gives first submissions without a start one too", async () => {
    // The harness hands both implementations the same Record IDs in order
    // (recordIdSequence); real ones are random display codes.
    const impl = make();
    const started = await impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName);
    expect(started).toMatchObject({ stage: "not-started", recordId: "EIR-00000A" });
    expect(started.actions).toEqual([
      expect.objectContaining({ kind: "started", actorScimId: APPLICANT.principalId }),
    ]);
    await expect(
      impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName),
    ).rejects.toThrow("already been started");
    const { submit } = steps(impl);
    expect((await submit(APPLICANT)).recordId).toBe("EIR-00000A");
    expect((await submit(OTHER_PERSON)).recordId).toBe("EIR-00000B");
  });

  it.each([
    ["a missing required answer", { workEmail: "" }, "Enter work email."],
    [
      "an email that isn't one",
      { managerEmail: "not-an-email" },
      "Manager's work email: enter an email address",
    ],
    ["a user ID that isn't one", { userId: "a b" }, "User ID: use 3 to 12 letters and numbers"],
    [
      "a date that isn't one",
      { privacyTrainingDate: "2026-02-30" },
      "Privacy training date: enter a real date.",
    ],
    // Form 1.3: every compliance item is required, meaning answered.
    [
      "a training date not given",
      { cyberAwarenessTrainingDate: "" },
      "Enter cyber awareness training date.",
    ],
    [
      "the MBI expiration date not given",
      { mbiExpirationDate: "" },
      "Enter MBI or staff-like access expiration date.",
    ],
    [
      "a yes/no question not answered",
      { ndaSigned: "" },
      "Choose Yes or No: Have you agreed to and signed the IRS non-disclosure agreement (NDA)?",
    ],
    [
      "a yes/no answered with neither yes nor no",
      { irmAcknowledged: "maybe" },
      "choose yes or no.",
    ],
    ["the declaration not agreed", { declarationAgreed: "" }, "Agree to the declaration"],
    [
      "an answer the form doesn't have",
      { liveDataWaiver: "yes" },
      /liveDataWaiver isn't on the EIR form for bootstrap \(version 0\)|doesn't match what this endpoint accepts/,
    ],
  ] as [string, Record<string, string>, string | RegExp][])(
    "refuses %s, writing nothing",
    async (_label, change, message) => {
      const impl = make();
      const { submit, get } = steps(impl);
      await expect(submit(APPLICANT, { values: { ...VALUES, ...change } })).rejects.toThrow(
        Object.hasOwn(change, "userId") ? "blocking EIR fields" : message,
      );
      expect(await get(APPLICANT)).toMatchObject({ stage: "not-started", submissions: [] });
    },
  );

  it("never refuses compliance answers: a no, a lapsed or future training date, out-of-order MBI dates", async () => {
    const impl = make();
    const { submit } = steps(impl);
    const flagged = {
      ...VALUES,
      irmAcknowledged: "no",
      ndaSigned: "no",
      mbiPreliminary: "yes",
      unauthorizedAccessTrainingDate: "2024-01-01",
      privacyTrainingDate: "2027-01-01",
      mbiInitialDate: "2027-01-01",
      mbiExpirationDate: "2026-01-01",
    };
    const eir = await submit(APPLICANT, { values: flagged });
    expect(eir).toMatchObject({
      stage: "submitted",
      formValues: flagged,
      formVersion: "bootstrap",
    });
  });

  it("submits without a contracting company: not everyone is a contractor (form 1.3)", async () => {
    const impl = make();
    const { submit } = steps(impl);
    const eir = await submit(APPLICANT, { values: { ...VALUES, contractingCompany: "" } });
    expect(eir).toMatchObject({
      stage: "submitted",
      formValues: { contractingCompany: "" },
      formVersion: "bootstrap",
    });
  });

  it("stores the form version, when the form was started (its draft) and trimmed answers", async () => {
    const impl = make();
    const { submit, draft } = steps(impl);
    await draft(APPLICANT, VALUES);
    impl.clock.advance(3 * DAY);
    const eir = await submit(APPLICANT, { values: { ...VALUES, team: "  Test Team  " } });
    expect(eir.submissions[0]).toMatchObject({
      formVersion: "bootstrap",
      formStartedAt: "2026-10-01T12:00:00.000Z",
      submittedAt: "2026-10-04T12:00:00.000Z",
      formValues: VALUES,
    });
    expect(eir).toMatchObject({
      formVersion: "bootstrap",
      formStartedAt: "2026-10-01T12:00:00.000Z",
      formSubmittedAt: "2026-10-04T12:00:00.000Z",
    });
    // Without a draft, the form started when it was submitted.
    const other = await submit(OTHER_PERSON);
    expect(other.submissions[0]?.formStartedAt).toBe("2026-10-04T12:00:00.000Z");
  });

  it("keeps every answer of a draft, partial or complete, across a reload", async () => {
    const impl = make();
    const { draft, get } = steps(impl);
    const partial = { ...VALUES, managerEmail: "", declarationAgreed: "", mbiPreliminary: "yes" };
    await draft(APPLICANT, partial);
    impl.clock.advance(DAY);
    const reloaded = await get(APPLICANT);
    expect(reloaded).toMatchObject({
      draftValues: partial,
      draftFormVersion: "bootstrap",
      draftStartedAt: "2026-10-01T12:00:00.000Z",
    });
    // A later save keeps the draft's start.
    await draft(APPLICANT, VALUES);
    expect(await get(APPLICANT)).toMatchObject({
      draftValues: VALUES,
      draftStartedAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it("employee draft save/load round-trips through the repository with fields from the definition", async () => {
    const impl = make();
    const { draft, get, submit } = steps(impl);
    // The bootstrap definition's own synthetic answers (#200), every field it defines.
    const answers = BOOTSTRAP_PASS_ANSWERS;
    expect(Object.keys(answers)).toHaveLength(20);
    await draft(APPLICANT, answers);
    expect(await get(APPLICANT)).toMatchObject({
      draftValues: answers,
      draftFormVersion: "bootstrap",
    });
    const submitted = await submit(APPLICANT, { values: answers });
    expect(submitted).toMatchObject({
      stage: "submitted",
      formVersion: "bootstrap",
      formValues: answers,
    });
  });

  it("lists what a validator can act on, without unsigned drafts", async () => {
    const impl = make();
    const { submit, decide, draft, inbox } = steps(impl);
    await submit(APPLICANT);
    await submit(OTHER_PERSON, {
      values: { ...VALUES, firstName: "Sample", lastName: "Applicant" },
    });
    await decide(VAL, OTHER_PERSON, "valid");
    await draft(OTHER_PERSON, { ...VALUES, firstName: "Sample B." });
    const items = await inbox();
    expect(items.map((item) => [item.principalId, item.stage])).toEqual([
      [APPLICANT.principalId, "submitted"],
      [OTHER_PERSON.principalId, "valid"],
    ]);
    expect(items.every((item) => item.draftValues === undefined)).toBe(true);
  });
});

it("reload-then-upload succeeds from a fresh Delta client and restores the persisted evaluation", async () => {
  const impl = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
  const beforeReload = impl.as(APPLICANT);
  await beforeReload.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
  await beforeReload.evaluateDraft(APPLICANT.principalId);
  await beforeReload.generatePdf(APPLICANT.principalId);

  const afterReload = impl.fresh(APPLICANT);
  await expect(afterReload.get(APPLICANT.principalId)).resolves.toMatchObject({
    evaluation: {
      outcome: "pass",
      definitionVersion: "bootstrap",
      evaluatedDraftVersion: 1,
    },
  });
  await expect(
    afterReload.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: BOOTSTRAP_PASS_ANSWERS,
    }),
  ).resolves.toMatchObject({ stage: "submitted" });
});

it("restores an evaluated draft from a warmed snapshot before a fresh client uploads", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const impl = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
  const repository = impl.as(APPLICANT);
  await repository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
  await repository.evaluateDraft(APPLICANT.principalId);
  await repository.generatePdf(APPLICANT.principalId);

  const cache = createDeltaSnapshotCache({
    tables: SNAPSHOT_TABLES.filter((table) => table.area === "eir"),
    pollIntervalMs: 60_000,
    maxStaleMs: 60_000,
  });
  const read = impl.deps.runner.reader({ readId: crypto.randomUUID() });
  await cache.start(
    async <T extends object>(statement: Parameters<typeof read>[0]): Promise<T[]> =>
      statement.statement.includes("UNION ALL")
        ? ([{ area: "eir", version: "evaluated-draft-1" }] as T[])
        : read<T>(statement),
    impl.deps.names,
  );
  impl.deps.snapshotCache = cache;

  const afterReload = impl.fresh(APPLICANT);
  await expect(afterReload.get(APPLICANT.principalId)).resolves.toMatchObject({
    evaluation: {
      outcome: "pass",
      definitionVersion: "bootstrap",
      evaluatedDraftVersion: 1,
    },
  });
  expect(info).toHaveBeenCalledWith(expect.stringContaining("read eir/mine source=snapshot"));
  await expect(
    afterReload.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: BOOTSTRAP_PASS_ANSWERS,
    }),
  ).resolves.toMatchObject({ stage: "submitted" });
});

it("refuses an upload when a concurrent save changes the evaluated draft before commit", async () => {
  const impl = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
  const repository = impl.as(APPLICANT);
  await repository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
  await repository.evaluateDraft(APPLICANT.principalId);
  await repository.generatePdf(APPLICANT.principalId);

  const paused = impl.warehouse.holdNext();
  const upload = repository.submitWithFile({
    principalId: APPLICANT.principalId,
    personName: APPLICANT.displayName,
    file: pdf(),
    values: BOOTSTRAP_PASS_ANSWERS,
  });
  await paused.reached;
  await impl.fresh(APPLICANT).saveDraft(APPLICANT.principalId, {
    ...BOOTSTRAP_PASS_ANSWERS,
    team: "Changed while uploading",
  });
  paused.release();

  await expect(upload).rejects.toMatchObject({ code: "evaluation-required", status: 409 });
  await expect(repository.get(APPLICANT.principalId)).resolves.toMatchObject({
    stage: "not-started",
    draftValues: { team: "Changed while uploading" },
  });
});

it("refuses a stale Delta upload before writing an orphan file", async () => {
  const impl = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
  const repository = impl.as(APPLICANT);
  await repository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
  await repository.evaluateDraft(APPLICANT.principalId);
  await repository.saveDraft(APPLICANT.principalId, {
    ...BOOTSTRAP_PASS_ANSWERS,
    team: "Edited after evaluation",
  });

  await expect(
    repository.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: { ...BOOTSTRAP_PASS_ANSWERS, team: "Edited after evaluation" },
    }),
  ).rejects.toMatchObject({ status: 409, code: "evaluation-required" });
  expect(impl.files.size).toBe(0);
});

it("refuses a draft-only field mismatch before upload and treats a missing key as blank", async () => {
  const mismatched = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
  const mismatchedRepository = mismatched.as(APPLICANT);
  const draftOnly = { ...BOOTSTRAP_PASS_ANSWERS, subTeam: "Draft-only value" };
  await mismatchedRepository.saveDraft(APPLICANT.principalId, draftOnly);
  await mismatchedRepository.evaluateDraft(APPLICANT.principalId);
  const withoutSubTeam = { ...draftOnly } as Partial<EirFormValues>;
  delete withoutSubTeam["subTeam"];

  await expect(
    mismatchedRepository.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: withoutSubTeam as EirFormValues,
    }),
  ).rejects.toMatchObject({ status: 409, code: "evaluation-mismatch" });
  expect(mismatched.files.size).toBe(0);

  const blank = deltaImplementation(createClock(), ON_BOOTSTRAP_1);
  const blankRepository = blank.as(APPLICANT);
  await blankRepository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
  await blankRepository.evaluateDraft(APPLICANT.principalId);
  const withoutBlankSubTeam = { ...BOOTSTRAP_PASS_ANSWERS } as Partial<EirFormValues>;
  delete withoutBlankSubTeam["subTeam"];
  await expect(
    blankRepository.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: withoutBlankSubTeam as EirFormValues,
    }),
  ).resolves.toMatchObject({ stage: "submitted" });
  expect(blank.files.size).toBe(1);
});

it.each([
  [
    "memory",
    () =>
      memoryImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        definitions: definitionsWithoutTheDraftsForm(),
      }),
  ],
  [
    "delta",
    () =>
      deltaImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        definitions: definitionsWithoutTheDraftsForm(),
      }),
  ],
] as const)(
  "legacy or mismatched draft form version routes to recorded manual review on %s",
  async (_name, make) => {
    const repository = make().as(APPLICANT);
    await repository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
    await expect(repository.evaluateDraft(APPLICANT.principalId)).resolves.toMatchObject({
      outcome: "manual-review",
      formVersion: "bootstrap",
      automaticValidityEligible: false,
      outcomes: [{ reasonCode: "EIR-EVALUATION-UNAVAILABLE" }],
    });
  },
);

describe.each([
  [
    "memory",
    (kind: "definition" | "evaluator" | "operator") =>
      memoryImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        ...(kind === "definition"
          ? {
              definitions: definitionsThatFailToLoad(),
            }
          : kind === "operator"
            ? { definitions: definitionsWithUnhandledOperator() }
            : {
                evaluator: () => {
                  throw new Error("synthetic evaluator failure");
                },
              }),
      }),
  ],
  [
    "delta",
    (kind: "definition" | "evaluator" | "operator") =>
      deltaImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        ...(kind === "definition"
          ? {
              definitions: definitionsThatFailToLoad(),
            }
          : kind === "operator"
            ? { definitions: definitionsWithUnhandledOperator() }
            : {
                evaluator: () => {
                  throw new Error("synthetic evaluator failure");
                },
              }),
      }),
  ],
] as const)("EIR evaluation failure contract: %s", (_name, make) => {
  it.each(["definition", "evaluator", "operator"] as const)(
    "%s failure yields manual handling and is never blocking or eligible for automatic validity",
    async (kind) => {
      const impl = make(kind);
      await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
      expect(await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId)).toMatchObject({
        outcome: "manual-review",
        automaticValidityEligible: false,
        outcomes: [{ reasonCode: "EIR-EVALUATION-UNAVAILABLE", disposition: "manual-review" }],
      });
    },
  );
});

it.each([
  [
    "memory",
    () =>
      memoryImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        persistEvaluation: () => {
          throw new Error("synthetic persistence failure");
        },
      }),
  ],
  [
    "delta",
    () =>
      deltaImplementation(createClock(), {
        ...ON_BOOTSTRAP_1,
        failEvaluationPersistence: true,
      }),
  ],
] as const)(
  "result-persistence failure on %s records nothing and reports a safely retryable unconfirmed pre-check",
  async (_name, make) => {
    const impl = make();
    const repository = impl.as(APPLICANT);
    await repository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
    await expect(repository.evaluateDraft(APPLICANT.principalId)).rejects.toMatchObject({
      draftWasSaved: true,
      message:
        "Your draft was saved, but the pre-check couldn't be confirmed. Try again; retrying is safe.",
    });
    await expect(repository.generatePdf(APPLICANT.principalId)).rejects.toThrow("Evaluate");
    await expect(
      repository.submitWithFile({
        principalId: APPLICANT.principalId,
        personName: APPLICANT.displayName,
        file: pdf(),
        values: BOOTSTRAP_PASS_ANSWERS,
      }),
    ).rejects.toThrow("Evaluate");
  },
);

describe("EIR repository contract: memory and Delta give the same answers", () => {
  it("matches step by step through a full lifecycle for two people", async () => {
    const run = async (impl: EirImplementation) => {
      const { submit, decide, draft, get, inbox } = steps(impl);
      const transcript: unknown[] = [];
      const step = async (label: string, action: () => Promise<unknown>) => {
        try {
          transcript.push([label, comparable(await action())]);
        } catch (error) {
          transcript.push([label, "refused", (error as Error).message]);
        }
      };
      await step("ada empty", () => get(APPLICANT));
      await step("applicant starts", () =>
        impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName),
      );
      await step("applicant starts twice", () =>
        impl.as(APPLICANT).start(APPLICANT.principalId, APPLICANT.displayName),
      );
      await step("submit an incomplete form", () =>
        submit(APPLICANT, { values: { ...VALUES, userId: "" } }),
      );
      await step("ada draft", () => draft(APPLICANT, { ...VALUES, subTeam: "draft" }));
      await step("ada submits", () => submit(APPLICANT));
      await step("ada submits twice", () => submit(APPLICANT));
      await step("ada draft while waiting", () => draft(APPLICANT, VALUES));
      await step("grace submits", () =>
        submit(OTHER_PERSON, { values: { ...VALUES, firstName: "G" } }),
      );
      await step("inbox", () => inbox());
      await step("val questions, no note", () => decide(VAL, APPLICANT, "questions"));
      await step("val questions", () => decide(VAL, APPLICANT, "questions", "Why?"));
      impl.clock.advance(2 * DAY);
      await step("inbox later", () => inbox(VIC));
      await step("ada resubmits", () => submit(APPLICANT, { response: "Because" }));
      await step("vic validates", () => decide(VIC, APPLICANT, "valid", "Looks right"));
      await step("val rejects grace", () => decide(VAL, OTHER_PERSON, "rejected", "Unsigned"));
      await step("grace again", () =>
        submit(OTHER_PERSON, { values: { ...VALUES, firstName: "G2" } }),
      );
      await step("ada renews", () => submit(APPLICANT, { values: { ...VALUES, team: "Lead" } }));
      await step("vic questions renewal", () => decide(VIC, APPLICANT, "questions", "Which team?"));
      await step("ada answers renewal", () => submit(APPLICANT, { response: "Data team" }));
      await step("val rejects renewal", () => decide(VAL, APPLICANT, "rejected", "Wrong form"));
      await step("ada renews again", () => submit(APPLICANT));
      impl.clock.advance(400 * DAY);
      await step("ada expired", () => get(APPLICANT));
      await step("inbox expired", () => inbox());
      await step("val approves renewal", () => decide(VAL, APPLICANT, "valid"));
      await step("val revokes", () => decide(VAL, APPLICANT, "revoked", "Left"));
      await step("ada draft after revoke", () => draft(APPLICANT, { ...VALUES, team: "Back" }));
      await step("ada restarts", () => submit(APPLICANT, { values: { ...VALUES, team: "Back" } }));
      await step("grace final", () => get(OTHER_PERSON));
      await step("ada final", () => get(APPLICANT));
      return transcript;
    };
    const memory = await run(memoryImplementation(createClock(), ON_BOOTSTRAP_1));
    const delta = await run(deltaImplementation(createClock(), ON_BOOTSTRAP_1));
    expect(delta).toEqual(memory);
    // The transcript holds both answers and refusals.
    expect(memory.filter((entry) => (entry as unknown[])[1] === "refused")).toHaveLength(5);
  });
});

/**
 * #201 / PR #210 follow-up: a draft evaluated on its pinned definition can't
 * get a PDF once that definition can't be loaded. Both adapters refuse with
 * 503 and the unavailable message, never a PDF on a guessed form.
 */
describe.each([
  ["memory", memoryImplementation],
  ["delta", deltaImplementation],
] as const)("PDF generation when the draft's definition can't be loaded: %s", (_name, make) => {
  it("refuses with 503 and the unavailable message", async () => {
    let loadable = true;
    const definitions: EirDefinitionLookup = {
      active: bootstrap,
      byId: (id) => (!loadable ? null : id === "bootstrap" ? bootstrap() : undefined),
    };
    const impl = make(createClock(), { definitions, shownFormVersion: "bootstrap" });
    const repository = impl.as(APPLICANT);
    await repository.saveDraft(APPLICANT.principalId, BOOTSTRAP_PASS_ANSWERS);
    expect(await repository.evaluateDraft(APPLICANT.principalId)).toMatchObject({
      outcome: "pass",
      // Its identity (#224): the version the draft is pinned to.
      definitionVersion: "bootstrap",
    });

    loadable = false;
    await expect(repository.generatePdf(APPLICANT.principalId)).rejects.toMatchObject({
      status: 503,
      message: "The EIR form is temporarily unavailable. Nothing has been saved.",
    });
  });
});
