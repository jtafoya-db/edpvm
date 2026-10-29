/**
 * The one error the dataset and change-list repositories raise when they
 * refuse an action. `code` says why, so screens can explain the refusal
 * without parsing the message.
 */
export type RefusalCode =
  | "not-owner"
  | "not-edp-staff"
  | "not-found"
  | "not-active"
  | "invalid"
  | "already-applied"
  | "superseded"
  | "duplicate"
  | "last-owner"
  | "owner-holds-manager"
  | "owner-mismatch";

export class ActionRefusedError extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "ActionRefusedError";
    this.code = code;
  }
}
