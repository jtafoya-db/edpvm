// @vitest-environment node
import { expect, it } from "vitest";

import { ACTIVE_PRIVACY_NOTICE } from "../../../data/privacy/notice";
import { createAppRegistry } from "../areas";
import { registerPrivacyArea } from "../areas/privacy";
import { APPLICANT, deltaImplementation } from "./eir-harness";

const acknowledge = (payload: unknown, key: string) =>
  new Request("https://app/api/commands/privacy/acknowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key, expectedVersion: 0, payload }),
  });

const activePayload = {
  noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
  contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
};

it("privacy API rejects caller identity and records the authenticated session principal", async () => {
  const implementation = deltaImplementation();
  registerPrivacyArea(implementation.deps.registry, ACTIVE_PRIVACY_NOTICE);

  const forged = await implementation.request(
    APPLICANT,
    acknowledge(
      { ...activePayload, principalId: "caller-supplied", actorDisplay: "Caller Supplied" },
      "00000000-0000-4000-8000-000000000401",
    ),
  );
  expect(forged.status).toBe(400);

  const accepted = await implementation.request(
    APPLICANT,
    acknowledge(activePayload, "00000000-0000-4000-8000-000000000402"),
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    result: {
      principalId: APPLICANT.principalId,
      actorDisplay: APPLICANT.displayName,
      actorApp: "tenant",
    },
  });
});

it("the registry exposes acknowledge as its only privacy command", () => {
  const commands = createAppRegistry()
    .list()
    .writes.filter((write) => write.area === "privacy")
    .map((write) => write.name);

  expect(commands).toEqual(["acknowledge"]);
});
