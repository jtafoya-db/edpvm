import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAccessRequestInbox } from "@/data/access-requests/queries";
import { createMemoryStore } from "@/data/adapters/memory";
import { addOwnerSave } from "@/data/datasets/team-queries";
import { useSave } from "@/data/optimistic-save";
import { createQueryClient } from "@/data/query-policy";
import { StoreProvider } from "@/data/store-provider";
import type { DataStore } from "@/data/store";
import type { UserProfile } from "@/data/types";
import {
  DATASET_ID,
  OWNER,
  STAFF,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "@/data/__tests__/dataset-fixture";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { AccessInboxScreen } from "../AccessRequests";
import { ChangeListScreen } from "../DatasetAccess";

afterEach(cleanup);

function makeStore(user: () => UserProfile) {
  return createMemoryStore(makeSnapshot(), {
    currentUser: async () => user(),
    now: makeClock().now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  });
}

/** Rendered under the app's own QueryClient, so the freshness policy applies. */
function wrap(ui: ReactNode, store: DataStore) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

const ctx = () => ({ go: vi.fn() });

describe("Refresh on work queues", () => {
  it("the change list re-reads on Refresh and shows what changed behind the cache", async () => {
    const me = { current: STAFF };
    const store = makeStore(() => me.current);
    const listEntries = vi.spyOn(store.changeList, "listEntries");
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    expect(await screen.findByText("Nothing to change.")).toBeInTheDocument();
    expect(listEntries).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Updated/)).toBeInTheDocument();

    // Someone else's write: still fresh under the policy, so the screen doesn't re-read by itself.
    me.current = OWNER;
    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: "Tess Tester",
      email: "tess.tester@example.gov",
      role: "tester",
    });
    me.current = STAFF;
    expect(screen.getByText("Nothing to change.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh the change list" }));
    const table = await screen.findByRole("table", { name: "Change-list entries" });
    expect(within(table).getByRole("button", { name: "Mark applied CL-0001" })).toBeInTheDocument();
    expect(listEntries).toHaveBeenCalledTimes(2);
  });

  it("the owner inbox has a Refresh that re-reads it", async () => {
    const store = makeStore(() => OWNER);
    const listInbox = vi.spyOn(store.accessRequests, "listInbox");
    wrap(<AccessInboxScreen ctx={ctx()} />, store);

    const refresh = await screen.findByRole("button", { name: "Refresh the access request inbox" });
    expect(listInbox).toHaveBeenCalledTimes(1);
    fireEvent.click(refresh);
    await vi.waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
  });
});

function useInboxAndAddOwner() {
  return { inbox: useAccessRequestInbox(), addOwner: useSave(addOwnerSave) };
}

describe("writes still reach the keys they change under the policy", () => {
  it("an owner change re-reads the owner inbox, which depends on who owns what", async () => {
    const store = makeStore(() => OWNER);
    const listInbox = vi.spyOn(store.accessRequests, "listInbox");
    const client = createQueryClient();
    const { result } = renderHook(useInboxAndAddOwner, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <StoreProvider store={store}>{children}</StoreProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.inbox.isSuccess).toBe(true));
    expect(listInbox).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.addOwner({
        datasetId: DATASET_ID,
        name: "Drew Deputy",
        email: "drew.deputy@example.gov",
        managerLabel: "Maintainer",
      });
    });
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
  });
});
