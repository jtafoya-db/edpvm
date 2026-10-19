/**
 * Errors on the Delta command path, and how a warehouse error is classified.
 *
 * - {@link DomainError}: a rule said no (not an owner, already open, not
 *   found). Thrown by handlers or raised by an in-transaction guard. Never retried.
 * - {@link VersionConflictError}: the record moved on since the client read
 *   it, or a version-checked update changed zero rows. Never retried: the
 *   client's version is stale, so a retry can't succeed.
 * - {@link IdempotencyKeyReusedError}: a known key arrived with a different command.
 * - {@link BusyError}: Delta conflicts outlasted every retry (ADR-0007 decision 6).
 * - {@link SqlError}: anything the warehouse reported. Retried only when it's
 *   a Delta concurrency conflict.
 */

/** What the person sees after a version conflict or exhausted retries (issue #76). */
export const CONFLICT_MESSAGE = "This changed since you opened it. Reload to see the latest.";

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

export class VersionConflictError extends DomainError {
  constructor(detail?: string) {
    super("version-conflict", CONFLICT_MESSAGE, 409);
    this.name = "VersionConflictError";
    if (detail) this.cause = detail;
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super(
      "idempotency-key-reused",
      "This request's idempotency key was already used for a different change.",
      409,
    );
    this.name = "IdempotencyKeyReusedError";
  }
}

export class BusyError extends Error {
  readonly code = "busy";
  readonly status = 503;
  readonly attempts: number;
  constructor(attempts: number, cause?: unknown) {
    super(CONFLICT_MESSAGE);
    this.name = "BusyError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

/** A statement the warehouse failed, cancelled or closed. */
export class SqlError extends Error {
  readonly sqlState: string | undefined;
  readonly errorCode: string | undefined;
  readonly statementId: string | undefined;
  constructor(
    message: string,
    details: { sqlState?: string; errorCode?: string; statementId?: string } = {},
  ) {
    super(message);
    this.name = "SqlError";
    this.sqlState = details.sqlState;
    this.errorCode = details.errorCode;
    this.statementId = details.statementId;
  }
}

/**
 * The client gave up on a statement at its deadline and cancelled it. Its
 * outcome is unknown: it may have committed before the cancel landed. A
 * command retries and its idempotency lookup finds out; a write with no
 * stored key must not be retried blindly.
 */
export class StatementAbandonedError extends SqlError {
  readonly lastState: string | undefined;
  constructor(deadlineMs: number, lastState?: string, statementId?: string) {
    super(
      `Statement abandoned at the ${deadlineMs} ms deadline and cancelled (last state: ${lastState ?? "unknown"}).`,
      {
        errorCode: "DEADLINE_EXCEEDED",
        ...(statementId ? { statementId } : {}),
      },
    );
    this.name = "StatementAbandonedError";
    this.lastState = lastState;
  }
}

/** A write without an idempotency key whose statement was abandoned: it may or may not have landed. */
export class OutcomeUnknownError extends Error {
  readonly code = "outcome-unknown";
  readonly status = 503;
  constructor(cause?: unknown) {
    super("We couldn't confirm this was saved. Reload to check before trying again.");
    this.name = "OutcomeUnknownError";
    this.cause = cause;
  }
}

/**
 * SQLSTATEs our own guards raise with `SIGNAL` inside a `BEGIN ATOMIC` block.
 * Class `ED` is not used by Databricks.
 */
export const GUARD_STATE = {
  /** A version-checked update changed zero rows, or the read version is stale. */
  versionConflict: "ED001",
  /** Another writer committed this idempotency key after our pre-read. Retried. */
  idempotencyRace: "ED002",
  /** A row the command must produce is missing at the end of the block. */
  incompleteWrite: "ED003",
  /** The new record's random display code is already taken. Retried with a fresh code. */
  displayCodeTaken: "ED004",
  /** A domain rule failed; `MESSAGE_TEXT` names which guard (`edp:guard:<n>`). */
  domain: "ED010",
} as const;

/**
 * Delta conflict errors worth retrying: the whole block re-runs and re-reads.
 * Names from the Databricks conflict docs and the ADR-0007 GovCloud test
 * (`DELTA_CONCURRENT_APPEND.ROW_LEVEL_CHANGES`, `DELTA_METADATA_CHANGED`).
 */
const RETRYABLE_PATTERNS = [
  /DELTA_CONCURRENT_[A-Z_]+/,
  /DELTA_METADATA_CHANGED/,
  /DELTA_PROTOCOL_CHANGED/,
  /Concurrent(Append|DeleteRead|DeleteDelete|Transaction|Write)Exception/,
  /TRANSACTION_CONFLICT/i,
  /concurrent (update|transaction|modification)/i,
];

export function isRetryableConflict(error: unknown): boolean {
  if (!(error instanceof SqlError)) return false;
  if (error.sqlState === GUARD_STATE.idempotencyRace) return true;
  const text = `${error.errorCode ?? ""} ${error.message}`;
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(text));
}

/** The guard index in a `SIGNAL` message (`edp:guard:3`), if any. */
export function guardIndex(error: SqlError): number | undefined {
  const match = /edp:guard:(\d+)/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}
