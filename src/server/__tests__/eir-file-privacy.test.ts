// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import { ACTIVE_PRIVACY_NOTICE } from "../../data/privacy/notice";
import { registerPrivacyArea } from "../delta/areas/privacy";
import type { SessionUser } from "../delta/registry";
import { deltaImplementation } from "../delta/__tests__/eir-harness";
import { handleEirFileRequest, handleEirUploadRequest } from "../eir-api";
import { privacyAcknowledgmentGuard } from "../privacy-enforcement";

afterEach(() => vi.unstubAllEnvs());

it("owner PDF read is refused by the real guard without a current acknowledgment", async () => {
  vi.stubEnv("EDP_IDENTITY_MODE", "development");
  const implementation = deltaImplementation();
  registerPrivacyArea(implementation.deps.registry, ACTIVE_PRIVACY_NOTICE);
  const realGuard = privacyAcknowledgmentGuard({
    runner: implementation.deps.runner,
    names: implementation.deps.names,
    notice: ACTIVE_PRIVACY_NOTICE,
  });
  const guard = (user: SessionUser) => realGuard(user);
  const storage = {
    read: vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70, 45])),
    write: vi.fn(),
    list: vi.fn(),
  };
  const request = new Request(
    "https://app/api/eir/files?path=/Volumes/edp/docs/eir/dev-local-user/1790000000001-00000000-0000-4000-8000-000000000001.pdf",
  );

  const response = await handleEirFileRequest(
    request,
    { EIR_VOLUME_CATALOG: "edp", EIR_VOLUME_SCHEMA: "docs", EIR_VOLUME_NAME: "eir" },
    storage,
    guard,
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "privacy-acknowledgment-required" });
  expect(storage.read).not.toHaveBeenCalled();
});

it("upload is refused by the real guard, then succeeds after a real acknowledgment", async () => {
  vi.stubEnv("EDP_IDENTITY_MODE", "development");
  const implementation = deltaImplementation();
  registerPrivacyArea(implementation.deps.registry, ACTIVE_PRIVACY_NOTICE);
  const guard = privacyAcknowledgmentGuard({
    runner: implementation.deps.runner,
    names: implementation.deps.names,
    notice: ACTIVE_PRIVACY_NOTICE,
  });
  const user: SessionUser = {
    principalId: "dev-local-user",
    displayName: "Local Developer",
    email: "local@example.invalid",
    isAdmin: false,
    onboardingReviewerRoles: [],
  };
  const body = () => {
    const form = new FormData();
    form.set("file", new File(["%PDF-1.7 synthetic"], "signed.pdf", { type: "application/pdf" }));
    return new Request("https://app/api/eir/uploads", { method: "POST", body: form });
  };
  const storage = { read: vi.fn(), write: vi.fn(), list: vi.fn() };
  const env = { EIR_VOLUME_CATALOG: "edp", EIR_VOLUME_SCHEMA: "docs", EIR_VOLUME_NAME: "eir" };

  const refused = await handleEirUploadRequest(body(), env, storage, guard);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "privacy-acknowledgment-required" });

  const acknowledged = await implementation.request(
    user,
    new Request("https://app/api/commands/privacy/acknowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "00000000-0000-4000-8000-000000000301",
        expectedVersion: 0,
        payload: {
          noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
          contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
        },
      }),
    }),
  );
  expect(acknowledged.status).toBe(200);

  const accepted = await handleEirUploadRequest(body(), env, storage, guard);
  expect(accepted.status).toBe(201);
  expect(storage.write).toHaveBeenCalledTimes(1);
});
