import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { httpTransport } from "@/data/adapters/delta";
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

const TESS = { name: "Tess Tester", email: "tess.tester@example.gov" };

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

const team = (store: DataStore) =>
  wrap(<DatasetTeamScreen ctx={{ go: vi.fn() }} params={{ id: DATASET_ID }} />, store);

/**
 * The add-owner form, in the Add team member panel (UAT round 2, PR #234):
 * an owner picks the Owner card; EDP staff get an Owner-only form.
 */
async function openAddOwner() {
  fireEvent.click(await screen.findByRole("button", { name: "Add team member" }));
  const panel = screen.getByRole("dialog", { name: "Add team member" });
  const owner = within(panel).queryByRole("radio", { name: "Owner" });
  if (owner) fireEvent.click(owner);
  return within(panel).getByRole("form", { name: owner ? "Add a member" : "Add an owner" });
}

async function storeWithTess(role: "tester" | "developer" = "tester") {
  const store = makeStore(() => OWNER);
  await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role });
  return store;
}

describe("editing a member's role on the team page", () => {
  it("picks the new role from the role cards, shows what they lose and gain, then lists the entries", async () => {
    const store = await storeWithTess();
    team(store);

    fireEvent.click(await screen.findByRole("button", { name: "Edit access for Tess Tester" }));
    const cards = screen.getByRole("radiogroup", { name: "New dataset role" });
    fireEvent.click(within(cards).getByRole("radio", { name: "Dev (test)" }));
    fireEvent.click(screen.getByRole("button", { name: /Review role change/ }));

    const confirm = screen.getByRole("region", { name: "Confirm the role change" });
    expect(confirm).toHaveTextContent("from Tester to Dev (test)");
    expect(within(confirm).getByRole("region", { name: "They lose" })).toHaveTextContent(
      "Test grant: read",
    );
    expect(within(confirm).getByRole("region", { name: "They gain" })).toHaveTextContent(
      "Test grant: read/write",
    );
    fireEvent.click(screen.getByRole("button", { name: /Confirm role change/ }));

    expect(
      await screen.findByText(/Changed Tess Tester from Tester to Dev \(test\)\. CL-0002, CL-0003/),
    ).toBeInTheDocument();
    const members = screen.getByRole("table", { name: "Members" });
    const tess = within(members)
      .getAllByRole("row")
      .find((r) => r.textContent?.includes(TESS.email));
    expect(tess).toHaveTextContent("Dev (test)");
    expect(await screen.findByRole("table", { name: "Team history" })).toHaveTextContent(
      "Changed Tess Tester (tess.tester@example.gov) from Tester to Dev (test)",
    );
  });

  it("says so, and lists nothing, when the chosen role is the one they already hold", async () => {
    const store = await storeWithTess();
    team(store);

    fireEvent.click(await screen.findByRole("button", { name: "Edit access for Tess Tester" }));
    fireEvent.click(screen.getByRole("button", { name: /Review role change/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tester is already their role here");
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(await store.changeList.listEntries()).toHaveLength(1);
  });
});

describe("removing a member's role", () => {
  it("confirms what they lose, then lists a remove-member entry", async () => {
    const store = await storeWithTess();
    team(store);

    fireEvent.click(await screen.findByRole("button", { name: "Edit access for Tess Tester" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Tess Tester's Tester role" }));
    expect(screen.getByRole("region", { name: "Confirm the removal" })).toHaveTextContent(
      "Test grant: read",
    );
    fireEvent.click(screen.getByRole("button", { name: /Confirm removal/ }));

    expect(
      await screen.findByText(/Removed Tess Tester's Tester role\. CL-0002/),
    ).toBeInTheDocument();
    // Tess stays listed until EDP staff apply the removal (#114).
    await waitFor(() =>
      expect(
        within(screen.getByRole("table", { name: "Members" }))
          .getByText(TESS.email)
          .closest("tr"),
      ).toHaveTextContent("Pending removal · CL-0002"),
    );
    expect((await store.changeList.listEntries()).map((e) => e.kind)).toEqual([
      "add-member",
      "remove-member",
    ]);
  });
});

describe("owners", () => {
  it("refuses removing the last owner with a clear message", async () => {
    team(makeStore(() => OWNER));

    fireEvent.click(await screen.findByRole("button", { name: "Remove Olive Owner as owner" }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm owner removal/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Olive Owner is the last owner of Refund anomaly scores, and a dataset can't be left without one.",
    );
  });

  it("the remove-owner confirmation lists what they lose, ownership and the manager grants", async () => {
    const store = makeStore(() => OWNER);
    await store.datasetTeam.addOwner({
      datasetId: DATASET_ID,
      name: "Drew",
      email: "drew@example.gov",
    });
    team(store);

    fireEvent.click(await screen.findByRole("button", { name: "Remove Drew as owner" }));
    const confirm = screen.getByRole("region", { name: "Confirm the owner removal" });
    const lose = within(confirm).getByRole("region", { name: "They lose" });
    expect(lose).toHaveTextContent("Ownership");
    expect(lose).toHaveTextContent("The Maintainer role");
    expect(lose).toHaveTextContent("Test grant: read/write");
    expect(lose).toHaveTextContent("Test grant: manage");
    fireEvent.click(within(confirm).getByRole("button", { name: /Confirm owner removal/ }));

    // An owner holds only the manager role, so removing them leaves only their pending removal.
    expect(
      await screen.findByText(
        /Removed Drew as an owner and from the Maintainer role\. CL-0002 pending/,
      ),
    ).toBeInTheDocument();
    const members = screen.getByRole("table", { name: "Members" });
    await waitFor(() =>
      expect(within(members).getByText("drew@example.gov").closest("tr")).toHaveTextContent(
        "Pending removal · CL-0002",
      ),
    );
  });

  it("removing a seeded owner confirms the manager grants and lists the removal by Databricks account ID", async () => {
    let me = OWNER;
    const store = makeStore(() => me);
    await store.datasetTeam.addOwner({
      datasetId: DATASET_ID,
      name: "Drew",
      email: "drew@example.gov",
    });
    team(store);

    const members = await screen.findByRole("table", { name: "Members" });
    expect(members).toHaveTextContent(`Databricks account ID ${OWNER.principalId}`);
    fireEvent.click(screen.getByRole("button", { name: "Remove Olive Owner as owner" }));
    const confirm = screen.getByRole("region", { name: "Confirm the owner removal" });
    expect(within(confirm).getByRole("region", { name: "They lose" })).toHaveTextContent(
      "Test grant: manage",
    );
    expect(confirm).toHaveTextContent(
      `remove them (Databricks account ID ${OWNER.principalId}) from the Maintainer group`,
    );
    fireEvent.click(within(confirm).getByRole("button", { name: /Confirm owner removal/ }));

    expect(
      await screen.findByText(
        /Removed Olive Owner as an owner and from the Maintainer role\. CL-0002/,
      ),
    ).toBeInTheDocument();
    // Olive no longer owns the dataset, so the change list is EDP staff's to read.
    me = STAFF;
    expect(await store.changeList.listEntries()).toContainEqual(
      expect.objectContaining({
        kind: "remove-member",
        target: expect.objectContaining({
          person: { name: OWNER.name, email: "", principalId: OWNER.principalId },
          role: "manager",
        }),
      }),
    );
  });

  it("adds an owner, who shows as holding manager and can't have that role edited", async () => {
    const store = makeStore(() => OWNER);
    team(store);

    const form = await openAddOwner();
    fireEvent.change(within(form).getByLabelText(/name/i), { target: { value: "Drew Partner" } });
    fireEvent.change(within(form).getByLabelText(/email/i), {
      target: { value: "drew.partner@example.gov" },
    });
    fireEvent.click(within(form).getByRole("button", { name: /Review new owner/ }));
    expect(screen.getByRole("region", { name: "Confirm the new owner" })).toHaveTextContent(
      "Test grant: manage",
    );
    fireEvent.click(screen.getByRole("button", { name: /Confirm new owner/ }));

    expect(await screen.findByText(/Made Drew Partner an owner\. CL-0001/)).toBeInTheDocument();
    const owners = screen.getByRole("table", { name: "Owners" });
    expect(owners).toHaveTextContent("drew.partner@example.gov");
    expect(owners).toHaveTextContent("Not bound yet");
    const members = await screen.findByRole("table", { name: "Members" });
    expect(members).toHaveTextContent("Owner: holds Maintainer");
    expect(within(members).queryByRole("button", { name: /Edit access for Drew/ })).toBeNull();
  });

  it("the Owner-only add form names the existing role that will be replaced", async () => {
    let current = OWNER;
    const store = makeStore(() => current);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "developer" });
    current = STAFF;
    team(store);

    const form = await openAddOwner();
    fireEvent.change(within(form).getByLabelText(/Owner's name/), {
      target: { value: TESS.name },
    });
    fireEvent.change(within(form).getByLabelText(/Owner's email/), {
      target: { value: TESS.email },
    });
    fireEvent.click(within(form).getByRole("button", { name: /Review new owner/ }));

    expect(screen.getByRole("region", { name: "Confirm the new owner" })).toHaveTextContent(
      "Making Tess Tester an owner will replace their Dev (test) role with Maintainer in one step.",
    );
    fireEvent.click(screen.getByRole("button", { name: /Confirm new owner/ }));
    expect(await screen.findByText(/Made Tess Tester an owner\./)).toBeInTheDocument();
    expect(await store.datasetTeam.listTeamEvents(DATASET_ID)).toEqual([
      expect.objectContaining({ kind: "owner-added", replacedRole: "developer" }),
    ]);
  });

  it("marks the add-owner fields required, and on an empty submit announces and focuses the errors", async () => {
    // EDP staff's Owner-only form, which carries the add-owner wording.
    team(makeStore(() => STAFF));

    const form = await openAddOwner();
    const name = within(form).getByRole("textbox", { name: /Owner's name/ });
    const email = within(form).getByRole("textbox", { name: /Owner's email/ });
    expect(name).toBeRequired();
    expect(email).toBeRequired();
    expect(email).toHaveAccessibleDescription(
      "They act as an owner once signed in with this email.",
    );

    fireEvent.click(within(form).getByRole("button", { name: /Review new owner/ }));

    const summary = within(form).getByRole("alert");
    expect(summary).toHaveFocus();
    expect(
      within(summary).getByRole("link", { name: "Enter the new owner's name." }),
    ).toHaveAttribute("href", "#owner-name");
    expect(name).toBeInvalid();
    expect(name).toHaveAccessibleDescription("Enter the new owner's name.");
    expect(email).toHaveAccessibleDescription(
      "Enter an email address in the format name@example.gov.",
    );
    fireEvent.click(within(summary).getByRole("link", { name: /email address/ }));
    expect(email).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Confirm the new owner" })).toBeNull();
  });

  it("keeps focus and every keystroke in an add-owner field after a failed submit (#179)", async () => {
    const user = userEvent.setup();
    team(makeStore(() => STAFF));
    const form = await openAddOwner();
    await user.click(within(form).getByRole("button", { name: /Review new owner/ }));
    const summary = within(form).getByRole("alert");
    expect(summary).toHaveFocus();

    await user.click(within(summary).getByRole("link", { name: "Enter the new owner's name." }));
    const name = within(form).getByRole("textbox", { name: /Owner's name/ });
    await user.keyboard("Drew Partner");
    expect(name).toHaveFocus();
    expect(name).toHaveValue("Drew Partner");
    expect(within(summary).queryByRole("link", { name: "Enter the new owner's name." })).toBeNull();
    await user.tab();
    expect(summary).not.toHaveFocus();

    await user.click(within(form).getByRole("button", { name: /Review new owner/ }));
    expect(within(form).getByRole("alert")).toHaveFocus();
  });

  async function teamAs(viewer: UserProfile) {
    const me = { current: OWNER };
    const store = makeStore(() => me.current);
    await store.datasetRoles.addMember({ datasetId: DATASET_ID, ...TESS, role: "tester" });
    me.current = viewer;
    team(store);
  }

  it("EDP staff who don't own the dataset can manage owners but not members", async () => {
    await teamAs(STAFF);

    expect(await openAddOwner()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Remove Olive Owner as owner" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit access for Tess/ })).toBeNull();
  });

  it("anyone else sees the team read-only", async () => {
    await teamAs(STRANGER);

    expect(await screen.findByRole("table", { name: "Owners" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add an owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove|Edit/ })).toBeNull();
  });
});

// #189: the Databricks Apps proxy can answer a save with an HTML page (an
// expired sign-in, a 502) that never reached the app server. The add goes
// through the real browser API client; answers the test doesn't script reach
// the store, as the server would.
describe("adding an owner when the proxy answers instead of the app", () => {
  const SIGN_IN_PAGE = "<!DOCTYPE html><html><body>Sign in to Databricks</body></html>";
  const html = (status: number) => () =>
    new Response(SIGN_IN_PAGE, { status, headers: { "content-type": "text/html" } });

  function addOwnerOverHttp(store: DataStore, answers: Array<() => Response>) {
    const real = store.datasetTeam.addOwner.bind(store.datasetTeam);
    const keys: string[] = [];
    const transport = httpTransport((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      keys.push(body.idempotencyKey);
      const scripted = answers.shift();
      if (scripted) return scripted();
      return new Response(JSON.stringify({ result: await real(body.payload) }), { status: 200 });
    }) as unknown as typeof fetch);
    store.datasetTeam.addOwner = async (input) =>
      (
        await transport.command<{ result: Awaited<ReturnType<typeof real>> }>(
          "teams",
          "add-owner",
          { idempotencyKey: input.idempotencyKey ?? "", expectedVersion: 0, payload: input },
        )
      ).result;
    return keys;
  }

  async function confirmNewOwner(user: ReturnType<typeof userEvent.setup>) {
    const form = await openAddOwner();
    await user.type(within(form).getByLabelText(/name/i), "Drew Partner");
    await user.type(within(form).getByLabelText(/email/i), "drew.partner@example.gov");
    await user.click(within(form).getByRole("button", { name: /Review new owner/ }));
    await user.click(screen.getByRole("button", { name: /Confirm new owner/ }));
  }

  function expectNoRefusalOrRawText(alert: HTMLElement) {
    expect(alert).not.toHaveTextContent(/refused|wasn.t saved/i);
    expect(alert).not.toHaveTextContent(/Unexpected token|JSON|DOCTYPE|<html/);
  }

  it("says the sign-in expired and nothing was saved, never 'refused' or a parse error", async () => {
    const user = userEvent.setup();
    const store = makeStore(() => OWNER);
    addOwnerOverHttp(store, [html(200)]);
    team(store);

    await confirmNewOwner(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your sign-in has expired");
    expect(alert).toHaveTextContent("Reload the page to sign in again — nothing was saved.");
    expect(within(alert).getByRole("button", { name: "Reload the page" })).toBeInTheDocument();
    expectNoRefusalOrRawText(alert);
    // Announced, not focused (#184).
    expect(alert).not.toHaveFocus();
    expect(alert).not.toHaveAttribute("tabindex");
    expect(screen.getByRole("table", { name: "Owners" })).not.toHaveTextContent("drew.partner");
  });

  it("says a gateway failure is unconfirmed, and the retry resends the same key", async () => {
    const user = userEvent.setup();
    const store = makeStore(() => OWNER);
    const keys = addOwnerOverHttp(store, [html(502)]);
    team(store);

    await confirmNewOwner(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't confirm this save");
    expect(alert).toHaveTextContent("Check the list before trying again.");
    expectNoRefusalOrRawText(alert);
    expect(alert).not.toHaveFocus();

    // The new owner stays on the list, unconfirmed; Try again resends the same key.
    expect(screen.getByRole("table", { name: "Owners" })).toHaveTextContent("Not confirmed");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Made Drew Partner an owner\. CL-0001/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(screen.queryByText("We couldn't confirm this save")).toBeNull();
  });

  it("says the app couldn't be reached when its ownership check gets the proxy's 503 page", async () => {
    const user = userEvent.setup();
    const store = makeStore(() => OWNER);
    const unavailable = httpTransport(
      (async () =>
        new Response("<!DOCTYPE html><html><title>Databricks App Not Available</title></html>", {
          status: 503,
          headers: { "content-type": "text/html; charset=UTF-8" },
        })) as unknown as typeof fetch,
    );
    // A read the store makes before a write (e.g. a record's version) gets
    // the page when the app is stopped; nothing was sent, so nothing saved.
    store.datasetTeam.addOwner = () => unavailable.read("teams", "ownership");
    team(store);

    await confirmNewOwner(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't reach the app");
    expect(alert).toHaveTextContent("Try again in a moment.");
    expectNoRefusalOrRawText(alert);
  });

  it("still shows the server's own refusal as refused", async () => {
    const user = userEvent.setup();
    const store = makeStore(() => OWNER);
    addOwnerOverHttp(store, [
      () =>
        new Response(
          JSON.stringify({
            error: { code: "duplicate", message: "Drew Partner is already an owner." },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    ]);
    team(store);

    await confirmNewOwner(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That owner was refused");
    expect(alert).toHaveTextContent("Drew Partner is already an owner.");
  });
});

describe("the change list shows team-management entries", () => {
  it("says to remove from the old group and add to the new one, why, and what each role grants", async () => {
    const store = await storeWithTess();
    await store.datasetTeam.changeMemberRole({
      datasetId: DATASET_ID,
      email: TESS.email,
      role: "tester",
      newRole: "developer",
    });
    wrap(<ChangeListScreen ctx={{ go: vi.fn() }} />, store);

    const table = await screen.findByRole("table", { name: "Change-list entries" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[1]).toHaveTextContent(
      "Remove Tess Tester (tess.tester@example.gov) from group edp-refund_anomalies-tester",
    );
    expect(rows[1]).toHaveTextContent("Revokes: Test grant: read");
    expect(rows[1]).toHaveTextContent(
      "Olive Owner changed their role on Refund anomaly scores from Tester to Dev (test)",
    );
    expect(rows[2]).toHaveTextContent(
      "Add Tess Tester (tess.tester@example.gov) to group edp-refund_anomalies-developer",
    );
    expect(rows[2]).toHaveTextContent("Grants: Test grant: read/write");
    expect(rows).toHaveLength(3);
  });
});
