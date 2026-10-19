import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DatasetTeamScreen } from "@/components/DatasetAccess";
import { SaveStatusRegion } from "@/components/SaveStatus";
import { createMemoryStore } from "@/data/adapters/memory";
import {
  DATASET_ID,
  OWNER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "@/data/__tests__/dataset-fixture";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { createQueryClient } from "@/data/query-policy";
import type { DataStore } from "@/data/store";
import { StoreProvider } from "@/data/store-provider";

afterEach(cleanup);

function makeStore() {
  return createMemoryStore(makeSnapshot(), {
    currentUser: async () => OWNER,
    now: makeClock().now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  });
}

/** A slow add: it waits until the test lets it finish. */
function slowAdd(store: DataStore) {
  let finish!: () => void;
  const real = store.datasetRoles.addMember.bind(store.datasetRoles);
  store.datasetRoles.addMember = vi.fn(
    (input: Parameters<typeof real>[0]) =>
      new Promise<Awaited<ReturnType<typeof real>>>((resolve) => {
        finish = () => void real(input).then(resolve);
      }),
  );
  return async () => {
    await waitFor(() => expect(store.datasetRoles.addMember).toHaveBeenCalled());
    await finish();
  };
}

/** The app shell in miniature: one screen at a time, and the save region. */
function Shell() {
  const [screenName, go] = useState<"team" | "home">("team");
  return (
    <>
      <button type="button" onClick={() => go(screenName === "team" ? "home" : "team")}>
        {screenName === "team" ? "Go home" : "Back to the team"}
      </button>
      {screenName === "team" ? (
        <DatasetTeamScreen ctx={{ go: vi.fn() }} params={{ id: DATASET_ID }} />
      ) : (
        <h1>Home</h1>
      )}
      <SaveStatusRegion />
    </>
  );
}

function renderShell(store: DataStore) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <StoreProvider store={store}>
        <Shell />
      </StoreProvider>
    </QueryClientProvider>,
  );
}

async function addTess() {
  await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
  // The add form is in the Add team member panel (#114).
  fireEvent.click(screen.getByRole("button", { name: "Add team member" }));
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Tess Tester" } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "tess.tester@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));
}

const region = () => screen.getByRole("region", { name: "Saves in progress" });

describe("saves across navigation (ADR-0009 phase 1)", () => {
  it("keeps a save running after leaving the page, and the page shows it pending on return", async () => {
    const store = makeStore();
    const finish = slowAdd(store);
    renderShell(store);
    await addTess();
    // On the team page, the page's own notices show it; the corner region leaves it to them.
    expect(
      await within(screen.getByRole("region", { name: "Team changes" })).findByText(
        "Saving… Add Tess Tester as Tester",
      ),
    ).toBeVisible();
    expect(region()).not.toHaveTextContent("Saving…");

    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    expect(await within(region()).findByText("Saving… Add Tess Tester as Tester")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to the team" }));
    const members = await screen.findByRole("table", { name: "Members" });
    const row = within(members).getByText("tess.tester@example.test").closest("tr")!;
    expect(row).toHaveTextContent("Saving…");

    await finish();
    expect(await screen.findByText(/CL-0001 is pending on the change list/)).toBeVisible();
    expect(row).toHaveTextContent("Pending add · CL-0001");
    expect(await store.datasetRoles.listMembers(DATASET_ID)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tester" })]),
    );
  });

  it("says saved in the corner when it lands while the person is elsewhere", async () => {
    const store = makeStore();
    const finish = slowAdd(store);
    renderShell(store);
    await addTess();
    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    await finish();
    expect(
      await within(region()).findByText(
        "Added Tess Tester as Tester. CL-0001 is pending on the change list.",
      ),
    ).toBeVisible();
  });

  it("announces Saving and Saved through a live region without moving focus", async () => {
    const store = makeStore();
    const finish = slowAdd(store);
    renderShell(store);
    await addTess();
    const notices = screen.getByRole("region", { name: "Team changes" });
    const live = notices.querySelector("[aria-live='polite']")!;
    expect(await within(live as HTMLElement).findByText(/^Saving…/)).toBeVisible();
    // The add panel has closed; focus is on the page, and the save mustn't move it.
    const button = screen.getByRole("button", { name: "Add team member" });
    button.focus();

    await finish();
    expect(await within(live as HTMLElement).findByText(/CL-0001 is pending/)).toBeVisible();
    expect(button).toHaveFocus();
  });

  it("asks the browser to warn before leaving while a save is unresolved", async () => {
    const store = makeStore();
    const finish = slowAdd(store);
    renderShell(store);
    await addTess();
    await screen.findByText("Saving… Add Tess Tester as Tester");

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    await finish();
    await screen.findByText(/CL-0001 is pending/);
    await waitFor(() => {
      const after = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    });
  });
});
