/**
 * The in-memory adapter's dataset seed: one active initiative with two
 * datasets in different domains, each with one owner. Sample data only: on
 * Delta it's loaded only into a preview's store, never production's (see
 * src/server/pilot-config.ts).
 *
 * The first dataset's owner defaults to the local-dev seed user
 * (`src/legacy/appData.js`). A deployment can name real owners for it instead
 * with `EDP_SEED_DATASET_OWNER_IDS` (see {@link withConfiguredOwners} and
 * src/server/seed-config.ts). The second dataset always belongs to someone
 * else, so the read-only team page can be shown.
 */
import type { DatasetSeed } from "./types";

export const DEFAULT_DATASET_SEED: DatasetSeed = {
  initiatives: [
    { id: "INI-0001", name: "Refund Integrity Analytics", tenant: "RAAS", stage: "active" },
  ],
  datasets: [
    {
      id: "ds-refund-anomaly-scores",
      initiativeId: "INI-0001",
      name: "Refund anomaly scores",
      domainTag: "individual-filing",
      datasetTag: "refund_anomaly_scores",
      owners: [{ principalId: "seed-dana-whitfield", displayName: "Dana Whitfield" }],
    },
    {
      id: "ds-business-return-timeliness",
      initiativeId: "INI-0001",
      name: "Business return timeliness",
      domainTag: "business-tax",
      datasetTag: "business_return_timeliness",
      owners: [{ principalId: "seed-marcus-liu", displayName: "Marcus Liu" }],
    },
  ],
};

/** The seed with its first dataset's owners replaced by the configured SCIM ids, if any. */
export function withConfiguredOwners(seed: DatasetSeed, ownerIds: string[] | null): DatasetSeed {
  if (!ownerIds || ownerIds.length === 0) return seed;
  return {
    ...seed,
    datasets: seed.datasets.map((dataset, index) =>
      index === 0
        ? {
            ...dataset,
            owners: ownerIds.map((principalId) => ({ principalId, displayName: principalId })),
          }
        : dataset,
    ),
  };
}
