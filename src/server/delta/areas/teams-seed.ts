/**
 * Loads the datasets and owners from deployment configuration (the pilot
 * configuration, or a preview's sample seed: see src/server/pilot-config.ts)
 * into Delta once (#123): per initiative, one command by `system` that
 * records the initiative `created`, with where its configuration came from,
 * its datasets `created`, and their owners and owners' Maintainer (stored as `manager`) roles `added`.
 *
 * Idempotent three ways: an initiative already in Delta is skipped; the
 * command's idempotency key derives from the initiative's ID, so two servers
 * loading at once write it once; and a key already used with a different
 * configuration (owners changed after the first load) leaves Delta as it is.
 * After the first load, owners are managed in the app.
 *
 * Not an API endpoint: the server runs it before serving these areas.
 *
 * A sample requester as an owner refuses the whole load, before any write,
 * unless sample mode is on for the store (#312). The configuration is
 * refused before this too (src/server/pilot-config.ts); this is for any
 * other caller.
 */
import { z } from "zod";

import {
  validateGroupNames,
  validateGroupNaming,
  DEFAULT_GROUP_NAMING,
  type GroupNamingConfig,
} from "../../../data/datasets/group-naming";
import { normalizeEmail, type DatasetSeed } from "../../../data/datasets/types";
import { DomainError, IdempotencyKeyReusedError } from "../errors.ts";
import { sampleOwners } from "../../pilot-config.ts";
import { sampleAccessRequestsForStore } from "../../sample-access-requests.ts";
import { uuidV5 } from "../ids.ts";
import type { CommandDefinition, SessionUser } from "../registry.ts";
import type { StoreNames } from "../sql-builder.ts";
import type { TransactionRunner } from "../transaction.ts";
import {
  followOn,
  insertAction,
  insertCurrentState,
  SYSTEM_ACTOR,
  type ActionTableRef,
  type WriteContext,
} from "../write-helpers.ts";
import {
  DATASET_ACTIONS,
  DATASETS,
  INITIATIVE_ACTIONS,
  INITIATIVES,
  MEMBER_ACTIONS,
  MEMBERS,
  OWNER_ACTIONS,
  OWNERS,
  REPLAN,
  insertStateRows,
} from "./teams-model.ts";

/** Namespace for the configured initiatives' idempotency keys. */
const SEED_NAMESPACE = "6f1c2b0e-7a43-5d6e-9b1a-2c3d4e5f6a7b";

const SYSTEM_USER: SessionUser = {
  principalId: SYSTEM_ACTOR.principalId,
  displayName: SYSTEM_ACTOR.display,
  email: "",
  isAdmin: false,
  onboardingReviewerRoles: [],
};

type ConfiguredInitiative = {
  initiative: DatasetSeed["initiatives"][number];
  datasets: DatasetSeed["datasets"];
  source: ConfiguredSource;
};

/** Where a load's configuration came from, kept on its `created` action. */
export type ConfiguredSource = "pilot-config" | "preview-sample" | "configuration";

const SOURCE_NOTES: Record<ConfiguredSource, string> = {
  "pilot-config": "Loaded from the pilot configuration (EDP_PILOT_CONFIG_JSON).",
  "preview-sample": "Loaded from the preview's sample datasets (not for production).",
  configuration: "Loaded from deployment configuration.",
};

function configurationError(message: string): DomainError {
  return new DomainError("configuration-invalid", message, 500);
}

const LOAD: CommandDefinition<ConfiguredInitiative, { id: string }> = {
  kind: "command",
  area: "initiatives",
  name: "load-configured",
  app: "staff",
  // Never routed: the server runs this itself, as `system`.
  authorize: () => {
    throw new DomainError("forbidden", "Not an API command.", 403);
  },
  payload: z.custom<ConfiguredInitiative>(),
  leadActionTable: INITIATIVE_ACTIONS,
  async plan(ctx) {
    const { initiative, datasets, source } = ctx.payload;
    const { block, names } = ctx;
    block.signal(
      `EXISTS (SELECT 1 FROM ${names.table(INITIATIVES.schema, INITIATIVES.table)} WHERE id = ${block.bind(initiative.id)})`,
      REPLAN,
      "edp:configured-initiative-exists",
    );
    if (datasets.length) {
      block.guard(
        `EXISTS (SELECT 1 FROM ${names.table(DATASETS.schema, DATASETS.table)} WHERE id IN (${datasets.map((d) => block.bind(d.id)).join(", ")}) OR dataset_tag IN (${datasets.map((d) => block.bind(d.datasetTag)).join(", ")}))`,
        configurationError("A configured dataset's ID or dataset tag is already taken."),
      );
    }
    let position = 0;
    const next = () => followOn(ctx, position++);
    insertCurrentState(ctx, INITIATIVES, initiative.id, {
      onboarding_request_id: null,
      name: initiative.name,
      tenant: initiative.tenant,
      stage: initiative.stage,
    });

    insertStateRows(
      ctx,
      DATASETS,
      datasets.map((d) => ({
        id: d.id,
        columns: {
          initiative_id: d.initiativeId,
          name: d.name,
          domain_tag: d.domainTag,
          dataset_tag: d.datasetTag,
        },
      })),
    );
    for (const d of datasets) await follow(ctx, DATASET_ACTIONS, await next(), d.id, "created");

    const owners: {
      id: string;
      datasetId: string;
      owner: DatasetSeed["datasets"][number]["owners"][number];
    }[] = [];
    for (const d of datasets) {
      for (const owner of d.owners) owners.push({ id: await next(), datasetId: d.id, owner });
    }
    const person = (owner: (typeof owners)[number]["owner"]) => {
      const email = owner.email ? normalizeEmail(owner.email) : null;
      if (!email && !owner.principalId) {
        throw configurationError(
          `A configured owner of a dataset (${owner.displayName}) has no email or Databricks account ID.`,
        );
      }
      return { email, principalId: owner.principalId ?? null };
    };
    insertStateRows(
      ctx,
      OWNERS,
      owners.map(({ id, datasetId, owner }) => ({
        id,
        columns: {
          dataset_id: datasetId,
          source: "configuration",
          person_display: owner.displayName,
          person_email: person(owner).email,
          person_principal_id: person(owner).principalId,
          bound_at: null,
        },
      })),
    );
    const members: { id: string; datasetId: string; owner: (typeof owners)[number]["owner"] }[] =
      [];
    for (const o of owners)
      members.push({ id: await next(), datasetId: o.datasetId, owner: o.owner });
    // ADR-0005: every owner holds the Maintainer (stored as `manager`) role. Standup puts
    // them in its group outside the app, so nothing goes on the change list.
    insertStateRows(
      ctx,
      MEMBERS,
      members.map(({ id, datasetId, owner }) => ({
        id,
        columns: {
          dataset_id: datasetId,
          role: "manager",
          source: "configuration",
          person_display: owner.displayName,
          person_email: person(owner).email,
          person_principal_id: person(owner).email ? null : person(owner).principalId,
        },
      })),
    );
    for (const o of owners) {
      const p = person(o.owner);
      await follow(ctx, OWNER_ACTIONS, await next(), o.id, "added", {
        datasetId: o.datasetId,
        person: { name: o.owner.displayName, email: p.email },
      });
    }
    for (const m of members) {
      const p = person(m.owner);
      await follow(
        ctx,
        MEMBER_ACTIONS,
        await next(),
        m.id,
        "added",
        {
          datasetId: m.datasetId,
          person: {
            name: m.owner.displayName,
            email: p.email ?? "",
            ...(p.email ? {} : { principalId: p.principalId }),
          },
        },
        { role: [null, "manager"] },
      );
    }
    return {
      recordId: initiative.id,
      recordVersion: 1,
      leadAction: {
        action: "created",
        change: { stage: [null, initiative.stage] },
        note: SOURCE_NOTES[source],
        payload: { source },
      },
    };
  },
  resultRow: ({ recordId, names, block }) =>
    `SELECT id FROM ${names.table(INITIATIVES.schema, INITIATIVES.table)} WHERE id = ${block.bind(recordId)}`,
  result: (row) => ({ id: row["id"] as string }),
};

async function follow(
  ctx: WriteContext,
  table: ActionTableRef,
  actionId: string,
  recordId: string,
  action: string,
  payload?: unknown,
  change?: Record<string, [string | null, string | null]>,
) {
  insertAction(ctx, table, {
    actionId,
    recordId,
    action,
    recordVersion: 1,
    ...(payload ? { payload } : {}),
    ...(change ? { change } : {}),
  });
}

export interface ConfiguredDatasetsOptions {
  runner: TransactionRunner;
  names: StoreNames;
  groupNaming?: GroupNamingConfig;
  /** Recorded on each initiative's `created` action. */
  source?: ConfiguredSource;
  /** Whether sample access requests are on for the store; the env and its prefix by default (#312). */
  sampleAccessRequests?: (names: StoreNames) => boolean;
}

/** Load every configured initiative not in Delta yet. */
export async function loadConfiguredDatasets(
  seed: DatasetSeed,
  options: ConfiguredDatasetsOptions,
): Promise<void> {
  const naming = validateGroupNaming(structuredClone(options.groupNaming ?? DEFAULT_GROUP_NAMING));
  try {
    validateGroupNames(naming, seed.datasets);
  } catch (error) {
    throw configurationError((error as Error).message);
  }
  const found = sampleOwners(seed);
  if (
    found.length &&
    !(options.sampleAccessRequests ?? sampleAccessRequestsForStore)(options.names)
  ) {
    throw configurationError(
      `The configured datasets name a sample identity, refused outside a PR preview's sample mode (#312): ${found.join("; ")}.`,
    );
  }
  const read = options.runner.reader({ readId: globalThis.crypto.randomUUID() });
  for (const initiative of seed.initiatives) {
    const [existing] = await read({
      statement: `SELECT id FROM ${options.names.table(INITIATIVES.schema, INITIATIVES.table)} WHERE id = :id`,
      parameters: { id: initiative.id },
    });
    if (existing) continue;
    try {
      await options.runner.runCommand(LOAD, {
        user: SYSTEM_USER,
        actor: SYSTEM_ACTOR,
        idempotencyKey: await uuidV5(SEED_NAMESPACE, `configured-initiative:${initiative.id}`),
        expectedVersion: 0,
        payload: {
          initiative,
          datasets: seed.datasets.filter((d) => d.initiativeId === initiative.id),
          source: options.source ?? "configuration",
        },
      });
    } catch (error) {
      // Loaded before with other configuration: Delta keeps what it has.
      if (!(error instanceof IdempotencyKeyReusedError)) throw error;
    }
  }
}

/**
 * Once per server: load the configured datasets before the first request to
 * these areas. A failure isn't remembered, so the next request tries again.
 */
export function configuredDatasetsLoader(
  seed: () => Promise<DatasetSeed> | DatasetSeed,
  options: ConfiguredDatasetsOptions,
): () => Promise<void> {
  let loading: Promise<void> | undefined;
  return () => {
    loading ??= (async () => {
      const configured = await seed();
      if (configured.initiatives.length) await loadConfiguredDatasets(configured, options);
    })().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
}

/** The API paths that need the configured datasets loaded first. */
export function needsConfiguredDatasets(pathname: string): boolean {
  return /^\/api\/(reads|commands)\/(initiatives|teams|change-list)\//.test(pathname);
}
