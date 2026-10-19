import { describe, expect, it, vi } from "vitest";
import { createMemoryEirRepository } from "../eir/repository";
import { EIR_VALUES } from "./eir-fixtures";

const values = EIR_VALUES;

describe("EIR repository seam", () => {
  it("submits a browser file through injected file storage", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const repo = createMemoryEirRepository({
      fileStorage: { write },
      filePath: () => "/Volumes/local/mock/eir/scim-1/one.pdf",
    });
    const file = new File(["%PDF-memory"], "signed.pdf", { type: "application/pdf" });
    await repo.saveDraft("scim-1", values);
    await repo.evaluateDraft("scim-1");

    const record = await repo.submitWithFile({
      principalId: "scim-1",
      personName: "Test",
      file,
      values,
    });

    expect(record.stage).toBe("submitted");
    expect(write).toHaveBeenCalledWith(
      "/Volumes/local/mock/eir/scim-1/one.pdf",
      expect.any(Uint8Array),
      { overwrite: false },
    );
  });

  it("keeps exactly one EIR per SCIM id and preserves every PDF submission", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now });
    expect((await repo.get("scim-1")).stage).toBe("not-started");
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/first.pdf", values);
    await repo.decide("scim-1", "questions", "validator-1", "Answer this");
    now = new Date("2026-10-02T12:00:00Z");
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/second.pdf", values, "Answers");
    const eir = await repo.get("scim-1");
    expect(eir.submissions.map((item) => item.volumePath)).toEqual([
      "/Volumes/c/s/v/scim-1/first.pdf",
      "/Volumes/c/s/v/scim-1/second.pdf",
    ]);
  });

  it("shows submitted EIRs with SLA and records validator decisions, expiry, renewal and revocation", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({
      clock: () => now,
      validityDays: 2,
      reviewSlaBusinessDays: 3,
    });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    expect((await repo.listValidatorInbox())[0]?.sla).toMatchObject({
      stage: "eir-validation",
      state: "on-track",
    });
    await repo.decide("scim-1", "questions", "validator-7", "Clarify organization");
    await repo.submit(
      "scim-1",
      "Test",
      "/Volumes/c/s/v/scim-1/two.pdf",
      values,
      "Research division",
    );
    const valid = await repo.decide("scim-1", "valid", "validator-7");
    expect(valid.expiresAt).toBe("2026-10-03T12:00:00.000Z");
    await repo.decide("scim-1", "revoked", "validator-7", "Access review");
    const revoked = await repo.get("scim-1");
    expect(revoked.actions.at(-1)).toMatchObject({
      kind: "revoked",
      actorScimId: "validator-7",
      at: "2026-10-01T12:00:00.000Z",
    });
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/three.pdf");
    expect((await repo.get("scim-1")).stage).toBe("submitted");
    now = new Date("2026-10-04T12:00:00Z");
    await repo.decide("scim-1", "valid", "validator-7");
    now = new Date("2026-10-07T12:00:00Z");
    expect((await repo.get("scim-1")).stage).toBe("expired");
  });

  it("computes EIR validation SLA with deploy-time target, due-soon threshold and holidays", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({
      clock: () => now,
      reviewSlaBusinessDays: 2,
      dueSoonThresholdBusinessDays: 0,
      holidays: ["2026-10-02"],
    });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);

    expect((await repo.listValidatorInbox())[0]?.sla).toMatchObject({
      target: 2,
      dueAt: "2026-10-06T12:00:00.000Z",
      state: "on-track",
    });

    now = new Date("2026-10-06T12:00:01Z");
    expect((await repo.listValidatorInbox())[0]?.sla).toMatchObject({ state: "breached" });
  });

  it("keeps a stored EIR SLA due date when the deployed target changes", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const original = createMemoryEirRepository({
      clock: () => now,
      reviewSlaBusinessDays: 2,
      holidays: ["2026-10-02"],
    });
    const submitted = await original.submit(
      "scim-1",
      "Test",
      "/Volumes/c/s/v/scim-1/one.pdf",
      values,
    );
    expect(submitted.sla?.dueAt).toBe("2026-10-06T12:00:00.000Z");

    const afterRedeploy = createMemoryEirRepository({
      clock: () => now,
      reviewSlaBusinessDays: 7,
      initialRecords: [submitted],
    });

    expect((await afterRedeploy.get("scim-1")).sla?.dueAt).toBe("2026-10-06T12:00:00.000Z");
    expect((await afterRedeploy.listValidatorInbox())[0]?.sla.dueAt).toBe(
      "2026-10-06T12:00:00.000Z",
    );
  });

  it("rejects non-PDF submission paths", async () => {
    const repo = createMemoryEirRepository();
    await expect(repo.submit("scim-1", "Test", "/tmp/eir.txt", values)).rejects.toThrow("Only PDF");
  });

  it("starts again with a submission, not a renewal, after a rejection (decision 2026-10-05)", async () => {
    const repo = createMemoryEirRepository();
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "rejected", "validator-1", "Not valid");
    const again = await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");
    expect(again).toMatchObject({ stage: "submitted" });
    expect(again.submissions.at(-1)?.kind).toBe("first");
    expect(again.actions.at(-1)?.kind).toBe("submitted");
  });

  it("renews a valid EIR rather than submitting it again", async () => {
    const repo = createMemoryEirRepository();
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "valid", "validator-1");
    await expect(
      repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/two.pdf", values),
    ).rejects.toThrow("Renew a valid or expired EIR");
  });

  it("writes the signed PDF before it records the submission (#104)", async () => {
    const write = vi.fn().mockRejectedValue(new Error("volume unavailable"));
    const repo = createMemoryEirRepository({
      fileStorage: { write },
      filePath: () => "/Volumes/local/mock/eir/scim-1/one.pdf",
    });
    const file = new File(["%PDF-memory"], "signed.pdf", { type: "application/pdf" });
    await repo.saveDraft("scim-1", values);
    await repo.evaluateDraft("scim-1");

    await expect(
      repo.submitWithFile({ principalId: "scim-1", personName: "Test", file, values }),
    ).rejects.toThrow("volume unavailable");

    expect(write).toHaveBeenCalledTimes(1);
    expect(await repo.get("scim-1")).toMatchObject({ stage: "not-started", submissions: [] });
  });

  it("never records the same PDF path as two submissions", async () => {
    const repo = createMemoryEirRepository();
    const path = "/Volumes/c/s/v/scim-1/one.pdf";
    await repo.submit("scim-1", "Test", path, values);
    await repo.decide("scim-1", "questions", "validator-1", "Answer this");
    await expect(repo.submit("scim-1", "Test", path, values)).rejects.toThrow("already");
  });

  it("omits unavailable integrity and actor-name fields instead of storing placeholders", async () => {
    const repo = createMemoryEirRepository();
    const submitted = await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    expect(submitted.submissions[0]).not.toHaveProperty("sha256");
    expect(submitted.submissions[0]).not.toHaveProperty("sizeBytes");

    const decided = await repo.decide("scim-1", "valid", "validator-1");
    expect(decided.actions.at(-1)).not.toHaveProperty("actorName");
  });

  it("requires and audits an answer when a person resubmits after questions", async () => {
    const repo = createMemoryEirRepository();
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "questions", "validator-1", "Clarify the business need");

    await expect(
      repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/two.pdf", values),
    ).rejects.toThrow("answer");

    const resubmitted = await repo.submit(
      "scim-1",
      "Test",
      "/Volumes/c/s/v/scim-1/two.pdf",
      values,
      "Quarterly compliance review",
    );
    expect(resubmitted.actions.slice(-2)).toEqual([
      expect.objectContaining({
        kind: "questions",
        note: "Clarify the business need",
      }),
      expect.objectContaining({
        kind: "submitted",
        response: "Quarterly compliance review",
      }),
    ]);
    expect(resubmitted.submissions.at(-1)).toMatchObject({
      kind: "resubmission",
      formValues: values,
    });
  });

  it.each(["questions", "rejected"] as const)(
    "requires a validator note for a %s decision",
    async (decision) => {
      const repo = createMemoryEirRepository();
      await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);

      await expect(repo.decide("scim-1", decision, "validator-1", "  ")).rejects.toThrow("note");
    },
  );

  it("keeps the current validity and expiry while a renewal is pending", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now, validityDays: 30 });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    const valid = await repo.decide("scim-1", "valid", "validator-1");

    const renewing = await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");

    expect(renewing).toMatchObject({
      stage: "valid",
      expiresAt: valid.expiresAt,
      renewal: { stage: "submitted", volumePath: "/Volumes/c/s/v/scim-1/two.pdf" },
    });
    expect(renewing.submissions.at(-1)).toMatchObject({
      kind: "renewal",
      formValues: values,
    });
  });

  it("replaces the expiry when a pending renewal is approved", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now, validityDays: 30 });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    const first = await repo.decide("scim-1", "valid", "validator-1");
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");
    now = new Date("2026-10-11T12:00:00Z");

    const renewed = await repo.decide("scim-1", "valid", "validator-1");

    expect(renewed.expiresAt).toBe("2026-11-10T12:00:00.000Z");
    expect(renewed.expiresAt).not.toBe(first.expiresAt);
    expect(renewed.renewal).toBeUndefined();
  });

  it("keeps the old validity and expiry when a pending renewal is rejected", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now, validityDays: 30 });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    const first = await repo.decide("scim-1", "valid", "validator-1");
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");

    const rejected = await repo.decide(
      "scim-1",
      "rejected",
      "validator-1",
      "Renewal signature is incomplete",
    );

    expect(rejected).toMatchObject({
      stage: "valid",
      expiresAt: first.expiresAt,
      renewal: { stage: "rejected", note: "Renewal signature is incomplete" },
    });
  });

  it("expires current validity while leaving a pending renewal submitted", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now, validityDays: 2 });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "valid", "validator-1");
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");
    now = new Date("2026-10-04T12:00:00Z");

    expect(await repo.get("scim-1")).toMatchObject({
      stage: "expired",
      renewal: { stage: "submitted", volumePath: "/Volumes/c/s/v/scim-1/two.pdf" },
    });
  });

  it("closes a pending renewal when current validity is revoked", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now, validityDays: 30 });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "valid", "validator-1");
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");

    const revoked = await repo.decide("scim-1", "revoked", "validator-1", "Access review");

    expect(revoked).toMatchObject({ stage: "revoked" });
    expect(revoked.expiresAt).toBeUndefined();
    expect(revoked.renewal).toBeUndefined();
    expect(revoked.actions.slice(-2)).toEqual([
      expect.objectContaining({ kind: "renewal-closed", actorScimId: "system" }),
      expect.objectContaining({ kind: "revoked", actorScimId: "validator-1" }),
    ]);
    expect(await repo.listValidatorInbox()).toEqual([]);
    await expect(repo.decide("scim-1", "valid", "validator-1")).rejects.toThrow(
      "Only submitted EIRs",
    );
    const freshStart = await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/three.pdf");
    expect(freshStart.stage).toBe("submitted");
    expect(freshStart.renewal).toBeUndefined();
    expect(freshStart.submissions.at(-1)?.kind).toBe("first");
  });

  it("keeps the current expiry when a pending renewal is sent back", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const repo = createMemoryEirRepository({ clock: () => now, validityDays: 30 });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    const valid = await repo.decide("scim-1", "valid", "validator-1");
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");

    const returned = await repo.decide(
      "scim-1",
      "questions",
      "validator-1",
      "Clarify the signature",
    );

    expect(returned).toMatchObject({
      stage: "valid",
      expiresAt: valid.expiresAt,
      renewal: { stage: "questions", questions: "Clarify the signature" },
    });
  });

  it("audits closing a renewal at send-back when current validity is revoked", async () => {
    const repo = createMemoryEirRepository({
      clock: () => new Date("2026-10-01T12:00:00Z"),
      validityDays: 30,
    });
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "valid", "validator-1");
    await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");
    await repo.decide("scim-1", "questions", "validator-1", "Clarify the signature");

    const revoked = await repo.decide("scim-1", "revoked", "validator-1");

    expect(revoked.renewal).toBeUndefined();
    expect(revoked.actions.slice(-2)).toEqual([
      expect.objectContaining({
        kind: "renewal-closed",
        actorScimId: "system",
        actorName: "EDP Vending Machine",
        subject: "renewal",
      }),
      expect.objectContaining({ kind: "revoked", actorScimId: "validator-1" }),
    ]);
  });

  it.each(["revoked", "rejected"] as const)(
    "refuses approval of a stale pending renewal on a %s EIR",
    async (stage) => {
      const repo = createMemoryEirRepository({
        initialRecords: [
          {
            principalId: "scim-1",
            personName: "Test",
            stage,
            formValues: values,
            renewal: {
              stage: "submitted",
              volumePath: "/Volumes/c/s/v/scim-1/two.pdf",
              submittedAt: "2026-10-01T12:00:00.000Z",
            },
            submissions: [
              {
                volumePath: "/Volumes/c/s/v/scim-1/two.pdf",
                submittedAt: "2026-10-01T12:00:00.000Z",
              },
            ],
            actions: [],
          },
        ],
      });

      await expect(repo.decide("scim-1", "valid", "validator-1")).rejects.toThrow(
        "cannot be reviewed",
      );
    },
  );

  it.each(["valid", "revoked"] as const)(
    "saves only a draft on a %s EIR, never its signed values",
    async (stage) => {
      const repo = createMemoryEirRepository();
      await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
      await repo.decide("scim-1", "valid", "validator-1");
      if (stage === "revoked")
        await repo.decide("scim-1", "revoked", "validator-1", "No longer needed");

      const drafted = await repo.saveDraft("scim-1", {
        ...values,
        contractingCompany: "Changed LLC",
      });
      expect(drafted.formValues).toEqual(values);
      expect(drafted.submissions[0]?.formValues).toEqual(values);
      expect(drafted.actions.map((a) => a.kind)).not.toContain("saved");
    },
  );

  it("keeps finalized values immutable while saving and promoting a correction draft", async () => {
    const repo = createMemoryEirRepository();
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await repo.decide("scim-1", "rejected", "validator-1", "Correct the signature");
    const corrected = { ...values, team: "Senior Team" };

    const drafted = await repo.saveDraft("scim-1", corrected);
    expect(drafted.formValues).toEqual(values);
    expect(drafted.draftValues).toEqual(corrected);

    const submitted = await repo.renew("scim-1", "scim-1", "/Volumes/c/s/v/scim-1/two.pdf");
    expect(submitted).toMatchObject({ stage: "submitted", formValues: corrected });
    expect(submitted.draftValues).toBeUndefined();
  });

  it("refuses a draft while the EIR waits for a validator, and keeps one while answering questions", async () => {
    const repo = createMemoryEirRepository();
    await repo.submit("scim-1", "Test", "/Volumes/c/s/v/scim-1/one.pdf", values);
    await expect(repo.saveDraft("scim-1", { ...values, team: "Changed" })).rejects.toThrow(
      "waits for a safeguards validator",
    );
    expect((await repo.get("scim-1")).draftValues).toBeUndefined();
    await repo.decide("scim-1", "questions", "validator-1", "Clarify the need");
    const drafted = await repo.saveDraft("scim-1", { ...values, team: "Changed" });
    expect(drafted).toMatchObject({ stage: "questions", formValues: values });
    expect(drafted.draftValues?.["team"]).toBe("Changed");
  });
});
