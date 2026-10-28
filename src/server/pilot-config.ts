/**
 * The pilot initiative, tenant, datasets and owners the Delta store starts
 * with (#123, decided on #141/#146): deploy-time configuration, never sample
 * data in production. The store keeps its history indefinitely (ADR-0007
 * decision 12), so what's loaded here stays in it.
 *
 * - `EDP_PILOT_CONFIG_JSON` (bundle var `pilot_config_json`) set: exactly
 *   that, checked against {@link pilotConfigSchema}. Invalid JSON or shape
 *   refuses the whole configuration; nothing is loaded.
 * - `none` (the bundle's default; Databricks Apps refuses an empty env value)
 *   is the same as unset.
 * - Unset in a preview (`EDP_STORE_SCHEMA_PREFIX` non-empty): the sample seed
 *   (src/data/datasets/seed.ts), with its first dataset's owners from
 *   `EDP_SEED_DATASET_OWNER_IDS`, so preview UAT has datasets to work on.
 * - Unset in production (no schema prefix): nothing.
 *
 * Either way, a sample requester (src/data/access-requests/seed.ts) as an
 * owner refuses the whole configuration, unless sample mode is on
 * (src/server/sample-access-requests.ts, #312): production must never load
 * sample people into its teams.
 *
 * The shape, with an example, is in docs/delta-backend.md.
 */
import { z } from "zod";

import { ZOD3_PARSE_OPTIONS, zod3IssueMessage } from "../zod-compat";
import { DEFAULT_DATASET_SEED, withConfiguredOwners } from "../data/datasets/seed";
import { isValidEmail, type DatasetSeed } from "../data/datasets/types";
import { datasetTagError } from "../schema/dataset-tag";
import { parseOwnerIds } from "./seed-config";
import { isSampleRequester } from "../data/access-requests/seed";
import { sampleAccessRequestsAllowed } from "./sample-access-requests.ts";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "letters, digits, - and _ only");
const required = z.string().trim().min(1, "required");

export const pilotConfigSchema = z
  .object({
    initiative: z.object({ id, name: required, tenant: required }).strict(),
    datasets: z
      .array(
        z
          .object({
            /** Defaults to `ds-` and the dataset tag, with `_` as `-`. */
            id: id.optional(),
            name: required,
            domainTag: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and -"),
            datasetTag: z.string().superRefine((tag, ctx) => {
              const error = datasetTagError(tag);
              if (error) ctx.addIssue({ code: "custom", message: error });
            }),
            owners: z
              .array(
                z
                  .object({
                    /** The owner's Databricks account (SCIM) ID. */
                    principalId: z.string().regex(/^\S+$/, "a Databricks account ID"),
                    displayName: required,
                    email: z.string().refine(isValidEmail, "an email address").optional(),
                  })
                  .strict(),
              )
              .min(1, "a dataset needs at least one owner"),
          })
          .strict(),
      )
      .min(1, "the pilot needs at least one dataset"),
  })
  .strict()
  .superRefine((config, ctx) => {
    const unique = (label: string, values: string[]) => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) ctx.addIssue({ code: "custom", message: `${label} ${value} repeats` });
        seen.add(value);
      }
    };
    unique("dataset id", config.datasets.map(datasetId));
    unique(
      "dataset tag",
      config.datasets.map((d) => d.datasetTag),
    );
    for (const d of config.datasets) {
      unique(
        `${d.datasetTag} owner`,
        d.owners.map((o) => o.principalId),
      );
    }
  });

export type PilotConfig = z.infer<typeof pilotConfigSchema>;

function datasetId(dataset: PilotConfig["datasets"][number]): string {
  return dataset.id ?? `ds-${dataset.datasetTag.replace(/_/g, "-")}`;
}

export class PilotConfigError extends Error {}

/** Parse `EDP_PILOT_CONFIG_JSON` into a seed. Throws {@link PilotConfigError} listing every problem. */
export function parsePilotConfig(raw: string): DatasetSeed {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new PilotConfigError(`EDP_PILOT_CONFIG_JSON isn't JSON: ${(error as Error).message}`);
  }
  const parsed = pilotConfigSchema.safeParse(json, ZOD3_PARSE_OPTIONS);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(top level)"}: ${zod3IssueMessage(issue)}`,
    );
    throw new PilotConfigError(`EDP_PILOT_CONFIG_JSON is invalid: ${problems.join("; ")}`);
  }
  const { initiative, datasets } = parsed.data;
  return {
    initiatives: [
      { id: initiative.id, name: initiative.name, tenant: initiative.tenant, stage: "active" },
    ],
    datasets: datasets.map((d) => ({
      id: datasetId(d),
      initiativeId: initiative.id,
      name: d.name,
      domainTag: d.domainTag,
      datasetTag: d.datasetTag,
      owners: d.owners.map((o) => ({
        principalId: o.principalId,
        displayName: o.displayName,
        ...(o.email ? { email: o.email } : {}),
      })),
    })),
  };
}

export interface ConfiguredSeed {
  seed: DatasetSeed;
  /** Recorded on the load's `created` action; `null` when there's nothing to load. */
  source: "pilot-config" | "preview-sample" | null;
}

const NOTHING: DatasetSeed = { initiatives: [], datasets: [] };

/** The bundle's default for `pilot_config_json`: no pilot configuration. */
export const NO_PILOT_CONFIG = "none";

/** The seed this deployment loads into Delta, from its env values. */
export function configuredSeed(env: {
  pilotConfigJson: string | undefined;
  schemaPrefix: string | undefined;
  seedOwnerIds: string | undefined;
  /** `EDP_SAMPLE_ACCESS_REQUESTS`, raw. */
  sampleAccessRequests?: string | undefined;
}): ConfiguredSeed {
  const configured = chooseSeed(env);
  if (!sampleAccessRequestsAllowed(env.sampleAccessRequests, env.schemaPrefix)) {
    refuseSampleOwners(
      configured.seed,
      configured.source === "pilot-config" ? "EDP_PILOT_CONFIG_JSON" : "EDP_SEED_DATASET_OWNER_IDS",
    );
  }
  return configured;
}

function chooseSeed(env: Parameters<typeof configuredSeed>[0]): ConfiguredSeed {
  if (env.pilotConfigJson && env.pilotConfigJson.trim() !== NO_PILOT_CONFIG) {
    return { seed: parsePilotConfig(env.pilotConfigJson), source: "pilot-config" };
  }
  if (env.schemaPrefix) {
    return {
      seed: withConfiguredOwners(DEFAULT_DATASET_SEED, parseOwnerIds(env.seedOwnerIds)),
      source: "preview-sample",
    };
  }
  return { seed: NOTHING, source: null };
}

/** The `<dataset> owner <name>` of every configured owner who's a sample requester (#312). */
export function sampleOwners(seed: DatasetSeed): string[] {
  return seed.datasets.flatMap((d) =>
    d.owners.filter((o) => isSampleRequester(o)).map((o) => `${d.id} owner ${o.displayName}`),
  );
}

function refuseSampleOwners(seed: DatasetSeed, setting: string): void {
  const found = sampleOwners(seed);
  if (found.length) {
    throw new PilotConfigError(
      `${setting} is invalid: ${found.join("; ")}: a sample identity, refused outside a PR preview's sample mode (#312).`,
    );
  }
}
