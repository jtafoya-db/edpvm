/**
 * Same-person checks for access-request actors use stable principal ids.
 * Dataset ownership itself is defined by datasets/ownership.ts (ADR-0006).
 */
/** True only when both ids are non-empty strings and equal. */
export function samePrincipal(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && a !== "" && a === b;
}
