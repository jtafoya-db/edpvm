/**
 * The dataset, dataset-role and change-list repositories with the app's
 * default configuration: the checked-in seed (owners from
 * `EDP_SEED_DATASET_OWNER_IDS` via `/api/seed-config`), group naming, role
 * descriptions and the wall clock. Both adapters mount these.
 *
 * The memory adapter mounts these. The Delta adapter uses the Delta stores
 * instead (adapters/delta-teams.ts, #123).
 */
import {
  accessRequestConfigFromSla,
  DEFAULT_ACCESS_REQUEST_CONFIG,
  type AccessRequestConfig,
} from "../access-requests/config";
import { createMemoryAccessRequestStore } from "../access-requests/memory";
import { sampleAccessRequests } from "../access-requests/seed";
import type { AccessRequestStore } from "../access-requests/store";
import type { UserProfile } from "../types";
import {
  cloneEffectiveSlaConfig,
  DEFAULT_EFFECTIVE_SLA_CONFIG,
  type EffectiveSlaConfig,
} from "../sla-config";
import { DEFAULT_GROUP_NAMING, type GroupNamingConfig } from "./group-naming";
import { createMemoryAccessStores, type MemoryAccessStores } from "./memory";
import { DEFAULT_ROLE_DESCRIPTIONS, type RoleDescriptions } from "./role-descriptions";
import { DEFAULT_DATASET_SEED, withConfiguredOwners } from "./seed";
import { fetchSeedOwnerIds } from "./seed-config";
import type { DatasetSeed } from "./types";
import type { GroupMembershipReader } from "../group-membership";

/** Overrides for the defaults. Tests inject these. */
export interface AccessStoreOptions {
  /** The clock every recorded action is stamped with. */
  now?: () => Date;
  /** Replaces the default dataset seed outright. */
  datasetSeed?: DatasetSeed;
  /**
   * Owners for the default dataset seed. Defaults to `/api/seed-config`
   * (`EDP_SEED_DATASET_OWNER_IDS`); `null` keeps the seed's own owner.
   */
  seedOwnerIds?: () => Promise<string[] | null>;
  groupNaming?: GroupNamingConfig;
  roleDescriptions?: RoleDescriptions;
  /** Requestable roles and the access-request SLA target. */
  accessRequestConfig?: AccessRequestConfig;
  /** Draws a new access request's ID; a random display code by default (tests fix it). */
  newAccessRequestId?: () => string;
  slaConfig?: EffectiveSlaConfig;
  groupMembershipReader?: GroupMembershipReader;
}

export function createDefaultAccessStores(
  currentUser: () => Promise<UserProfile>,
  options: AccessStoreOptions = {},
): MemoryAccessStores & { accessRequests: AccessRequestStore } {
  const now = options.now ?? (() => new Date());
  const slaConfig = cloneEffectiveSlaConfig(options.slaConfig ?? DEFAULT_EFFECTIVE_SLA_CONFIG);
  const stores = createMemoryAccessStores({
    loadSeed: async () =>
      options.datasetSeed ??
      withConfiguredOwners(
        DEFAULT_DATASET_SEED,
        await (options.seedOwnerIds ?? fetchSeedOwnerIds)(),
      ),
    groupNaming: options.groupNaming ?? DEFAULT_GROUP_NAMING,
    roleDescriptions: options.roleDescriptions ?? DEFAULT_ROLE_DESCRIPTIONS,
    currentUser,
    now,
    ...(options.groupMembershipReader
      ? { groupMembershipReader: options.groupMembershipReader }
      : {}),
  });
  // Access requests (#91) sit on top of the dataset and dataset-role stores.
  // Sample requests go with the default dataset seed only.
  const accessRequests = createMemoryAccessRequestStore({
    ...stores,
    currentUser,
    now,
    settings:
      options.accessRequestConfig ??
      accessRequestConfigFromSla(DEFAULT_ACCESS_REQUEST_CONFIG, slaConfig),
    holidays: slaConfig.holidays,
    seed: options.datasetSeed ? [] : sampleAccessRequests(now()),
    ...(options.newAccessRequestId ? { newRequestId: options.newAccessRequestId } : {}),
  });
  return { ...stores, accessRequests };
}
