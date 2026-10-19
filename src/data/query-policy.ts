/**
 * How long the app trusts what it has already read (#80).
 *
 * On Delta every read is a warehouse round trip (about 0.4-1.3 s), and React
 * Query's own defaults (stale at once, refetch on every mount, focus and
 * reconnect) re-read on every navigation. This module is the one place that
 * says, per kind of data, how long a read stays fresh. The router builds its
 * client with {@link createQueryClient}; hooks don't set freshness themselves,
 * except the two config reads that keep `staleTime: Infinity` (see below).
 *
 * While a read is fresh, mounting a screen shows the cache and makes no call.
 * Once it's stale, mounting a screen still shows the cache at once and
 * re-reads in the background; screens gate "Loading…" on `isPending`, which is
 * true only when there's no data at all. Writes don't wait for staleness:
 * every mutation hook sets or invalidates the keys it changed, so a person
 * always sees their own change straight away.
 *
 * | Kind            | Keys (prefix match)                                                        | staleTime | gcTime | Why                                                                                                  |
 * | --------------- | -------------------------------------------------------------------------- | --------- | ------ | ---------------------------------------------------------------------------------------------------- |
 * | (default)       | anything not below                                                         | 60 s      | 10 min | One navigation's worth of reuse; nothing goes unread for long.                                        |
 * | reference       | `catalog`, `status/stages`, `datasets/initiatives`                         | 10 min    | 30 min | Catalog and config: changed by admins, rarely, and never by the person browsing.                     |
 * | session         | `catalog/user`                                                             | 5 min     | 30 min | Who you are and your groups. Display only: the server takes the actor from the session on every call. |
 * | dataset catalog | `datasets` (list, detail)                                                  | 5 min     | 30 min | Owners and descriptions. Team writes invalidate them, so your own change shows at once.              |
 * | team            | `datasets/list/member-summary`, `datasets/members`, `datasets/team-events` | 60 s      | 10 min | Team membership facts that co-owners edit. Your own writes invalidate them.                          |
 * | own records     | `eir/person`, `requests`, `status`, `access-requests/mine`, `onboarding/*` | 30 s      | 10 min | Yours, but staff act on them; short so their decision shows soon.                                    |
 * | inbox           | `eir/inbox`, `requests/pipeline`, `access-requests/inbox`, `change-list`   | 15 s      | 10 min | Work queues others add to. Short, plus a Refresh button on each inbox and the change list.           |
 *
 * `staleTime: Infinity` stays only on `access-requests/settings` and
 * `datasets/role-descriptions` (set in their hooks): they're checked-in
 * configuration that no write changes.
 *
 * Window focus never refetches: a Delta read per tab switch bought nothing.
 * Reconnect does, since the data may have moved on while offline. Retry is
 * React Query's own; EIR reads keep their own retry policy in their hooks.
 */
import { QueryClient, type QueryKey } from "@tanstack/react-query";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const QUERY_DEFAULTS = {
  staleTime: 60 * SECOND,
  gcTime: 10 * MINUTE,
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
} as const;

export type FreshnessKind =
  "reference" | "session" | "dataset catalog" | "team" | "own records" | "inbox";

export interface FreshnessRule {
  kind: FreshnessKind;
  /** A key prefix: it covers every query key that starts with it. */
  key: QueryKey;
  staleTime: number;
  gcTime: number;
}

const FRESHNESS: Record<FreshnessKind, { staleTime: number; gcTime: number }> = {
  reference: { staleTime: 10 * MINUTE, gcTime: 30 * MINUTE },
  session: { staleTime: 5 * MINUTE, gcTime: 30 * MINUTE },
  "dataset catalog": { staleTime: 5 * MINUTE, gcTime: 30 * MINUTE },
  team: { staleTime: 60 * SECOND, gcTime: 10 * MINUTE },
  "own records": { staleTime: 30 * SECOND, gcTime: 10 * MINUTE },
  inbox: { staleTime: 15 * SECOND, gcTime: 10 * MINUTE },
};

const rule = (kind: FreshnessKind, key: QueryKey): FreshnessRule => ({
  kind,
  key,
  ...FRESHNESS[kind],
});

/**
 * The table above, as data. React Query merges every matching prefix in
 * registration order, so each family's general prefix comes before its
 * narrower ones.
 */
export const FRESHNESS_POLICY: readonly FreshnessRule[] = [
  rule("reference", ["catalog"]),
  rule("session", ["catalog", "user"]),
  rule("dataset catalog", ["datasets"]),
  rule("team", ["datasets", "list", "member-summary"]),
  rule("reference", ["datasets", "initiatives"]),
  rule("team", ["datasets", "members"]),
  rule("team", ["datasets", "team-events"]),
  rule("own records", ["requests"]),
  rule("inbox", ["requests", "pipeline"]),
  rule("own records", ["status"]),
  rule("reference", ["status", "stages"]),
  rule("own records", ["eir", "person"]),
  rule("inbox", ["eir", "inbox"]),
  rule("own records", ["access-requests", "mine"]),
  rule("inbox", ["access-requests", "inbox"]),
  rule("own records", ["onboarding", "mine"]),
  rule("own records", ["onboarding", "detail"]),
  rule("inbox", ["onboarding", "inbox"]),
  rule("inbox", ["change-list"]),
];

const startsWith = (key: QueryKey, prefix: QueryKey) =>
  prefix.length <= key.length && prefix.every((part, i) => part === key[i]);

/** The kind of data a query key holds under the policy, or `undefined` for the default. */
export function freshnessKind(key: QueryKey): FreshnessKind | undefined {
  return FRESHNESS_POLICY.filter((r) => startsWith(key, r.key)).at(-1)?.kind;
}

/** The app's QueryClient: the defaults above plus one query default per table row. */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { ...QUERY_DEFAULTS } } });
  for (const { key, staleTime, gcTime } of FRESHNESS_POLICY) {
    client.setQueryDefaults(key, { staleTime, gcTime });
  }
  return client;
}
