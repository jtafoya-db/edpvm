/**
 * What each dataset role grants, in plain words, read from configuration.
 *
 * The wording lives in `role-descriptions.json`, next to the group-naming
 * config, so the team page, the change list and later access requests (#91)
 * all say the same thing. It follows GLOSSARY.md and docs/mvp-access-model.md.
 * The exact Unity Catalog privileges behind each role are still an open
 * question; this is the description owners and staff read, not a grant list
 * the app executes.
 */
import defaultConfig from "./role-descriptions.json";
import { DATASET_ROLES, type DatasetRoleName } from "./types";

export interface RoleDescription {
  label: string;
  /** One line, for reminders next to a member's role. */
  summary: string;
  /** Each thing the role grants, shown in full when adding and on the change list. */
  grants: string[];
}

export interface RoleDescriptions {
  roles: Record<DatasetRoleName, RoleDescription>;
  /** Why data consumers don't appear on a team page. */
  consumerNote: string;
}

/** Throws unless every role has a label, a summary and at least one grant. */
export function validateRoleDescriptions(config: RoleDescriptions): RoleDescriptions {
  for (const role of DATASET_ROLES) {
    const description = config.roles?.[role];
    if (
      !description ||
      !description.label?.trim() ||
      !description.summary?.trim() ||
      !Array.isArray(description.grants) ||
      description.grants.length === 0 ||
      description.grants.some((grant) => typeof grant !== "string" || !grant.trim())
    ) {
      throw new Error(
        `Role descriptions must give the ${role} role a label, a summary and at least one grant.`,
      );
    }
  }
  if (!config.consumerNote?.trim()) {
    throw new Error("Role descriptions must include a consumerNote.");
  }
  return config;
}

/** The checked-in configuration (`role-descriptions.json`). */
export const DEFAULT_ROLE_DESCRIPTIONS: RoleDescriptions = validateRoleDescriptions(
  defaultConfig as RoleDescriptions,
);
