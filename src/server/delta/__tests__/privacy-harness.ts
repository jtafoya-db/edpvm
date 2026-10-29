import {
  createMemoryPrivacyAcknowledgmentRepository,
  type PrivacyAcknowledgmentRepository,
} from "../../../data/privacy/repository";
import { ACTIVE_PRIVACY_NOTICE, type PrivacyNotice } from "../../../data/privacy/notice";
import { createDeltaPrivacyAcknowledgmentRepository } from "../../../data/privacy/delta-repository";
import type { DeltaApiTransport } from "../../../data/adapters/delta";
import type { PrivacyAcknowledgment } from "../../../data/privacy/repository";
import type { MemoryPrivacyState } from "../../../data/privacy/repository";
import { handleDeltaApiRequest } from "../api";
import { registerPrivacyArea } from "../areas/privacy";
import { createRegistry, type SessionUser } from "../registry";
import { createStoreNames } from "../sql-builder";
import { createTransactionRunner } from "../transaction";
import { createSqliteWarehouse } from "./eir-sqlite-warehouse";

export interface PrivacyImplementation {
  name: "memory" | "delta";
  as(principalId: string): PrivacyAcknowledgmentRepository;
  withNotice(notice: Pick<PrivacyNotice, "version" | "contentHash">): PrivacyImplementation;
  audit(principalId: string): Promise<PrivacyAcknowledgment[]>;
}

function memoryLikeImplementation(name: "memory" | "delta"): PrivacyImplementation {
  const state: MemoryPrivacyState = { acknowledgments: [] };
  const clock = () => new Date("2026-10-13T12:00:00.000Z");
  const build = (notice: PrivacyNotice): PrivacyImplementation => ({
    name,
    as: (principalId) =>
      createMemoryPrivacyAcknowledgmentRepository({
        state,
        notice,
        identity: { principalId, displayName: "Test Person", actorApp: "tenant" },
        clock,
      }),
    withNotice: (next) => build({ ...ACTIVE_PRIVACY_NOTICE, ...next }),
    audit: async (principalId) =>
      structuredClone(state.acknowledgments.filter((item) => item.principalId === principalId)),
  });
  return build(ACTIVE_PRIVACY_NOTICE);
}

export function memoryPrivacyImplementation(): PrivacyImplementation {
  return memoryLikeImplementation("memory");
}

export function deltaPrivacyImplementation(): PrivacyImplementation {
  const warehouse = createSqliteWarehouse({ now: () => new Date("2026-10-13T12:00:00.000Z") });
  const names = createStoreNames("edp_vending");
  const runner = createTransactionRunner({
    client: warehouse.client,
    names,
    now: () => new Date("2026-10-13T12:00:00.000Z"),
    sleep: async () => undefined,
    random: () => 0,
  });
  const build = (notice: PrivacyNotice): PrivacyImplementation => {
    const registry = createRegistry();
    registerPrivacyArea(registry, notice);
    const sendAs = async <T>(user: SessionUser, request: Request): Promise<T> => {
      const response = await handleDeltaApiRequest(request, {
        registry,
        runner,
        names,
        serves: ["tenant", "staff"],
        resolveUser: async () => user,
        requirePrivacyAcknowledgment: async () => undefined,
      });
      const body = (await response.json()) as T & { error?: { code?: string; message?: string } };
      if (!response.ok)
        throw Object.assign(new Error(body.error?.message ?? `HTTP ${response.status}`), {
          status: response.status,
          code: body.error?.code,
        });
      return body;
    };
    return {
      name: "delta",
      as(principalId) {
        const user: SessionUser = {
          principalId,
          displayName: "Test Person",
          email: "test.person@example.gov",
          isAdmin: false,
          onboardingReviewerRoles: [],
        };
        const send = <T>(request: Request) => sendAs<T>(user, request);
        const transport: DeltaApiTransport = {
          read: (area, name, query) =>
            send(
              new Request(
                `https://app/api/reads/${area}/${name}${query ? `?${new URLSearchParams(query)}` : ""}`,
              ),
            ),
          command: (area, name, body) =>
            send(
              new Request(`https://app/api/commands/${area}/${name}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            ),
          legacyWrite: () => Promise.reject(new Error("Privacy has no legacy writes.")),
        };
        return createDeltaPrivacyAcknowledgmentRepository({ transport, notice });
      },
      withNotice: (next) => build({ ...ACTIVE_PRIVACY_NOTICE, ...next }),
      audit: (principalId) =>
        sendAs<PrivacyAcknowledgment[]>(
          {
            principalId: "3001",
            displayName: "Sam Staff",
            email: "sam@example.gov",
            isAdmin: true,
            onboardingReviewerRoles: [],
          },
          new Request(`https://app/api/reads/privacy/audit?principalId=${principalId}`),
        ),
    };
  };
  return build(ACTIVE_PRIVACY_NOTICE);
}
