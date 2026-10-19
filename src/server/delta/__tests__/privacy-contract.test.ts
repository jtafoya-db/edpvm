// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ACTIVE_PRIVACY_NOTICE } from "../../../data/privacy/notice";
import {
  deltaPrivacyImplementation,
  memoryPrivacyImplementation,
  type PrivacyImplementation,
} from "./privacy-harness";

describe.each([
  ["memory", memoryPrivacyImplementation],
  ["delta", deltaPrivacyImplementation],
] as const)("privacy acknowledgment repository contract: %s", (_name, make) => {
  const acknowledgeActive = (repository: ReturnType<PrivacyImplementation["as"]>) =>
    repository.acknowledge({
      noticeVersion: repository.notice.version,
      contentHash: repository.notice.contentHash,
    });
  it("person with no acknowledgment has no current acknowledgment for the active notice", async () => {
    const repository = make().as("1001");

    expect(await repository.current()).toBeNull();
  });

  it("acknowledging records notice version, content hash, account id, display, actor app and time from the authenticated identity", async () => {
    const repository = make().as("1001");

    const acknowledgment = await acknowledgeActive(repository);

    expect(acknowledgment).toEqual({
      noticeVersion: "development-2026-10-13",
      contentHash: "sha256:908350dbf9dd8aa9c7c115b60bb95ff2e43f05d555b5dd092fb18ebd0b97ce6e",
      principalId: "1001",
      actorDisplay: "Test Person",
      actorApp: "tenant",
      acknowledgedAt: "2026-10-13T12:00:00.000Z",
    });
  });

  it("acknowledging twice is idempotent: one current acknowledgment", async () => {
    const repository = make().as("1001");

    expect(await acknowledgeActive(repository)).toEqual(await acknowledgeActive(repository));
    expect(await repository.history()).toHaveLength(1);
  });

  it("concurrent acknowledgments leave one unambiguous current state", async () => {
    const repository = make().as("1001");

    const acknowledgments = await Promise.all([
      acknowledgeActive(repository),
      acknowledgeActive(repository),
      acknowledgeActive(repository),
    ]);

    expect(new Set(acknowledgments.map((item) => JSON.stringify(item))).size).toBe(1);
    expect(await repository.history()).toHaveLength(1);
    expect(await repository.current()).toEqual(acknowledgments[0]);
  });

  it("activating a new notice version makes the prior acknowledgment non-current but keeps it in history", async () => {
    const implementation = make();
    await acknowledgeActive(implementation.as("1001"));

    const repository = implementation
      .withNotice({
        version: "development-2026-10-14",
        contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })
      .as("1001");

    expect(await repository.current()).toBeNull();
    expect(await repository.history()).toEqual([
      expect.objectContaining({ noticeVersion: "development-2026-10-13" }),
    ]);
  });

  it("refuses a stale displayed notice without adding it to history", async () => {
    const repository = make()
      .withNotice({
        version: "development-2026-10-14",
        contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })
      .as("1001");

    await expect(
      (
        repository.acknowledge as unknown as (displayedNotice: {
          noticeVersion: string;
          contentHash: string;
        }) => ReturnType<typeof repository.acknowledge>
      )({
        noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
        contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
      }),
    ).rejects.toMatchObject({ status: 409, code: "privacy-notice-changed" });
    expect(await repository.history()).toEqual([]);
  });

  it("staff audit lists which notice version a person acknowledged without EIR contents", async () => {
    const implementation = make();
    await acknowledgeActive(implementation.as("1001"));

    const audit = await implementation.audit("1001");

    expect(audit).toEqual([
      expect.objectContaining({
        principalId: "1001",
        noticeVersion: "development-2026-10-13",
        contentHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/formValues|submission|volumePath|EIR-/);
  });

  it("there is no API to record a refusal", () => {
    const repository = make().as("1001") as unknown as Record<string, unknown>;
    expect(repository["refuse"]).toBeUndefined();
    expect(repository["decline"]).toBeUndefined();
  });
});
