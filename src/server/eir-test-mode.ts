/**
 * Preview test mode for EIR self-decisions (human decision, 2026-10-07): on a
 * PR preview, a safeguards validator may decide their own EIR, so one person
 * can submit and then walk the validator flow on their own record.
 * Production keeps refusing self-validation.
 *
 * Fail closed: the mode is on only when BOTH hold, both checked on the server.
 * 1. `EDP_EIR_ALLOW_SELF_VALIDATION`, trimmed, is exactly `true` (lower case).
 *    The bundle sets it from `eir_allow_self_validation`, `"false"` except on
 *    the preview target. Any other value is off, and an unexpected one (not
 *    `true`, `false` or empty) logs a warning.
 * 2. The store's schema prefix is a PR preview's (`edp_vm_pr<N>_`). Production
 *    has no prefix, so a flag set there by mistake still does nothing.
 *
 * Off, the behaviour is exactly as before: a decision on one's own EIR is
 * refused (403), and the inbox leaves one's own EIR out. On, the server
 * builds the rules with `selfDecisionTestMode: true`
 * (`src/data/eir/self-decision.ts`): every self-decision is still recorded
 * with the actor from the session, and marked by the rules, never by a client.
 */

export { SELF_DECISION_TEST_MODE_NOTE } from "../data/eir/self-decision.ts";

export const EIR_SELF_VALIDATION_ENV = "EDP_EIR_ALLOW_SELF_VALIDATION";
/** A PR preview's store prefix: `edp_vm_pr<N>_`, N a positive PR number (no `pr0_`, no leading zero). */
export const PREVIEW_SCHEMA_PREFIX = /^edp_vm_pr[1-9]\d*_$/;

const warned = new Set<string>();
const warnOnce = (message: string) => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[eir] ${message}`);
};

/** Whether the mode is on, from the flag's raw value and the store's schema prefix. */
export function eirSelfValidationAllowed(
  flag: string | undefined,
  schemaPrefix: string | undefined,
  warn: (message: string) => void = warnOnce,
): boolean {
  const value = (flag ?? "").trim();
  if (value !== "true") {
    if (value !== "" && value !== "false") {
      warn(
        `${EIR_SELF_VALIDATION_ENV} is ${JSON.stringify(flag)}; only "true" turns on self-decision test mode, so it stays off.`,
      );
    }
    return false;
  }
  if (!PREVIEW_SCHEMA_PREFIX.test(schemaPrefix ?? "")) {
    warn(
      `${EIR_SELF_VALIDATION_ENV} is "true" but the store isn't a PR preview's (schema prefix ${JSON.stringify(schemaPrefix ?? "")}); self-decision test mode stays off.`,
    );
    return false;
  }
  return true;
}

/** The flag's raw value: `process.env` first (the app), then the platform env object. */
export function readSelfValidationFlag(env?: unknown): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromProcess = proc?.env?.[EIR_SELF_VALIDATION_ENV];
  if (fromProcess !== undefined) return fromProcess;
  if (env && typeof env === "object" && EIR_SELF_VALIDATION_ENV in env) {
    const value = (env as Record<string, unknown>)[EIR_SELF_VALIDATION_ENV];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function readSchemaPrefix(env?: unknown): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromProcess = proc?.env?.["EDP_STORE_SCHEMA_PREFIX"];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  if (env && typeof env === "object" && "EDP_STORE_SCHEMA_PREFIX" in env) {
    const value = (env as Record<string, unknown>)["EDP_STORE_SCHEMA_PREFIX"];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Whether the mode is on for this app, from its env (the session uses this). */
export function eirSelfValidationFromEnv(env?: unknown): boolean {
  return eirSelfValidationAllowed(readSelfValidationFlag(env), readSchemaPrefix(env));
}
