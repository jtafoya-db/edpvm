import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryStore } from "@/data/adapters/memory";
import { createDeltaStore, type DeltaApiTransport } from "@/data/adapters/delta";
import { ActionRefusedError } from "@/data/datasets/errors";
import { StoreProvider } from "@/data/store-provider";
import type { DataStore } from "@/data/store";
import { createQueryClient } from "@/data/query-policy";
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
  addedMembers,
} from "@/data/__tests__/dataset-fixture";
import { makeSnapshot } from "@/data/__tests__/fixture";
// @ts-expect-error -- the legacy JSX shell does not publish TypeScript declarations.
import App from "@/legacy/App.jsx";
import { ChangeListScreen, DatasetTeamScreen, DatasetsScreen } from "./index";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeStore(user: () => UserProfile) {
  return createMemoryStore(makeSnapshot(), {
    currentUser: async () => user(),
    now: makeClock().now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  });
}

function wrap(ui: ReactNode, store: DataStore) {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

const ctx = () => ({ go: vi.fn() });

const TESS = { name: "Tess Tester", email: "tess.tester@example.gov" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("DatasetsScreen", () => {
  it("lists every dataset with domain, tag, owners, member count and the viewer's role", async () => {
    const store = makeStore(() => OWNER);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    // The viewer is a member of the first dataset by email, as well as its owner.
    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: OWNER.name,
      email: OWNER.email,
      role: "manager",
    });
    wrap(<DatasetsScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Datasets" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("individual-filing");
    expect(rows[0]).toHaveTextContent("refund_anomalies");
    expect(rows[0]).toHaveTextContent("Olive Owner");
    // Tess, the viewer by email, and the seeded owner's manager role (by SCIM id).
    expect(within(rows[0]!).getAllByRole("cell")[4]).toHaveTextContent("3");
    expect(within(rows[0]!).getAllByRole("cell")[5]).toHaveTextContent("OwnerMaintainer");
    expect(within(rows[1]!).getAllByRole("cell")[4]).toHaveTextContent("1");
    // Owners and EDP staff, not Maintainers, decide the team (#141, #260).
    expect(
      screen.getByText(
        "Open a dataset to see its team. Only its owners and EDP staff decide who holds a role on it.",
      ),
    ).toBeInTheDocument();
  });

  it("counts people, not rows: an owner holding the Maintainer role is one member", async () => {
    const store = makeStore(() => OWNER);
    // Drew is an owner, so they also hold the manager role (one row per person).
    await store.datasetTeam.addOwner({
      datasetId: DATASET_ID,
      name: "Drew",
      email: "drew@example.gov",
    });
    wrap(<DatasetsScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Datasets" });
    const first = within(table).getAllByRole("row")[1]!;
    // Olive and Drew: each an owner and a manager member, counted once, not twice.
    expect(within(first).getAllByRole("cell")[4]).toHaveTextContent(/^2$/);
  });

  it("shows a role matched by email as display only: it grants no owner rights", async () => {
    const me = { current: OWNER };
    const store = makeStore(() => me.current);
    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: STRANGER.name,
      email: STRANGER.email,
      role: "manager",
    });
    me.current = STRANGER;
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    expect(await screen.findByText("You can't add people to this dataset")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  // #257: member counts are for the dataset's owners and EDP staff only.
  const COUNT_NOTE = "Only owners and EDP staff can see this";
  const membersCell = (row: HTMLElement) => within(row).getAllByRole("cell")[4]!;

  it("tells a member who isn't an owner that the count is for owners and EDP staff", async () => {
    const me = { current: OWNER };
    const store = makeStore(() => me.current);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    me.current = { ...STRANGER, name: TESS.name, email: TESS.email };
    wrap(<DatasetsScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Datasets" });
    const rows = within(table).getAllByRole("row").slice(1);
    for (const row of rows) expect(membersCell(row)).toHaveTextContent(COUNT_NOTE);
    // Their own role still shows.
    expect(within(rows[0]!).getAllByRole("cell")[5]).toHaveTextContent("Tester");
  });

  it.each([
    { label: "an owner", viewer: OWNER },
    { label: "EDP staff", viewer: STAFF },
  ])("shows $label the member count with no note", async ({ viewer }) => {
    wrap(
      <DatasetsScreen ctx={ctx()} />,
      makeStore(() => viewer),
    );

    const table = await screen.findByRole("table", { name: "Datasets" });
    const first = within(table).getAllByRole("row")[1]!;
    expect(membersCell(first)).toHaveTextContent(/^1$/);
    expect(screen.queryByText(COUNT_NOTE)).toBeNull();
  });

  it("scrolls the table inside its own focusable region, so zoomed-in columns stay reachable", async () => {
    wrap(
      <DatasetsScreen ctx={ctx()} />,
      makeStore(() => STRANGER),
    );

    const table = await screen.findByRole("table", { name: "Datasets" });
    const region = screen.getByRole("region", { name: "Datasets table" });
    expect(region).toContainElement(table);
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveStyle({ overflowX: "auto" });
  });

  it("shows 'No role' where the viewer holds nothing", async () => {
    wrap(
      <DatasetsScreen ctx={ctx()} />,
      makeStore(() => STRANGER),
    );

    const table = await screen.findByRole("table", { name: "Datasets" });
    expect(within(table).getAllByText("No role")).toHaveLength(2);
  });

  it("opens a team page through the shell's navigation", async () => {
    const nav = ctx();
    wrap(
      <DatasetsScreen ctx={nav} />,
      makeStore(() => OWNER),
    );

    fireEvent.click(await screen.findByRole("link", { name: /Refund anomaly scores/ }));

    expect(nav.go).toHaveBeenCalledWith("team", { id: DATASET_ID });
  });

  it("uses one Delta read for the dataset list with member summaries", async () => {
    const ref = { id: "row-1", version: 1 };
    const transport: DeltaApiTransport = {
      read: vi.fn(async (area: string, name: string) => {
        if (`${area}/${name}` !== "initiatives/dataset-member-summaries") {
          throw new Error(`unexpected read ${area}/${name}`);
        }
        return [
          {
            ...makeDatasetSeed().datasets[0]!,
            ref,
            owners: makeDatasetSeed().datasets[0]!.owners.map((owner) => ({ ...owner, ref })),
            memberSummary: {
              totalMembers: 1,
              roleCounts: { tester: 0, developer: 0, manager: 1 },
              viewerRoles: [],
            },
          },
        ];
      }) as DeltaApiTransport["read"],
      command: vi.fn(),
      legacyWrite: vi.fn(),
    };
    const store = createDeltaStore({
      transport,
      accessStores: {
        currentUser: async () => OWNER,
        roleDescriptions: TEST_ROLE_DESCRIPTIONS,
      },
    });

    wrap(<DatasetsScreen ctx={ctx()} />, store);

    expect(await screen.findByRole("table", { name: "Datasets" })).toBeInTheDocument();
    expect(transport.read).toHaveBeenCalledTimes(1);
    expect(transport.read).toHaveBeenCalledWith(
      "initiatives",
      "dataset-member-summaries",
      undefined,
    );
  });

  it("prefetches a dataset team on row hover intent and focus without repeated reads", async () => {
    const store = makeStore(() => OWNER);
    const getDataset = vi.spyOn(store.datasets, "getDataset");
    const listMembers = vi.spyOn(store.datasetRoles, "listMembers");
    const listEntries = vi.spyOn(store.changeList, "listEntries");
    wrap(<DatasetsScreen ctx={ctx()} />, store);

    const first = (await screen.findByRole("link", { name: /Refund anomaly scores/ })).closest(
      "tr",
    )!;

    vi.useFakeTimers();
    fireEvent.mouseEnter(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    fireEvent.mouseLeave(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getDataset).not.toHaveBeenCalled();

    fireEvent.mouseEnter(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(getDataset).toHaveBeenCalledWith(DATASET_ID);
    expect(listMembers).toHaveBeenCalledWith(DATASET_ID);
    expect(listEntries).toHaveBeenCalled();
    expect(getDataset).toHaveBeenCalledTimes(1);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(listEntries).toHaveBeenCalledTimes(1);

    fireEvent.mouseLeave(first);
    fireEvent.mouseEnter(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    fireEvent.focus(first);

    expect(getDataset).toHaveBeenCalledTimes(1);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(listEntries).toHaveBeenCalledTimes(1);
  });
});

/** Fill the add form with a name, email and role. */
/** Opens the Add team member panel (#114), unless it's already open. */
function openAdd() {
  if (!screen.queryByRole("dialog", { name: "Add team member" })) {
    fireEvent.click(screen.getByRole("button", { name: "Add team member" }));
  }
}

async function openAddWhenLoaded() {
  await screen.findByRole("button", { name: "Add team member" });
  openAdd();
}

function fill(name: string, email: string, role: string) {
  openAdd();
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: email } });
  fireEvent.click(screen.getByRole("radio", { name: role }));
}

describe("DatasetTeamScreen", () => {
  it("shows a card per role saying what it grants, with the wording from configuration", async () => {
    wrap(
      <DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => OWNER),
    );

    await openAddWhenLoaded();
    const cards = within(screen.getByRole("radiogroup", { name: "Dataset role" })).getAllByRole(
      "radio",
    );
    // Owners can also make someone an owner from here (UAT, PR #234).
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Tester",
      "Dev (test)",
      "Maintainer",
      "Owner",
    ]);
    expect(cards[1]).toHaveTextContent("Test grant: read/write");
    expect(cards[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Test consumer note.")).toBeInTheDocument();

    fireEvent.click(cards[2]!);
    expect(cards[2]).toHaveAttribute("aria-checked", "true");
    expect(cards[0]).toHaveAttribute("aria-checked", "false");
  });

  it("uses one role-card tab stop and selects roles with arrow, Home and End keys", async () => {
    wrap(
      <DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => OWNER),
    );
    await openAddWhenLoaded();
    const group = screen.getByRole("radiogroup", { name: "Dataset role" });
    const cards = within(group).getAllByRole("radio");

    expect(cards.map((card) => card.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
    cards[0]!.focus();
    fireEvent.keyDown(cards[0]!, { key: "ArrowRight" });
    expect(cards[1]).toHaveFocus();
    expect(cards[1]).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(cards[1]!, { key: "End" });
    expect(cards[3]).toHaveFocus();
    expect(cards[3]).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(cards[3]!, { key: "Home" });
    expect(cards[0]).toHaveFocus();
    expect(cards[0]).toHaveAttribute("aria-checked", "true");
    expect(cards.map((card) => card.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
  });

  it("shows the add in Members at once, marked Saving…, and says added only once saved", async () => {
    const store = makeStore(() => OWNER);
    let finish!: () => void;
    const real = store.datasetRoles.addMember.bind(store.datasetRoles);
    const addMember = vi.fn(
      (input: Parameters<typeof real>[0]) =>
        new Promise<Awaited<ReturnType<typeof real>>>((resolve) => {
          finish = () => void real(input).then(resolve);
        }),
    );
    store.datasetRoles.addMember = addMember;
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    fill("Tess Tester", "tess.tester@example.gov", "Dev (test)");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    const confirm = screen.getByRole("button", { name: /Confirm add/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    const members = screen.getByRole("table", { name: "Members" });
    const row = (await within(members).findByText("tess.tester@example.gov")).closest("tr")!;
    expect(row).toHaveTextContent("Saving…");
    expect(within(row).queryByRole("button")).toBeNull();
    const notices = screen.getByRole("region", { name: "Team changes" });
    expect(notices).toHaveTextContent("Saving… Add Tess Tester as Dev (test)");
    expect(notices).not.toHaveTextContent("pending on the change list");
    // The panel closed, and its form is free for the next person straight away.
    openAdd();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("");
    await waitFor(() => expect(addMember).toHaveBeenCalledTimes(1));

    finish();
    expect(await screen.findByText(/CL-0001 is pending on the change list/)).toBeInTheDocument();
    expect(screen.queryByText(/Saving…/)).not.toBeInTheDocument();
    expect(row).toHaveTextContent("Pending add · CL-0001");
  });

  it("refreshes team history after an add, as every other team write does", async () => {
    const store = makeStore(() => OWNER);
    const listTeamEvents = vi.spyOn(store.datasetTeam, "listTeamEvents");
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    await waitFor(() => expect(listTeamEvents).toHaveBeenCalledTimes(1));
    fill("Tess Tester", "tess.tester@example.gov", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));

    expect(await screen.findByText(/CL-0001 is pending on the change list/)).toBeInTheDocument();
    await waitFor(() => expect(listTeamEvents).toHaveBeenCalledTimes(2));
  });

  it("puts a refused add's details back in the form, with the reason", async () => {
    const store = makeStore(() => OWNER);
    store.datasetRoles.addMember = vi.fn(async () => {
      throw new ActionRefusedError("invalid", "That initiative isn't active.");
    });
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    fill("Tess Tester", "tess.tester@example.gov", "Dev (test)");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That add was refusedAdd Tess Tester as Dev (test).That initiative isn't active.",
    );
    // Rolled back: the row is gone, and what the owner typed is back.
    expect(
      within(screen.getByRole("table", { name: "Members" })).queryByText("tess.tester@example.gov"),
    ).toBeNull();
    openAdd();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Tess Tester");
    expect(screen.getByLabelText(/^Email/)).toHaveValue("tess.tester@example.gov");
  });

  it("doesn't lock the dataset: an owner add saves while a member add is pending", async () => {
    const store = makeStore(() => OWNER);
    let finish!: () => void;
    const realAddMember = store.datasetRoles.addMember.bind(store.datasetRoles);
    store.datasetRoles.addMember = vi.fn(
      (input: Parameters<typeof realAddMember>[0]) =>
        new Promise<Awaited<ReturnType<typeof realAddMember>>>((resolve) => {
          finish = () => void realAddMember(input).then(resolve);
        }),
    );
    const realAddOwner = store.datasetTeam.addOwner.bind(store.datasetTeam);
    const addOwner = vi.fn(realAddOwner);
    store.datasetTeam.addOwner = addOwner;
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    fill("Tess Tester", "tess.tester@example.gov", "Dev (test)");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));

    // The panel closed on the member add; an owner add opens it again (UAT round 2, PR #234).
    openAdd();
    fireEvent.click(screen.getByRole("radio", { name: "Owner" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Nora Owner" } });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: "nora.owner@example.gov" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Review new owner/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm new owner/ }));

    expect(await screen.findByText(/Made Nora Owner an owner/)).toBeInTheDocument();
    expect(addOwner).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Team changes" })).toHaveTextContent(
      "Saving… Add Tess Tester",
    );
    finish();
    expect(await screen.findByText(/is pending on the change list/)).toBeInTheDocument();
  });

  it("confirms who, which role and what it grants before adding", async () => {
    const store = makeStore(() => OWNER);
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    expect(screen.getByRole("note", { name: "Session-only state" })).toHaveTextContent(
      "Reloading the page discards them.",
    );
    fill("Tess Tester", " Tess.Tester@example.gov ", "Dev (test)");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));

    const summary = screen.getByRole("region", { name: "Confirm the add" });
    expect(summary).toHaveTextContent(
      "You're adding Tess Tester (tess.tester@example.gov) as Dev (test) on Refund anomaly scores. They will get:",
    );
    expect(within(summary).getByRole("list", { name: "Grants" })).toHaveTextContent(
      "Test grant: read/write",
    );
    expect(await addedMembers(store, DATASET_ID)).toEqual([]); // nothing yet

    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));

    expect(
      await screen.findByText(
        "Added Tess Tester as Dev (test). CL-0001 is pending on the change list.",
      ),
    ).toBeInTheDocument();
    const row = within(await screen.findByRole("table", { name: "Members" }))
      .getByText("tess.tester@example.gov")
      .closest("tr")!;
    expect(row).toHaveTextContent("Tess Tester");
    expect(row).toHaveTextContent("Dev (test)Test summary: read/write");
    expect(await within(row).findByText(/Pending add · CL-0001/)).toBeInTheDocument();
  });

  it("goes back from the summary without adding", async () => {
    const store = makeStore(() => OWNER);
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await openAddWhenLoaded();
    fill("Tess Tester", "tess.tester@example.gov", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Change details/ }));

    expect(screen.getByLabelText(/^Email/)).toHaveValue("tess.tester@example.gov");
    expect(await addedMembers(store, DATASET_ID)).toEqual([]);
  });

  it("asks for a name and a valid email before the summary", async () => {
    wrap(
      <DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => OWNER),
    );

    await openAddWhenLoaded();
    const name = screen.getByRole("textbox", { name: /^Name/ });
    const email = screen.getByRole("textbox", { name: /^Email/ });
    expect(name).toBeRequired();
    expect(email).toBeRequired();
    fill("", "not-an-email", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));

    const summary = screen.getByRole("alert");
    expect(summary).toHaveFocus();
    expect(within(summary).getByRole("link", { name: "Enter the person's name." })).toHaveAttribute(
      "href",
      "#member-name",
    );
    expect(name).toBeInvalid();
    expect(name).toHaveAccessibleDescription("Enter the person's name.");
    expect(email).toHaveAccessibleDescription(
      "Enter an email address in the format name@example.gov.",
    );
    fireEvent.click(within(summary).getByRole("link", { name: "Enter the person's name." }));
    expect(name).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Confirm the add" })).toBeNull();
  });

  it("keeps focus and every keystroke in a field fixed after a failed add (#179)", async () => {
    const user = userEvent.setup();
    wrap(
      <DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => OWNER),
    );
    await openAddWhenLoaded();
    fill("", "not-an-email", "Tester");
    await user.click(screen.getByRole("button", { name: /Review add/ }));
    const summary = screen.getByRole("alert");
    expect(summary).toHaveFocus();

    await user.click(within(summary).getByRole("link", { name: "Enter the person's name." }));
    const name = screen.getByRole("textbox", { name: /^Name/ });
    await user.keyboard("Tess Tester");
    expect(name).toHaveFocus();
    expect(name).toHaveValue("Tess Tester");
    expect(within(summary).queryByRole("link", { name: "Enter the person's name." })).toBeNull();
    await user.tab();
    expect(summary).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: /Review add/ }));
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  it("says when an add repeats one already recorded", async () => {
    const store = makeStore(() => OWNER);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await openAddWhenLoaded();
    fill("Tess T.", "TESS.TESTER@example.gov", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));

    expect(
      await screen.findByText("tess.tester@example.gov already holds Tester; nothing new was listed."),
    ).toBeInTheDocument();
  });

  it("shows a non-owner the team read-only, with no add form", async () => {
    wrap(
      <DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />,
      makeStore(() => STRANGER),
    );

    expect(await screen.findByText("You can't add people to this dataset")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add a member" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("shows loading, then an error when the store fails", async () => {
    const store = makeStore(() => OWNER);
    store.datasets.getDataset = async () => {
      throw new Error("backend down");
    };
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("backend down")).toBeInTheDocument();
  });
});

describe("ChangeListScreen", () => {
  async function storeWithOneEntry(me: { current: UserProfile }) {
    const store = makeStore(() => me.current);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    return store;
  }

  it("names the person and what the role grants, and lets EDP staff mark it applied", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    me.current = STAFF;
    wrap(
      <ChangeListScreen
        ctx={ctx()}
        chrome={{
          Pill: ({ icon, children }: { icon?: string; children?: ReactNode }) => (
            <span data-icon={icon}>{children}</span>
          ),
        }}
      />,
      store,
    );

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    expect(screen.getByRole("note", { name: "Session-only state" })).toBeInTheDocument();
    expect(table).toHaveTextContent(
      "Add Tess Tester (tess.tester@example.gov) to group edp-refund_anomalies-tester",
    );
    expect(table).toHaveTextContent("Grants: Test grant: read");
    expect(table).toHaveTextContent("Olive Owner added them as Tester on Refund anomaly scores");
    fireEvent.click(screen.getByRole("button", { name: "Mark applied CL-0001" }));

    expect(await within(table).findByText("Marked applied")).toBeInTheDocument();
    expect(table).toHaveTextContent(`by ${STAFF.principalId}`);
    expect(within(table).getByText("Requested")).toHaveAttribute("data-icon", "info");
  });

  it("shows Requested, Marked applied and Seen in snapshot as separate facts without a machine actor", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    const realList = store.changeList.listEntries.bind(store.changeList);
    store.changeList.listEntries = async () =>
      (await realList()).map((entry) => ({
        ...entry,
        verified: { runId: "snapshot-run-88", at: "2026-10-01T11:59:00.000Z" },
      }));
    me.current = STAFF;
    wrap(
      <ChangeListScreen
        ctx={ctx()}
        chrome={{
          Pill: ({ icon, children }: { icon?: string; children?: ReactNode }) => (
            <span data-icon={icon}>{children}</span>
          ),
        }}
      />,
      store,
    );

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    expect(
      screen.getByText(
        /Entries start Requested.*fresh, complete membership snapshot can show Seen in snapshot/s,
      ),
    ).toBeInTheDocument();
    expect(table).toHaveTextContent("Requested");
    expect(table).toHaveTextContent("Seen in snapshot");
    expect(table).toHaveTextContent("Seen in membership snapshot");
    expect(within(table).getByText("Requested")).toHaveAttribute("data-icon", "info");
    expect(table).not.toHaveTextContent("membership-snapshot:snapshot-run-88");
    expect(screen.getByText(/staff apply them by hand/i)).toBeInTheDocument();
  });

  it("de-emphasises superseded entries, excludes them from pending, and explains the disabled action", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });
    me.current = STAFF;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    const superseded = within(table).getByText("Superseded by CL-0002");
    const row = superseded.closest("tr");
    expect(row).toHaveStyle({ background: "var(--color-gray-cool-2)" });
    expect(row).toHaveTextContent(
      "A later entry replaced this change. It is no longer pending and cannot be marked applied.",
    );
    expect(
      within(row!).getByRole("button", {
        name: "Mark applied CL-0001 unavailable: superseded by CL-0002",
      }),
    ).toBeDisabled();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });

  it("does not show the unavailable apply button when a superseded entry is also seen in snapshot", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });
    const realList = store.changeList.listEntries.bind(store.changeList);
    store.changeList.listEntries = async () =>
      (await realList()).map((entry) =>
        entry.id === "CL-0001"
          ? { ...entry, verified: { runId: "snapshot-run-311", at: "2026-10-01T11:59:00.000Z" } }
          : entry,
      );
    me.current = STAFF;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    const row = within(table).getByText("Superseded by CL-0002").closest("tr")!;
    expect(row).toHaveTextContent("Seen in snapshot");
    expect(
      within(row).queryByRole("button", { name: /Mark applied .* unavailable/ }),
    ).not.toBeInTheDocument();
  });

  it("does not show the unavailable apply button when the superseding entry is marked applied", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
    });
    me.current = STAFF;
    await store.changeList.markApplied("CL-0002");
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    const supersededRow = within(table).getByText("Superseded by CL-0002").closest("tr")!;
    expect(
      within(supersededRow).queryByRole("button", { name: /Mark applied .* unavailable/ }),
    ).not.toBeInTheDocument();
    const replacementRow = within(table).getByText("CL-0002").closest("tr")!;
    expect(replacementRow).toHaveTextContent("Marked applied");
  });

  it("names the role an owner addition replaces in both change-list reasons", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    await store.datasetTeam.addOwner({ datasetId: DATASET_ID, ...TESS });
    me.current = STAFF;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    const replacementRows = within(table)
      .getAllByRole("row")
      .filter((row) =>
        /^CL-000[23]$/.test(within(row).queryAllByRole("cell")[0]?.textContent ?? ""),
      );
    expect(replacementRows).toHaveLength(2);
    for (const row of replacementRows) {
      expect(row).toHaveTextContent(
        "Olive Owner made them an owner of Refund anomaly scores; this replaces their Tester role with Maintainer",
      );
    }
  });

  it("keeps Mark applied synchronous: nothing shows applied until the server confirms", async () => {
    // ADR-0009 decision 2: it records an access change made in Databricks, so no optimistic success.
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    me.current = STAFF;
    const gate = deferred<Awaited<ReturnType<typeof store.changeList.markApplied>>>();
    const real = store.changeList.markApplied.bind(store.changeList);
    let captured!: string;
    let key: string | undefined;
    const markApplied = vi.fn((id: string, options?: { idempotencyKey?: string }) => {
      captured = id;
      key = options?.idempotencyKey;
      return gate.promise;
    });
    store.changeList.markApplied = markApplied;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    const button = await screen.findByRole("button", { name: "Mark applied CL-0001" });
    const table = screen.getByRole("table", { name: "Change-list entries" });
    const row = within(table).getByText("CL-0001").closest("tr")!;
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    fireEvent.click(button);

    expect(await screen.findByLabelText("Saving… Mark applied CL-0001")).toHaveTextContent(
      "Saving…",
    );
    expect(screen.getByLabelText("Saving… Mark applied CL-0001")).toBeDisabled();
    fireEvent.click(button);
    expect(markApplied).toHaveBeenCalledTimes(1);
    expect(key).toEqual(expect.any(String));
    // While it saves, the row and the pending count are what the server last said.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(row).queryByText("Marked applied")).toBeNull();
    expect(row).not.toHaveTextContent(`by ${STAFF.principalId}`);
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.queryByText("0 pending")).toBeNull();

    gate.resolve(await real(captured));
    expect(await within(table).findByText("Marked applied")).toBeInTheDocument();
    expect(await screen.findByText("0 pending")).toBeInTheDocument();
  });

  it("keeps one entry locked when another entry starts saving", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: "Devon Developer",
      email: "devon.developer@example.gov",
      role: "developer",
    });
    me.current = STAFF;
    const firstGate = deferred<Awaited<ReturnType<typeof store.changeList.markApplied>>>();
    const secondGate = deferred<Awaited<ReturnType<typeof store.changeList.markApplied>>>();
    const real = store.changeList.markApplied.bind(store.changeList);
    const markApplied = vi.fn((id: string) =>
      id === "CL-0001" ? firstGate.promise : secondGate.promise,
    );
    store.changeList.markApplied = markApplied;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    const first = await screen.findByRole("button", { name: "Mark applied CL-0001" });
    const second = await screen.findByRole("button", { name: "Mark applied CL-0002" });
    fireEvent.click(first);
    expect(await screen.findByLabelText("Saving… Mark applied CL-0001")).toBeDisabled();
    fireEvent.click(second);
    expect(await screen.findByLabelText("Saving… Mark applied CL-0002")).toBeDisabled();
    fireEvent.click(first);

    expect(markApplied.mock.calls.map(([id]) => id)).toEqual(["CL-0001", "CL-0002"]);
    firstGate.resolve(await real("CL-0001"));
    secondGate.resolve(await real("CL-0002"));
    await screen.findAllByText("Marked applied");
  });

  it("reuses the idempotency key when an unknown outcome is retried", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    me.current = STAFF;
    const real = store.changeList.markApplied.bind(store.changeList);
    const keys: string[] = [];
    const markApplied = vi.fn((id: string, options?: { idempotencyKey?: string }) => {
      keys.push(options?.idempotencyKey ?? "");
      if (keys.length === 1) {
        return Promise.reject(
          Object.assign(new Error("Outcome unknown"), { code: "outcome-unknown", status: 503 }),
        );
      }
      return real(id, options);
    });
    store.changeList.markApplied = markApplied;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    fireEvent.click(await screen.findByRole("button", { name: "Mark applied CL-0001" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /We couldn't confirm this save.*Check the list before trying again\./,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark applied CL-0001" }));

    expect(await screen.findByText("Marked applied")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends a fresh idempotency key for each new confirmation on the same dataset", async () => {
    const store = makeStore(() => OWNER);
    const realAdd = store.datasetRoles.addMember.bind(store.datasetRoles);
    const realRemove = store.datasetTeam.removeMember.bind(store.datasetTeam);
    const addKeys: string[] = [];
    const removeKeys: string[] = [];
    store.datasetRoles.addMember = vi.fn(async (input) => {
      addKeys.push(input.idempotencyKey ?? "");
      return realAdd(input);
    });
    store.datasetTeam.removeMember = vi.fn(async (input) => {
      removeKeys.push(input.idempotencyKey ?? "");
      return realRemove(input);
    });
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    const add = async () => {
      fill("Tess Tester", "tess.tester@example.gov", "Tester");
      fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
      fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));
    };
    await add();
    expect(await screen.findByText(/Added Tess Tester as Tester/)).toBeInTheDocument();
    const tessRow = (await screen.findByText("tess.tester@example.gov")).closest("tr")!;
    fireEvent.click(within(tessRow).getByRole("button", { name: "Edit access for Tess Tester" }));
    fireEvent.click(screen.getByRole("button", { name: /Remove Tess Tester's Tester role/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm removal/ }));
    expect(await screen.findByText(/Removed Tess Tester's Tester role/)).toBeInTheDocument();
    await add();
    expect(
      await screen.findByText(
        "Added Tess Tester as Tester. CL-0003 is pending on the change list.",
      ),
    ).toBeInTheDocument();

    expect(addKeys).toHaveLength(2);
    expect(removeKeys).toHaveLength(1);
    expect(new Set([...addKeys, ...removeKeys]).size).toBe(3);
  });

  it("keeps an unconfirmed add in Members, and Try again resends the same key", async () => {
    const store = makeStore(() => OWNER);
    const realAdd = store.datasetRoles.addMember.bind(store.datasetRoles);
    const keys: string[] = [];
    store.datasetRoles.addMember = vi.fn(async (input) => {
      keys.push(input.idempotencyKey ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("Outcome unknown"), {
          code: "outcome-unknown",
          status: 503,
        });
      }
      return realAdd(input);
    });
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    fill("Tess Tester", "tess.tester@example.gov", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));
    const notices = screen.getByRole("region", { name: "Team changes" });
    // #189's words, as an alert; never "refused".
    const alert = await within(notices).findByRole("alert");
    expect(alert).toHaveTextContent(
      /We couldn't confirm this save.*Add Tess Tester as Tester\..*Check the list before trying again\./,
    );
    expect(alert).not.toHaveTextContent(/refused/i);
    const row = within(screen.getByRole("table", { name: "Members" }))
      .getByText("tess.tester@example.gov")
      .closest("tr")!;
    expect(row).toHaveTextContent("Not confirmed");
    fireEvent.click(within(notices).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/Added Tess Tester as Tester/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new idempotency key for a different add after an unconfirmed one", async () => {
    const store = makeStore(() => OWNER);
    const realAdd = store.datasetRoles.addMember.bind(store.datasetRoles);
    const keys: string[] = [];
    store.datasetRoles.addMember = vi.fn(async (input) => {
      keys.push(input.idempotencyKey ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("Outcome unknown"), {
          code: "outcome-unknown",
          status: 503,
        });
      }
      return realAdd(input);
    });
    wrap(<DatasetTeamScreen ctx={ctx()} params={{ id: DATASET_ID }} />, store);

    await screen.findByRole("heading", { name: /Refund anomaly scores: team/ });
    fill("Tess Tester", "tess.tester@example.gov", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));
    expect(await screen.findByText("We couldn't confirm this save")).toBeVisible();
    fill("Bob Builder", "bob.builder@example.gov", "Tester");
    fireEvent.click(screen.getByRole("button", { name: /Review add/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm add/ }));

    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("clears the idempotency key after a refusal so the next intent is new", async () => {
    const me = { current: OWNER };
    const store = await storeWithOneEntry(me);
    me.current = STAFF;
    const real = store.changeList.markApplied.bind(store.changeList);
    const keys: string[] = [];
    const markApplied = vi.fn((id: string, options?: { idempotencyKey?: string }) => {
      keys.push(options?.idempotencyKey ?? "");
      if (keys.length === 1) {
        return Promise.reject(new ActionRefusedError("not-edp-staff", "EDP staff only."));
      }
      return real(id, options);
    });
    store.changeList.markApplied = markApplied;
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    fireEvent.click(await screen.findByRole("button", { name: "Mark applied CL-0001" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("EDP staff only.");
    fireEvent.click(screen.getByRole("button", { name: "Mark applied CL-0001" }));

    expect(await screen.findByText("Marked applied")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("shows anyone else the list read-only", async () => {
    const me = { current: OWNER };
    wrap(<ChangeListScreen ctx={ctx()} />, await storeWithOneEntry(me));

    expect(await screen.findByText("Only EDP staff can mark entries applied.")).toBeInTheDocument();
    expect(screen.getByText("Requested")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark .* applied/ })).toBeNull();
  });

  it("shows an error when the store fails", async () => {
    const store = makeStore(() => STAFF);
    store.changeList.listEntries = async () => {
      throw new Error("change list unavailable");
    };
    wrap(<ChangeListScreen ctx={ctx()} />, store);

    expect(await screen.findByText("change list unavailable")).toBeInTheDocument();
  });
});

describe("the legacy shell mounts the screens on hash routes", () => {
  function setGlobal(name: string, value: unknown) {
    (globalThis as unknown as Record<string, unknown>)[name] = value;
    (window as unknown as Record<string, unknown>)[name] = value;
  }

  beforeEach(() => {
    window.scrollTo = vi.fn();
    setGlobal("AppIcon", () => null);
    setGlobal("TopNav", () => <nav data-testid="topnav" />);
    setGlobal("AppFooter", () => <footer />);
    setGlobal("Page", ({ children }: { children?: ReactNode }) => (
      <div data-testid="page">{children}</div>
    ));
  });

  const data = { requests: [], user: { initials: "OO", isAdmin: false } };

  it.each([
    { hash: "#datasets", text: "Refund anomaly scores" },
    { hash: `#team/${DATASET_ID}`, text: "Refund anomaly scores: team" },
    { hash: "#change-list", text: "Nothing to change." },
  ])("renders $hash inside the shell's Page with the injected chrome", async ({ hash, text }) => {
    window.location.hash = hash;
    wrap(
      <App data={data} submitRequest={vi.fn()} />,
      makeStore(() => OWNER),
    );

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByTestId("topnav")).toBeInTheDocument();
    expect(screen.getByTestId("page")).toContainElement(screen.getByText(text));
  });

  it("does not prefetch the datasets route while already on it", async () => {
    const data = { requests: [], user: { initials: "OO", isAdmin: false } };
    const store = makeStore(() => OWNER);
    const listDatasetSummaries = vi.spyOn(store.datasets, "listDatasetSummaries");
    window.location.hash = "#datasets";
    setGlobal("TopNav", ({ prefetchRoute }: { prefetchRoute?: (name: string) => void }) => (
      <button type="button" onMouseEnter={() => prefetchRoute?.("datasets")}>
        Datasets
      </button>
    ));

    wrap(<App data={data} submitRequest={vi.fn()} />, store);

    expect(await screen.findByText("Refund anomaly scores")).toBeInTheDocument();
    expect(listDatasetSummaries).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Datasets" }));

    expect(listDatasetSummaries).toHaveBeenCalledTimes(1);
  });

  it("uses the nav hover prefetch when opening Datasets", async () => {
    const data = { requests: [], user: { initials: "OO", isAdmin: false } };
    const store = makeStore(() => OWNER);
    const listDatasetSummaries = vi.spyOn(store.datasets, "listDatasetSummaries");
    window.location.hash = "#home";
    setGlobal("HomeScreen", () => <div>Home</div>);
    setGlobal(
      "TopNav",
      ({
        go,
        prefetchRoute,
      }: {
        go: (name: string) => void;
        prefetchRoute?: (name: string) => void;
      }) => (
        <button
          type="button"
          onMouseEnter={() => prefetchRoute?.("datasets")}
          onClick={() => go("datasets")}
        >
          Datasets
        </button>
      ),
    );

    wrap(<App data={data} submitRequest={vi.fn()} />, store);

    const nav = screen.getByRole("button", { name: "Datasets" });
    fireEvent.mouseEnter(nav);
    await waitFor(() => expect(listDatasetSummaries).toHaveBeenCalledTimes(1));
    fireEvent.click(nav);

    expect(await screen.findByText("Refund anomaly scores")).toBeInTheDocument();
    expect(listDatasetSummaries).toHaveBeenCalledTimes(1);
  });
});
