import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryStore, type DataStore, type OnboardingIntake, type UserProfile } from "@/data";
import { StoreProvider } from "@/data/store-provider";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { completeIntake } from "@/data/onboarding/intake.fixtures";
import { ChangeListScreen } from "../DatasetAccess";
import { MyOnboardingRequests, OnboardingInbox } from "./index";

afterEach(cleanup);

const BASE_USER = makeSnapshot().user;
const PROVIDER: UserProfile = {
  ...BASE_USER,
  principalId: "scim-provider",
  name: "Pat Provider",
  email: "pat.provider@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: [],
};
/** EDP staff: the EDP admin group, which holds every staff role (#226). */
const STAFF: UserProfile = {
  ...BASE_USER,
  principalId: "scim-staff",
  name: "Sasha Staff",
  isAdmin: true,
  onboardingReviewerRoles: ["business-office", "ccb"],
};
const REVIEWER: UserProfile = {
  ...BASE_USER,
  principalId: "scim-bo",
  name: "Bea Office",
  isAdmin: false,
  onboardingReviewerRoles: ["business-office"],
};

const INTAKE: OnboardingIntake = completeIntake({
  initiativeOwner: { kind: "self" },
  datasets: [
    {
      name: "Case signals",
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      ingestionMethod: "eftu",
      datasetTag: "case_signals",
      owners: [
        { name: "Olive Owner", email: "olive.owner@example.gov" },
        { name: "Noel Newhire", email: "noel.newhire@example.gov" },
      ],
    },
  ],
});

let signedIn: UserProfile = PROVIDER;

function newStore(): DataStore {
  return createMemoryStore(makeSnapshot(), { currentUser: async () => signedIn });
}

function renderAs(store: DataStore, user: UserProfile, ui: ReactNode) {
  signedIn = user;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

async function submitted(store: DataStore) {
  signedIn = PROVIDER;
  return store.onboarding.submit(INTAKE);
}

async function ownersPanel() {
  const heading = await screen.findByRole("heading", { name: "Owners and their Databricks users" });
  return heading.closest("section")!;
}

const ownerItem = (panel: HTMLElement, name: RegExp) =>
  within(panel).getByRole("listitem", { name });

describe("EDP staff match owners on the review screen (#103, 103-B)", () => {
  it("lists every owner with their match state, Myself already verified", async () => {
    const store = newStore();
    await submitted(store);
    renderAs(store, STAFF, <OnboardingInbox role="business-office" />);

    const panel = await ownersPanel();
    const initiative = ownerItem(panel, /Pat Provider, Initiative point of contact/);
    expect(initiative).toHaveTextContent("Verified: signed-in account");
    expect(within(initiative).queryByRole("button")).not.toBeInTheDocument();
    const olive = ownerItem(panel, /Olive Owner, Owner of Case signals/);
    expect(olive).toHaveTextContent("Not verified");
    expect(olive).toHaveTextContent("Not matched to a Databricks user yet.");
    expect(within(olive).getByRole("button", { name: "Match Olive Owner" })).toBeInTheDocument();
    expect(
      within(olive).getByRole("button", { name: "Request user onboarding for Olive Owner" }),
    ).toBeInTheDocument();
  });

  it("refuses a principal ID that isn't digits, then records a match as entered by staff, not verified", async () => {
    const store = newStore();
    const request = await submitted(store);
    renderAs(store, STAFF, <OnboardingInbox role="business-office" />);

    const panel = await ownersPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "Match Olive Owner" }));
    const input = within(panel).getByLabelText("Databricks principal ID for Olive Owner");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "olive@example.gov" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save match" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent(/digits only/);
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(input, { target: { value: "7412589630" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save match" }));

    const olive = await waitFor(() => {
      const item = ownerItem(panel, /Olive Owner/);
      expect(item).toHaveTextContent("Matched by EDP staff, not verified");
      return item;
    });
    expect(olive).toHaveTextContent(/Databricks principal ID 7412589630, entered by Sasha Staff/);
    expect(panel).toHaveTextContent("Matched Olive Owner to Databricks principal ID 7412589630.");
    // The staff read keeps the principal; the provider's read has state only.
    const [stored] = await store.onboarding.listInbox("business-office");
    expect(stored!.ownerMatches.find((o) => o.name === "Olive Owner")?.principalId).toBe(
      "7412589630",
    );
  });

  it("requests user onboarding for an owner and names the change-list entry", async () => {
    const store = newStore();
    await submitted(store);
    renderAs(store, STAFF, <OnboardingInbox role="business-office" />);

    const panel = await ownersPanel();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Request user onboarding for Noel Newhire" }),
    );
    await waitFor(() =>
      expect(ownerItem(panel, /Noel Newhire/)).toHaveTextContent(
        "Onboarding is on the change list as CL-0001.",
      ),
    );
    expect(ownerItem(panel, /Noel Newhire/)).toHaveTextContent("Not a Databricks user yet");
    expect(
      within(ownerItem(panel, /Noel Newhire/)).queryByRole("button", {
        name: /Request user onboarding/,
      }),
    ).not.toBeInTheDocument();
    signedIn = STAFF;
    expect((await store.changeList.listEntries()).map((entry) => entry.kind)).toEqual([
      "onboard-user",
    ]);
  });

  it("shows a reviewer who isn't EDP staff no matching", async () => {
    const store = newStore();
    await submitted(store);
    renderAs(store, REVIEWER, <OnboardingInbox role="business-office" />);
    await screen.findByRole("article");
    expect(
      screen.queryByRole("heading", { name: "Owners and their Databricks users" }),
    ).not.toBeInTheDocument();
  });
});

describe("the provider sees each owner's match state", () => {
  it("marks a staff match and a requested onboarding on their request page", async () => {
    const store = newStore();
    const request = await submitted(store);
    signedIn = STAFF;
    const [olive, noel] = request.ownerMatches.filter((owner) => owner.role === "dataset");
    await store.onboarding.matchOwner(request.id, { ownerId: olive!.ownerId, principalId: "1234" });
    await store.onboarding.requestOwnerOnboarding(request.id, { ownerId: noel!.ownerId });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    fireEvent.click(await screen.findByRole("button", { name: /Open all steps/ }));
    const oliveRow = (await screen.findByText(/Olive Owner \(olive.owner@example.gov\)/)).closest(
      "dd",
    )!;
    expect(oliveRow).toHaveTextContent("Matched by EDP staff, not verified");
    const noelRow = screen.getByText(/Noel Newhire \(noel.newhire@example.gov\)/).closest("dd")!;
    expect(noelRow).toHaveTextContent("Not a Databricks user yet");
  });
});

describe("the change list describes an onboard-user entry", () => {
  it("says whom to onboard, for which initiative, and that it's by hand, with no raw payload", async () => {
    const store = newStore();
    const request = await submitted(store);
    signedIn = STAFF;
    const noel = request.ownerMatches.find((owner) => owner.name === "Noel Newhire")!;
    await store.onboarding.requestOwnerOnboarding(request.id, { ownerId: noel.ownerId });

    renderAs(store, STAFF, <ChangeListScreen ctx={{ go: () => undefined }} />);
    const table = await screen.findByRole("table", { name: "Change-list entries" });
    expect(table).toHaveTextContent(
      "Onboard Noel Newhire (noel.newhire@example.gov) as a Databricks user",
    );
    expect(table).toHaveTextContent(
      `For: initiative Collections case signals (${request.id}). Done by hand only.`,
    );
    expect(table).toHaveTextContent(
      `EDP staff (scim-staff) marked them not a Databricks user yet; they're named as an owner on ${request.id}`,
    );
    expect(table).not.toHaveTextContent("{");
    // WCAG 1.4.10: at high zoom the table scrolls sideways in its own focusable
    // region, so every column, Mark applied included, stays reachable.
    const region = screen.getByRole("region", { name: "Change-list entries, scrolls sideways" });
    expect(region).toContainElement(table);
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.style.overflowX).toBe("auto");
    expect(screen.getByRole("button", { name: "Mark applied CL-0001" })).toBeInTheDocument();
  });
});
