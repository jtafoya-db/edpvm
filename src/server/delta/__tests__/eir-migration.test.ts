// @vitest-environment node
/**
 * The one-off migration of #98's interim volume records into the `eir`
 * tables, from fixture record files on a fake volume, through the real
 * runner over the SQLite fake warehouse.
 */
import { describe, expect, it } from "vitest";

import type { EirRecord } from "../../../data/eir/types";
import { EIR_STUB_VALUES as STUB } from "../../../data/__tests__/eir-fixtures.ts";
import type { EirFileStorageClient } from "../../eir-storage";
import { answerSections } from "../../../data/eir/form.ts";
import { describeReport, listVolumeRecords, migrateEirVolumeRecords } from "../../eir-migration";
import {
  APPLICANT,
  comparable,
  deltaImplementation,
  OTHER_PERSON,
  pdf,
  VAL,
  VALUES,
  VOLUME,
} from "./eir-harness.ts";

const ROOT = `/Volumes/${VOLUME.catalog}/${VOLUME.schema}/${VOLUME.volume}`;
const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const file = (owner: string, n: number) =>
  `${ROOT}/${owner}/${1790000000000 + n}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.pdf`;

/** A volume of files, listed the way the Files API lists a directory. */
function fakeVolume(files: Record<string, unknown>) {
  const bytes = new Map(
    Object.entries(files).map(([path, value]) => [
      path,
      new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
    ]),
  );
  const writes: string[] = [];
  const storage: EirFileStorageClient = {
    async read(path) {
      const found = bytes.get(path);
      if (!found) throw new Error("Unity Catalog volume read failed (404).");
      return found;
    },
    async write(path, value) {
      writes.push(path);
      bytes.set(path, new Uint8Array(value));
    },
    async list(dir) {
      const children = new Set<string>();
      for (const path of bytes.keys()) {
        if (!path.startsWith(`${dir}/`)) continue;
        children.add(`${dir}/${path.slice(dir.length + 1).split("/")[0]}`);
      }
      return [...children];
    },
  };
  return { storage, bytes, writes };
}

/** #98's current shape: a valid EIR renewed alongside, sent back, answered, closed by revocation, then started again as a "renewal". */
const ADA_RECORD: EirRecord = {
  principalId: "1001",
  personName: "Test Person",
  stage: "submitted",
  formValues: { ...STUB, jobTitle: "Back" },
  submissions: [
    {
      volumePath: file("1001", 1),
      submittedAt: at(1),
      sha256: "a".repeat(64),
      sizeBytes: 10,
      formValues: STUB,
      kind: "first",
    },
    {
      volumePath: file("1001", 2),
      submittedAt: at(2),
      sha256: "b".repeat(64),
      sizeBytes: 11,
      formValues: STUB,
      kind: "resubmission",
    },
    {
      volumePath: file("1001", 3),
      submittedAt: at(5),
      sha256: "c".repeat(64),
      sizeBytes: 12,
      formValues: { ...STUB, jobTitle: "Lead" },
      kind: "renewal",
    },
    {
      volumePath: file("1001", 4),
      submittedAt: at(7),
      sha256: "d".repeat(64),
      sizeBytes: 13,
      formValues: { ...STUB, jobTitle: "Lead" },
      kind: "renewal",
    },
    {
      volumePath: file("1001", 5),
      submittedAt: at(9),
      sha256: "e".repeat(64),
      sizeBytes: 14,
      formValues: { ...STUB, jobTitle: "Back" },
      kind: "renewal",
    },
  ],
  actions: [
    { kind: "submitted", actorScimId: "1001", actorName: "Test Person", at: at(1) },
    {
      kind: "questions",
      actorScimId: "2001",
      actorName: "Val Idator",
      at: at(1, 15),
      note: "Why?",
    },
    {
      kind: "submitted",
      actorScimId: "1001",
      actorName: "Test Person",
      at: at(2),
      response: "Because",
    },
    { kind: "valid", actorScimId: "2002", actorName: "Vic Second", at: at(3) },
    {
      kind: "renewed",
      actorScimId: "1001",
      actorName: "Test Person",
      at: at(5),
      subject: "renewal",
    },
    {
      kind: "questions",
      actorScimId: "2001",
      actorName: "Val Idator",
      at: at(6),
      subject: "renewal",
      note: "Which team?",
    },
    {
      kind: "renewed",
      actorScimId: "1001",
      actorName: "Test Person",
      at: at(7),
      subject: "renewal",
      response: "Data",
    },
    {
      kind: "renewal-closed",
      actorScimId: "2001",
      actorName: "Val Idator",
      at: at(8),
      subject: "renewal",
      note: "Closed because the current EIR was revoked.",
    },
    { kind: "revoked", actorScimId: "2001", actorName: "Val Idator", at: at(8), note: "Left" },
    { kind: "renewed", actorScimId: "1001", actorName: "Test Person", at: at(9) },
  ],
};

/** The oldest shape: `_record.json`, no hash, size, kind, signed values or actor names. */
const LEGACY_RECORD: EirRecord = {
  principalId: "1002",
  personName: "Sample Applicant",
  stage: "valid",
  formValues: STUB,
  expiresAt: "2027-09-02T12:00:00.000Z",
  draftValues: { ...STUB, organization: "Example Agency" },
  submissions: [{ volumePath: file("1002", 1), submittedAt: at(1) }],
  actions: [
    { kind: "submitted", actorScimId: "1002", at: at(1) },
    { kind: "valid", actorScimId: "2001", at: at(2) },
  ],
};

/** A record whose stage its own history contradicts. */
const BROKEN_RECORD: EirRecord = {
  principalId: "1003",
  personName: "Broken",
  stage: "valid",
  submissions: [{ volumePath: file("1003", 1), submittedAt: at(1), kind: "first" }],
  actions: [{ kind: "submitted", actorScimId: "1003", actorName: "Broken", at: at(1) }],
};

const fixtures = () => ({
  [`${ROOT}/1001/record/v1.json`]: {
    ...ADA_RECORD,
    stage: "submitted",
    actions: ADA_RECORD.actions.slice(0, 1),
    submissions: ADA_RECORD.submissions.slice(0, 1),
  },
  [`${ROOT}/1001/record/v2.json`]: { ...ADA_RECORD, stage: "questions" },
  [`${ROOT}/1001/record/v10.json`]: ADA_RECORD,
  [`${ROOT}/1001/${file("1001", 1).split("/").at(-1)}`]: "%PDF-1.7 one",
  [`${ROOT}/1002/_record.json`]: LEGACY_RECORD,
  [`${ROOT}/.pr98-create-probe/7700000000000999`]: "probe",
});

function setup(extra: Record<string, unknown> = {}) {
  const impl = deltaImplementation();
  impl.clock.now = new Date("2026-10-06T12:00:00.000Z");
  const volume = fakeVolume({ ...fixtures(), ...extra });
  const migrate = (dryRun = false) =>
    migrateEirVolumeRecords({
      storage: volume.storage,
      volume: VOLUME,
      runner: impl.deps.runner,
      names: impl.deps.names,
      dryRun,
      now: () => impl.clock.now,
    });
  const snapshot = () =>
    ["eirs", "eir_submissions", "eir_actions", "eir_drafts", "eir_draft_saves"].map((table) =>
      impl.warehouse.query(`SELECT * FROM eir__${table} ORDER BY 1`),
    );
  return { impl, volume, migrate, snapshot };
}

describe("EIR volume migration", () => {
  it("reads each person's highest record version, else the legacy sidecar, and skips folders without one", async () => {
    const { volume } = setup();
    const records = await listVolumeRecords(volume.storage, VOLUME);
    expect(
      records.map((r) => [r.principalId, r.sourceVersion, r.path.split("/").slice(-2).join("/")]),
    ).toEqual([
      ["1001", 10, "record/v10.json"],
      ["1002", 0, "1002/_record.json"],
    ]);
  });

  it("imports every submission and action as system writes, then reads back as the same EIR", async () => {
    const { impl, migrate } = setup();
    const report = await migrate();
    expect(report.ok).toBe(true);
    expect(report.entries).toEqual([
      expect.objectContaining({
        principalId: "1001",
        outcome: "migrated",
        source: { submissions: 5, actions: 10 },
        tables: { submissions: 5, actions: 10 },
      }),
      expect.objectContaining({
        principalId: "1002",
        outcome: "migrated",
        source: { submissions: 1, actions: 2 },
        tables: { submissions: 1, actions: 2 },
      }),
    ]);

    const actions = impl.warehouse.query<Record<string, unknown>>(
      "SELECT action, from_stage, to_stage, record_version, actor_principal_id, actor_app, caused_by_action_id FROM eir__eir_actions WHERE eir_id = (SELECT id FROM eir__eirs WHERE person_principal_id = '1001') ORDER BY record_version",
    );
    expect(
      actions.map((a) => [
        a["action"],
        a["from_stage"],
        a["to_stage"],
        a["actor_principal_id"],
        a["actor_app"],
      ]),
    ).toEqual([
      ["submitted", "not-started", "submitted", "1001", "system"],
      ["sent-back", "submitted", "questions", "2001", "system"],
      ["resubmitted", "questions", "submitted", "1001", "system"],
      ["validated", "submitted", "valid", "2002", "system"],
      ["renewal-submitted", "valid", "valid", "1001", "system"],
      ["sent-back", "valid", "valid", "2001", "system"],
      ["renewal-submitted", "valid", "valid", "1001", "system"],
      ["renewal-closed", "valid", "valid", "2001", "system"],
      ["revoked", "valid", "revoked", "2001", "system"],
      // #98 called this a renewal; starting again after a revocation is a submission.
      ["submitted", "revoked", "submitted", "1001", "system"],
      ["migrated", null, null, "system", "system"],
    ]);
    const lead = impl.warehouse.query<{ action_id: string; note: string; command_hash: string }>(
      "SELECT action_id, note, command_hash FROM eir__eir_actions WHERE action = 'migrated' AND eir_id = (SELECT id FROM eir__eirs WHERE person_principal_id = '1001')",
    )[0]!;
    expect(lead.note).toContain("record/v10.json");
    expect(lead.command_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(actions.slice(0, -1).every((a) => a["caused_by_action_id"] === lead.action_id)).toBe(
      true,
    );
    expect(
      impl.warehouse.query(
        "SELECT kind, stage FROM eir__eir_submissions WHERE eir_id = (SELECT id FROM eir__eirs WHERE person_principal_id = '1001') ORDER BY submitted_at",
      ),
    ).toEqual([
      { kind: "first", stage: "questions" },
      { kind: "resubmission", stage: "valid" },
      { kind: "renewal", stage: "questions" },
      { kind: "renewal", stage: "closed" },
      { kind: "first", stage: "submitted" },
    ]);
    expect(
      impl.warehouse.query(
        "SELECT person_principal_id, version, stage, created_by_principal_id FROM eir__eirs ORDER BY 1",
      ),
    ).toEqual([
      {
        person_principal_id: "1001",
        version: 11,
        stage: "submitted",
        created_by_principal_id: "system",
      },
      {
        person_principal_id: "1002",
        version: 3,
        stage: "valid",
        created_by_principal_id: "system",
      },
    ]);

    // The app reads it back as the source said (apart from the relabelled restart).
    // #98's answers keep their own form version, 0.1; nothing is filled in for 1.2.
    expect(
      impl.warehouse.query(
        "SELECT DISTINCT form_version FROM eir__eir_submissions ORDER BY form_version",
      ),
    ).toEqual([{ form_version: "0.1" }]);
    expect(impl.warehouse.query("SELECT form_version FROM eir__eir_drafts")).toEqual([
      { form_version: "0.1" },
    ]);
    // Each migrated EIR gets a display code as its Record ID, not a counter number.
    expect(
      impl.warehouse.query(
        "SELECT person_principal_id, display_code, display_number FROM eir__eirs ORDER BY 1",
      ),
    ).toEqual([
      { person_principal_id: "1001", display_code: "EIR-00000A", display_number: null },
      { person_principal_id: "1002", display_code: "EIR-00000B", display_number: null },
    ]);
    const ada = await impl.as(APPLICANT).get(APPLICANT.principalId);
    expect(ada).toMatchObject({
      stage: "submitted",
      formValues: ADA_RECORD.formValues,
      version: 11,
    });
    expect(ada.submissions.map((s) => s.volumePath)).toEqual(
      ADA_RECORD.submissions.map((s) => s.volumePath),
    );
    expect(ada.actions.map((a) => a.kind)).toEqual([
      ...ADA_RECORD.actions.slice(0, -1).map((a) => a.kind),
      "submitted",
    ]);
    // The draft migrates too: the person sees it (a validator never does).
    const grace = await impl.as(OTHER_PERSON).get(OTHER_PERSON.principalId);
    expect(grace.submissions[0]?.volumePath).toBe(file("1002", 1));
    expect(comparable(grace)).toMatchObject({
      stage: "valid",
      expiresAt: LEGACY_RECORD.expiresAt,
      draftValues: LEGACY_RECORD.draftValues,
      submissions: [{ submittedAt: at(1), kind: "first" }],
    });
    expect(grace.submissions[0]).not.toHaveProperty("sha256");

    // And work carries on from there: a validator decides the migrated submission.
    const decided = await impl
      .as(VAL)
      .decide("1001", "valid", VAL.principalId, undefined, VAL.displayName);
    expect(decided).toMatchObject({ stage: "valid", version: 12 });
  });

  it("shows migrated checklist answers as legacy, and renews them on the fallback built-in form (bootstrap-2)", async () => {
    const { impl, migrate } = setup();
    await migrate();
    const legacy = await impl.as(OTHER_PERSON).get(OTHER_PERSON.principalId);
    expect(legacy).toMatchObject({ stage: "valid", formVersion: "0.1", recordId: "EIR-00000B" });
    expect(answerSections(legacy.formValues!, legacy.formVersion)).toMatchObject({
      legacy: true,
      sections: [{ title: "Legacy answers" }],
    });
    expect(legacy.formValues).not.toHaveProperty("workEmail");
    // Its own legacy answers can't be submitted again; the fallback built-in form's (bootstrap-2) can.
    await expect(
      impl.as(OTHER_PERSON).submitWithFile({
        principalId: OTHER_PERSON.principalId,
        personName: OTHER_PERSON.displayName,
        file: pdf(),
        values: legacy.formValues!,
      }),
    ).rejects.toThrow(
      /fullName isn't on the EIR form for bootstrap-2 \(version 0\)|doesn't match what this endpoint accepts/,
    );
    await impl.as(OTHER_PERSON).saveDraft(OTHER_PERSON.principalId, VALUES);
    await impl.as(OTHER_PERSON).evaluateDraft(OTHER_PERSON.principalId);
    const renewing = await impl.as(OTHER_PERSON).submitWithFile({
      principalId: OTHER_PERSON.principalId,
      personName: OTHER_PERSON.displayName,
      file: pdf(),
      values: VALUES,
    });
    expect(renewing).toMatchObject({
      formVersion: "0.1",
      renewal: { stage: "submitted", formVersion: "bootstrap-2" },
    });
    const approved = await impl
      .as(VAL)
      .decide(OTHER_PERSON.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    expect(approved).toMatchObject({ formVersion: "bootstrap-2", formValues: VALUES });
    expect(approved.submissions.map((s) => s.formVersion)).toEqual(["0.1", "bootstrap-2"]);
  });

  it("changes nothing when it runs again", async () => {
    const { migrate, snapshot } = setup();
    await migrate();
    const before = snapshot();
    const again = await migrate();
    expect(again.ok).toBe(true);
    expect(again.entries.map((e) => e.outcome)).toEqual(["already-migrated", "already-migrated"]);
    expect(snapshot()).toEqual(before);
  });

  it("never touches the volume: no file is written, moved or deleted", async () => {
    const { volume, migrate } = setup();
    const files = [...volume.bytes.keys()].sort();
    await migrate();
    await migrate();
    expect(volume.writes).toEqual([]);
    expect([...volume.bytes.keys()].sort()).toEqual(files);
  });

  it("reports a record that changed after it was migrated, and rewrites nothing", async () => {
    const { volume, migrate, snapshot } = setup();
    await migrate();
    const before = snapshot();
    volume.bytes.set(
      `${ROOT}/1002/record/v1.json`,
      new TextEncoder().encode(
        JSON.stringify({ ...LEGACY_RECORD, personName: "Sample B. Applicant" }),
      ),
    );
    const report = await migrate();
    expect(report.ok).toBe(false);
    expect(report.entries.find((e) => e.principalId === "1002")?.outcome).toBe("source-changed");
    expect(snapshot()).toEqual(before);
  });

  it("refuses a record its own history contradicts, writing nothing for that person", async () => {
    const { impl, migrate } = setup({ [`${ROOT}/1003/record/v1.json`]: BROKEN_RECORD });
    const report = await migrate();
    expect(report.ok).toBe(false);
    const broken = report.entries.find((e) => e.principalId === "1003");
    expect(broken).toMatchObject({ outcome: "mismatch", detail: expect.stringContaining("stage") });
    expect(
      impl.warehouse.query(
        "SELECT count(*) AS n FROM eir__eirs WHERE person_principal_id = '1003'",
      ),
    ).toEqual([{ n: 0 }]);
    expect(describeReport(report)).toContain("FAILED");
  });

  it("leaves someone who already has an EIR on Delta alone", async () => {
    const { impl, migrate } = setup();
    await impl.as(APPLICANT).saveDraft(APPLICANT.principalId, VALUES);
    await impl.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    await impl.as(APPLICANT).submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: VALUES,
    });
    const report = await migrate();
    expect(report.ok).toBe(true);
    expect(report.entries.find((e) => e.principalId === "1001")?.outcome).toBe("already-on-delta");
    expect((await impl.as(APPLICANT).get(APPLICANT.principalId)).submissions).toHaveLength(1);
  });

  it("checks without writing on a dry run", async () => {
    const { impl, migrate } = setup();
    const report = await migrate(true);
    expect(report.entries.map((e) => e.outcome)).toEqual(["would-migrate", "would-migrate"]);
    expect(impl.warehouse.statements.filter((s) => s.startsWith("BEGIN ATOMIC"))).toEqual([]);
  });
});
