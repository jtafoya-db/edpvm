import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDeltaStore, type DeltaApiTransport } from "../adapters/delta";
import { createMemoryStore } from "../adapters/memory";
import { useLegacyAppData } from "../legacy-bridge";
import { useSubmitRequest } from "../queries";
import { StoreProvider } from "../store-provider";
import type { DataStore } from "../store";
import { makeNewRequest, makeSnapshot } from "./fixture";

/** Fresh QueryClient (no retries so errors surface) + StoreProvider bound to a store. */
function makeWrapper(store: DataStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>{children}</StoreProvider>
      </QueryClientProvider>
    );
  };
}

function useBridgeAndSubmit() {
  return { legacy: useLegacyAppData(), submit: useSubmitRequest() };
}

describe("useLegacyAppData — app-level wiring traverses an injected DataStore", () => {
  beforeEach(() => {
    // Poison window.AppData so any accidental global read would be obvious.
    (window as unknown as { AppData?: unknown }).AppData = {
      domains: [{ id: "WINDOW-LEAK", name: "SHOULD NOT APPEAR" }],
    };
  });
  afterEach(() => {
    delete (window as unknown as { AppData?: unknown }).AppData;
  });

  it("assembles catalog, request list and status timelines from the store, not window.AppData", async () => {
    const wrapper = makeWrapper(createMemoryStore(makeSnapshot()));
    const { result } = renderHook(useLegacyAppData, { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    const D = result.current.data!;

    // Catalog comes from the store (window.AppData held a WINDOW-LEAK domain).
    expect(D.domains.map((d) => d.id)).toEqual(["individual-filing", "modernized-efile"]);
    expect(D.domains.some((d) => d.id === "WINDOW-LEAK")).toBe(false);
    expect(D.bun("analyst-starter")?.name).toBe("Analyst Starter Pack");
    expect(D.user.initials).toBe("TA");

    // Request list from the store.
    expect(D.requests.map((r) => r.id)).toEqual(["REQ-2038", "REQ-2052"]);

    // Status timelines from the StatusStore projection.
    expect(D.statuses["REQ-2052"]?.overall).toBe("Provisioning failed");
    expect(D.statuses["REQ-2052"]?.subRequests.some((s) => s.status === "blocked")).toBe(true);
    expect(D.statuses["REQ-2052"]?.stages).toHaveLength(6);
  });

  it("surfaces a backend error instead of falling back to seed data", async () => {
    const failing = createMemoryStore(makeSnapshot());
    failing.catalog = {
      ...failing.catalog,
      listDomains: async () => {
        throw new Error("backend unavailable");
      },
    };
    const wrapper = makeWrapper(failing);
    const { result } = renderHook(useLegacyAppData, { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toMatch(/backend unavailable/);
  });

  it("submission traverses the store and the assembled list + status reflect it", async () => {
    const store = createMemoryStore(makeSnapshot());
    const wrapper = makeWrapper(store);
    const { result } = renderHook(useBridgeAndSubmit, { wrapper });

    await waitFor(() => expect(result.current.legacy.data).toBeDefined());
    expect(result.current.legacy.data!.requests).toHaveLength(2);

    await act(async () => {
      await result.current.submit.mutateAsync(makeNewRequest());
    });

    await waitFor(() => expect(result.current.legacy.data?.requests).toHaveLength(3));
    expect(result.current.legacy.data?.requests[0]?.id).toBe("REQ-9001");
    // The new request's status timeline becomes available through the seam.
    await waitFor(() => expect(result.current.legacy.data?.statuses["REQ-9001"]).toBeDefined());
    // The store itself holds it — the write traversed the DataStore, not local state.
    expect((await store.requests.listRequests()).some((r) => r.id === "REQ-9001")).toBe(true);
  });

  it.each([
    ["non-staff with no requests", false, []],
    ["non-staff with requests", false, makeSnapshot().requests],
    ["staff with no requests", true, []],
    ["staff with requests", true, makeSnapshot().requests],
  ])("uses bounded Delta read endpoints on first load: %s", async (_label, isAdmin, requests) => {
    const snapshot = { ...makeSnapshot(), requests };
    const calls: string[] = [];
    const transport: DeltaApiTransport = {
      read: (async <T,>(area: string, name: string): Promise<T> => {
        calls.push(`${area}/${name}`);
        if (`${area}/${name}` === "catalog/bootstrap") {
          return {
            domains: snapshot.domains,
            datasets: snapshot.datasets,
            bundles: snapshot.bundles,
            systems: snapshot.systems,
            personas: snapshot.onboardingPersonas,
            tenants: isAdmin ? snapshot.tenants : [],
          } as T;
        }
        if (`${area}/${name}` === "requests/statuses") {
          return {
            requests: snapshot.requests,
            statuses: Object.fromEntries(
              snapshot.requests.map((request) => [
                request.id,
                {
                  requestId: request.id,
                  status: request.status,
                  overall: request.overall,
                  stageIndex: request.stageIndex,
                  stages: snapshot.STAGES,
                  subRequests: request.subRequests,
                },
              ]),
            ),
          } as T;
        }
        if (`${area}/${name}` === "access/my-access") return snapshot.myAccess as T;
        if (`${area}/${name}` === "requests/pipeline") return snapshot.pipeline as T;
        throw new Error(`unexpected read ${area}/${name}`);
      }) as DeltaApiTransport["read"],
      command: async () => {
        throw new Error("unexpected command");
      },
      legacyWrite: async () => {
        throw new Error("unexpected legacy write");
      },
    };
    const store = createDeltaStore({
      transport,
      stages: () => snapshot.STAGES,
      domains: () => snapshot.domains,
      accessStores: { currentUser: async () => ({ ...snapshot.user, isAdmin }) },
    });
    const wrapper = makeWrapper(store);
    const { result } = renderHook(useLegacyAppData, { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    const expected = isAdmin
      ? ["catalog/bootstrap", "requests/statuses", "access/my-access", "requests/pipeline"]
      : ["catalog/bootstrap", "requests/statuses", "access/my-access"];
    expect([...calls].sort()).toEqual([...expected].sort());
    for (const endpoint of expected) {
      expect(
        calls.filter((call) => call === endpoint),
        `${endpoint} should be read once on first load`,
      ).toHaveLength(1);
    }
    expect(calls.filter((call) => call === "requests/access-requests")).toHaveLength(0);
    expect(result.current.data?.requests).toHaveLength(requests.length);
    expect(Object.keys(result.current.data?.statuses ?? {})).toHaveLength(requests.length);
  });
});
