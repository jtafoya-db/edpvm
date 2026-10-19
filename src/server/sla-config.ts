import {
  cloneEffectiveSlaConfig,
  DEFAULT_EFFECTIVE_SLA_CONFIG,
  type EffectiveSlaConfig,
} from "../data/sla-config.ts";

export { DEFAULT_EFFECTIVE_SLA_CONFIG };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function envValue(env: unknown, name: string): string | undefined {
  if (env && typeof env === "object" && name in env) {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
    return undefined;
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function readIntegerInRange(
  env: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new Error(`${name} must not be blank.`);
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function readBoolean(env: unknown, name: string, fallback: boolean): boolean {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new Error(`${name} must not be blank.`);
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be "true" or "false".`);
}

function readHolidays(env: unknown): readonly string[] {
  const raw = envValue(env, "EDP_SLA_HOLIDAYS");
  if (raw === undefined) return DEFAULT_EFFECTIVE_SLA_CONFIG.holidays;
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("EDP_SLA_HOLIDAYS must not be blank; use [] for none.");
  if (trimmed === "[]") return [];
  const holidays = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!holidays.length) throw new Error("EDP_SLA_HOLIDAYS must name ISO dates or [].");
  for (const holiday of holidays) {
    const parsed = new Date(`${holiday}T00:00:00.000Z`);
    if (
      !ISO_DATE.test(holiday) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== holiday
    ) {
      throw new Error(`EDP_SLA_HOLIDAYS contains an invalid ISO date: ${holiday}.`);
    }
  }
  return holidays;
}

export function readEffectiveSlaConfig(env?: unknown): EffectiveSlaConfig {
  const defaults = DEFAULT_EFFECTIVE_SLA_CONFIG;
  return cloneEffectiveSlaConfig({
    stages: {
      "edp-roi-review": readIntegerInRange(
        env,
        "EDP_SLA_EDP_ROI_REVIEW_BUSINESS_DAYS",
        defaults.stages["edp-roi-review"],
        1,
        60,
      ),
      ccb: readIntegerInRange(env, "EDP_SLA_CCB_BUSINESS_DAYS", defaults.stages.ccb, 1, 60),
      "eir-validation": readIntegerInRange(
        env,
        "EDP_SLA_EIR_VALIDATION_BUSINESS_DAYS",
        defaults.stages["eir-validation"],
        1,
        60,
      ),
      "access-request-decision": readIntegerInRange(
        env,
        "EDP_SLA_ACCESS_REQUEST_DECISION_BUSINESS_DAYS",
        defaults.stages["access-request-decision"],
        1,
        60,
      ),
    },
    dueSoonThresholdBusinessDays: readIntegerInRange(
      env,
      "EDP_SLA_DUE_SOON_BUSINESS_DAYS",
      defaults.dueSoonThresholdBusinessDays,
      0,
      60,
    ),
    holidays: readHolidays(env),
    eirValidityDays: readIntegerInRange(
      env,
      "EDP_EIR_VALIDITY_DAYS",
      defaults.eirValidityDays,
      1,
      3650,
    ),
    accessRequestSlaProvisional: readBoolean(
      env,
      "EDP_ACCESS_REQUEST_SLA_PROVISIONAL",
      defaults.accessRequestSlaProvisional,
    ),
  });
}

let configured = readEffectiveSlaConfig();

/** The validated server startup SLA config. Runtime requests reuse this object. */
export function configuredSlaConfig(): EffectiveSlaConfig {
  return cloneEffectiveSlaConfig(configured);
}

/** Test hook: replace the startup config without mutating process.env. */
export function setConfiguredSlaConfigForTests(config: EffectiveSlaConfig): void {
  configured = cloneEffectiveSlaConfig(config);
}
