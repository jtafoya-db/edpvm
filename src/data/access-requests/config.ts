/**
 * Access-request settings, read from configuration
 * (`access-request-config.json`), like the role descriptions: which dataset
 * roles a person may request, and the SLA target on owners' decisions.
 *
 * The SLA target comes from deployment configuration. The note says whether
 * that target is still provisional and whether configured holidays are skipped.
 * Manager isn't requestable (a dataset owner grants it directly);
 * `nonRequestableNote` says so on the request form and in the refusal.
 */
import defaultConfig from "./access-request-config.json";
import { DATASET_ROLES, type DatasetRoleName } from "../datasets/types";
import { type EffectiveSlaConfig } from "../sla-config";

export interface AccessRequestSlaConfig {
  /** Business days owners have to approve or reject. */
  targetBusinessDays: number;
  /** An open request is due soon once this many business days or fewer remain. */
  dueSoonBusinessDays: number;
  /** True until the business confirms the target. */
  provisional: boolean;
  /** Shown next to the target: what it is and what it doesn't count. */
  note: string;
}

export interface AccessRequestConfig {
  requestableRoles: DatasetRoleName[];
  /** Why the other roles can't be requested, shown on the form and in the refusal. */
  nonRequestableNote: string;
  sla: AccessRequestSlaConfig;
}

const isWholeDays = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** Throws unless the roles are known and non-empty and the SLA numbers are whole business days. */
export function validateAccessRequestConfig(config: AccessRequestConfig): AccessRequestConfig {
  const roles = config.requestableRoles;
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some((r) => !(DATASET_ROLES as readonly string[]).includes(r))
  ) {
    throw new Error(
      `Access-request config must list requestable roles from ${DATASET_ROLES.join(", ")}.`,
    );
  }
  if (roles.length < DATASET_ROLES.length && !config.nonRequestableNote?.trim()) {
    throw new Error(
      "Access-request config must explain, in nonRequestableNote, why some roles can't be requested.",
    );
  }
  const sla = config.sla;
  if (
    !sla ||
    !isWholeDays(sla.targetBusinessDays) ||
    sla.targetBusinessDays === 0 ||
    !isWholeDays(sla.dueSoonBusinessDays) ||
    typeof sla.provisional !== "boolean" ||
    !sla.note?.trim()
  ) {
    throw new Error(
      "Access-request config must give the SLA a whole-day target above zero, a due-soon threshold, a provisional flag and a note.",
    );
  }
  return config;
}

/** The checked-in configuration (`access-request-config.json`). */
export const DEFAULT_ACCESS_REQUEST_CONFIG: AccessRequestConfig = validateAccessRequestConfig(
  defaultConfig as AccessRequestConfig,
);

function accessRequestSlaNote(provisional: boolean, hasHolidays: boolean): string {
  const source = provisional
    ? "This provisional target still needs business confirmation."
    : "This target comes from the app's deployment settings.";
  const calendar = hasHolidays
    ? "Configured holidays are skipped."
    : "It counts weekdays only; no holidays are configured.";
  return `${source} ${calendar}`;
}

export function accessRequestConfigFromSla(
  base: AccessRequestConfig,
  slaConfig: EffectiveSlaConfig,
): AccessRequestConfig {
  return validateAccessRequestConfig({
    ...base,
    sla: {
      ...base.sla,
      targetBusinessDays: slaConfig.stages["access-request-decision"],
      dueSoonBusinessDays: slaConfig.dueSoonThresholdBusinessDays,
      provisional: slaConfig.accessRequestSlaProvisional,
      note: accessRequestSlaNote(
        slaConfig.accessRequestSlaProvisional,
        slaConfig.holidays.length > 0,
      ),
    },
  });
}
