import { z } from "zod";

import { createDeltaGroupMembershipReader } from "../../group-membership";
import type { MembershipVisibility } from "../../../data/group-membership";
import type { Registry, SessionUser, ReadFn } from "../registry.ts";
import type { StoreNames } from "../sql-builder.ts";
import type { SqlClient } from "../sql-client.ts";

export interface MembershipAreaConfig {
  catalog: string;
  schema: string;
}

export function membershipReaderFor(
  config: MembershipAreaConfig,
  user: SessionUser,
  names: StoreNames,
  read: ReadFn,
) {
  const client = {
    execute: (async (statement: Parameters<SqlClient["execute"]>[0]) => ({
      rows: await read(statement),
      numAffectedRows: null,
    })) as SqlClient["execute"],
  };
  const visibility = async (): Promise<MembershipVisibility> => {
    if (user.isAdmin) return { edpStaff: true };
    const rows = await read<{ domain: string; dataset_tag: string }>({
      statement: `SELECT DISTINCT d.domain_tag AS domain, d.dataset_tag FROM ${names.table("initiatives", "datasets")} d JOIN ${names.table("teams", "dataset_owners")} o ON o.dataset_id = d.id WHERE o.person_principal_id = :principalId`,
      parameters: { principalId: user.principalId },
    });
    return {
      edpStaff: false,
      domains: [...new Set(rows.map((row) => row.domain))],
      datasetTags: [...new Set(rows.map((row) => row.dataset_tag))],
    };
  };
  return createDeltaGroupMembershipReader({ ...config, client, visibility });
}

export function registerMembershipArea(registry: Registry, config: MembershipAreaConfig): void {
  registry.read({
    area: "membership",
    name: "memberships",
    app: "tenant",
    query: z
      .object({
        includeRemoved: z
          .literal("true", { error: 'Invalid literal value, expected "true"' })
          .optional(),
      })
      .strict(),
    run: ({ query, user, names, read }) =>
      membershipReaderFor(config, user, names, read).listMemberships({
        includeRemoved: query.includeRemoved === "true",
      }),
  });
  registry.read({
    area: "membership",
    name: "history",
    app: "tenant",
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        cursorVersion: z.coerce.number().int().min(0).optional(),
        cursorGroupId: z.string().min(1).optional(),
        cursorUserId: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (query) =>
          [query.cursorVersion, query.cursorGroupId, query.cursorUserId].every(
            (value) => value === undefined,
          ) ||
          [query.cursorVersion, query.cursorGroupId, query.cursorUserId].every(
            (value) => value !== undefined,
          ),
        { message: "History cursor fields must be provided together" },
      ),
    run: ({ query, user, names, read }) =>
      membershipReaderFor(config, user, names, read).listHistory({
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursorVersion === undefined
          ? {}
          : {
              cursor: {
                commitVersion: query.cursorVersion,
                groupId: query.cursorGroupId!,
                userId: query.cursorUserId!,
              },
            }),
      }),
  });
  registry.read({
    area: "membership",
    name: "latest-run",
    app: "tenant",
    query: z.object({}).strict(),
    run: ({ user, names, read }) => membershipReaderFor(config, user, names, read).latestRun(),
  });
}
