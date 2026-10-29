/**
 * TanStack Query hooks for datasets, dataset roles and the change list, in
 * front of the {@link DataStore} seam. Same pattern as src/data/queries.ts:
 * every read goes through Query; writes are optimistic saves
 * (src/data/optimistic-save.ts) that go through the seam and then refresh what
 * they changed.
 */
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ChangeListEntry } from "../change-list/types";
import { project, type SaveSpec } from "../optimistic-save";
import type { DataStore } from "../store";
import { useStore } from "../store-context";
import type { RoleDescriptions } from "./role-descriptions";
import type { AddMemberResult } from "./store";
import {
  normalizeEmail,
  type AddMemberInput,
  type Dataset,
  type DatasetMember,
  type DatasetWithMemberSummary,
  type Initiative,
} from "./types";

export const datasetQueryKeys = {
  datasets: ["datasets"] as const,
  initiatives: () => ["datasets", "initiatives"] as const,
  datasetList: () => ["datasets", "list"] as const,
  datasetSummaries: () => ["datasets", "list", "member-summary"] as const,
  dataset: (id: string) => ["datasets", "detail", id] as const,
  members: (datasetId: string) => ["datasets", "members", datasetId] as const,
  teamEvents: (datasetId: string) => ["datasets", "team-events", datasetId] as const,
  roleDescriptions: () => ["datasets", "role-descriptions"] as const,
  changeList: ["change-list"] as const,
};

const datasetSummariesQuery = (store: DataStore) => ({
  queryKey: datasetQueryKeys.datasetSummaries(),
  queryFn: () => store.datasets.listDatasetSummaries(),
});

const datasetQuery = (store: DataStore, id: string) => ({
  queryKey: datasetQueryKeys.dataset(id),
  queryFn: async () => (await store.datasets.getDataset(id)) ?? null,
});

const membersQuery = (store: DataStore, datasetId: string) => ({
  queryKey: datasetQueryKeys.members(datasetId),
  queryFn: () => store.datasetRoles.listMembers(datasetId),
});

const roleDescriptionsQuery = (store: DataStore) => ({
  queryKey: datasetQueryKeys.roleDescriptions(),
  queryFn: () => store.datasetRoles.describeRoles(),
  staleTime: Infinity,
});

const changeListQuery = (store: DataStore) => ({
  queryKey: datasetQueryKeys.changeList,
  queryFn: () => store.changeList.listEntries(),
});

export function useInitiatives(): UseQueryResult<Initiative[]> {
  const store = useStore();
  return useQuery({
    queryKey: datasetQueryKeys.initiatives(),
    queryFn: () => store.datasets.listInitiatives(),
  });
}

export function useDatasets(): UseQueryResult<Dataset[]> {
  const store = useStore();
  return useQuery({
    queryKey: datasetQueryKeys.datasetList(),
    queryFn: () => store.datasets.listDatasets(),
  });
}

export function useDatasetSummaries(): UseQueryResult<DatasetWithMemberSummary[]> {
  const store = useStore();
  return useQuery(datasetSummariesQuery(store));
}

/** One dataset, or `null` if it doesn't exist. */
export function useDataset(id: string): UseQueryResult<Dataset | null> {
  const store = useStore();
  return useQuery(datasetQuery(store, id));
}

export function useDatasetMembers(datasetId: string): UseQueryResult<DatasetMember[]> {
  const store = useStore();
  return useQuery(membersQuery(store, datasetId));
}

/** Members of several datasets at once, keyed by dataset id (shares each dataset's cache). */
export function useMembersByDataset(datasetIds: string[]): {
  data: Record<string, DatasetMember[]> | undefined;
  isPending: boolean;
  error: Error | null;
} {
  const store = useStore();
  const results = useQueries({
    queries: datasetIds.map((id) => ({
      queryKey: datasetQueryKeys.members(id),
      queryFn: () => store.datasetRoles.listMembers(id),
    })),
  });
  const error = results.find((r) => r.error)?.error ?? null;
  const isPending = results.some((r) => r.isPending);
  const data = isPending
    ? undefined
    : Object.fromEntries(datasetIds.map((id, i) => [id, results[i]?.data ?? []]));
  return { data, isPending, error };
}

/** What each dataset role grants, from configuration. */
export function useRoleDescriptions(): UseQueryResult<RoleDescriptions> {
  const store = useStore();
  return useQuery(roleDescriptionsQuery(store));
}

export function useChangeList(): UseQueryResult<ChangeListEntry[]> {
  const store = useStore();
  return useQuery(changeListQuery(store));
}

export function prefetchDatasetsScreen(queryClient: QueryClient, store: DataStore): Promise<void> {
  return queryClient.prefetchQuery(datasetSummariesQuery(store));
}

export async function prefetchDatasetTeam(
  queryClient: QueryClient,
  store: DataStore,
  datasetId: string,
): Promise<void> {
  await Promise.all([
    queryClient.prefetchQuery(datasetQuery(store, datasetId)),
    queryClient.prefetchQuery(membersQuery(store, datasetId)),
    queryClient.prefetchQuery(changeListQuery(store)),
    queryClient.prefetchQuery(roleDescriptionsQuery(store)),
  ]);
}

export function usePrefetchDatasetsScreen(): () => void {
  const queryClient = useQueryClient();
  const store = useStore();
  return () => {
    void prefetchDatasetsScreen(queryClient, store);
  };
}

export function usePrefetchDatasetTeam(): (datasetId: string) => void {
  const queryClient = useQueryClient();
  const store = useStore();
  return (datasetId) => {
    void prefetchDatasetTeam(queryClient, store, datasetId);
  };
}

/** The record a member save locks: one of a person's roles on one dataset. */
export const memberRecord = (datasetId: string, email: string, role: string) =>
  `member:${datasetId}:${normalizeEmail(email)}:${role}`;

/**
 * A dataset owner adds a person to a dataset role: an optimistic save
 * (ADR-0009 phase 1). Refusals surface on the save.
 */
export const addMemberSave: SaveSpec<
  AddMemberInput & { roleLabel: string; addedBy: string },
  AddMemberResult
> = {
  action: "add-member",
  refusedTitle: "That add was refused",
  record: (i) => memberRecord(i.datasetId, i.email, i.role),
  describe: (i) => `Add ${i.name.trim()} as ${i.roleLabel}`,
  describeSaved: (r, i) =>
    r.created
      ? `Added ${r.member.person.name} as ${i.roleLabel}. ` +
        `${r.entries.map((e) => e.id).join(", ")} is pending on the change list.`
      : `${r.member.person.email} already holds ${i.roleLabel}; nothing new was listed.`,
  run: (store, i) =>
    store.datasetRoles.addMember({
      datasetId: i.datasetId,
      name: i.name,
      email: i.email,
      role: i.role,
      idempotencyKey: i.idempotencyKey,
    }),
  projections: (i) => {
    const email = normalizeEmail(i.email);
    const others = (members: DatasetMember[]) =>
      members.filter((m) => !(m.person.email === email && m.role === i.role));
    return [
      project<DatasetMember[], typeof i, AddMemberResult>(
        datasetQueryKeys.members(i.datasetId),
        (members) =>
          members.some((m) => m.person.email === email && m.role === i.role)
            ? members
            : [
                ...members,
                {
                  datasetId: i.datasetId,
                  person: { name: i.name.trim(), email },
                  role: i.role,
                  addedBy: i.addedBy,
                  addedAt: new Date().toISOString(),
                },
              ],
        (members, r) => [...others(members), r.member],
      ),
    ];
  },
  // Team history too, like every other team write.
  invalidates: (i) => [
    datasetQueryKeys.members(i.datasetId),
    datasetQueryKeys.datasetSummaries(),
    datasetQueryKeys.changeList,
    datasetQueryKeys.teamEvents(i.datasetId),
  ],
};

/**
 * EDP staff mark a change-list entry applied. Synchronous, not an optimistic
 * save (ADR-0009 decision 2): it records that an access change was made in
 * Databricks, so nothing shows it applied until the server confirms, and the
 * screen keeps #182's blocking Saving…. Refusals surface as the mutation's error.
 */
export function useMarkChangeApplied(): UseMutationResult<
  ChangeListEntry,
  Error,
  { entryId: string; idempotencyKey?: string }
> {
  const store = useStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      store.changeList.markApplied(
        input.entryId,
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
      ),
    onSuccess: (entry) => {
      queryClient.setQueryData<ChangeListEntry[]>(datasetQueryKeys.changeList, (entries) =>
        entries?.map((existing) => (existing.id === entry.id ? entry : existing)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: datasetQueryKeys.changeList });
      // An applied onboard-user entry returns its owner to unmatched (#103).
      void queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    },
  });
}
