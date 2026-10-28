import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DatasetTeamScreen } from "@/components/DatasetAccess";
import { createMemoryStore } from "@/data/adapters/memory";
import { StoreProvider } from "@/data/store-provider";
import type { DataStore } from "@/data/store";
import type { UserProfile } from "@/data/types";
import {
  DATASET_ID,
  OWNER,
  STAFF,
  STRANGER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "@/data/__tests__/dataset-fixture";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { EdpAdminScreen } from "./EdpAdminScreen";
import { IntakeEditorRoute } from "./IntakeEditorRoute";

afterEach(cleanup);

const BUSINESS_OFFICE: UserProfile = { ...STRANGER, onboardingReviewerRoles: ["business-office"] };

function makeStore(user: UserProfile) {
  return createMemoryStore(makeSnapshot(), {
    currentUser: async () => user,
    now: makeClock().now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  });
}

function wrap(ui: ReactNode, store: DataStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

const reassignment = (store: DataStore) =>
  wrap(<EdpAdminScreen ctx={{ go: vi.fn() }} params={{ id: "owner-reassignment" }} />, store);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Adds Drew Partner as an owner through whichever owners panel is on screen. */
async function addDrew() {
  const form = await screen.findByRole("form", { name: "Add an owner" });
  fireEvent.change(within(form).getByLabelText(/name/), { target: { value: "Drew Partner" } });
  fireEvent.change(within(form).getByLabelText(/email/), {
    target: { value: "drew.partner@example.gov" },
  });
  fireEvent.click(within(form).getByRole("button", { name: /Review new owner/ }));
  fireEvent.click(screen.getByRole("button", { name: /Confirm new owner/ }));
  expect(await screen.findByText(/Made Drew Partner an owner\. CL-0001/)).toBeInTheDocument();
}

async function expectOwnerRemovedStatus() {
  // The save notice, not the team history row ("Removed Olive Owner as an owner").
  expect(
    await screen.findByText(/Removed Olive Owner as an owner and from the Maintainer role/),
  ).toBeInTheDocument();
}

/** The entries without their timestamps, for comparing two runs of the same change. */
async function entriesOf(store: DataStore) {
  return (await store.changeList.listEntries()).map((entry) => ({ ...entry, createdAt: "" }));
}

describe("EDP Admin owner reassignment", () => {
  it("lists every dataset with its domain and current owners for EDP staff", async () => {
    reassignment(makeStore(STAFF));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Owner reassignment" }),
    ).toBeVisible();
    const table = await screen.findByRole("table", { name: "Datasets and their owners" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Refund anomaly scores");
    expect(rows[0]).toHaveTextContent("individual-filing");
    expect(rows[0]).toHaveTextContent("Olive Owner");
    expect(rows[1]).toHaveTextContent("Payroll events");
    // Same honesty notice as the team page: ownership isn't persisted yet.
    expect(screen.getByRole("note", { name: "Session-only state" })).toHaveTextContent(
      "Changes last for this session only",
    );
  });

  it("adds owners from the shared Owner-only Add team member panel", async () => {
    const user = userEvent.setup();
    reassignment(makeStore(STAFF));

    await user.click(
      await screen.findByRole("button", { name: "Manage owners of Refund anomaly scores" }),
    );
    const owners = screen.getByRole("region", { name: "Owners of Refund anomaly scores" });
    expect(within(owners).queryByRole("form", { name: "Add an owner" })).toBeNull();

    await user.click(within(owners).getByRole("button", { name: "Add team member" }));
    const panel = screen.getByRole("dialog", { name: "Add team member" });
    expect(within(panel).getByText(/As EDP staff, you can add owners/)).toBeInTheDocument();
    expect(within(panel).queryByRole("radiogroup", { name: "Dataset role" })).toBeNull();
    expect(within(panel).getByRole("form", { name: "Add an owner" })).toBeInTheDocument();

    await addDrew();
    expect(screen.queryByRole("dialog", { name: "Add team member" })).toBeNull();
    expect(
      within(screen.getByRole("table", { name: "Owners" })).getByText("Drew Partner"),
    ).toBeVisible();
  });

  it("keeps focus and every keystroke in an add-owner field after a failed submit (#179)", async () => {
    const user = userEvent.setup();
    reassignment(makeStore(STAFF));
    await user.click(
      await screen.findByRole("button", { name: "Manage owners of Refund anomaly scores" }),
    );
    await user.click(screen.getByRole("button", { name: "Add team member" }));
    const form = await screen.findByRole("form", { name: "Add an owner" });
    await user.click(within(form).getByRole("button", { name: /Review new owner/ }));
    const summary = within(form).getByRole("alert");
    expect(summary).toHaveFocus();

    await user.click(within(summary).getByRole("link", { name: /email address/ }));
    const email = within(form).getByRole("textbox", { name: /Owner's email/ });
    await user.keyboard("drew.partner@example.gov");
    expect(email).toHaveFocus();
    expect(email).toHaveValue("drew.partner@example.gov");
    await user.tab();
    expect(summary).not.toHaveFocus();

    await user.click(within(form).getByRole("button", { name: /Review new owner/ }));
    expect(within(form).getByRole("alert")).toHaveFocus();
  });

  it("reassigns through the team page's owners panel, with the same change-list entries", async () => {
    const adminStore = makeStore(STAFF);
    reassignment(adminStore);
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage owners of Refund anomaly scores" }),
    );
    const panel = screen.getByRole("region", { name: "Owners of Refund anomaly scores" });
    expect(within(panel).getByRole("table", { name: "Owners" })).toHaveTextContent("Olive Owner");
    fireEvent.click(within(panel).getByRole("button", { name: "Add team member" }));
    await addDrew();

    // Reassignment: the old owner goes, with their manager role.
    fireEvent.click(screen.getByRole("button", { name: "Remove Olive Owner as owner" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm owner removal/ }));
    await expectOwnerRemovedStatus();
    const table = screen.getByRole("table", { name: "Datasets and their owners" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Drew Partner");
    expect(within(table).getAllByRole("row")[1]).not.toHaveTextContent("Olive Owner");
    cleanup();

    // The same change by EDP staff on the dataset team page.
    const teamStore = makeStore(STAFF);
    wrap(<DatasetTeamScreen ctx={{ go: vi.fn() }} params={{ id: DATASET_ID }} />, teamStore);
    // On the team page, staff add owners from the Add team member panel (UAT round 2, PR #234).
    fireEvent.click(await screen.findByRole("button", { name: "Add team member" }));
    await addDrew();
    fireEvent.click(screen.getByRole("button", { name: "Remove Olive Owner as owner" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm owner removal/ }));
    await expectOwnerRemovedStatus();

    const fromAdmin = await entriesOf(adminStore);
    expect(fromAdmin.map((e) => e.kind)).toEqual(["add-member", "remove-member"]);
    expect(fromAdmin).toEqual(await entriesOf(teamStore));
  });

  it("shows a new owner at once, marked Saving…, and ignores a double click", async () => {
    const store = makeStore(STAFF);
    const gate = deferred<Awaited<ReturnType<typeof store.datasetTeam.addOwner>>>();
    const real = store.datasetTeam.addOwner.bind(store.datasetTeam);
    let capturedAddOwner!: Parameters<typeof store.datasetTeam.addOwner>[0];
    const addOwner = vi.fn((input: Parameters<typeof store.datasetTeam.addOwner>[0]) => {
      capturedAddOwner = input;
      return gate.promise;
    });
    store.datasetTeam.addOwner = addOwner;
    reassignment(store);
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage owners of Refund anomaly scores" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add team member" }));
    const form = await screen.findByRole("form", { name: "Add an owner" });
    fireEvent.change(within(form).getByLabelText(/name/), { target: { value: "Drew Partner" } });
    fireEvent.change(within(form).getByLabelText(/email/), {
      target: { value: "drew.partner@example.gov" },
    });
    fireEvent.click(within(form).getByRole("button", { name: /Review new owner/ }));

    const confirm = screen.getByRole("button", { name: /Confirm new owner/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    // On the panel and in the datasets list at once; Saving…, not Saved.
    const owners = screen.getByRole("table", { name: "Owners" });
    const row = (await within(owners).findByText("Drew Partner")).closest("tr")!;
    expect(row).toHaveTextContent("Saving…");
    expect(screen.getByRole("table", { name: "Datasets and their owners" })).toHaveTextContent(
      "Drew Partner",
    );
    expect(screen.getByRole("region", { name: "Owner changes" })).toHaveTextContent(
      "Saving… Make Drew Partner an owner",
    );
    await waitFor(() => expect(addOwner).toHaveBeenCalledTimes(1));

    gate.resolve(await real(capturedAddOwner));
    expect(await screen.findByText(/Made Drew Partner an owner\. CL-0001/)).toBeInTheDocument();
    expect(row).not.toHaveTextContent("Saving…");
  });

  it("keeps the store's last-owner refusal", async () => {
    reassignment(makeStore(STAFF));
    fireEvent.click(await screen.findByRole("button", { name: "Manage owners of Payroll events" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Olive Owner as owner" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm owner removal/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /That removal was refused.*Remove Olive Owner as an owner\..*last owner/,
    );
    // Rolled back: still an owner.
    expect(
      await within(screen.getByRole("table", { name: "Owners" })).findByText("Olive Owner"),
    ).toBeVisible();
  });

  it.each([
    ["someone who isn't staff", STRANGER],
    ["the business office", BUSINESS_OFFICE],
  ])("never shows the section to %s", async (_, user) => {
    reassignment(makeStore(user));
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
    expect(screen.queryByRole("table", { name: "Datasets and their owners" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Owner reassignment" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add an owner" })).toBeNull();
  });

  it("the store still refuses owner changes from anyone who isn't an owner or EDP staff", async () => {
    const store = makeStore(STRANGER);
    await expect(
      store.datasetTeam.addOwner({
        datasetId: DATASET_ID,
        name: "Sam Stranger",
        email: STRANGER.email!,
      }),
    ).rejects.toMatchObject({ code: "not-owner" });
    await expect(
      store.datasetTeam.removeOwner({ datasetId: DATASET_ID, owner: OWNER.principalId }),
    ).rejects.toMatchObject({ code: "not-owner" });
    expect(await store.changeList.listEntries()).toEqual([]);
  });
});

describe("the #admin intake form editor route", () => {
  const Editor = () => <h1>Admin console</h1>;
  const editorRoute = (user: UserProfile, go = vi.fn()) => {
    wrap(<IntakeEditorRoute ctx={{ go }} Screen={Editor} />, makeStore(user));
    return go;
  };

  it.each([
    ["someone who isn't staff", STRANGER],
    ["the business office", BUSINESS_OFFICE],
  ])("shows %s the same Not available page as EDP Admin", async (_, user) => {
    editorRoute(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Not available" })).toBeVisible();
    expect(screen.getByText("This page is for EDP staff.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Admin console" })).toBeNull();
  });

  it("gives EDP staff the editor and a link back to EDP Admin", async () => {
    const go = editorRoute(STAFF);
    expect(await screen.findByRole("heading", { name: "Admin console" })).toBeVisible();
    const back = screen.getByRole("link", { name: /Back to EDP Admin/ });
    expect(back).toHaveAttribute("href", "#edp-admin/intake-editor");
    fireEvent.click(back);
    expect(go).toHaveBeenCalledWith("edp-admin", { id: "intake-editor" });
  });
});
