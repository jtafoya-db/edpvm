/**
 * Dataset group naming, read from configuration (dataset + role → group name).
 *
 * The naming convention is an open question (docs/mvp-access-model.md, open
 * question 1), so it lives in `group-naming.json`, not in code. A template
 * names every dataset group; `overrides` pins the name of one dataset's role
 * group when it doesn't follow the template. Editing the JSON changes every
 * name the change list shows, with no code change.
 */
import defaultConfig from "./group-naming.json";
import { DATASET_ROLES, type Dataset, type DatasetRoleName } from "./types";

export interface GroupNamingConfig {
  /**
   * Template for a dataset group's name. Placeholders: `{datasetTag}`,
   * `{datasetId}`, `{domainTag}`, `{role}`. It must include `{role}` and one of
   * `{datasetTag}` / `{datasetId}`, so a name says which dataset and which
   * role it grants.
   */
  datasetGroup: string;
  /** Explicit names keyed by dataset id, then role. These win over the template. */
  overrides: Partial<Record<string, Partial<Record<DatasetRoleName, string>>>>;
}

const PLACEHOLDERS = ["datasetTag", "datasetId", "domainTag", "role"] as const;

/** Throws if the config could produce a name that doesn't identify its dataset and role. */
export function validateGroupNaming(config: GroupNamingConfig): GroupNamingConfig {
  const template = config.datasetGroup;
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(match[1] ?? "")) {
      throw new Error(
        `Group naming template ${JSON.stringify(template)} uses unknown placeholder {${match[1]}}; ` +
          `expected ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.`,
      );
    }
  }
  if (!template.includes("{role}")) {
    throw new Error(
      `Group naming template ${JSON.stringify(template)} must include {role} so a group name says which role it grants.`,
    );
  }
  if (!template.includes("{datasetTag}") && !template.includes("{datasetId}")) {
    throw new Error(
      `Group naming template ${JSON.stringify(template)} must include {datasetTag} or {datasetId} so a group name says which dataset it grants.`,
    );
  }
  for (const [datasetId, roles] of Object.entries(config.overrides)) {
    for (const [role, name] of Object.entries(roles ?? {})) {
      if (!(DATASET_ROLES as readonly string[]).includes(role)) {
        throw new Error(`Group naming override for ${datasetId} names unknown role ${role}.`);
      }
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error(`Group naming override for ${datasetId}/${role} must be a non-empty name.`);
      }
    }
  }
  return config;
}

/**
 * Throws unless every dataset/role group name identifies its dataset and role,
 * and no two dataset/role mappings share a name. Overrides are held to the
 * same rule as the template: the name must contain the role and the dataset's
 * tag or id.
 */
export function validateGroupNames(config: GroupNamingConfig, datasets: Dataset[]): void {
  const seen = new Map<string, string>();
  for (const dataset of datasets) {
    for (const role of DATASET_ROLES) {
      const name = datasetGroupName(config, dataset, role);
      const override = config.overrides[dataset.id]?.[role];
      if (
        override !== undefined &&
        (!override.includes(role) ||
          (!override.includes(dataset.datasetTag) && !override.includes(dataset.id)))
      ) {
        throw new Error(
          `Group naming override ${JSON.stringify(override)} for ${dataset.id}/${role} must contain ` +
            `"${role}" and the dataset's tag (${dataset.datasetTag}) or id.`,
        );
      }
      const mapping = `${dataset.id}/${role}`;
      const clash = seen.get(name);
      if (clash) {
        throw new Error(
          `Group name ${JSON.stringify(name)} would be the same group name for ${clash} and ${mapping}.`,
        );
      }
      seen.set(name, mapping);
    }
  }
}

/** The configured name of one dataset's group for one role. */
export function datasetGroupName(
  config: GroupNamingConfig,
  dataset: Dataset,
  role: DatasetRoleName,
): string {
  const override = config.overrides[dataset.id]?.[role];
  if (override) return override;
  const values: Record<(typeof PLACEHOLDERS)[number], string> = {
    datasetTag: dataset.datasetTag,
    datasetId: dataset.id,
    domainTag: dataset.domainTag,
    role,
  };
  return config.datasetGroup.replace(
    /\{(datasetTag|datasetId|domainTag|role)\}/g,
    (_, key: keyof typeof values) => values[key],
  );
}

/** The checked-in configuration (`group-naming.json`). */
export const DEFAULT_GROUP_NAMING: GroupNamingConfig = validateGroupNaming(
  defaultConfig as GroupNamingConfig,
);
