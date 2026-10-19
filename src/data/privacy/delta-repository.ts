import type { DeltaApiTransport } from "../adapters/delta";
import { ACTIVE_PRIVACY_NOTICE, type PrivacyNotice } from "./notice";
import type { PrivacyAcknowledgment, PrivacyAcknowledgmentRepository } from "./repository";

export function createDeltaPrivacyAcknowledgmentRepository(options: {
  transport: DeltaApiTransport;
  notice?: PrivacyNotice;
  newKey?: () => string;
}): PrivacyAcknowledgmentRepository {
  const notice = options.notice ?? ACTIVE_PRIVACY_NOTICE;
  const current = () => options.transport.read<PrivacyAcknowledgment | null>("privacy", "current");
  return {
    notice,
    current,
    async acknowledge(displayedNotice) {
      try {
        const response = await options.transport.command<{ result: PrivacyAcknowledgment }>(
          "privacy",
          "acknowledge",
          {
            idempotencyKey: (options.newKey ?? (() => crypto.randomUUID()))(),
            expectedVersion: 0,
            payload: displayedNotice,
          },
        );
        return response.result;
      } catch (error) {
        if ((error as { code?: string }).code === "already-acknowledged") {
          const existing = await current();
          if (existing) return existing;
        }
        throw error;
      }
    },
    async history() {
      return options.transport.read<PrivacyAcknowledgment[]>("privacy", "history");
    },
  };
}
