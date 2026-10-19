import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createMemoryStore } from "../adapters/memory";
import {
  queryKeys,
  useCatalog,
  useEir,
  useEirInbox,
  useAcknowledgePrivacyNotice,
  useEvaluateEirDraft,
  useGenerateEirPdf,
  useRespondEir,
  useStartEir,
  useSubmitEirFile,
  useRequestStatus,
  useRequests,
  useSubmitRequest,
} from "../queries";
import { createMemoryPrivacyAcknowledgmentRepository } from "../privacy/repository";
import { StoreProvider } from "../store-provider";
import type { DataStore } from "../store";
import { makeNewRequest, makeSnapshot } from "./fixture";

const acknowledgeActive = (
  repository: ReturnType<typeof createMemoryPrivacyAcknowledgmentRepository>,
) =>
  repository.acknowledge({
    noticeVersion: repository.notice.version,
    contentHash: repository.notice.contentHash,
  });

/** Fresh QueryClient + StoreProvider wrapper bound to a specific store. */
function makeWrapper(store: DataStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>{children}</StoreProvider>
      </QueryClientProvider>
    );
  }
  return { client, Wrapper };
}

// Custom-hook wrappers so tests never call hooks from a bare callback.
function useRequestsAndSubmit() {
  return { list: useRequests(), submit: useSubmitRequest() };
}
function useStatusForBlockedRequest() {
  return useRequestStatus("REQ-2052");
}
function useEirReads() {
  return { eir: useEir("person-1"), inbox: useEirInbox(true) };
}
function useGuardedEirActions() {
  return {
    acknowledge: useAcknowledgePrivacyNotice(),
    evaluate: useEvaluateEirDraft(),
    generatePdf: useGenerateEirPdf(),
    start: useStartEir(),
    submit: useSubmitEirFile(),
    respond: useRespondEir(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Query hooks read through the seam", () => {
  it("useRequests fetches the request list through the store", async () => {
    const { Wrapper } = makeWrapper(createMemoryStore(makeSnapshot()));
    const { result } = renderHook(useRequests, { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => r.id)).toEqual(["REQ-2038", "REQ-2052"]);
  });

  it("useCatalog aggregates catalog reads", async () => {
    const { Wrapper } = makeWrapper(createMemoryStore(makeSnapshot()));
    const { result } = renderHook(useCatalog, { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.domains).toHaveLength(2);
    expect(result.current.data?.datasets).toHaveLength(1);
    expect(result.current.data?.bundles).toHaveLength(2);
  });

  it("useRequestStatus projects the timeline for one request", async () => {
    const { Wrapper } = makeWrapper(createMemoryStore(makeSnapshot()));
    const { result } = renderHook(useStatusForBlockedRequest, { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.overall).toBe("Provisioning failed");
    expect(result.current.data?.subRequests.some((s) => s.status === "blocked")).toBe(true);
  });

  it("EIR reads do not refetch just because the browser window regains focus", () => {
    const { client, Wrapper } = makeWrapper(createMemoryStore(makeSnapshot()));
    renderHook(useEirReads, { wrapper: Wrapper });

    expect(
      client.getQueryCache().find({ queryKey: queryKeys.eir("person-1") })?.options,
    ).toMatchObject({
      refetchOnWindowFocus: false,
    });
    expect(client.getQueryCache().find({ queryKey: queryKeys.eirInbox() })?.options).toMatchObject({
      refetchOnWindowFocus: false,
    });
  });

  it("an EIR privacy refusal invalidates the cached acknowledgment", async () => {
    const store = createMemoryStore(makeSnapshot());
    vi.spyOn(store.eir, "get").mockRejectedValue(
      Object.assign(new Error("Privacy acknowledgment required"), {
        status: 403,
        code: "privacy-acknowledgment-required",
      }),
    );
    const { client, Wrapper } = makeWrapper(store);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useEir("person-1"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.privacyAcknowledgment(),
    });
  });

  it("EIR evaluation, PDF generation, start, submit/upload, and respond wait for the in-flight privacy acknowledgment", async () => {
    const privacy = createMemoryPrivacyAcknowledgmentRepository({
      identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
    });
    const acknowledgment = deferred<Awaited<ReturnType<typeof privacy.acknowledge>>>();
    privacy.acknowledge = vi.fn(() => acknowledgment.promise);
    const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: privacy });
    const existing = await store.eir.get("person-1");
    const start = vi.spyOn(store.eir, "start").mockResolvedValue(existing);
    const evaluate = vi.spyOn(store.eir, "evaluateDraft").mockResolvedValue({
      definitionVersion: "bootstrap",
      formVersion: "bootstrap",
      effectiveAt: "2026-10-14T00:00:00.000Z",
      evaluatedDraftVersion: 1,
      outcome: "pass",
      outcomes: [],
      automaticValidityEligible: true,
      actorPrincipalId: "system",
      actorDisplay: "EDP Vending Machine",
      actorApp: "system",
    });
    const generatePdf = vi.spyOn(store.eir, "generatePdf").mockResolvedValue(new Uint8Array());
    const submit = vi.spyOn(store.eir, "submitWithFile").mockResolvedValue(existing);
    const respond = vi.spyOn(store.eir, "respond").mockResolvedValue(existing);
    const { Wrapper } = makeWrapper(store);
    const { result } = renderHook(useGuardedEirActions, { wrapper: Wrapper });

    let writes!: Promise<unknown[]>;
    act(() => {
      void result.current.acknowledge.start();
    });
    await waitFor(() => expect(privacy.acknowledge).toHaveBeenCalledTimes(1));
    act(() => {
      writes = Promise.all([
        result.current.evaluate.mutateAsync("person-1"),
        result.current.generatePdf.mutateAsync("person-1"),
        result.current.start.mutateAsync({ principalId: "person-1", personName: "Synthetic" }),
        result.current.submit.mutateAsync({
          principalId: "person-1",
          personName: "Synthetic",
          file: new File(["pdf"], "signed.pdf", { type: "application/pdf" }),
          values: {},
        }),
        result.current.respond.mutateAsync({
          principalId: "person-1",
          personName: "Synthetic",
          values: {},
          response: "Synthetic response",
        }),
      ]);
    });

    expect(start).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(generatePdf).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();

    await act(async () =>
      acknowledgment.resolve(
        await acknowledgeActive(
          createMemoryPrivacyAcknowledgmentRepository({
            identity: {
              principalId: "person-1",
              displayName: "Synthetic Person",
              actorApp: "tenant",
            },
          }),
        ),
      ),
    );
    await writes;

    expect(start).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(generatePdf).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
  });
});

describe("useSubmitRequest — write + cache invalidation", () => {
  it("submits through the seam and the request list reflects it", async () => {
    const { Wrapper } = makeWrapper(createMemoryStore(makeSnapshot()));
    const { result } = renderHook(useRequestsAndSubmit, { wrapper: Wrapper });

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(result.current.list.data).toHaveLength(2);

    await act(async () => {
      await result.current.submit.mutateAsync(makeNewRequest());
    });

    // Optimistic update + invalidation/refetch both land on the new list.
    await waitFor(() => expect(result.current.list.data).toHaveLength(3));
    expect(result.current.list.data?.[0]?.id).toBe("REQ-9001");
  });
});

describe("readAppDataSeed — the real prototype seed", () => {
  it("builds a working store from the bundled window.AppData data", async () => {
    await import("../../legacy/appData.js");
    const { readAppDataSeed } = await import("../seed");
    const store = createMemoryStore(readAppDataSeed());

    const domains = await store.catalog.listDomains();
    expect(domains.length).toBeGreaterThanOrEqual(8);
    const requests = await store.requests.listRequests();
    expect(requests.some((r) => r.id === "REQ-2041")).toBe(true);
  });
});
