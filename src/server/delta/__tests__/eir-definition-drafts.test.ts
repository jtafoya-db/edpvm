// @vitest-environment node
/**
 * EIR drafts and submissions under published definitions (#201), on the EIR
 * repository contract: the in-memory repository and the Delta one, each
 * with its definitions in the same store.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { APPLICANT, OTHER_PERSON, pdf, VAL, VALUES } from "./eir-harness.ts";
import {
  BOOTSTRAP_YAML,
  deltaEirWithDefinitions,
  EMPLOYEE,
  memoryEirWithDefinitions,
  nextDefinitionYaml,
  SAFEGUARDS,
  sameQuestionsYaml,
  type EirWithDefinitions,
} from "./eir-definition-harness.ts";
import type { SessionUser } from "../registry.ts";

function steps({ eir }: EirWithDefinitions) {
  return {
    draft: (user: SessionUser, formVersion: string) =>
      eir.as(user).saveDraft(user.principalId, VALUES, undefined, formVersion),
    /** Upload the signed PDF of the draft as saved, after its pre-check (#203). */
    submit: async (user: SessionUser, formVersion: string, response?: string) => {
      await eir.as(user).evaluateDraft(user.principalId);
      return eir.as(user).submitWithFile({
        principalId: user.principalId,
        personName: user.displayName,
        file: pdf(),
        values: VALUES,
        formVersion,
        ...(response ? { response } : {}),
      });
    },
  };
}

async function activateNext(impl: EirWithDefinitions) {
  const safeguards = impl.definitions(SAFEGUARDS);
  await safeguards.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
  await safeguards.activate({ versionNumber: 1, expectedVersion: 1 });
}

describe.each([
  ["memory", memoryEirWithDefinitions],
  ["delta", deltaEirWithDefinitions],
] as const)("EIR drafts under published definitions: %s", (_name, make) => {
  it("new drafts use the active definition; existing drafts keep their starting version", async () => {
    const impl = make();
    const { draft, submit } = steps(impl);
    // Begun on the fallback built-in, bootstrap-2 (#217), under its reserved identity.
    expect((await draft(APPLICANT, "bootstrap-2")).draftFormVersion).toBe("bootstrap-2");

    await activateNext(impl);

    // The existing draft stays on bootstrap-2; a screen that showed version 1 is refused.
    expect((await draft(APPLICANT, "bootstrap-2")).draftFormVersion).toBe("bootstrap-2");
    await expect(draft(APPLICANT, "1")).rejects.toMatchObject({ status: 400 });
    // A new draft starts on the active definition, version 1.
    await expect(draft(OTHER_PERSON, "bootstrap-2")).rejects.toMatchObject({ status: 400 });
    expect((await draft(OTHER_PERSON, "1")).draftFormVersion).toBe("1");

    // Each submission records the version its draft began under.
    const applicant = await submit(APPLICANT, "bootstrap-2");
    expect(applicant).toMatchObject({ formVersion: "bootstrap-2", stage: "submitted" });
    expect(applicant.submissions.at(-1)?.formVersion).toBe("bootstrap-2");
    const other = await submit(OTHER_PERSON, "1");
    expect(other.submissions.at(-1)?.formVersion).toBe("1");

    // A submission still stands on its own definition: sent back, it can be answered.
    await impl.eir
      .as(VAL)
      .decide(APPLICANT.principalId, "questions", VAL.principalId, "Clarify", VAL.displayName);
    const answered = await impl.eir.as(APPLICANT).respond({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      values: VALUES,
      response: "Clarified",
    });
    expect(answered).toMatchObject({ stage: "submitted", formVersion: "bootstrap-2" });

    // After its submission, the person's next draft starts on the active form.
    await impl.eir
      .as(VAL)
      .decide(APPLICANT.principalId, "valid", VAL.principalId, undefined, VAL.displayName);
    expect((await draft(APPLICANT, "1")).draftFormVersion).toBe("1");
  });
});

describe.each([
  ["memory", memoryEirWithDefinitions],
  ["delta", deltaEirWithDefinitions],
] as const)("the store's typed EIR definitions: %s", (_name, make) => {
  it("resolves the active published definition, and a pinned draft's own after another activation and a rollback", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    // Nothing active: the fallback built-in definition (bootstrap-2, #217), whole, under its reserved identity.
    let resolved = await impl.resolve({});
    expect(resolved.active()).toMatchObject({
      form: { version: "bootstrap-2" },
      validityDays: 365,
    });
    expect(resolved.activeRef()).toEqual({ source: "bootstrap", id: "bootstrap-2" });

    await safeguards.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 2 });
    const pinned = await impl.eir
      .as(APPLICANT)
      .saveDraft(APPLICANT.principalId, VALUES, undefined, "1");
    expect(pinned.draftFormVersion).toBe("1");

    await safeguards.activate({ versionNumber: 2, expectedVersion: 3 });
    resolved = await impl.resolve({ ids: [pinned.draftFormVersion!] });
    const active = resolved.active()!;
    expect(active.form.version).toBe("2");
    expect(active.form.sections[0]!.title).toBe("User details (v3)");
    expect(active.rules.map((r) => r.reasonCode)).toContain("EIR-NDA-NOT-SIGNED");
    expect(active.scenarios.map((s) => s.id)).toEqual([
      "pass",
      "blocking-user-id",
      "warning-mbi-dates",
      "manual-review-nda",
    ]);
    expect(resolved.activeRef()).toEqual({ source: "published", versionNumber: 2 });
    // The draft is evaluated against the definition it was pinned to.
    expect(resolved.byId("1")?.form.version).toBe("1");
    expect(resolved.byId("1")?.form.sections[0]!.title).toBe("User details (v2)");
    // The bootstrap's reserved identity, and its form version from before #224.
    expect(resolved.byId("bootstrap")?.form.version).toBe("bootstrap");
    expect(resolved.byId("1.3")?.form.version).toBe("1.3");
    expect(resolved.byId("1.3")?.form.sections[0]!.title).toBe("User details");
    // The fallback built-in (#217) too. The two built-ins keep their own rules:
    // a draft pinned to bootstrap (or 1.3) isn't moved onto bootstrap-2's.
    expect(resolved.byId("bootstrap-2")?.form.version).toBe("bootstrap-2");
    const nda = (id: string) =>
      resolved.byId(id)?.rules.find((rule) => rule.id === "nda-signed")?.disposition;
    expect([nda("bootstrap"), nda("1.3"), nda("bootstrap-2")]).toEqual([
      "manual-review",
      "manual-review",
      "blocking",
    ]);
    expect(resolved.byId("9")).toBeUndefined();
    expect(resolved.byId("1.4")).toBeUndefined();
    expect(resolved.byId("0")).toBeUndefined();

    // Roll back to version 1: active again; version 2 is still found by its number.
    await safeguards.activate({ versionNumber: 1, expectedVersion: 4 });
    resolved = await impl.resolve({ ids: ["2"] });
    expect(resolved.active()?.form.version).toBe("1");
    expect(resolved.byId("2")?.form.sections[0]!.title).toBe("User details (v3)");
  });
});

const THIRD_PERSON: SessionUser = {
  ...OTHER_PERSON,
  principalId: "1003",
  displayName: "Third Person",
  email: "third.person@example.gov",
};

/** The text a generated PDF carries (it is uncompressed). */
const pdfText = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

describe.each([
  ["memory", memoryEirWithDefinitions],
  ["delta", deltaEirWithDefinitions],
] as const)("EIR pre-check under published definitions: %s", (_name, make) => {
  /** Save `user`'s draft on the form they're shown, then pre-check it. */
  const evaluate = async (impl: EirWithDefinitions, user: SessionUser, formVersion: string) => {
    const eir = impl.eir.as(user);
    await eir.saveDraft(user.principalId, VALUES, undefined, formVersion);
    return eir.evaluateDraft(user.principalId);
  };

  it("a draft started on v1 is still evaluated with v1 after v2 is activated", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 2 });
    expect(await evaluate(impl, APPLICANT, "1")).toMatchObject({
      definitionVersion: "1",
      formVersion: "1",
    });

    await safeguards.activate({ versionNumber: 2, expectedVersion: 3 });

    // Re-evaluated after version 2 is active: still its own version 1.
    const again = impl.eir.as(APPLICANT);
    await again.saveDraft(APPLICANT.principalId, VALUES, undefined, "1");
    expect(await again.evaluateDraft(APPLICANT.principalId)).toMatchObject({
      definitionVersion: "1",
      formVersion: "1",
    });
    // Its PDF is built on that form and names that definition.
    const text = pdfText(await again.generatePdf(APPLICANT.principalId));
    // One version line, the definition's number (#224).
    expect(text.match(/\(EIR definition: [^)]*\)/g)).toEqual(["(EIR definition: version 1)"]);
    expect(text).not.toContain("Form version");
    expect(text).toContain("User details \\(v2\\)");
  });

  it("a new draft after v2 activates uses v2", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    // Before any publish, the fallback built-in (bootstrap-2): a draft begun on it keeps it.
    expect(await evaluate(impl, APPLICANT, "bootstrap-2")).toMatchObject({
      definitionVersion: "bootstrap-2",
      formVersion: "bootstrap-2",
    });
    await activateNext(impl);

    expect(await evaluate(impl, OTHER_PERSON, "1")).toMatchObject({
      definitionVersion: "1",
      formVersion: "1",
    });
    expect(
      pdfText(await impl.eir.as(OTHER_PERSON).generatePdf(OTHER_PERSON.principalId)),
    ).toContain("(EIR definition: version 1)");
    expect(await impl.eir.as(APPLICANT).evaluateDraft(APPLICANT.principalId)).toMatchObject({
      definitionVersion: "bootstrap-2",
      formVersion: "bootstrap-2",
    });
  });

  it("after a rollback, new drafts use the rolled-back version", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(3), expectedVersion: 1 });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 2 });
    await safeguards.activate({ versionNumber: 2, expectedVersion: 3 });
    expect(await evaluate(impl, APPLICANT, "2")).toMatchObject({
      definitionVersion: "2",
    });

    // Roll back to version 1.
    await safeguards.activate({ versionNumber: 1, expectedVersion: 4 });

    await expect(
      impl.eir.as(OTHER_PERSON).saveDraft(OTHER_PERSON.principalId, VALUES, undefined, "2"),
    ).rejects.toMatchObject({ status: 400 });
    expect(await evaluate(impl, OTHER_PERSON, "1")).toMatchObject({
      definitionVersion: "1",
      formVersion: "1",
    });
    expect(await evaluate(impl, THIRD_PERSON, "1")).toMatchObject({
      definitionVersion: "1",
    });
    // The draft begun on the rolled-away version keeps it.
    expect(await impl.eir.as(APPLICANT).evaluateDraft(APPLICANT.principalId)).toMatchObject({
      definitionVersion: "2",
      formVersion: "2",
    });
  });

  it("the same questions published twice: a draft started before the second keeps version 1's rules (#224)", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    // Version 1: a preliminary background investigation is manual review, as in the bootstrap.
    await safeguards.publish({
      sourceYaml: sameQuestionsYaml("irm-acknowledged"),
      expectedVersion: 0,
    });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 1 });
    const preliminary = { ...VALUES, mbiPreliminary: "yes" };
    const save = (user: SessionUser, id: string) =>
      impl.eir.as(user).saveDraft(user.principalId, preliminary, undefined, id);
    expect((await save(APPLICANT, "1")).draftFormVersion).toBe("1");

    // Version 2: the same questions, word for word; that answer is only a warning now.
    await safeguards.publish({
      sourceYaml: sameQuestionsYaml("irm-acknowledged", "mbi-investigation-complete"),
      expectedVersion: 2,
    });
    await safeguards.activate({ versionNumber: 2, expectedVersion: 3 });
    // The screen showing version 2 to the applicant is refused: their draft is pinned to 1.
    await expect(save(APPLICANT, "2")).rejects.toMatchObject({ status: 400 });
    const pinned = await impl.eir.as(APPLICANT).evaluateDraft(APPLICANT.principalId);
    expect(pinned).toMatchObject({
      definitionVersion: "1",
      formVersion: "1",
      outcome: "manual-review",
    });
    // A draft started now is on version 2's rules.
    expect((await save(OTHER_PERSON, "2")).draftFormVersion).toBe("2");
    expect(await impl.eir.as(OTHER_PERSON).evaluateDraft(OTHER_PERSON.principalId)).toMatchObject({
      definitionVersion: "2",
      outcome: "warning",
    });

    // Rollback, and a later publish, change neither pinned draft.
    await safeguards.activate({ versionNumber: 1, expectedVersion: 4 });
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(5), expectedVersion: 5 });
    await safeguards.activate({ versionNumber: 3, expectedVersion: 6 });
    expect((await save(APPLICANT, "1")).draftFormVersion).toBe("1");
    expect((await save(OTHER_PERSON, "2")).draftFormVersion).toBe("2");
    expect(await impl.eir.as(APPLICANT).evaluateDraft(APPLICANT.principalId)).toMatchObject({
      definitionVersion: "1",
      outcome: "manual-review",
    });
    expect(await impl.eir.as(OTHER_PERSON).evaluateDraft(OTHER_PERSON.principalId)).toMatchObject({
      definitionVersion: "2",
      outcome: "warning",
    });

    // The PDF and the upload resolve it by that number too.
    const text = pdfText(await impl.eir.as(APPLICANT).generatePdf(APPLICANT.principalId));
    expect(text.match(/\(EIR definition: [^)]*\)/g)).toEqual(["(EIR definition: version 1)"]);
    const submitted = await impl.eir.as(APPLICANT).submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: preliminary,
      formVersion: "1",
    });
    expect(submitted).toMatchObject({ stage: "submitted", formVersion: "1" });
    expect(submitted.submissions.at(-1)?.formVersion).toBe("1");
  });

  it("the PDF carries both the record's display code (#177) and one definition version line (#224)", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    await safeguards.publish({ sourceYaml: nextDefinitionYaml(2), expectedVersion: 0 });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 1 });
    const eir = impl.eir.as(APPLICANT);
    const started = await eir.start(APPLICANT.principalId, APPLICANT.displayName);
    expect(started.recordId).toMatch(/^EIR-[0-9A-HJKMNP-TV-Z]{6}$/);
    await eir.saveDraft(APPLICANT.principalId, VALUES, undefined, "1");
    await eir.evaluateDraft(APPLICANT.principalId);
    const text = pdfText(await eir.generatePdf(APPLICANT.principalId));
    expect(text).toContain(`(Record ID: ${started.recordId})`);
    expect(text.match(/\(EIR definition: [^)]*\)/g)).toEqual(["(EIR definition: version 1)"]);
    expect(text).not.toMatch(/Form version|Definition version/);
  });

  it("uploads a draft on a published form with a field the bootstrap form doesn't have", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    const yaml = nextDefinitionYaml(2)
      .replace(
        "        - id: contractingCompany\n",
        "        - id: costCenter\n          label: Cost center\n          type: text\n          required: false\n        - id: contractingCompany\n",
      )
      .replace(
        "            - [team, subTeam]\n",
        "            - [team, subTeam]\n            - [costCenter]\n",
      );
    await safeguards.publish({ sourceYaml: yaml, expectedVersion: 0 });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 1 });

    const values = { ...VALUES, costCenter: "CC-0001" };
    const eir = impl.eir.as(APPLICANT);
    await eir.saveDraft(APPLICANT.principalId, values, undefined, "1");
    await eir.evaluateDraft(APPLICANT.principalId);
    const submitted = await eir.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values,
      formVersion: "1",
    });
    expect(submitted).toMatchObject({ stage: "submitted", formVersion: "1" });
  });

  it("preview, activation and the employee pre-check run one rule engine", async () => {
    const impl = make();
    const safeguards = impl.definitions(SAFEGUARDS);
    // The blocking scenario also leaves Team blank: required, with no rule of its own,
    // so only the shared engine (#203) gives it a reason code.
    const yaml = nextDefinitionYaml(2).replace(
      "      userId: not an id!\n",
      '      userId: not an id!\n      team: ""\n',
    );
    const preview = await safeguards.check(yaml);
    if (!preview.ok) throw new Error("The synthetic definition must load.");
    expect(preview.publishable).toBe(true);
    const blocking = preview.scenarios.find((scenario) => scenario.id === "blocking-user-id");
    expect(blocking).toMatchObject({ expected: "blocking", actual: "blocking", ok: true });
    expect(blocking?.reasons.map((r) => [r.field, r.disposition, r.reasonCode])).toEqual([
      ["userId", "blocking", "EIR-USER-ID-FORMAT"],
      ["team", "blocking", "EIR-FORM-TEAM-INVALID"],
    ]);

    // Activation re-runs the same scenarios, and they still hold.
    await safeguards.publish({ sourceYaml: yaml, expectedVersion: 0 });
    await safeguards.activate({ versionNumber: 1, expectedVersion: 1 });

    // The employee's draft with the same answers gets the same reasons.
    const eir = impl.eir.as(APPLICANT);
    await eir.saveDraft(
      APPLICANT.principalId,
      { ...VALUES, userId: "not an id!", team: "" },
      undefined,
      "1",
    );
    const evaluation = await eir.evaluateDraft(APPLICANT.principalId);
    expect(evaluation).toMatchObject({ outcome: "blocking", definitionVersion: "1" });
    expect(evaluation.outcomes.map((o) => [o.field, o.disposition, o.reasonCode])).toEqual([
      ["userId", "blocking", "EIR-USER-ID-FORMAT"],
      ["team", "blocking", "EIR-FORM-TEAM-INVALID"],
    ]);
  });
});

describe("EIR definitions fail closed (Delta)", () => {
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const command = (name: string, payload: unknown, expectedVersion = 0) =>
    new Request(`https://app/api/commands/eir/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: globalThis.crypto.randomUUID(),
        expectedVersion,
        payload,
      }),
    });
  const myForm = (impl: ReturnType<typeof deltaEirWithDefinitions>, user = EMPLOYEE) =>
    impl.eir.request(user, new Request("https://app/api/reads/eir-definitions/forms"));

  /** Version 2 as a direct writer left it, made active behind the app's back. */
  async function activeVersionTwo(sourceYaml: string, contentSha256 = sha256(sourceYaml)) {
    const impl = deltaEirWithDefinitions();
    await activateNext(impl);
    impl.eir.warehouse.query(
      `INSERT INTO "eir__eir_definition_versions" (id, version_number, definition_version, form_version, source_yaml, normalized_definition, content_sha256, published_action_id, published_at, published_by_principal_id, published_by_display, published_by_app, created_at) VALUES ('5a0c9b1e-0000-4000-8000-000000000002', 2, '2', '2', :yaml, '{}', :sha, 'none', '2026-10-01T12:00:00.000Z', '4001', 'Sara Safeguards', 'staff', '2026-10-01T12:00:00.000Z')`,
      { yaml: sourceYaml, sha: contentSha256 },
    );
    impl.eir.warehouse.query(
      `UPDATE "eir__eir_definition_register" SET active_version_number = 2, latest_version_number = 2`,
    );
    return impl;
  }

  it("with no published definition the bootstrap is active", async () => {
    const impl = deltaEirWithDefinitions();
    const response = await myForm(impl);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { active: { version: string } }).active.version).toBe(
      "bootstrap-2",
    );
    expect(
      (
        await impl.eir
          .as(EMPLOYEE)
          .saveDraft(EMPLOYEE.principalId, VALUES, undefined, "bootstrap-2")
      ).draftFormVersion,
    ).toBe("bootstrap-2");
  });

  it.each([
    [
      "no longer loads",
      () =>
        activeVersionTwo(
          BOOTSTRAP_YAML.replace("validityDays: 365", "validityDays: 365\ncolour: blue"),
        ),
    ],
    ["no longer matches its content hash", () => activeVersionTwo(BOOTSTRAP_YAML, "0".repeat(64))],
  ])("an active definition that %s fails closed, never falling back", async (_label, setup) => {
    const impl = await setup();
    const unavailable = { error: { code: "eir-unavailable" } };
    const read = await myForm(impl);
    expect(read.status).toBe(503);
    expect(await read.json()).toMatchObject(unavailable);
    for (const request of [
      command("start", {}),
      command("save-draft", { formVersion: "bootstrap-2", values: VALUES }),
      command("save-draft", { formVersion: "1", values: VALUES }),
    ]) {
      const response = await impl.eir.request(EMPLOYEE, request);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject(unavailable);
    }
    expect(impl.eir.warehouse.query(`SELECT count(*) AS n FROM "eir__eir_drafts"`)).toEqual([
      { n: 0 },
    ]);
    expect(impl.eir.warehouse.query(`SELECT count(*) AS n FROM "eir__eirs"`)).toEqual([{ n: 0 }]);
    // Staff still see what's recorded, and that version 2 can't be opened.
    const history = await impl.definitions(SAFEGUARDS).history();
    expect(history.active).toMatchObject({ source: "published", versionNumber: 2 });
    await expect(impl.definitions(SAFEGUARDS).get(2)).rejects.toMatchObject({ status: 503 });
    // Rollback to a version that loads is the recovery.
    await impl.definitions(SAFEGUARDS).activate({ versionNumber: 1, expectedVersion: 2 });
    expect((await myForm(impl)).status).toBe(200);
  });

  it("refuses employee commands when the definitions can't be read", async () => {
    const impl = deltaEirWithDefinitions();
    impl.eir.warehouse.query(`DROP TABLE "eir__eir_definition_register"`);
    const response = await impl.eir.request(
      EMPLOYEE,
      command("save-draft", { formVersion: "bootstrap-2", values: VALUES }),
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await myForm(impl)).status).toBeGreaterThanOrEqual(500);
    expect(impl.eir.warehouse.query(`SELECT count(*) AS n FROM "eir__eir_drafts"`)).toEqual([
      { n: 0 },
    ]);
  });
});
