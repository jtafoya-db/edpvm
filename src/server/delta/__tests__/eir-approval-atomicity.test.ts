// @vitest-environment node
/**
 * #204, #308 review: an automatic-mode upload is all or nothing. A failure
 * at any one of its writes leaves nothing from that upload saved: no EIR
 * change, submission, employee action, system validity action, upload-time
 * evaluation (or its sequence number), and no submitted PDF. Then the same
 * upload, retried, goes through.
 *
 * - **Delta:** the SQLite fake runs the chosen statement of the upload's
 *   block, then fails the block, so the test proves the rollback undoes a
 *   write that really happened. The PDF is the upload before the command.
 * - **Memory:** its record (EIR, submission, both actions) is one value,
 *   committed after the evaluation and the PDF; `writeFailpoint` fails it
 *   at each of those writes.
 *
 * A signed PDF that reached the volume before a refused command stays
 * there unreferenced, as every refused upload's does (`eir-api.ts`); it is
 * never a submission.
 */
import { describe, expect, it } from "vitest";

import type { EirApprovalConfig } from "../../../data/eir/approval-mode.ts";
import type { EirUploadWrite } from "../../../data/eir/repository.ts";
import { builtInById, withId } from "../../../data/eir/definition/built-in.ts";
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
const AUTOMATIC: EirApprovalConfig = { mode: "automatic", automaticValidityOutcomes: ["pass"] };
const PUBLISHED = withId(bootstrap1(), "7");
const definitions: EirDefinitionLookup = {
  active: () => PUBLISHED,
  byId: (id) => (id === "7" ? PUBLISHED : builtInById(id)),
};

/** The upload's writes, as the Delta block names them: a statement and a bound value it carries. */
const DELTA_WRITES = {
  "EIR row": { statement: /^UPDATE "eir__eirs"/ },
  submission: { statement: /^INSERT INTO "eir__eir_submissions"/ },
  "employee action": { statement: /^INSERT INTO "eir__eir_actions"/, value: "submitted" },
  "system validity action": { statement: /^INSERT INTO "eir__eir_actions"/, value: "validated" },
  "evaluation row with its sequence": { statement: /^INSERT INTO "eir__eir_evaluations"/ },
  "draft superseded": { statement: /^UPDATE "eir__eir_drafts"/ },
} as const;
const MEMORY_WRITES: Record<string, EirUploadWrite> = {
  "EIR row": "eir",
  submission: "submission",
  "employee action": "employee-action",
  "system validity action": "system-action",
  "evaluation row with its sequence": "evaluation",
  "PDF write": "pdf",
};

async function prepare(impl: EirImplementation) {
  await impl.as(APPLICANT).preparePdf({
    principalId: APPLICANT.principalId,
    personName: APPLICANT.displayName,
    values: PASSING,
    expectedDraftVersion: 0,
  });
}
const upload = (impl: EirImplementation) =>
  impl.as(APPLICANT).submitWithFile({
    principalId: APPLICANT.principalId,
    personName: APPLICANT.displayName,
    file: pdf(),
    values: PASSING,
  });

/** Nothing from the failed upload: the EIR is as preparePdf left it, its draft and pre-check intact. */
async function expectUntouched(impl: EirImplementation) {
  const record = await impl.as(APPLICANT).get(APPLICANT.principalId);
  expect(record).toMatchObject({
    stage: "not-started",
    submissions: [],
    draftValues: PASSING,
    evaluation: { outcome: "pass", sequence: 1 },
  });
  expect(record.actions.map((action) => action.kind)).toEqual(["started"]);
  expect(record.expiresAt).toBeUndefined();
}

describe("automatic upload atomicity (#204): memory", () => {
  it.each(Object.entries(MEMORY_WRITES))(
    "a failure at the %s saves nothing from the upload, and a retry goes through",
    async (_label, write) => {
      let failing: EirUploadWrite | undefined;
      const impl = memoryImplementation(createClock(), {
        definitions,
        shownFormVersion: "7",
        approval: AUTOMATIC,
        writeFailpoint: (at) => {
          if (at === failing) throw new Error(`synthetic ${at} write failure`);
        },
      });
      await prepare(impl);
      failing = write;
      await expect(upload(impl)).rejects.toThrow();
      failing = undefined;
      await expectUntouched(impl);
      const retried = await upload(impl);
      expect(retried).toMatchObject({ stage: "valid", submissions: [{ kind: "first" }] });
      expect(retried.actions.map((action) => [action.kind, action.actorScimId])).toEqual([
        ["started", "1001"],
        ["submitted", "1001"],
        ["valid", "system"],
      ]);
    },
  );
});

describe("automatic upload atomicity (#204): delta", () => {
  const count = (impl: ReturnType<typeof deltaImplementation>, table: string) =>
    Number(impl.warehouse.query(`SELECT count(*) AS n FROM "eir__${table}"`)[0]!["n"]);

  it.each([...Object.keys(DELTA_WRITES), "PDF write"])(
    "a failure at the %s saves nothing from the upload, and a retry goes through",
    async (label) => {
      let failing = false;
      const target = DELTA_WRITES[label as keyof typeof DELTA_WRITES];
      const impl = deltaImplementation(createClock(), {
        definitions,
        shownFormVersion: "7",
        approval: AUTOMATIC,
        failUpload: () => failing && label === "PDF write",
        failWrite: (statement, values) =>
          failing &&
          target !== undefined &&
          target.statement.test(statement) &&
          (!("value" in target) || Object.values(values).includes(target.value)),
      });
      await prepare(impl);
      const before = {
        eirs: impl.warehouse.query(`SELECT version, stage FROM "eir__eirs"`),
        drafts: impl.warehouse.query(`SELECT version, form_values FROM "eir__eir_drafts"`),
      };
      failing = true;
      await expect(upload(impl)).rejects.toThrow();
      failing = false;
      // The write the block ran is gone with everything else from the upload.
      expect(impl.warehouse.query(`SELECT version, stage FROM "eir__eirs"`)).toEqual(before.eirs);
      expect(impl.warehouse.query(`SELECT version, form_values FROM "eir__eir_drafts"`)).toEqual(
        before.drafts,
      );
      expect(count(impl, "eir_submissions")).toBe(0);
      expect(count(impl, "eir_actions")).toBe(1);
      expect(
        impl.warehouse.query(`SELECT evaluation_sequence AS n FROM "eir__eir_evaluations"`),
      ).toEqual([{ n: 1 }]);
      await expectUntouched(impl);

      const retried = await upload(impl);
      expect(retried.stage).toBe("valid");
      expect(count(impl, "eir_submissions")).toBe(1);
      expect(
        impl.warehouse.query(
          `SELECT evaluation_sequence AS n FROM "eir__eir_evaluations" ORDER BY evaluation_sequence`,
        ),
      ).toEqual([{ n: 1 }, { n: 2 }]);
      expect(
        impl.warehouse.query(`SELECT action FROM "eir__eir_actions" ORDER BY record_version`),
      ).toEqual([{ action: "started" }, { action: "submitted" }, { action: "validated" }]);
    },
  );
});
