// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ACTIVE_PRIVACY_NOTICE, type PrivacyNotice } from "../../../data/privacy/notice";
import { privacyAcknowledgmentGuard } from "../../privacy-enforcement";
import { registerEirArea } from "../areas/eir";
import { registerPrivacyArea } from "../areas/privacy";
import { createRegistry } from "../registry";
import { APPLICANT, deltaImplementation, pdf, VAL, VALUES } from "./eir-harness";

const command = (name: string, key: string) =>
  new Request(`https://app/api/commands/eir/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key, expectedVersion: 0, payload: {} }),
  });

function realGuardImplementation(notice: PrivacyNotice = ACTIVE_PRIVACY_NOTICE) {
  const implementation = deltaImplementation();
  registerPrivacyArea(implementation.deps.registry, notice);
  implementation.deps.requirePrivacyAcknowledgment = privacyAcknowledgmentGuard({
    runner: implementation.deps.runner,
    names: implementation.deps.names,
    notice,
  });
  return implementation;
}

async function acknowledge(
  implementation: ReturnType<typeof realGuardImplementation>,
  key = "00000000-0000-4000-8000-000000000100",
) {
  return implementation.request(
    APPLICANT,
    new Request("https://app/api/commands/privacy/acknowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: key,
        expectedVersion: 0,
        payload: {
          noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
          contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
        },
      }),
    }),
  );
}

describe("real privacy guard at the EIR API seam", () => {
  it.each([
    ["read", new Request("https://app/api/reads/eir/mine")],
    ["evaluation-result read", new Request("https://app/api/reads/eir/generated-pdf")],
    ["start", command("start", "00000000-0000-4000-8000-000000000001")],
    ["save", command("save-draft", "00000000-0000-4000-8000-000000000002")],
    ["evaluate", command("evaluate", "00000000-0000-4000-8000-000000000005")],
    ["prepare PDF", command("prepare-pdf", "00000000-0000-4000-8000-000000000006")],
    ["submit", command("submit", "00000000-0000-4000-8000-000000000003")],
    ["respond", command("respond", "00000000-0000-4000-8000-000000000004")],
  ])("EIR %s is refused without a current acknowledgment", async (_operation, request) => {
    const implementation = realGuardImplementation();
    const response = await implementation.request(APPLICANT, request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "privacy-acknowledgment-required" },
    });
  });

  it("EIR routes fail closed when the privacy guard dependency is missing", async () => {
    const implementation = deltaImplementation();
    delete (implementation.deps as Partial<typeof implementation.deps>)
      .requirePrivacyAcknowledgment;
    const response = await implementation.request(
      APPLICANT,
      new Request("https://app/api/reads/eir/mine"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "privacy-guard-unavailable" },
    });
  });

  it("after a real acknowledgment EIR commands succeed and no EIR becomes valid", async () => {
    const implementation = realGuardImplementation();
    expect((await acknowledge(implementation)).status).toBe(200);
    const repository = implementation.as(APPLICANT);
    expect((await repository.get(APPLICANT.principalId)).stage).toBe("not-started");
    await repository.start(APPLICANT.principalId, APPLICANT.displayName);
    await repository.saveDraft(APPLICANT.principalId, VALUES);
    await repository.evaluateDraft(APPLICANT.principalId);
    const submitted = await repository.submitWithFile({
      principalId: APPLICANT.principalId,
      personName: APPLICANT.displayName,
      file: pdf(),
      values: VALUES,
    });
    await implementation
      .as(VAL)
      .decide(APPLICANT.principalId, "questions", VAL.principalId, "Clarify", VAL.displayName);
    const responded = await repository.respond({
      principalId: APPLICANT.principalId,
      values: VALUES,
      response: "Clarified",
    });
    expect(submitted.stage).toBe("submitted");
    expect(responded.stage).toBe("submitted");
    expect(responded.stage).not.toBe("valid");
  });

  it("activating notice v2 makes EIR reads require acknowledgment again", async () => {
    const implementation = realGuardImplementation();
    expect((await acknowledge(implementation)).status).toBe(200);
    expect(
      (await implementation.request(APPLICANT, new Request("https://app/api/reads/eir/mine")))
        .status,
    ).toBe(200);

    const noticeV2: PrivacyNotice = {
      ...ACTIVE_PRIVACY_NOTICE,
      version: "development-2026-10-14",
      contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const registry = createRegistry();
    registerEirArea(registry);
    registerPrivacyArea(registry, noticeV2);
    implementation.deps.registry = registry;
    implementation.deps.requirePrivacyAcknowledgment = privacyAcknowledgmentGuard({
      runner: implementation.deps.runner,
      names: implementation.deps.names,
      notice: noticeV2,
    });

    const response = await implementation.request(
      APPLICANT,
      new Request("https://app/api/reads/eir/mine"),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "privacy-acknowledgment-required" },
    });
  });
});
