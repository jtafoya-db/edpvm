/**
 * The deploy-time EIR approval settings (#204), read once on the server:
 *
 * - `EDP_EIR_APPROVAL_MODE` (bundle variable `eir_approval_mode`):
 *   `manual-validator` (unset) or `automatic`.
 * - `EDP_EIR_AUTOMATIC_VALIDITY_OUTCOMES` (`eir_automatic_validity_outcomes`):
 *   the pre-check results that qualify in automatic mode, `pass` (unset),
 *   `warning`, or `pass,warning`. Never `blocking` (#148, 2026-10-24).
 *
 * Anything else refuses to start the app, like the SLA settings
 * (`sla-config.ts`, and `databricks-app/serve.mjs` before the server loads):
 * a mistyped setting never quietly becomes either mode. No client sends
 * them. See `src/data/eir/approval-mode.ts`.
 */
import {
  DEFAULT_EIR_APPROVAL_CONFIG,
  parseAutomaticValidityOutcomes,
  parseEirApprovalMode,
  type EirApprovalConfig,
} from "../data/eir/approval-mode.ts";

export const EIR_APPROVAL_MODE_ENV = "EDP_EIR_APPROVAL_MODE";
export const EIR_AUTOMATIC_VALIDITY_OUTCOMES_ENV = "EDP_EIR_AUTOMATIC_VALIDITY_OUTCOMES";

function envValue(env: unknown, name: string): string | undefined {
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/** The settings from `env` (the app's process env when omitted). */
export function readEirApprovalConfig(env?: unknown): EirApprovalConfig {
  return {
    mode: parseEirApprovalMode(envValue(env, EIR_APPROVAL_MODE_ENV), EIR_APPROVAL_MODE_ENV),
    automaticValidityOutcomes: parseAutomaticValidityOutcomes(
      envValue(env, EIR_AUTOMATIC_VALIDITY_OUTCOMES_ENV),
      EIR_AUTOMATIC_VALIDITY_OUTCOMES_ENV,
    ),
  };
}

let configured: EirApprovalConfig | undefined;

/** The settings the server started with: read and checked once. */
export function configuredEirApprovalConfig(): EirApprovalConfig {
  configured ??= readEirApprovalConfig();
  return configured;
}

/** Test hook: replace the startup settings without touching process.env. */
export function setConfiguredEirApprovalConfigForTests(config?: EirApprovalConfig): void {
  configured = config ?? DEFAULT_EIR_APPROVAL_CONFIG;
}
