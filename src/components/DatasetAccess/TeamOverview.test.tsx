// The team page's overview-first layout (#114): header, KPI filters, one row
// per person, and the add and edit panels. Behaviour of the forms themselves
// is pinned in DatasetAccess.test.tsx and TeamManagement.test.tsx.
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { ChangeListScreen, DatasetTeamScreen } from "./index";

afterEach(cleanup);

const TESS = { name: "Tess Tester", email: "tess.tester@example.test" };
const DEV = { name: "Dana Dev", email: "dana.dev@example.test" };

function makeStore(user: () => UserProfile) {
  return createMemoryStore(makeSnapshot(), {
    currentUser: async () => user(),
    now: makeClock().now,
    datasetSeed: makeDatasetSeed(),
    groupNaming: TEST_GROUP_NAMING,
    roleDescriptions: TEST_ROLE_DESCRIPTIONS,
  });
}

function team(store: DataStore, go = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>
        <DatasetTeamScreen ctx={{ go }} params={{ id: DATASET_ID }} />
      </StoreProvider>
    </QueryClientProvider>,
  );
  return go;
}

/** An owner's store with Tess (tester) and Dana (developer) added; CL-0001 and CL-0002 pending. */
async function storeWithTeam(me = { current: OWNER }) {
  const store = makeStore(() => me.current);
  await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
  await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...DEV, role: "developer" });
  return store;
}

const peopleTable = () => screen.findByRole("table", { name: "Members" });
const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);
const rowOf = (table: HTMLElement, text: string) =>
  bodyRows(table).find((r) => r.textContent?.includes(text))!;
const kpi = (label: RegExp) => screen.getByRole("button", { name: label });

describe("the team page header", () => {
  it("names the dataset, its tags and the viewer's role, with Add team member and Pending changes", async () => {
    const go = team(await storeWithTeam());

    expect(
      await screen.findByRole("heading", { level: 1, name: "Refund anomaly scores: team" }),
    ).toBeInTheDocument();
    expect(screen.getByText("individual-filing")).toBeInTheDocument();
    expect(screen.getByText("refund_anomalies")).toBeInTheDocument();
    expect(screen.getByLabelText("Your role")).toHaveTextContent("Manager · Owner");
    expect(screen.getByRole("button", { name: "Add team member" })).toBeInTheDocument();

    const pending = await screen.findByRole("link", { name: "Pending changes (2)" });
    expect(pending).toHaveAttribute("href", `#change-list/${DATASET_ID}`);
    fireEvent.click(pending);
    expect(go).toHaveBeenCalledWith("change-list", { id: DATASET_ID });
  });

  it("shows a member's own role, and no actions, to someone who doesn't own the dataset", async () => {
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = { ...STRANGER, email: TESS.email };
    team(store);

    expect(await screen.findByLabelText("Your role")).toHaveTextContent("Tester");
    expect(screen.queryByRole("button", { name: "Add team member" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Pending changes/ })).toBeNull();
  });
});

describe("the KPI cards", () => {
  it("count people, testers, developers, managers with owners, and pending changes", async () => {
    team(await storeWithTeam());
    await peopleTable();

    // Olive (owner, manager), Tess (tester), Dana (developer).
    expect(kpi(/^3 Members/)).toBeInTheDocument();
    expect(kpi(/^1 Testers/)).toBeInTheDocument();
    expect(kpi(/^1 Developers/)).toBeInTheDocument();
    expect(kpi(/^1 Managers/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^2 Pending changes/ })).toBeInTheDocument();
  });

  it("filter the table on click, say so, and clear back to everyone", async () => {
    team(await storeWithTeam());
    const table = await peopleTable();
    expect(bodyRows(table)).toHaveLength(3);
    expect(kpi(/Members/)).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(kpi(/Testers/));
    expect(kpi(/Testers/)).toHaveAttribute("aria-pressed", "true");
    expect(kpi(/Members/)).toHaveAttribute("aria-pressed", "false");
    expect(bodyRows(table)).toHaveLength(1);
    expect(bodyRows(table)[0]).toHaveTextContent(TESS.email);
    expect(screen.getByRole("status", { name: "Table filter" })).toHaveTextContent(
      "Showing testers: 1 of 3 people",
    );

    fireEvent.click(kpi(/Managers/));
    expect(bodyRows(table)).toHaveLength(1);
    expect(bodyRows(table)[0]).toHaveTextContent("Olive Owner");

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(bodyRows(table)).toHaveLength(3);
    expect(screen.getByRole("status", { name: "Table filter" })).toHaveTextContent(
      "Showing everyone: 3 people",
    );
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
  });

  it("the pending filter shows the people with a change waiting", async () => {
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = STAFF;
    await store.changeList.markApplied("CL-0001");
    me.current = OWNER;
    team(store);
    const table = await peopleTable();

    fireEvent.click(await screen.findByRole("button", { name: /^1 Pending changes/ }));
    expect(bodyRows(table)).toHaveLength(1);
    expect(bodyRows(table)[0]).toHaveTextContent(DEV.email);
  });
});

describe("the team table", () => {
  it("has one row per person: name and email, role badge, access, status and Edit access", async () => {
    team(await storeWithTeam());
    const table = await peopleTable();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Person", "Role", "Access levels", "Status", "Actions"]);

    const tess = rowOf(table, TESS.email);
    expect(tess).toHaveTextContent("Tess Tester");
    expect(tess).toHaveTextContent("Tester");
    expect(tess).toHaveTextContent("Test summary: read");
    expect(within(tess).getByRole("link", { name: "Pending add, CL-0001" })).toHaveAttribute(
      "href",
      `#change-list/${DATASET_ID}`,
    );
    expect(
      within(tess).getByRole("button", { name: "Edit access for Tess Tester" }),
    ).toBeInTheDocument();

    const olive = rowOf(table, "Olive Owner");
    expect(olive).toHaveTextContent("Manager");
    expect(olive).toHaveTextContent("Owner");
    expect(olive).toHaveTextContent("Active");
    // The table edits nothing itself.
    expect(within(table).queryByRole("textbox")).toBeNull();
    expect(within(table).queryByRole("radio")).toBeNull();
  });

  it("shows Active once the add is applied, and Pending removal for someone removed", async () => {
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = STAFF;
    await store.changeList.markApplied("CL-0001");
    me.current = OWNER;
    await store.datasetTeam.removeMember({
      datasetId: DATASET_ID,
      email: DEV.email,
      role: "developer",
    });
    team(store);
    const table = await peopleTable();

    expect(rowOf(table, TESS.email)).toHaveTextContent("Active");
    const dana = rowOf(table, DEV.email);
    expect(
      within(dana).getByRole("link", { name: "Pending removal, CL-0003" }),
    ).toBeInTheDocument();
    expect(within(dana).queryByRole("button")).toBeNull();
    // Dana is no longer a member: the counts leave her out.
    expect(kpi(/^2 Members/)).toBeInTheDocument();
  });
});

describe("the edit access panel", () => {
  it("opens from the row, changes nothing until confirmed, and closes on Escape with focus back", async () => {
    const user = userEvent.setup();
    const store = await storeWithTeam();
    team(store);
    const table = await peopleTable();
    const edit = within(rowOf(table, TESS.email)).getByRole("button", {
      name: "Edit access for Tess Tester",
    });

    await user.click(edit);
    const panel = screen.getByRole("dialog", { name: "Edit access: Tess Tester" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    expect(within(panel).getByRole("radiogroup", { name: "New dataset role" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("radio", { name: "Dev (test)" }));
    await user.click(within(panel).getByRole("button", { name: /Review role change/ }));
    expect(within(panel).getByRole("region", { name: "They gain" })).toHaveTextContent(
      "Test grant: read/write",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(edit).toHaveFocus();
    expect(await store.changeList.listEntries()).toHaveLength(2);
    expect(rowOf(table, TESS.email)).toHaveTextContent("Tester");
  });

  it("keeps Tab inside the panel", async () => {
    const user = userEvent.setup();
    team(await storeWithTeam());
    const table = await peopleTable();
    await user.click(within(rowOf(table, TESS.email)).getByRole("button", { name: /Edit access/ }));
    const panel = screen.getByRole("dialog");

    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(panel).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect(panel).toContainElement(document.activeElement as HTMLElement);
  });

  it("removes from the panel, after its own confirmation", async () => {
    const store = await storeWithTeam();
    team(store);
    const table = await peopleTable();
    fireEvent.click(within(rowOf(table, TESS.email)).getByRole("button", { name: /Edit access/ }));
    const panel = screen.getByRole("dialog");

    fireEvent.click(
      within(panel).getByRole("button", { name: "Remove Tess Tester's Tester role" }),
    );
    expect(within(panel).getByRole("region", { name: "Confirm the removal" })).toHaveTextContent(
      "Test grant: read",
    );
    fireEvent.click(within(panel).getByRole("button", { name: /Cancel/ }));
    expect(within(panel).getByRole("radiogroup", { name: "New dataset role" })).toBeInTheDocument();

    fireEvent.click(
      within(panel).getByRole("button", { name: "Remove Tess Tester's Tester role" }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: /Confirm removal/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByText(/Removed Tess Tester's Tester role\. CL-0003/),
    ).toBeInTheDocument();
    await waitFor(() => expect(rowOf(table, TESS.email)).toHaveTextContent("Pending removal"));
  });
});

describe("the add team member panel", () => {
  it("opens with focus in the form, and gives focus back to the button on close", async () => {
    const user = userEvent.setup();
    team(makeStore(() => OWNER));
    const add = await screen.findByRole("button", { name: "Add team member" });

    await user.click(add);
    const panel = screen.getByRole("dialog", { name: "Add team member" });
    expect(within(panel).getByRole("form", { name: "Add a member" })).toBeInTheDocument();
    expect(within(panel).getByRole("textbox", { name: /^Name/ })).toHaveFocus();

    await user.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(add).toHaveFocus();
  });

  it("closes on confirm, and the person shows in the table at once", async () => {
    const user = userEvent.setup();
    team(makeStore(() => OWNER));
    const add = await screen.findByRole("button", { name: "Add team member" });

    await user.click(add);
    const panel = screen.getByRole("dialog");
    await user.type(within(panel).getByLabelText(/^Name/), TESS.name);
    await user.type(within(panel).getByLabelText(/^Email/), TESS.email);
    await user.click(within(panel).getByRole("button", { name: /Review add/ }));
    await user.click(within(panel).getByRole("button", { name: /Confirm add/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(add).toHaveFocus();
    expect(within(await peopleTable()).getByText(TESS.email)).toBeInTheDocument();
    expect(await screen.findByText(/CL-0001 is pending on the change list/)).toBeInTheDocument();
  });
});

// #257: only the dataset's owners and EDP staff see who is on its team and how
// many. Anyone else sees only their own row, no counts and no actions.
describe("the view for someone who isn't an owner or EDP staff", () => {
  const ONLY_OWNERS_AND_STAFF =
    /Only this dataset's owners and EDP staff can see its full team, member counts and pending changes/;

  /** Olive's team (Tess, Dana), viewed by `viewer`. */
  async function viewAs(viewer: UserProfile) {
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = viewer;
    team(store);
    return peopleTable();
  }

  function expectNoCountsOrActions(table: HTMLElement) {
    expect(screen.queryByRole("group", { name: "Filter the team" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Members|Testers|Developers|Managers/ }),
    ).toBeNull();
    expect(screen.queryByRole("status", { name: "Table filter" })).toBeNull();
    expect(within(table).queryByRole("columnheader", { name: "Actions" })).toBeNull();
    expect(within(table).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add team member" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Pending changes/ })).toBeNull();
    expect(screen.getByRole("note", { name: "Who can see this team" })).toHaveTextContent(
      ONLY_OWNERS_AND_STAFF,
    );
  }

  it("shows a member only their own row, with no one else's, no counts and no actions", async () => {
    const table = await viewAs({ ...STRANGER, name: TESS.name, email: TESS.email });

    expect(bodyRows(table)).toHaveLength(1);
    expect(rowOf(table, TESS.name)).toHaveTextContent(TESS.email);
    expect(table).not.toHaveTextContent(DEV.name);
    expect(table).not.toHaveTextContent(OWNER.name);
    expect(document.body).not.toHaveTextContent(DEV.email);
    expectNoCountsOrActions(table);
    expect(screen.getByRole("note", { name: "Who can see this team" })).toHaveTextContent(
      "You see only your own roles.",
    );
  });

  it("shows someone with no role an empty team that says so", async () => {
    const table = await viewAs(STRANGER);

    expect(bodyRows(table)).toHaveLength(1);
    expect(bodyRows(table)[0]).toHaveTextContent(/^You have no role on Refund anomaly scores\.$/);
    expect(document.body).not.toHaveTextContent(TESS.email);
    expect(document.body).not.toHaveTextContent(DEV.email);
    expectNoCountsOrActions(table);
  });

  it.each([
    { label: "an owner", viewer: OWNER },
    { label: "EDP staff", viewer: STAFF },
  ])("isn't shown to $label, who sees the whole team and its counts", async ({ viewer }) => {
    const table = await viewAs(viewer);

    expect(bodyRows(table)).toHaveLength(3);
    expect(kpi(/^3 Members/)).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Who can see this team" })).toBeNull();
    expect(screen.queryByText(ONLY_OWNERS_AND_STAFF)).toBeNull();
  });
});

describe("the change list, filtered to one dataset", () => {
  it("lists only that dataset's entries and links back to every entry", async () => {
    const store = await storeWithTeam();
    // A second dataset's owner change lists an entry there too.
    await store.datasetTeam.addOwner({
      datasetId: "ds-payroll-events",
      name: "Pat Payroll",
      email: "pat@example.test",
    });
    const go = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <ChangeListScreen ctx={{ go }} params={{ id: DATASET_ID }} />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    expect(bodyRows(table)).toHaveLength(2);
    expect(table).not.toHaveTextContent("pat@example.test");
    expect(screen.getByText("Refund anomaly scores").closest("p")).toHaveTextContent(
      "Showing entries for Refund anomaly scores. Show every entry",
    );
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Show every entry" }));
    expect(go).toHaveBeenCalledWith("change-list");
  });
});

// UAT round 1 on PR #234: an owner can also add an owner from the Add team
// member panel. It's the one add-owner (AddPersonForm): same command,
// validation, refusals and change-list entries as the Owner-only form.
describe("adding an owner from the Add team member panel", () => {
  const DREW = { name: "Drew Partner", email: "drew.partner@example.test" };

  async function openPanel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Add team member" }));
    return screen.getByRole("dialog", { name: "Add team member" });
  }

  async function reviewOwner(user: ReturnType<typeof userEvent.setup>, who = DREW) {
    const panel = await openPanel(user);
    await user.type(within(panel).getByLabelText(/^Name/), who.name);
    await user.type(within(panel).getByLabelText(/^Email/), who.email);
    await user.click(within(panel).getByRole("radio", { name: "Owner" }));
    await user.click(within(panel).getByRole("button", { name: /Review new owner/ }));
    return panel;
  }

  it("offers Owner after the dataset roles, to owners only", async () => {
    const user = userEvent.setup();
    team(makeStore(() => OWNER));
    const panel = await openPanel(user);

    const cards = within(within(panel).getByRole("radiogroup")).getAllByRole("radio");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Tester",
      "Dev (test)",
      "Manager",
      "Owner",
    ]);
    expect(cards[3]).toHaveTextContent("Holds the Manager role");
    // One tab stop; End reaches Owner from the keyboard.
    cards[0]!.focus();
    await user.keyboard("{End}");
    expect(cards[3]).toHaveFocus();
    expect(cards[3]).toHaveAttribute("aria-checked", "true");
    expect(within(panel).getByRole("button", { name: /Review new owner/ })).toBeInTheDocument();
  });

  it("isn't offered to anyone who can't add owners from the team page", async () => {
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = STRANGER;
    team(store);
    await peopleTable();
    expect(screen.queryByRole("button", { name: "Add team member" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Owner" })).toBeNull();
  });

  it("says in plain words what being an owner does to their role, then saves like the Owners section", async () => {
    const user = userEvent.setup();
    const store = makeStore(() => OWNER);
    const addOwner = vi.spyOn(store.datasetTeam, "addOwner");
    const addMember = vi.spyOn(store.datasetRoles, "addMember");
    team(store);
    const panel = await reviewOwner(user);

    const review = within(panel).getByRole("region", { name: "Confirm the new owner" });
    expect(review).toHaveTextContent(
      "You're making Drew Partner (drew.partner@example.test) an owner of Refund anomaly scores.",
    );
    expect(review).toHaveTextContent("Every owner holds the Manager role");
    expect(review).toHaveTextContent(
      "A person holds one role on a dataset, so someone who already holds another role here must have it removed first.",
    );
    expect(within(review).getByRole("list", { name: "Grants" })).toHaveTextContent(
      "Test grant: manage",
    );
    expect(review).toHaveFocus();
    await user.click(within(panel).getByRole("button", { name: /Confirm new owner/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Add team member" })).toHaveFocus();
    expect(await screen.findByText(/Made Drew Partner an owner\. CL-0001/)).toBeInTheDocument();
    expect(addOwner).toHaveBeenCalledTimes(1);
    expect(addOwner).toHaveBeenCalledWith({
      datasetId: DATASET_ID,
      ...DREW,
      idempotencyKey: expect.any(String),
    });
    expect(addMember).not.toHaveBeenCalled();
    expect(screen.getByRole("table", { name: "Owners" })).toHaveTextContent(DREW.email);
    await waitFor(() =>
      expect(rowOf(screen.getByRole("table", { name: "Members" }), DREW.email)).toHaveTextContent(
        "ManagerOwner",
      ),
    );

    // The Owner-only form (EDP staff's panel, and EDP Admin's owner
    // reassignment), on a fresh store, lists the same entries.
    const viaPanel = await store.changeList.listEntries();
    cleanup();
    const other = makeStore(() => STAFF);
    team(other);
    fireEvent.click(await screen.findByRole("button", { name: "Add team member" }));
    const form = screen.getByRole("form", { name: "Add an owner" });
    fireEvent.change(within(form).getByLabelText(/Owner's name/), { target: { value: DREW.name } });
    fireEvent.change(within(form).getByLabelText(/Owner's email/), {
      target: { value: DREW.email },
    });
    fireEvent.click(within(form).getByRole("button", { name: /Review new owner/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm new owner/ }));
    expect(await screen.findByText(/Made Drew Partner an owner\. CL-0001/)).toBeInTheDocument();
    // Same entries; only who made them, and when, differ (an owner here, staff there).
    const strip = (entries: Awaited<ReturnType<DataStore["changeList"]["listEntries"]>>) =>
      entries.map(({ createdAt: _c, createdBy: _b, reason, ...e }) => ({
        ...e,
        reason: { ...reason, addedAt: undefined, addedBy: undefined },
      }));
    expect(strip(viaPanel)).toEqual(strip(await other.changeList.listEntries()));
  });

  it("warns before confirming that an existing member is refused, and the store refuses it as today", async () => {
    const user = userEvent.setup();
    const store = await storeWithTeam();
    team(store);
    const panel = await reviewOwner(user, TESS);

    expect(within(panel).getByRole("region", { name: "Confirm the new owner" })).toHaveTextContent(
      "Tess Tester already holds Tester on Refund anomaly scores, so this will be refused. Remove their Tester role first, then make them an owner.",
    );
    await user.click(within(panel).getByRole("button", { name: /Confirm new owner/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/That owner was refused.*Tester/);
    expect(await store.changeList.listEntries()).toHaveLength(2);
    // A refusal puts the details back, Owner still chosen.
    await user.click(screen.getByRole("button", { name: "Add team member" }));
    const again = screen.getByRole("dialog");
    expect(within(again).getByLabelText(/^Email/)).toHaveValue(TESS.email);
    expect(within(again).getByRole("radio", { name: "Owner" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

// UAT round 2 on PR #234: the team page's bottom "Add an owner" form is gone.
// Owners and EDP staff add owners through the Add team member panel; the
// Owners list (with Remove) stays.
describe("adding owners only through the Add team member panel", () => {
  const DREW = { name: "Drew Partner", email: "drew.partner@example.test" };

  it("shows an owner the Owners list with Remove, and no separate add-owner form", async () => {
    team(makeStore(() => OWNER));
    const owners = await screen.findByRole("table", { name: "Owners" });
    expect(owners).toHaveTextContent("Olive Owner");
    expect(screen.getByRole("button", { name: "Remove Olive Owner as owner" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add an owner" })).toBeNull();
    expect(screen.queryByText("Owner action")).toBeNull();
  });

  it("gives EDP staff the panel with Owner only, since the server lets them add owners but not members", async () => {
    const user = userEvent.setup();
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = STAFF;
    const addOwner = vi.spyOn(store.datasetTeam, "addOwner");
    team(store);
    await peopleTable();
    expect(screen.queryByRole("form", { name: "Add an owner" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add team member" }));
    const panel = screen.getByRole("dialog", { name: "Add team member" });
    expect(within(panel).getByRole("form", { name: "Add an owner" })).toBeInTheDocument();
    expect(within(panel).queryByRole("radiogroup")).toBeNull();
    expect(panel).toHaveTextContent(
      "As EDP staff, you can add owners. Only the dataset's owners add members.",
    );
    expect(within(panel).getByRole("textbox", { name: /Owner's name/ })).toHaveFocus();
    await user.type(within(panel).getByRole("textbox", { name: /Owner's name/ }), DREW.name);
    await user.type(within(panel).getByRole("textbox", { name: /Owner's email/ }), DREW.email);
    await user.click(within(panel).getByRole("button", { name: /Review new owner/ }));
    expect(within(panel).getByRole("region", { name: "Confirm the new owner" })).toHaveTextContent(
      "Every owner holds the Manager role",
    );
    await user.click(within(panel).getByRole("button", { name: /Confirm new owner/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(/Made Drew Partner an owner\. CL-0003/)).toBeInTheDocument();
    expect(addOwner).toHaveBeenCalledWith({
      datasetId: DATASET_ID,
      ...DREW,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByRole("table", { name: "Owners" })).toHaveTextContent(DREW.email);
    // Staff still can't edit members.
    expect(screen.queryByRole("button", { name: /Edit access/ })).toBeNull();
  });

  it("shows anyone else neither the panel nor an add-owner form", async () => {
    const me = { current: OWNER };
    const store = await storeWithTeam(me);
    me.current = STRANGER;
    team(store);
    await peopleTable();
    expect(screen.queryByRole("button", { name: "Add team member" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add an owner" })).toBeNull();
  });
});
