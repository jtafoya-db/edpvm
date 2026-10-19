import { ACTIVE_PRIVACY_NOTICE, type PrivacyNotice } from "./notice";

export type PrivacyActorApp = "tenant" | "staff";

export interface PrivacyIdentity {
  principalId: string;
  displayName: string;
  actorApp: PrivacyActorApp;
}

export interface PrivacyAcknowledgment {
  noticeVersion: string;
  contentHash: string;
  principalId: string;
  actorDisplay: string;
  actorApp: PrivacyActorApp;
  acknowledgedAt: string;
}

export type DisplayedPrivacyNotice = Pick<PrivacyAcknowledgment, "noticeVersion" | "contentHash">;

export interface PrivacyAcknowledgmentRepository {
  readonly notice: PrivacyNotice;
  current(): Promise<PrivacyAcknowledgment | null>;
  acknowledge(displayedNotice: DisplayedPrivacyNotice): Promise<PrivacyAcknowledgment>;
  history(): Promise<PrivacyAcknowledgment[]>;
}

export interface MemoryPrivacyState {
  acknowledgments: PrivacyAcknowledgment[];
}

export function createMemoryPrivacyAcknowledgmentRepository(
  options: {
    identity?: PrivacyIdentity;
    notice?: PrivacyNotice;
    clock?: () => Date;
    state?: MemoryPrivacyState;
  } = {},
): PrivacyAcknowledgmentRepository {
  const identity = options.identity ?? {
    principalId: "development-person",
    displayName: "Development Person",
    actorApp: "tenant" as const,
  };
  const notice = options.notice ?? ACTIVE_PRIVACY_NOTICE;
  const clock = options.clock ?? (() => new Date());
  const state = options.state ?? { acknowledgments: [] };
  const belongsToActiveNotice = (item: PrivacyAcknowledgment) =>
    item.principalId === identity.principalId &&
    item.noticeVersion === notice.version &&
    item.contentHash === notice.contentHash;

  return {
    notice,
    async current() {
      return structuredClone(state.acknowledgments.find(belongsToActiveNotice) ?? null);
    },
    async acknowledge(displayedNotice) {
      if (
        displayedNotice.noticeVersion !== notice.version ||
        displayedNotice.contentHash !== notice.contentHash
      ) {
        throw Object.assign(new Error("The privacy notice changed."), {
          status: 409,
          code: "privacy-notice-changed",
        });
      }
      const existing = state.acknowledgments.find(belongsToActiveNotice);
      if (existing) return structuredClone(existing);
      const acknowledgment: PrivacyAcknowledgment = {
        noticeVersion: notice.version,
        contentHash: notice.contentHash,
        principalId: identity.principalId,
        actorDisplay: identity.displayName,
        actorApp: identity.actorApp,
        acknowledgedAt: clock().toISOString(),
      };
      state.acknowledgments.push(acknowledgment);
      return structuredClone(acknowledgment);
    },
    async history() {
      return structuredClone(
        state.acknowledgments.filter((item) => item.principalId === identity.principalId),
      );
    },
  };
}
