/**
 * The committed govdev defaults in `databricks.yml` (#338). They are sentinels,
 * not usable names: a deploy must override every one, so both the preflight
 * (command-line vars) and the resolved-config gate (any override source)
 * refuse them by value. Keyed by bundle variable.
 */
export const GOVDEV_SENTINELS = {
  app_name: "edp-vm-govdev-unset",
  store_schema_prefix: "edp_vm_govdev_unset_",
  eir_volume_name: "eir_govdev_unset",
  edp_admin_group_id: "configure-edp-admin-group-id",
} as const;

const SENTINEL_VALUES: ReadonlySet<string> = new Set(Object.values(GOVDEV_SENTINELS));

/** True when a (trimmed) value is one of the committed govdev sentinels. */
export function isGovdevSentinel(value: string): boolean {
  return SENTINEL_VALUES.has(value.trim());
}

/** The production app name, which no govdev deploy may claim. */
export const PRODUCTION_APP_NAME = "edp-vending-machine";
