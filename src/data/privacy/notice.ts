export interface PrivacyNotice {
  version: string;
  contentHash: string;
  heading: string;
  body: string;
  help: string;
  productionApproved: false;
}

/** Stable content identity: UTF-8 heading, body and help separated by LF. */
export function canonicalPrivacyNoticeContent(
  notice: Pick<PrivacyNotice, "heading" | "body" | "help">,
): string {
  return `${notice.heading}\n${notice.body}\n${notice.help}`;
}

/** Development-only copy. IRS privacy authority approval is required before production use. */
export const ACTIVE_PRIVACY_NOTICE: PrivacyNotice = Object.freeze({
  version: "development-2026-10-13",
  contentHash: "sha256:908350dbf9dd8aa9c7c115b60bb95ff2e43f05d555b5dd092fb18ebd0b97ce6e",
  heading: "Development privacy notice — not approved for production",
  body: "This development preview records that you acknowledged this notice before using the Employee Identity Record journey. Use synthetic information only. This wording is not an IRS-approved privacy notice and does not authorize FTI use.",
  help: "If you do not want to continue, leave this page. Nothing about a refusal is recorded. Contact the EDP support team for help.",
  productionApproved: false,
});
