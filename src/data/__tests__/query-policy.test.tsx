import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accessRequestQueryKeys } from "../access-requests/queries";
import { createMemoryStore } from "../adapters/memory";
import { createDeltaStore, httpTransport } from "../adapters/delta";
import {
  datasetQueryKeys,
  prefetchDatasetTeam,
  prefetchDatasetsScreen,
  useDataset,
  useDatasetMembers,
  useDatasetSummaries,
  useDatasets,
  useRoleDescriptions,
} from "../datasets/queries";
import { teamQueryKeys, useTeamEvents } from "../datasets/team-queries";
import { onboardingKeys } from "../onboarding/queries";
import { queryKeys, useRequests, useSubmitRequest } from "../queries";
import {
  FRESHNESS_POLICY,
  QUERY_DEFAULTS,
  createQueryClient,
  freshnessKind,
} from "../query-policy";
import { StoreProvider } from "../store-provider";
import type { AccessRequest } from "../types";
import { DATASET_ID } from "./dataset-fixture";
import { makeNewRequest, makeSnapshot } from "./fixture";

/**
 * A fake of the app server behind the real {@link httpTransport}: it answers
 * the requests-and-statuses read and the cart-request create, and records every URL so
 * a test can count `/api/reads` calls exactly as the browser would make them.
 */
function fakeDeltaServer(initial: AccessRequest[]) {
  const requests = structuredClone(initial);
  const calls: string[] = [];
  let hold: Promise<void> | undefined;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/reads/requests/statuses") {
      if (hold) await hold;
      return json({ requests, statuses: {} });
    }
    if (url === "/api/legacy-writes/requests/create-request") {
      const { payload } = JSON.parse(String(init?.body)) as { payload: AccessRequest };
      requests.unshift(payload);
      return json({ result: payload });
    }
    return new Response(JSON.stringify({ error: { code: "not-found" } }), { status: 404 });
  };
  return {
    store: createDeltaStore({ transport: httpTransport(request) }),
    reads: () => calls.filter((c) => c.startsWith("GET /api/reads/")).length,
    /** Hold reads until the returned function is called. */
    holdReads: () => {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

function wrapperFor(client: QueryClient, server: ReturnType<typeof fakeDeltaServer>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <StoreProvider store={server.store}>{children}</StoreProvider>
      </QueryClientProvider>
    );
  };
}

function useRequestsAndSubmit() {
  return { list: useRequests(), submit: useSubmitRequest() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the freshness policy is what the app's QueryClient uses", () => {
  it("sets the app-wide defaults", () => {
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(defaults).toMatchObject(QUERY_DEFAULTS);
    expect(defaults?.staleTime).toBeGreaterThan(0);
    expect(defaults?.refetchOnWindowFocus).toBe(false);
    expect(defaults?.refetchOnReconnect).toBe(true);
    // Retry stays React Query's own (EIR reads set theirs per hook).
    expect(defaults).not.toHaveProperty("retry");
  });

  it("registers every row of the table, and each row's key resolves to that row", () => {
    const client = createQueryClient();
    for (const rule of FRESHNESS_POLICY) {
      expect(client.getQueryDefaults(rule.key), rule.kind).toMatchObject({
        staleTime: rule.staleTime,
        gcTime: rule.gcTime,
      });
    }
  });

  it("classifies each hook's key by its kind of data", () => {
    expect(freshnessKind(queryKeys.catalog)).toBe("reference");
    expect(freshnessKind(queryKeys.stages())).toBe("reference");
    expect(freshnessKind(queryKeys.user())).toBe("session");
    expect(freshnessKind(datasetQueryKeys.datasetList())).toBe("dataset catalog");
    expect(freshnessKind(datasetQueryKeys.datasetSummaries())).toBe("team");
    expect(freshnessKind(datasetQueryKeys.dataset("d1"))).toBe("dataset catalog");
    expect(freshnessKind(datasetQueryKeys.initiatives())).toBe("reference");
    expect(freshnessKind(datasetQueryKeys.members("d1"))).toBe("team");
    expect(freshnessKind(teamQueryKeys.events("d1"))).toBe("team");
    expect(freshnessKind(queryKeys.eir("p1"))).toBe("own records");
    expect(freshnessKind(queryKeys.requestList())).toBe("own records");
    expect(freshnessKind(queryKeys.statusAll())).toBe("own records");
    expect(freshnessKind(queryKeys.myAccess())).toBe("own records");
    expect(freshnessKind(accessRequestQueryKeys.mine())).toBe("own records");
    expect(freshnessKind(onboardingKeys.mine())).toBe("own records");
    expect(freshnessKind(onboardingKeys.detail("o1"))).toBe("own records");
    expect(freshnessKind(queryKeys.eirInbox())).toBe("inbox");
    expect(freshnessKind(queryKeys.pipeline())).toBe("inbox");
    expect(freshnessKind(accessRequestQueryKeys.inbox())).toBe("inbox");
    expect(freshnessKind(onboardingKeys.inbox("ccb"))).toBe("inbox");
    expect(freshnessKind(datasetQueryKeys.changeList)).toBe("inbox");
  });

  it("is the client the router hands the app", async () => {
    const { getRouter } = await import("../../router");
    const client = getRouter().options.context.queryClient;
    expect(client.getDefaultOptions().queries).toMatchObject(QUERY_DEFAULTS);
    for (const rule of FRESHNESS_POLICY) {
      expect(client.getQueryDefaults(rule.key)).toMatchObject({ staleTime: rule.staleTime });
    }
  });

  type QueryFreshnessOptions = { staleTime?: unknown; gcTime?: unknown };

  const queryOptions = (client: QueryClient, queryKey: readonly unknown[]) => {
    const query = client.getQueryCache().find({ queryKey });
    expect(query, queryKey.join("/")).toBeDefined();
    return query!.options as QueryFreshnessOptions;
  };

  const policyOptions = (client: QueryClient, queryKey: readonly unknown[]) =>
    client.getQueryDefaults(queryKey);

  it.each([
    {
      label: "dataset list hook",
      queryKey: datasetQueryKeys.datasetList(),
      expected: "policy",
      load: async (client: QueryClient, wrapper: (props: { children: ReactNode }) => ReactNode) => {
        const rendered = renderHook(useDatasets, { wrapper });
        await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
      },
    },
    {
      label: "dataset detail hook",
      queryKey: datasetQueryKeys.dataset(DATASET_ID),
      expected: "policy",
      load: async (client: QueryClient, wrapper: (props: { children: ReactNode }) => ReactNode) => {
        const rendered = renderHook(() => useDataset(DATASET_ID), { wrapper });
        await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
      },
    },
    {
      label: "dataset summaries hook",
      queryKey: datasetQueryKeys.datasetSummaries(),
      expected: "policy",
      load: async (client: QueryClient, wrapper: (props: { children: ReactNode }) => ReactNode) => {
        const rendered = renderHook(useDatasetSummaries, { wrapper });
        await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
      },
    },
    {
      label: "dataset members hook",
      queryKey: datasetQueryKeys.members(DATASET_ID),
      expected: "policy",
      load: async (client: QueryClient, wrapper: (props: { children: ReactNode }) => ReactNode) => {
        const rendered = renderHook(() => useDatasetMembers(DATASET_ID), { wrapper });
        await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
      },
    },
    {
      label: "team events hook",
      queryKey: teamQueryKeys.events(DATASET_ID),
      expected: "policy",
      load: async (client: QueryClient, wrapper: (props: { children: ReactNode }) => ReactNode) => {
        const rendered = renderHook(() => useTeamEvents(DATASET_ID), { wrapper });
        await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
      },
    },
    {
      label: "role descriptions hook",
      queryKey: datasetQueryKeys.roleDescriptions(),
      expected: Infinity,
      load: async (client: QueryClient, wrapper: (props: { children: ReactNode }) => ReactNode) => {
        const rendered = renderHook(useRoleDescriptions, { wrapper });
        await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
      },
    },
    {
      label: "Datasets screen prefetch",
      queryKey: datasetQueryKeys.datasetSummaries(),
      expected: "policy",
      load: async (client: QueryClient) => {
        await prefetchDatasetsScreen(client, createMemoryStore(makeSnapshot()));
      },
    },
    {
      label: "dataset team prefetch: detail",
      queryKey: datasetQueryKeys.dataset(DATASET_ID),
      expected: "policy",
      load: async (client: QueryClient) => {
        await prefetchDatasetTeam(client, createMemoryStore(makeSnapshot()), DATASET_ID);
      },
    },
    {
      label: "dataset team prefetch: members",
      queryKey: datasetQueryKeys.members(DATASET_ID),
      expected: "policy",
      load: async (client: QueryClient) => {
        await prefetchDatasetTeam(client, createMemoryStore(makeSnapshot()), DATASET_ID);
      },
    },
    {
      label: "dataset team prefetch: role descriptions",
      queryKey: datasetQueryKeys.roleDescriptions(),
      expected: Infinity,
      load: async (client: QueryClient) => {
        await prefetchDatasetTeam(client, createMemoryStore(makeSnapshot()), DATASET_ID);
      },
    },
  ] as const)(
    "$label uses the freshness policy on the actual cached query",
    async ({ queryKey, expected, load }) => {
      const client = createQueryClient();
      const store = createMemoryStore(makeSnapshot());
      const wrapper = function Wrapper({ children }: { children: ReactNode }) {
        return (
          <QueryClientProvider client={client}>
            <StoreProvider store={store}>{children}</StoreProvider>
          </QueryClientProvider>
        );
      };

      await load(client, wrapper);

      const options = queryOptions(client, queryKey);
      const expectedOptions = expected === "policy" ? policyOptions(client, queryKey) : undefined;
      expect(options.staleTime).toBe(expected === "policy" ? expectedOptions?.staleTime : expected);
      if (expected === "policy") expect(options.gcTime).toBe(expectedOptions?.gcTime);
    },
  );

  it("keeps dataset summaries fresh for the policy window, not a hook-local staleTime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = createMemoryStore(makeSnapshot());
    const listDatasetSummaries = vi.spyOn(store.datasets, "listDatasetSummaries");
    const client = createQueryClient();
    const wrapper = function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <StoreProvider store={store}>{children}</StoreProvider>
        </QueryClientProvider>
      );
    };

    const first = renderHook(useDatasetSummaries, { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(listDatasetSummaries).toHaveBeenCalledTimes(1);
    first.unmount();

    const staleTime = client.getQueryDefaults(datasetQueryKeys.datasetSummaries())
      .staleTime as number;
    vi.setSystemTime(Date.now() + staleTime - 1);
    const back = renderHook(useDatasetSummaries, { wrapper });
    expect(back.result.current.isPending).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(listDatasetSummaries).toHaveBeenCalledTimes(1);
  });
});

describe("reads through the Delta transport under the policy", () => {
  it("navigating away and back within the stale window makes no new /api/reads call", async () => {
    const server = fakeDeltaServer(makeSnapshot().requests);
    const client = createQueryClient();
    const wrapper = wrapperFor(client, server);

    const first = renderHook(useRequests, { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(server.reads()).toBe(1);
    first.unmount();

    const back = renderHook(useRequests, { wrapper });
    // Cached data shows on the first render: no "Loading…".
    expect(back.result.current.isPending).toBe(false);
    expect(back.result.current.data?.map((r) => r.id)).toEqual(["REQ-2038", "REQ-2052"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.reads()).toBe(1);
  });

  it("a stale key shows cached data and revalidates in the background", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = fakeDeltaServer(makeSnapshot().requests);
    const client = createQueryClient();
    const wrapper = wrapperFor(client, server);

    const first = renderHook(useRequests, { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const staleTime = client.getQueryDefaults(queryKeys.requestList()).staleTime as number;
    vi.setSystemTime(Date.now() + staleTime + 1);
    const release = server.holdReads();

    const back = renderHook(useRequests, { wrapper });
    expect(back.result.current.data).toHaveLength(2);
    await waitFor(() => expect(back.result.current.isFetching).toBe(true));
    expect(back.result.current.isPending).toBe(false);
    expect(server.reads()).toBe(2);

    release();
    await waitFor(() => expect(back.result.current.isFetching).toBe(false));
    expect(back.result.current.data).toHaveLength(2);
  });

  it("after a write, the person's own list re-reads at once and shows their change", async () => {
    const server = fakeDeltaServer(makeSnapshot().requests);
    const client = createQueryClient();
    const { result } = renderHook(useRequestsAndSubmit, {
      wrapper: wrapperFor(client, server),
    });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(server.reads()).toBe(1);

    await act(async () => {
      await result.current.submit.mutateAsync(makeNewRequest());
    });

    // Fresh by the policy, yet invalidated by the write: re-read, not served from cache.
    await waitFor(() => expect(server.reads()).toBe(2));
    await waitFor(() => expect(result.current.list.data?.[0]?.id).toBe("REQ-9001"));
  });
});
