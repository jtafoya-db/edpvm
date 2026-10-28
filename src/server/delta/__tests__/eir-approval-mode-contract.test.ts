// @vitest-environment node
/**
 * #204 at the EIR repository's upload seam: after the signed PDF of a draft
 * with a non-blocking pre-check is uploaded, the deploy-time approval mode
 * decides the next stage. The same contract on both adapters: memory, and
 * the browser's Delta client → Delta API → `eir` area → SQLite fake
 * warehouse.
 *
 * Definitions are synthetic: `PUBLISHED` is the bootstrap definition's rules
 * (a warning for MBI dates out of order, manual review for NDA = No) under
 * published version 7, so the warning and manual-review outcomes #217 took
 * out of the fallback built-in still run end to end. Expected values are
 * written by hand from those rules on the harness clock, 2026-10-01.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_EIR_APPROVAL_CONFIG } from "../../../data/eir/approval-mode.ts";
import type { EirApprovalConfig } from "../../../data/eir/approval-mode.ts";
import { builtInById, withId } from "../../../data/eir/definition/built-in.ts";
import type { EirDefinition } from "../../../data/eir/definition/types.ts";
import { evaluateEirDraft } from "../../../data/eir/evaluation.ts";
import type { EirDefinitionLookup } from "../../../data/eir/repository";
import type { EirFormValues, EirRecord } from "../../../data/eir/types";
import {
  APPLICANT,
  bootstrap1,
  createClock,
  deltaImplementation,
  memoryImplementation,
  pdf,
  VAL,
  VIC,
  type EirImplementation,
} from "./eir-harness.ts";
import type { SessionUser } from "../registry.ts";

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
/** A warning: the MBI expires before it started. */
const WARNING: EirFormValues = { ...PASSING, mbiExpirationDate: "2024-01-15" };
/** Manual review: the NDA isn't signed. */
const MANUAL_REVIEW: EirFormValues = { ...PASSING, ndaSigned: "no" };
/** A pass a year on: training taken again in 2027. */
const RENEWING: EirFormValues = {
  ...PASSING,
  unauthorizedAccessTrainingDate: "2027-06-01",
  privacyTrainingDate: "2027-06-01",
  cyberAwarenessTrainingDate: "2027-06-01",
};

const DAY = 86_400_000;
const AUTOMATIC: EirApprovalConfig = { mode: "automatic", automaticValidityOutcomes: ["pass"] };
const AUTOMATIC_WITH_WARNINGS: EirApprovalConfig = {
  mode: "automatic",
  automaticValidityOutcomes: ["pass", "warning"],
};
const MANUAL: EirApprovalConfig = { ...DEFAULT_EIR_APPROVAL_CONFIG, mode: "manual-validator" };

/** Synthetic published version 7: the bootstrap definition's rules, published. */
const PUBLISHED: EirDefinition = withId(bootstrap1(), "7");

/** A store whose active definition is published version 7; `loads` can make it unloadable. */
function publishedStore(state: { loads: boolean } = { loads: true }): EirDefinitionLookup {
  return {
    active: () => PUBLISHED,
    byId: (id) => (id === "7" ? (state.loads ? PUBLISHED : null) : builtInById(id)),
  };
}

type Options = Parameters<typeof memoryImplementation>[1] &
  Parameters<typeof deltaImplementation>[1];

const IMPLEMENTATIONS = [
  ["memory", (options: Options) => memoryImplementation(createClock(), options)],
  ["delta", (options: Options) => deltaImplementation(createClock(), options)],
] as const;

describe.each(IMPLEMENTATIONS)("EIR approval mode after upload (#204): %s", (name, build) => {
  /** A store on published version 7, in `approval` (the deploy default when unset). */
  const make = (options: Options = {}): EirImplementation =>
    build({
      definitions: publishedStore(),
      shownFormVersion: "7",
      ...options,
    });

  /** Download PDF to sign, then upload it: the employee's two steps. */
  async function signAndUpload(
    impl: EirImplementation,
    values: EirFormValues,
    user: SessionUser = APPLICANT,
  ): Promise<EirRecord> {
    const repository = impl.as(user);
    const before = await repository.get(user.principalId);
    await repository.preparePdf({
      principalId: user.principalId,
      personName: user.displayName,
      values,
      expectedDraftVersion: before.draftVersion ?? 0,
    });
    return upload(impl, values, user);
  }

  const upload = (impl: EirImplementation, values: EirFormValues, user = APPLICANT) =>
    impl.as(user).submitWithFile({
      principalId: user.principalId,
      personName: user.displayName,
      file: pdf(),
      values,
    });

  const systemValidity = (outcome: "pass" | "warning", extra: Record<string, unknown> = {}) => ({
    kind: "valid",
    actorScimId: "system",
    actorName: "EDP Vending Machine",
    at: "2026-10-01T12:00:00.000Z",
    automaticValidity: {
      evaluationId: expect.any(String),
      evaluatedAt: "2026-10-01T12:00:00.000Z",
      definitionVersion: "7",
      formVersion: "7",
      outcome,
      reasonCodes: outcome === "warning" ? ["EIR-MBI-EXPIRES-BEFORE-START"] : [],
      qualifyingOutcomes: outcome === "warning" ? ["pass", "warning"] : ["pass"],
      ...extra,
    },
  });

  describe("manual-validator (the default)", () => {
    it.each([
      ["unset", undefined],
      ["explicit", MANUAL],
    ] as const)(
      "%s: an eligible upload is the normal immutable submission, waiting for Safeguards",
      async (_label, approval) => {
        const impl = make(approval ? { approval } : {});
        const submitted = await signAndUpload(impl, PASSING);
        expect(submitted).toMatchObject({
          stage: "submitted",
          formValues: PASSING,
          formVersion: "7",
          sla: { stage: "eir-validation" },
        });
        expect(submitted.expiresAt).toBeUndefined();
        expect(submitted.submissions).toEqual([
          expect.objectContaining({
            kind: "first",
            volumePath: expect.stringMatching(/^\/Volumes\/edp\/docs\/eir\/1001\/.+\.pdf$|\.pdf$/),
            sizeBytes: pdf().size,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        ]);
        expect(submitted.actions.map((action) => [action.kind, action.actorScimId])).toEqual([
          ["started", "1001"],
          ["submitted", "1001"],
        ]);
        // Waiting on a validator: listed for them, with its SLA.
        expect(await impl.as(VAL).listValidatorInbox()).toEqual([
          expect.objectContaining({ principalId: "1001", stage: "submitted" }),
        ]);
      },
    );
  });

  describe("automatic", () => {
    it("a pass, re-checked at the upload, records the submission and the system's validity together", async () => {
      const impl = make({ approval: AUTOMATIC });
      const valid = await signAndUpload(impl, PASSING);
      expect(valid).toMatchObject({
        stage: "valid",
        formValues: PASSING,
        formVersion: "7",
        // The configured validity period from the upload: 365 days.
        expiresAt: "2027-10-01T12:00:00.000Z",
      });
      expect(valid.sla).toBeUndefined();
      expect(valid.submissions).toEqual([
        expect.objectContaining({
          kind: "first",
          sizeBytes: pdf().size,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]);
      expect(valid.actions).toEqual([
        expect.objectContaining({ kind: "started", actorScimId: "1001" }),
        expect.objectContaining({ kind: "submitted", actorScimId: "1001" }),
        expect.objectContaining(systemValidity("pass")),
      ]);
      // What a reload and the validator see is the same.
      expect(await impl.as(APPLICANT).get("1001")).toMatchObject({
        stage: "valid",
        expiresAt: "2027-10-01T12:00:00.000Z",
        actions: [{}, {}, systemValidity("pass")],
      });
      expect(await impl.as(VAL).listValidatorInbox()).toEqual([
        expect.objectContaining({ principalId: "1001", stage: "valid" }),
      ]);
    });

    it("a warning goes to a validator by default", async () => {
      const impl = make({ approval: AUTOMATIC });
      const submitted = await signAndUpload(impl, WARNING);
      expect(submitted.stage).toBe("submitted");
      expect(submitted.actions.map((action) => action.kind)).toEqual(["started", "submitted"]);
    });

    it("a warning qualifies when the deploy names it", async () => {
      const impl = make({ approval: AUTOMATIC_WITH_WARNINGS });
      const valid = await signAndUpload(impl, WARNING);
      expect(valid.stage).toBe("valid");
      expect(valid.actions.at(-1)).toMatchObject(systemValidity("warning"));
    });

    it.each([
      ["only pass qualifies", AUTOMATIC],
      ["pass and warning qualify", AUTOMATIC_WITH_WARNINGS],
    ] as const)("manual review always enters manual review (%s)", async (_label, approval) => {
      const impl = make({ approval });
      const submitted = await signAndUpload(impl, MANUAL_REVIEW);
      expect(submitted).toMatchObject({ stage: "submitted", sla: { stage: "eir-validation" } });
      expect(submitted.expiresAt).toBeUndefined();
      expect(submitted.actions.map((action) => action.actorScimId)).not.toContain("system");
    });

    it("a draft on a built-in definition is never automatic: nobody published it", async () => {
      const impl = build({ approval: AUTOMATIC });
      const submitted = await signAndUpload(impl, PASSING);
      expect(submitted).toMatchObject({ stage: "submitted", formVersion: "bootstrap-2" });
    });

    it("an evaluator that fails at the upload takes the manual path", async () => {
      let calls = 0;
      const impl = make({
        approval: AUTOMATIC,
        evaluator: (input) => {
          calls += 1;
          if (calls > 1) throw new Error("synthetic evaluator failure");
          return evaluateEirDraft(input);
        },
      });
      const submitted = await signAndUpload(impl, PASSING);
      expect(calls).toBe(2);
      expect(submitted.stage).toBe("submitted");
    });

    it("a result that blocks at the upload takes the manual path, never automatic validity", async () => {
      let calls = 0;
      const impl = make({
        approval: AUTOMATIC,
        evaluator: (input) => {
          calls += 1;
          const evaluation = evaluateEirDraft(input);
          return calls > 1 ? { ...evaluation, outcome: "blocking" } : evaluation;
        },
      });
      expect((await signAndUpload(impl, PASSING)).stage).toBe("submitted");
    });

    it("a definition that can't be loaded at the upload refuses it: nothing is submitted", async () => {
      const state = { loads: true };
      const impl = make({ approval: AUTOMATIC, definitions: publishedStore(state) });
      await impl.as(APPLICANT).preparePdf({
        principalId: "1001",
        personName: APPLICANT.displayName,
        values: PASSING,
        expectedDraftVersion: 0,
      });
      state.loads = false;
      await expect(upload(impl, PASSING)).rejects.toThrow("temporarily unavailable");
      state.loads = true;
      expect(await impl.as(APPLICANT).get("1001")).toMatchObject({
        stage: "not-started",
        submissions: [],
      });
    });

    it("an upload-time result that can't be recorded refuses the upload: no file, action or state", async () => {
      let failing = false;
      const impl = make({
        approval: AUTOMATIC,
        persistEvaluation: () => {
          if (failing) throw new Error("synthetic evaluation persistence failure");
        },
        failEvaluationPersistence: () => failing,
      });
      await impl.as(APPLICANT).preparePdf({
        principalId: "1001",
        personName: APPLICANT.displayName,
        values: PASSING,
        expectedDraftVersion: 0,
      });
      failing = true;
      await expect(upload(impl, PASSING)).rejects.toThrow();
      failing = false;
      const after = await impl.as(APPLICANT).get("1001");
      expect(after).toMatchObject({ stage: "not-started", submissions: [] });
      expect(after.actions.map((action) => action.kind)).toEqual(["started"]);
      // The draft and its pre-check stand: the same upload goes through once it can be recorded.
      expect((await upload(impl, PASSING)).stage).toBe("valid");
    });

    it("a failed PDF write never produces validity, a submission or an action", async () => {
      let failing = false;
      const impl = make({
        approval: AUTOMATIC,
        failFileWrite: () => failing,
        failUpload: () => failing,
      });
      await impl.as(APPLICANT).preparePdf({
        principalId: "1001",
        personName: APPLICANT.displayName,
        values: PASSING,
        expectedDraftVersion: 0,
      });
      failing = true;
      await expect(upload(impl, PASSING)).rejects.toThrow(/synthetic volume/);
      failing = false;
      expect(await impl.as(APPLICANT).get("1001")).toMatchObject({
        stage: "not-started",
        submissions: [],
        actions: [{ kind: "started" }],
      });
    });

    it("a draft edited after its PDF was made is refused until it's checked again", async () => {
      const impl = make({ approval: AUTOMATIC });
      await impl.as(APPLICANT).preparePdf({
        principalId: "1001",
        personName: APPLICANT.displayName,
        values: PASSING,
        expectedDraftVersion: 0,
      });
      const edited = { ...PASSING, team: "Edited Team" };
      await impl.as(APPLICANT).saveDraft("1001", edited, 1);
      await expect(upload(impl, edited)).rejects.toThrow("Evaluate the current saved draft");
      // The PDF of the older answers can't be uploaded for the new draft either.
      await expect(upload(impl, PASSING)).rejects.toThrow();
      expect((await impl.as(APPLICANT).get("1001")).stage).toBe("not-started");
    });

    it("someone else can't upload against this person's draft", async () => {
      const impl = make({ approval: AUTOMATIC });
      await impl.as(APPLICANT).preparePdf({
        principalId: "1001",
        personName: APPLICANT.displayName,
        values: PASSING,
        expectedDraftVersion: 0,
      });
      // VIC has no evaluated draft of their own; an upload is always the session's own.
      await expect(upload(impl, PASSING, VIC)).rejects.toThrow("Evaluate the current saved draft");
      expect((await impl.as(APPLICANT).get("1001")).stage).toBe("not-started");
    });

    it("uploading again after success is refused: one submission, one validity", async () => {
      const impl = make({ approval: AUTOMATIC });
      await signAndUpload(impl, PASSING);
      await expect(upload(impl, PASSING)).rejects.toThrow();
      const record = await impl.as(APPLICANT).get("1001");
      expect(record.submissions).toHaveLength(1);
      expect(record.actions.filter((action) => action.kind === "valid")).toHaveLength(1);
    });

    it("a renewal follows the mode: valid again from the renewal, never shortened before it succeeds", async () => {
      const impl = make({ approval: AUTOMATIC });
      await signAndUpload(impl, PASSING);
      impl.clock.advance(300 * DAY);
      // A renewal that needs manual review: the current EIR stays valid, unchanged.
      const pending = await signAndUpload(impl, MANUAL_REVIEW);
      expect(pending).toMatchObject({
        stage: "valid",
        expiresAt: "2027-10-01T12:00:00.000Z",
        renewal: { stage: "submitted" },
      });
      // A validator sends it back; a passing renewal then validates automatically.
      await impl.as(VAL).decide("1001", "rejected", VAL.principalId, "Sign the NDA first", "Val");
      const renewed = await signAndUpload(impl, RENEWING);
      expect(renewed).toMatchObject({
        stage: "valid",
        expiresAt: new Date(Date.parse("2027-07-28T12:00:00.000Z") + 365 * DAY).toISOString(),
      });
      expect(renewed.renewal).toBeUndefined();
      expect(renewed.actions.slice(-2)).toEqual([
        expect.objectContaining({ kind: "renewed", actorScimId: "1001", subject: "renewal" }),
        expect.objectContaining({
          kind: "valid",
          actorScimId: "system",
          subject: "renewal",
          automaticValidity: expect.objectContaining({ outcome: "pass", definitionVersion: "7" }),
        }),
      ]);
    });

    it("a manual renewal keeps the current validity while it waits, in manual mode too", async () => {
      const impl = make();
      await signAndUpload(impl, PASSING);
      await impl.as(VAL).decide("1001", "valid", VAL.principalId, undefined, VAL.displayName);
      impl.clock.advance(30 * DAY);
      const pending = await signAndUpload(impl, PASSING);
      expect(pending).toMatchObject({
        stage: "valid",
        expiresAt: "2027-10-01T12:00:00.000Z",
        renewal: { stage: "submitted" },
      });
    });

    it("an expired EIR renewed with a pass is valid again", async () => {
      const impl = make({ approval: AUTOMATIC });
      await signAndUpload(impl, PASSING);
      impl.clock.advance(366 * DAY);
      expect((await impl.as(APPLICANT).get("1001")).stage).toBe("expired");
      const renewed = await signAndUpload(impl, RENEWING);
      expect(renewed).toMatchObject({
        stage: "valid",
        expiresAt: new Date(Date.parse("2027-10-02T12:00:00.000Z") + 365 * DAY).toISOString(),
      });
    });

    it("Safeguards still decides: an automatically valid EIR expires on schedule and can be revoked", async () => {
      const impl = make({ approval: AUTOMATIC });
      await signAndUpload(impl, PASSING);
      const revoked = await impl
        .as(VAL)
        .decide("1001", "revoked", VAL.principalId, "Access review", VAL.displayName);
      expect(revoked.stage).toBe("revoked");
      expect(revoked.actions.map((action) => [action.kind, action.actorScimId])).toEqual([
        ["started", "1001"],
        ["submitted", "1001"],
        ["valid", "system"],
        ["revoked", VAL.principalId],
      ]);
    });

    it("Safeguards still sends back and rejects what reaches them", async () => {
      const impl = make({ approval: AUTOMATIC });
      await signAndUpload(impl, MANUAL_REVIEW);
      const sentBack = await impl
        .as(VAL)
        .decide("1001", "questions", VAL.principalId, "Explain the NDA", VAL.displayName);
      expect(sentBack).toMatchObject({ stage: "questions", questions: "Explain the NDA" });
      await impl.as(APPLICANT).preparePdf({
        principalId: "1001",
        personName: APPLICANT.displayName,
        values: MANUAL_REVIEW,
        expectedDraftVersion: (await impl.as(APPLICANT).get("1001")).draftVersion ?? 0,
      });
      const resubmitted = await impl.as(APPLICANT).submitWithFile({
        principalId: "1001",
        personName: APPLICANT.displayName,
        file: pdf(),
        values: MANUAL_REVIEW,
        response: "Signing it this week",
      });
      // Still manual review: a resubmission never skips the validator.
      expect(resubmitted.stage).toBe("submitted");
      const rejected = await impl
        .as(VAL)
        .decide("1001", "rejected", VAL.principalId, "Not signed", VAL.displayName);
      expect(rejected.actions.at(-1)).toMatchObject({
        kind: "rejected",
        actorScimId: VAL.principalId,
      });
    });

    it("a validator's own passing EIR is validated by the system; they still can't decide it", async () => {
      const impl = make({ approval: AUTOMATIC });
      const own = await signAndUpload(impl, PASSING, VAL);
      expect(own.actions.at(-1)).toMatchObject({ kind: "valid", actorScimId: "system" });
      await expect(
        impl.as(VAL).decide(VAL.principalId, "revoked", VAL.principalId, "Mine", VAL.displayName),
      ).rejects.toThrow("Safeguards validators can't decide their own EIR.");
    });
  });

  if (name === "delta") {
    describe("Delta: one block, ordered evidence", () => {
      it("stores the upload-time pre-check, the person's upload and the system's validity in one block", async () => {
        const impl = deltaImplementation(createClock(), {
          definitions: publishedStore(),
          shownFormVersion: "7",
          approval: AUTOMATIC,
        });
        await signAndUpload(impl, PASSING);
        const evaluations = impl.warehouse.query<Record<string, unknown>>(
          `SELECT action_id, record_version, evaluation_sequence, outcome, definition_version, caused_by_action_id, actor_principal_id FROM eir__eir_evaluations ORDER BY evaluation_sequence`,
        );
        const actions = impl.warehouse.query<Record<string, unknown>>(
          `SELECT action_id, action, record_version, actor_principal_id, actor_app, caused_by_action_id, payload FROM eir__eir_actions ORDER BY record_version`,
        );
        expect(evaluations.map((row) => [row["evaluation_sequence"], row["outcome"]])).toEqual([
          [1, "pass"],
          [2, "pass"],
        ]);
        const submitted = actions.find((row) => row["action"] === "submitted")!;
        const validated = actions.find((row) => row["action"] === "validated")!;
        expect(submitted).toMatchObject({
          record_version: 2,
          actor_principal_id: "1001",
          caused_by_action_id: null,
        });
        expect(validated).toMatchObject({
          record_version: 3,
          actor_principal_id: "system",
          actor_app: "system",
          caused_by_action_id: submitted["action_id"],
        });
        // The upload-time pre-check is the upload's, system-attributed.
        expect(evaluations[1]).toMatchObject({
          caused_by_action_id: submitted["action_id"],
          actor_principal_id: "system",
          definition_version: "7",
        });
        expect(JSON.parse(String(validated["payload"]))).toMatchObject({
          automaticValidity: {
            evaluationId: evaluations[1]!["action_id"],
            outcome: "pass",
          },
        });
        expect(
          impl.warehouse.query(
            `SELECT e.stage, e.version, e.sla_due_at, e.expires_at, s.stage AS submission_stage, e.valid_submission_id = s.id AS valid_is_it FROM eir__eirs e JOIN eir__eir_submissions s ON s.eir_id = e.id`,
          ),
        ).toEqual([
          {
            stage: "valid",
            version: 3,
            sla_due_at: null,
            expires_at: "2027-10-01T12:00:00.000Z",
            submission_stage: "valid",
            valid_is_it: 1,
          },
        ]);
      });

      it("a repeated upload command replays its first answer; a stale concurrent one is refused", async () => {
        const impl = deltaImplementation(createClock(), {
          definitions: publishedStore(),
          shownFormVersion: "7",
          approval: AUTOMATIC,
        });
        const repository = impl.as(APPLICANT);
        await repository.preparePdf({
          principalId: "1001",
          personName: APPLICANT.displayName,
          values: PASSING,
          expectedDraftVersion: 0,
        });
        const uploaded = await repository.submitWithFile({
          principalId: "1001",
          personName: APPLICANT.displayName,
          file: pdf(),
          values: PASSING,
          formVersion: "7",
        });
        const path = uploaded.submissions[0]!.volumePath;
        const command = (key: string, expectedVersion: number) =>
          impl.request(
            APPLICANT,
            new Request("https://app/api/commands/eir/submit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                idempotencyKey: key,
                expectedVersion,
                payload: { volumePath: path, formVersion: "7", values: PASSING },
              }),
            }),
          );
        // The client's own key for that upload replays the stored answer.
        const lead = impl.warehouse.query<{ idempotency_key: string }>(
          `SELECT idempotency_key FROM eir__eir_actions WHERE action = 'submitted'`,
        )[0]!;
        const replay = await command(lead.idempotency_key, 1);
        expect(replay.status).toBe(200);
        expect((await replay.json()) as { result: EirRecord }).toMatchObject({
          result: { stage: "valid" },
        });
        // A new command from the state before it is stale.
        expect((await command(globalThis.crypto.randomUUID(), 1)).status).toBe(409);
        expect(impl.warehouse.query(`SELECT count(*) AS n FROM eir__eir_submissions`)[0]).toEqual({
          n: 1,
        });
        expect(
          impl.warehouse.query(
            `SELECT count(*) AS n FROM eir__eir_actions WHERE action = 'validated'`,
          )[0],
        ).toEqual({ n: 1 });
      });

      it("two racing uploads of one draft: one is recorded, the other refused, nothing doubled", async () => {
        const impl = deltaImplementation(createClock(), {
          definitions: publishedStore(),
          shownFormVersion: "7",
          approval: AUTOMATIC,
        });
        await impl.as(APPLICANT).preparePdf({
          principalId: "1001",
          personName: APPLICANT.displayName,
          values: PASSING,
          expectedDraftVersion: 0,
        });
        const release = impl.warehouse.hold();
        const racing = [impl.fresh(APPLICANT), impl.fresh(APPLICANT)].map((repository) =>
          repository
            .submitWithFile({
              principalId: "1001",
              personName: APPLICANT.displayName,
              file: pdf(),
              values: PASSING,
              formVersion: "7",
            })
            .then(
              (record) => record.stage,
              (error: { status?: number }) => error.status,
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        expect((await Promise.all(racing)).sort()).toEqual([409, "valid"].sort());
        expect(impl.warehouse.query(`SELECT count(*) AS n FROM eir__eir_submissions`)).toEqual([
          { n: 1 },
        ]);
        expect(
          impl.warehouse.query(
            `SELECT count(*) AS n FROM eir__eir_actions WHERE action = 'validated'`,
          ),
        ).toEqual([{ n: 1 }]);
      });
    });
  }
});
