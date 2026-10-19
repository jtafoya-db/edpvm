import type { PrivacyNotice } from "../data/privacy/notice";
import { DomainError } from "./delta/errors";
import type { SessionUser } from "./delta/registry";
import type { StoreNames } from "./delta/sql-builder";
import type { TransactionRunner } from "./delta/transaction";

export const PRIVACY_ACKNOWLEDGMENT_REQUIRED = "privacy-acknowledgment-required";

export function privacyAcknowledgmentGuard(deps: {
  runner: TransactionRunner;
  names: StoreNames;
  notice: PrivacyNotice;
}): (user: SessionUser) => Promise<void> {
  return async (user) => {
    const rows = await deps.runner.reader({ readId: crypto.randomUUID() })<{ present: number }>({
      statement: `SELECT 1 AS present FROM ${deps.names.table("privacy", "acknowledgments")} WHERE actor_principal_id = :principal AND notice_version = :version AND content_hash = :hash LIMIT 1`,
      parameters: {
        principal: user.principalId,
        version: deps.notice.version,
        hash: deps.notice.contentHash,
      },
    });
    if (!rows[0]) {
      throw new DomainError(
        PRIVACY_ACKNOWLEDGMENT_REQUIRED,
        "Acknowledge the active privacy notice before using the EIR journey.",
        403,
      );
    }
  };
}
