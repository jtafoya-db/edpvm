// @vitest-environment node
/**
 * #235 at the EIR repository seam: `preparePdf` saves the draft (checking the
 * draft version the screen read), evaluates it against its pinned definition
 * and, unless that blocks, returns the PDF, all in one call. The same
 * contract on both adapters: memory, and the browser's Delta client → Delta
 * API → `eir` area → SQLite fake warehouse. Expected values are written by
 * hand from bootstrap-2 (#217: every rule blocks) on the harness clock,
 * 2026-10-01.
 */
import { describe, expect, it } from "vitest";

import { builtInById } from "../../../data/eir/definition/built-in.ts";
import type { EirDefinition } from "../../../data/eir/definition/types.ts";
import type { EirDefinitionLookup } from "../../../data/eir/repository";
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

const text = (bytes: Uint8Array | undefined) => new TextDecoder("latin1").decode(bytes);
const DAY = 86_400_000;

/**
 * A store whose active definition can be switched, as Safeguards activating
 * another one does: `bootstrap` (its NDA No is flagged for the validator)
 * until a test switches to `bootstrap-2` (every rule blocks).
 */
function switchableDefinitions() {
  let active: EirDefinition = bootstrap1();
  const lookup: EirDefinitionLookup = {
    active: () => active,
    byId: (id) => (id === "bootstrap" ? bootstrap1() : builtInById(id)),
  };
  return { lookup, activate: (definition: EirDefinition) => (active = definition) };
}

const IMPLEMENTATIONS = [
  ["memory", memoryImplementation],
  ["delta", deltaImplementation],
] as const;

describe.each(IMPLEMENTATIONS)("EirRepository.preparePdf (#235): %s", (_name, build) => {
  const make = (): EirImplementation => build(createClock());
  const prepare = (
    impl: EirImplementation,
    values: EirFormValues,
    expectedDraftVersion: number,
    extra: { idempotencyKey?: string; formVersion?: string } = {},
  ) =>
    impl.as(APPLICANT).preparePdf({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      values,
      expectedDraftVersion,
      ...extra,
    });

  it("a passing draft: saved, evaluated and its PDF returned, in one call", async () => {
    const impl = make();
    const repository = impl.as(APPLICANT);

    const prepared = await repository.preparePdf({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      values: PASSING,
      expectedDraftVersion: 0,
    });

    expect(prepared.evaluation).toMatchObject({
      definitionVersion: "bootstrap-2",
      formVersion: "bootstrap-2",
      effectiveAt: "2026-10-01T12:00:00.000Z",
      evaluatedDraftVersion: 1,
      outcome: "pass",
      outcomes: [],
    });
    // Started on the way: the PDF carries its Record ID.
    expect(prepared.record).toMatchObject({
      recordId: "EIR-00000A",
      draftValues: PASSING,
      draftFormVersion: "bootstrap-2",
      draftStartedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(text(prepared.pdf).startsWith("%PDF-")).toBe(true);
    // What was saved and evaluated is what the next read and the upload see.
    expect(await repository.get(APPLICANT.principalId)).toMatchObject({
      recordId: "EIR-00000A",
      draftValues: PASSING,
      evaluation: { evaluatedDraftVersion: 1, outcome: "pass" },
    });
  });

  it("the upload that follows is accepted: the evaluation it needs was recorded with the draft", async () => {
    const impl = make();
    await prepare(impl, PASSING, 0);
    const submitted = await impl.as(APPLICANT).submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: PASSING,
    });
    expect(submitted.stage).toBe("submitted");
  });

  it("a blocking draft: saved with its evaluation, its guidance returned, and no PDF", async () => {
    const impl = make();
    const values = { ...PASSING, ndaSigned: "no" };
    const prepared = await prepare(impl, values, 0);

    expect(prepared.pdf).toBeUndefined();
    expect(prepared.evaluation).toMatchObject({
      evaluatedDraftVersion: 1,
      outcome: "blocking",
      outcomes: [
        {
          ruleId: "nda-signed",
          field: "ndaSigned",
          reasonCode: "EIR-NDA-NOT-SIGNED",
          disposition: "blocking",
          guidance: "[Placeholder wording] Sign the IRS NDA, then answer Yes.",
        },
      ],
    });
    expect(await impl.as(APPLICANT).get(APPLICANT.principalId)).toMatchObject({
      draftValues: values,
      evaluation: { evaluatedDraftVersion: 1, outcome: "blocking" },
    });
    await expect(impl.as(APPLICANT).generatePdf(APPLICANT.principalId)).rejects.toThrow(
      "Sign the IRS NDA",
    );
  });

  it("refuses a stale draft version and saves nothing", async () => {
    const impl = make();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, { ...PASSING, team: "Saved first" });

    // The screen read no draft (version 0); another tab saved one since.
    await expect(prepare(impl, PASSING, 0)).rejects.toMatchObject({
      status: 409,
      message: "This changed since you opened it. Reload to see the latest.",
    });
    const after = await impl.as(APPLICANT).get(APPLICANT.principalId);
    expect(after.draftValues).toMatchObject({ team: "Saved first" });
    expect(after.recordId).toBeUndefined();
    expect(after.evaluation).toBeUndefined();
  });

  it("a resend with the same key returns the first answer, even after the clock moves, and saves once", async () => {
    const impl = make();
    const key = "00000000-0000-4000-8000-000000000235";
    const first = await prepare(impl, PASSING, 0, { idempotencyKey: key });
    impl.clock.advance(DAY);

    const again = await prepare(impl, PASSING, 0, { idempotencyKey: key });

    expect(again.evaluation).toEqual(first.evaluation);
    expect(again.record.draftVersion).toBe(first.record.draftVersion);
    expect(text(again.pdf).startsWith("%PDF-")).toBe(true);
    const after = await impl.as(APPLICANT).get(APPLICANT.principalId);
    expect(after.evaluation?.effectiveAt).toBe("2026-10-01T12:00:00.000Z");
    expect(after.actions.filter((action) => action.kind === "started")).toHaveLength(1);
    // The next Download sends the draft version the first answer gave.
    expect((await prepare(impl, PASSING, first.record.draftVersion ?? 1)).evaluation).toMatchObject(
      { evaluatedDraftVersion: 2, effectiveAt: "2026-10-02T12:00:00.000Z" },
    );
  });

  it("refuses one key sent with other answers", async () => {
    const impl = make();
    const key = "00000000-0000-4000-8000-000000000236";
    await prepare(impl, PASSING, 0, { idempotencyKey: key });
    await expect(
      prepare(impl, { ...PASSING, team: "Other" }, 0, { idempotencyKey: key }),
    ).rejects.toMatchObject({ status: 409 });
  });

  describe("on the definition the draft is pinned to", () => {
    const pinned = () => {
      const definitions = switchableDefinitions();
      const impl = build(createClock(), {
        definitions: definitions.lookup,
        shownFormVersion: "bootstrap",
      });
      return { impl, definitions };
    };

    it("a draft begun under bootstrap keeps its rules after bootstrap-2 is activated: an NDA No isn't blocked", async () => {
      const { impl, definitions } = pinned();
      await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, PASSING);
      definitions.activate(builtInById("bootstrap-2")!);

      const prepared = await prepare(impl, { ...PASSING, ndaSigned: "no" }, 1);

      expect(prepared.evaluation.definitionVersion).toBe("bootstrap");
      expect(prepared.evaluation.outcome).not.toBe("blocking");
      expect(prepared.record.draftFormVersion).toBe("bootstrap");
      expect(text(prepared.pdf).startsWith("%PDF-")).toBe(true);
    });

    it("a new draft is on the active definition: there, the same answer blocks", async () => {
      const { impl, definitions } = pinned();
      definitions.activate(builtInById("bootstrap-2")!);
      const prepared = await prepare(impl, { ...PASSING, ndaSigned: "no" }, 0, {
        formVersion: "bootstrap-2",
      });
      expect(prepared.evaluation).toMatchObject({
        definitionVersion: "bootstrap-2",
        outcome: "blocking",
      });
      expect(prepared.pdf).toBeUndefined();
    });

    it("refuses a screen that showed another form than the draft's, and saves nothing", async () => {
      const { impl, definitions } = pinned();
      await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, PASSING);
      definitions.activate(builtInById("bootstrap-2")!);
      await expect(prepare(impl, PASSING, 1, { formVersion: "bootstrap-2" })).rejects.toMatchObject(
        { status: 400 },
      );
      const after = await impl.as(APPLICANT).get(APPLICANT.principalId);
      expect(after.evaluation).toBeUndefined();
      // All or nothing: not even started.
      expect(after.recordId).toBeUndefined();
      expect(after.draftValues).toEqual(PASSING);
    });
  });
});

describe("EirRepository.preparePdf on Delta (#235)", () => {
  it("is one request: no read of the EIR first", async () => {
    const impl = deltaImplementation(createClock());
    const sent: string[] = [];
    const request = impl.request;
    impl.request = (user, req) => {
      sent.push(`${req.method} ${new URL(req.url).pathname}`);
      return request(user, req);
    };
    await impl.as(APPLICANT).preparePdf({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      values: PASSING,
      expectedDraftVersion: 0,
    });
    expect(sent).toEqual(["POST /api/commands/eir/prepare-pdf"]);
  });

  it("a retry after a lost reply resends the same key: the server replays it, nothing is saved twice", async () => {
    const impl = deltaImplementation(createClock());
    const request = impl.request;
    let drop = true;
    impl.request = async (user, req) => {
      const response = await request(user, req);
      if (drop && req.url.endsWith("/prepare-pdf")) {
        drop = false;
        throw Object.assign(new Error("connection reset"), { status: 0 });
      }
      return response;
    };
    const input = {
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      values: PASSING,
      expectedDraftVersion: 0,
    };
    await expect(impl.as(APPLICANT).preparePdf(input)).rejects.toThrow("connection reset");
    impl.clock.advance(DAY);
    const retried = await impl.as(APPLICANT).preparePdf(input);
    expect(retried.evaluation).toMatchObject({
      evaluatedDraftVersion: 1,
      effectiveAt: "2026-10-01T12:00:00.000Z",
    });
    expect(text(retried.pdf).startsWith("%PDF-")).toBe(true);
    expect(impl.attempts.filter((attempt) => attempt.outcome === "replayed")).toHaveLength(1);
  });
});
