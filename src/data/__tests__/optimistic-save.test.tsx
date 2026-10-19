import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ActionRefusedError } from "../datasets/errors";
import { project, useSave, useSaves, type SaveIntent, type SaveSpec } from "../optimistic-save";
import { createQueryClient } from "../query-policy";
import type { DataStore } from "../store";
import { StoreContext } from "../store-context";

/** The seam under test: a screen's save hook and the cache it projects into. */
interface Item {
  id: string;
  label: string;
}
const LIST = ["items"] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A fake backend: each save waits until the test settles it. */
function harness(initial: Item[] = [{ id: "a", label: "Alpha" }]) {
  let server = structuredClone(initial);
  const calls: Array<{ input: Item; intent: string }> = [];
  const gates: Array<ReturnType<typeof deferred<Item>>> = [];
  const spec: SaveSpec<Item, Item> = {
    action: "add-item",
    refusedTitle: "That item was refused",
    record: (input) => `item:${input.id}`,
    describe: (input) => `Add ${input.label}`,
    describeSaved: (result) => `Added ${result.label}`,
    run: (_store, input: Item & SaveIntent) => {
      calls.push({ input: { id: input.id, label: input.label }, intent: input.idempotencyKey });
      const gate = deferred<Item>();
      gates.push(gate);
      return gate.promise.then((item) => {
        server = [...server, item];
        return item;
      });
    },
    projections: () => [
      project<Item[], Item, Item>(
        LIST,
        (items, input) => [...items.filter((i) => i.id !== input.id), { ...input }],
        (items, result) => [...items.filter((i) => i.id !== result.id), result],
      ),
    ],
    invalidates: () => [LIST],
  };
  const client = createQueryClient();
  const read = vi.fn(async () => structuredClone(server));
  client.setQueryDefaults(LIST, { queryFn: read, retry: false });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <StoreContext.Provider value={{} as DataStore}>{children}</StoreContext.Provider>
    </QueryClientProvider>
  );
  return {
    spec,
    client,
    calls,
    gates,
    read,
    wrapper,
    setServer: (items: Item[]) => (server = items),
  };
}

function useScreen(spec: SaveSpec<Item, Item>) {
  const items = useQuery<Item[]>({ queryKey: LIST });
  return { items: items.data, save: useSave(spec), saves: useSaves() };
}

async function mount(h: ReturnType<typeof harness>) {
  const view = renderHook(() => useScreen(h.spec), { wrapper: h.wrapper });
  await waitFor(() => expect(view.result.current.items).toBeDefined());
  return view;
}

const labels = (client: QueryClient) => client.getQueryData<Item[]>(LIST)?.map((i) => i.label);

describe("optimistic saves (ADR-0009 phase 1)", () => {
  it("shows the change at once, marked saving, before the server answers", async () => {
    const h = harness();
    const view = await mount(h);
    const started = performance.now();
    act(() => void view.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(labels(h.client)).toEqual(["Alpha", "Bravo"]));
    expect(performance.now() - started).toBeLessThan(200);
    expect(view.result.current.saves.map((s) => [s.state, s.label])).toEqual([
      ["saving", "Add Bravo"],
    ]);
  });

  it("says saved only once the server confirms, with the server's result", async () => {
    const h = harness();
    const view = await mount(h);
    act(() => void view.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(h.gates).toHaveLength(1));
    expect(view.result.current.saves[0]?.state).toBe("saving");
    await act(async () => h.gates[0]!.resolve({ id: "b", label: "Bravo (server)" }));
    await waitFor(() => expect(view.result.current.saves[0]?.state).toBe("saved"));
    expect(view.result.current.saves[0]?.label).toBe("Added Bravo (server)");
    expect(labels(h.client)).toEqual(["Alpha", "Bravo (server)"]);
  });

  it("rolls the change back on a refusal and keeps the reason", async () => {
    const h = harness();
    const view = await mount(h);
    act(() => void view.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(labels(h.client)).toEqual(["Alpha", "Bravo"]));
    await act(async () =>
      h.gates[0]!.reject(new ActionRefusedError("duplicate", "Bravo is already listed.")),
    );
    await waitFor(() => expect(view.result.current.saves[0]?.state).toBe("refused"));
    expect(labels(h.client)).toEqual(["Alpha"]);
    expect(view.result.current.saves[0]?.reason).toBe("Bravo is already listed.");
  });

  it("keeps an unknown outcome visibly unconfirmed; Try again resends the same key", async () => {
    const h = harness();
    const view = await mount(h);
    act(() => void view.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(h.gates).toHaveLength(1));
    await act(async () => h.gates[0]!.reject(new TypeError("Failed to fetch")));
    await waitFor(() => expect(view.result.current.saves[0]?.state).toBe("unconfirmed"));
    // It may have committed: still shown, never as saved.
    expect(labels(h.client)).toEqual(["Alpha", "Bravo"]);

    act(() => view.result.current.saves[0]!.retry());
    await waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1]!.intent).toBe(h.calls[0]!.intent);
    expect(view.result.current.saves.map((s) => s.state)).toEqual(["saving"]);
    await act(async () => h.gates[1]!.resolve({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(view.result.current.saves[0]?.state).toBe("saved"));
  });

  it("makes one save of a double click", async () => {
    const h = harness();
    const view = await mount(h);
    let second: boolean | undefined;
    act(() => {
      void view.result.current.save({ id: "b", label: "Bravo" });
      second = view.result.current.save({ id: "b", label: "Bravo" });
    });
    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(second).toBe(false);
    expect(view.result.current.saves).toHaveLength(1);
  });

  it("keeps running after the screen unmounts, and the next screen shows it pending then saved", async () => {
    const h = harness();
    const first = await mount(h);
    act(() => void first.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(h.gates).toHaveLength(1));
    first.unmount();

    const next = renderHook(() => useScreen(h.spec), { wrapper: h.wrapper });
    expect(next.result.current.saves.map((s) => s.state)).toEqual(["saving"]);
    expect(next.result.current.items?.map((i) => i.label)).toEqual(["Alpha", "Bravo"]);
    await act(async () => h.gates[0]!.resolve({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(next.result.current.saves[0]?.state).toBe("saved"));
  });

  it("a stale refetch can't erase a pending change", async () => {
    const h = harness();
    const view = await mount(h);
    act(() => void view.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(labels(h.client)).toEqual(["Alpha", "Bravo"]));
    h.setServer([
      { id: "a", label: "Alpha" },
      { id: "c", label: "Charlie (someone else)" },
    ]);
    await act(() => h.client.refetchQueries({ queryKey: LIST }));
    expect(labels(h.client)).toEqual(["Alpha", "Charlie (someone else)", "Bravo"]);
  });

  it("a refusal rolls back only its own change, not another record's", async () => {
    const h = harness();
    const view = await mount(h);
    act(() => {
      void view.result.current.save({ id: "b", label: "Bravo" });
      void view.result.current.save({ id: "c", label: "Charlie" });
    });
    await waitFor(() => expect(h.gates).toHaveLength(2));
    await act(async () => h.gates[1]!.resolve({ id: "c", label: "Charlie" }));
    await act(async () => h.gates[0]!.reject(new ActionRefusedError("duplicate", "No.")));
    await waitFor(() =>
      expect(view.result.current.saves.map((s) => s.state)).toEqual(["refused", "saved"]),
    );
    expect(labels(h.client)).toEqual(["Alpha", "Charlie"]);
  });

  it("doesn't hold the save pending for the background refresh", async () => {
    const h = harness();
    const view = await mount(h);
    act(() => void view.result.current.save({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(h.gates).toHaveLength(1));
    const hold = deferred<Item[]>();
    h.read.mockImplementationOnce(() => hold.promise);
    await act(async () => h.gates[0]!.resolve({ id: "b", label: "Bravo" }));
    await waitFor(() => expect(view.result.current.saves[0]?.state).toBe("saved"));
    hold.resolve([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Bravo" },
    ]);
  });
});
