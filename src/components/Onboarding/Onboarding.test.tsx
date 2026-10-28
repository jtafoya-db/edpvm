import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryStore, type DataStore, type OnboardingIntake, type UserProfile } from "@/data";
import { StoreProvider } from "@/data/store-provider";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { COMPLETE_INTAKE_ANSWERS } from "@/data/onboarding/intake.fixtures";
import { MyOnboardingRequests, OnboardingInbox } from "./index";
import { continueTo, continueToResubmit, openResubmitWizard } from "./__tests__/resubmit-wizard";

afterEach(cleanup);

function formControl(scope: HTMLElement, label: string | RegExp): HTMLElement {
  return within(scope)
    .getAllByLabelText(label)
    .find((element) => element.tagName !== "BUTTON")!;
}

const BASE_USER = makeSnapshot().user;

function profile(over: Partial<UserProfile>): UserProfile {
  return { ...BASE_USER, ...over };
}

const PROVIDER = profile({ principalId: "scim-provider", name: "Pat Provider" });
const BUSINESS_OFFICE = profile({
  principalId: "scim-bo",
  name: "Bea Office",
  onboardingReviewerRoles: ["business-office"],
  // A per-role reviewer, not EDP staff: staff owner matching (#103) is off this inbox for them.
  isAdmin: false,
});
const CCB = profile({
  principalId: "scim-ccb",
  name: "Cal Board",
  onboardingReviewerRoles: ["ccb"],
  isAdmin: false,
});

const INTAKE: OnboardingIntake = {
  initiativeName: "Collections case signals",
  businessCase: "Prioritize balance-due cases.",
  annualBenefit: 1_250_000,
  levers: ["taxgap"],
  datasets: [
    {
      name: "Case signals",
      sourceSystem: "IMF / Individual Master File",
      domain: "individual-filing",
      ingestionMethod: "eftu",
      datasetTag: "case_signals",
      owners: [{ name: "Olive Owner", email: "olive.owner@example.gov" }],
    },
  ],
  workspaceNeeds: { isolation: "Not sure", teamSize: 6 },
  answers: { ...COMPLETE_INTAKE_ANSWERS },
  initiativeOwner: { kind: "self" },
};

// Who the store's session resolves to. The store reads it on every call.
let signedIn: UserProfile | Error = PROVIDER;

function newStore(): DataStore {
  return createMemoryStore(makeSnapshot(), {
    currentUser: async () => {
      if (signedIn instanceof Error) throw signedIn;
      return signedIn;
    },
  });
}

/** Sign in as `user`, then render `ui` over the same store. */
function renderAs(store: DataStore, user: UserProfile | Error, ui: ReactNode) {
  signedIn = user;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

/** Act directly on the store as `user` (setup steps outside the rendered screen). */
function as(store: DataStore, user: UserProfile) {
  signedIn = user;
  return store.onboarding;
}

describe("role-scoped onboarding inboxes", () => {
  it("asks the business office to confirm before approval moves the request to the CCB", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);

    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    expect(
      within(item).getByText(/Service-level agreement \(SLA\): On track · 0 of 5 business days/),
    ).toBeInTheDocument();
    expect(within(item).getByText(/olive.owner@example.gov/)).toBeInTheDocument();

    fireEvent.click(within(item).getByRole("button", { name: "Approve" }));
    expect(item).toHaveTextContent(/moves to CCB/i);
    expect(item).toHaveTextContent(/Bea Office \(scim-bo\)/);
    expect(document.activeElement).toHaveTextContent(/Approve this initiative/i);
    expect((await store.onboarding.get(created.id))?.stage).toBe("business-roi-review");

    fireEvent.click(within(item).getByRole("button", { name: "Cancel" }));
    const approve = within(item).getByRole("button", { name: "Approve" });
    expect(document.activeElement).toBe(approve);
    fireEvent.click(approve);
    fireEvent.click(within(item).getByRole("button", { name: "Confirm approval" }));
    expect(
      await screen.findByText(/Nothing is waiting on the business & roi review/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveAttribute("role", "status"));
    expect(document.activeElement).toHaveTextContent(/Approved Collections case signals/);
    expect((await as(store, PROVIDER).get(created.id))?.stage).toBe("ccb");
    cleanup();

    renderAs(store, CCB, <OnboardingInbox role="ccb" />);
    expect(
      await screen.findByRole("article", { name: new RegExp(created.id) }),
    ).toBeInTheDocument();
  });

  it("shows an error when identity cannot be resolved", async () => {
    renderAs(newStore(), new Error("401"), <OnboardingInbox role="ccb" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not resolve who you are: 401/,
    );
  });

  it("does not show another user's request in My onboarding requests", async () => {
    const store = newStore();
    await as(store, PROVIDER).submit(INTAKE);

    renderAs(store, BUSINESS_OFFICE, <MyOnboardingRequests />);
    await screen.findByText(/haven't submitted an onboarding request/i);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("asks the CCB to confirm the standup stage and recorded reviewer", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, { type: "approve" });

    renderAs(store, CCB, <OnboardingInbox role="ccb" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(item).getByRole("button", { name: "Approve" }));

    expect(item).toHaveTextContent(/moves to Standup/i);
    expect(document.activeElement).toHaveTextContent(/Approve this initiative/i);
    expect(item).toHaveTextContent(/Cal Board \(scim-ccb\)/);
    expect((await store.onboarding.get(created.id))?.stage).toBe("ccb");

    fireEvent.click(within(item).getByRole("button", { name: "Confirm approval" }));
    expect(await screen.findByText(/Nothing is waiting on the CCB/i)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveAttribute("role", "status"));
    expect(document.activeElement).toHaveTextContent(/Approved Collections case signals/);
    expect((await as(store, PROVIDER).get(created.id))?.stage).toBe("standup");
  });

  it("marks a request the CCB sent back as a new response, with the answer and what changed", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, { type: "approve" });
    await as(store, CCB).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Use the governed tag.",
    });
    await as(store, PROVIDER).resubmit(created.id, {
      answer: "Retagged it.",
      intake: {
        ...created.intake,
        datasets: [{ ...created.intake.datasets[0]!, datasetTag: "case_signals_gold" }],
      },
    });

    renderAs(store, CCB, <OnboardingInbox role="ccb" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    const response = within(item).getByRole("region", {
      name: /new response from the data provider/i,
    });
    expect(response).toHaveTextContent("Resubmitted");
    expect(response).toHaveTextContent("Question: “Use the governed tag.”");
    expect(response).toHaveTextContent("Pat Provider answered: “Retagged it.”");
    const changes = within(response).getByRole("table", { name: /changed since the send-back/i });
    expect(
      within(changes).getByRole("row", {
        name: /Dataset 1 dataset tag case_signals case_signals_gold/,
      }),
    ).toBeInTheDocument();
  });

  it("says nothing in the intake changed when the provider only answered", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Clarify the benefit.",
    });
    await as(store, PROVIDER).resubmit(created.id, { answer: "It's recurring." });

    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    const response = within(item).getByRole("region", {
      name: /new response from the data provider/i,
    });
    expect(response).toHaveTextContent("No intake fields changed; only the answer is new.");
  });

  it("shows no new-response marker on a request that was never sent back", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    expect(within(item).queryByRole("region", { name: /new response/i })).not.toBeInTheDocument();
  });

  it("requires a rejection reason in the inbox", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);

    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    const reject = within(item).getByRole("button", { name: "Reject" });
    fireEvent.click(reject);
    expect(document.activeElement).toBe(within(item).getByLabelText("Reason for rejection"));
    fireEvent.click(within(item).getByRole("button", { name: "Cancel" }));
    const reopenedReject = within(item).getByRole("button", { name: "Reject" });
    expect(document.activeElement).toBe(reopenedReject);
    fireEvent.click(reopenedReject);
    fireEvent.click(within(item).getByRole("button", { name: "Confirm rejection" }));

    expect(within(item).getByRole("alert")).toHaveTextContent(/Enter the reason for rejection/);
    expect((await store.onboarding.get(created.id))?.stage).toBe("business-roi-review");
  });
});

describe("the data provider's onboarding requests", () => {
  it("shows the current stage and SLA state", async () => {
    const store = newStore();
    await as(store, PROVIDER).submit(INTAKE);

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: /Collections case signals/ });
    expect(
      within(card).getByText("Business & ROI review", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Service-level agreement \(SLA\): On track/)).toBeInTheDocument();
  });

  it("answers a send-back and resubmits it to the business & ROI review", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Which workspaces need isolation?",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    expect(within(card).getByText("“Which workspaces need isolation?”")).toBeInTheDocument();
    expect(within(card).getByText("Waiting on the data provider")).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Only prod analytics." },
    });
    const wizard = openResubmitWizard(card);
    // Opening the wizard moves focus to it.
    expect(document.activeElement).toHaveTextContent(`Edit the intake for ${created.id}`);
    fireEvent.click(continueToResubmit(wizard));

    expect(
      await within(card).findByText(/Service-level agreement \(SLA\): On track/),
    ).toBeInTheDocument();
    expect((await store.onboarding.get(created.id))?.stage).toBe("business-roi-review");
  });

  it("tells the provider a CCB send-back goes back to the CCB, and resubmits it there", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, { type: "approve" });
    await as(store, CCB).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Which streams?",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    expect(card).toHaveTextContent("It goes back to the CCB.");
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Two streams." },
    });
    fireEvent.click(continueToResubmit(openResubmitWizard(card)));

    await waitFor(() => expect(card).toHaveTextContent("Current stage: CCB"));
    expect((await store.onboarding.get(created.id))?.stage).toBe("ccb");
  });

  it("opens the whole intake prefilled, with every step's answers editable", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Restate the business case.",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    const wizard = openResubmitWizard(card);
    // The same steps as the first submit, on the first one, prefilled.
    expect(
      within(wizard)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Initiative",
      "Architecture",
      "Delivery support",
      "Business case",
      "Datasets",
      "Workspace",
      "Sizing",
      "Review & submit",
    ]);
    expect(formControl(wizard, /Initiative name/)).toHaveValue(INTAKE.initiativeName);
    // No steward any more (#103), even on a request that has one stored.
    expect(within(wizard).queryByLabelText(/Accountable data steward/)).toBeNull();
    continueTo(wizard, "Business case");
    expect(formControl(wizard, /Business justification/)).toHaveValue(INTAKE.businessCase);
    expect(formControl(wizard, /Estimated annual benefit/)).toHaveValue("1250000");
    continueTo(wizard, "Datasets");
    expect(formControl(wizard, "Dataset 1 tag")).toHaveValue("case_signals");
    continueTo(wizard, "Workspace");
    expect(formControl(wizard, /How many people/)).toHaveValue("6");
  });

  it("starts Someone else blank when a stored Myself owner is switched, never with the provider's identity", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit({
      ...INTAKE,
      datasets: [{ ...INTAKE.datasets[0]!, owners: [{ self: true, name: "", email: "" }] }],
    });
    // Stored as the session's identity, which the resubmit wizard reads back.
    expect(created.intake.datasets[0]?.owners[0]).toMatchObject({
      self: true,
      name: "Pat Provider",
    });
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Who owns this?",
    });
    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    const wizard = openResubmitWizard(card);

    // The initiative owner, as a guard: stored Myself, switched, starts blank.
    const initiative = within(wizard).getByRole("group", {
      name: /initiative point of contact/i,
    });
    expect(within(initiative).getByRole("radio", { name: /myself/i })).toBeChecked();
    fireEvent.click(within(initiative).getByRole("radio", { name: /someone else/i }));
    expect(within(initiative).getByLabelText("Owner's name")).toHaveValue("");
    expect(within(initiative).getByLabelText("Owner's email")).toHaveValue("");
    fireEvent.click(within(initiative).getByRole("radio", { name: /myself/i }));

    continueTo(wizard, "Datasets");
    const row = within(wizard).getByRole("group", { name: "Dataset 1 owner 1" });
    expect(within(row).getByRole("radio", { name: /myself/i })).toBeChecked();
    fireEvent.click(within(row).getByRole("radio", { name: /someone else/i }));
    expect(within(row).getByLabelText("Owner's name")).toHaveValue("");
    expect(within(row).getByLabelText("Owner's email")).toHaveValue("");

    // What's typed as Someone else in this session survives a switch to Myself and back.
    fireEvent.change(within(row).getByLabelText("Owner's name"), { target: { value: "Sam Else" } });
    fireEvent.change(within(row).getByLabelText("Owner's email"), {
      target: { value: "sam.else@example.gov" },
    });
    fireEvent.click(within(row).getByRole("radio", { name: /myself/i }));
    fireEvent.click(within(row).getByRole("radio", { name: /someone else/i }));
    expect(within(row).getByLabelText("Owner's name")).toHaveValue("Sam Else");
    expect(within(row).getByLabelText("Owner's email")).toHaveValue("sam.else@example.gov");
  });

  it("never moves a new owner's typed details to another stored dataset when one is removed", async () => {
    const store = newStore();
    const dataset = INTAKE.datasets[0]!;
    const created = await as(store, PROVIDER).submit({
      ...INTAKE,
      datasets: [
        { ...dataset, name: "First", datasetTag: "first" },
        { ...dataset, name: "Second", datasetTag: "second" },
      ],
    });
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Drop the first dataset.",
    });
    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    const wizard = openResubmitWizard(card);
    continueTo(wizard, "Datasets");
    const row = (d: number, o: number) =>
      within(wizard).getByRole("group", { name: `Dataset ${d} owner ${o}` });

    // A new owner on stored dataset 1: typed as Someone else, then switched to Myself.
    fireEvent.click(within(wizard).getByRole("button", { name: "Add an owner to dataset 1" }));
    fireEvent.click(within(row(1, 2)).getByRole("radio", { name: /someone else/i }));
    fireEvent.change(within(row(1, 2)).getByLabelText("Owner's name"), {
      target: { value: "Hidden Person" },
    });
    fireEvent.change(within(row(1, 2)).getByLabelText("Owner's email"), {
      target: { value: "hidden@example.gov" },
    });
    fireEvent.click(within(row(1, 2)).getByRole("radio", { name: /myself/i }));
    // A new owner on stored dataset 2, in the same position.
    fireEvent.click(within(wizard).getByRole("button", { name: "Add an owner to dataset 2" }));

    fireEvent.click(within(wizard).getByRole("button", { name: "Remove dataset 1" }));
    expect(formControl(wizard, "Dataset 1 name")).toHaveValue("Second");
    fireEvent.click(within(row(1, 2)).getByRole("radio", { name: /someone else/i }));
    expect(within(row(1, 2)).getByLabelText("Owner's name")).toHaveValue("");
    expect(within(row(1, 2)).getByLabelText("Owner's email")).toHaveValue("");
  });

  it("resubmits an edited ROI answer, an added dataset and a removed owner, and the reviewer sees each", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit({
      ...INTAKE,
      datasets: [
        {
          ...INTAKE.datasets[0]!,
          owners: [
            { name: "Olive Owner", email: "olive.owner@example.gov" },
            { name: "Otto Second", email: "otto.second@example.gov" },
          ],
        },
      ],
    });
    await as(store, BUSINESS_OFFICE).decide(created.id, { type: "approve" });
    await as(store, CCB).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Restate the ROI and add the ledger.",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Restated the ROI and added the ledger." },
    });
    const wizard = openResubmitWizard(card);
    continueTo(wizard, "Business case");
    fireEvent.change(formControl(wizard, /Estimated annual benefit/), {
      target: { value: "2000000" },
    });
    continueTo(wizard, "Datasets");
    fireEvent.click(
      within(within(wizard).getByRole("region", { name: "Dataset 1" })).getByRole("button", {
        name: "Remove owner 2",
      }),
    );
    fireEvent.click(within(wizard).getByRole("button", { name: "Add another dataset" }));
    fireEvent.change(formControl(wizard, "Dataset 2 name"), {
      target: { value: "Collections ledger" },
    });
    fireEvent.change(formControl(wizard, "Dataset 2 source system"), {
      target: { value: "BMF / Business Master File" },
    });
    fireEvent.change(formControl(wizard, "Dataset 2 domain"), {
      target: { value: "other" },
    });
    fireEvent.change(formControl(wizard, "Dataset 2 ingestion method"), {
      target: { value: "eftu" },
    });
    fireEvent.change(formControl(wizard, "Dataset 2 tag"), {
      target: { value: "collections_ledger" },
    });
    fireEvent.click(
      within(within(wizard).getByRole("group", { name: "Dataset 2 owner 1" })).getByRole("radio", {
        name: /someone else/i,
      }),
    );
    fireEvent.change(
      within(within(wizard).getByRole("group", { name: "Dataset 2 owner 1" })).getByLabelText(
        "Owner's name",
      ),
      {
        target: { value: "Lee Ledger" },
      },
    );
    fireEvent.change(
      within(within(wizard).getByRole("group", { name: "Dataset 2 owner 1" })).getByLabelText(
        "Owner's email",
      ),
      {
        target: { value: "lee.ledger@example.gov" },
      },
    );
    fireEvent.click(continueToResubmit(wizard));

    await waitFor(() => expect(card).toHaveTextContent("Current stage: CCB"));
    const stored = (await store.onboarding.get(created.id))!;
    expect(stored.intake.annualBenefit).toBe(2_000_000);
    expect(stored.intake.datasets.map((d) => d.name)).toEqual([
      "Case signals",
      "Collections ledger",
    ]);
    expect(stored.intake.datasets[0]!.id).toBe(created.intake.datasets[0]!.id);
    expect(stored.intake.datasets[0]!.owners.map((o) => o.name)).toEqual(["Olive Owner"]);
    expect(stored.decisions.at(-1)?.note).toMatch(
      /Removed owner from Case signals: Otto Second \(otto.second@example.gov\)\./,
    );
    cleanup();

    renderAs(store, CCB, <OnboardingInbox role="ccb" />);
    const item = await screen.findByRole("article", { name: new RegExp(created.id) });
    const changes = within(item).getByRole("table", { name: /changed since the send-back/i });
    for (const row of [
      /Estimated annual benefit \(USD\) \$1,250,000 \$2,000,000/,
      /Dataset 1 owner 2 removed Otto Second \(otto.second@example.gov\)/,
      /Dataset 2 added — Collections ledger \(collections_ledger\)/,
    ]) {
      expect(within(changes).getByRole("row", { name: row })).toBeInTheDocument();
    }
  });

  it("enforces the tag rule in the wizard and resubmits the fixed tag", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Use the governed dataset tag.",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Updated the dataset metadata." },
    });
    const wizard = openResubmitWizard(card);
    continueTo(wizard, "Datasets");
    const tag = formControl(wizard, "Dataset 1 tag");
    fireEvent.change(formControl(wizard, "Dataset 1 name"), {
      target: { value: "Case signals gold" },
    });
    fireEvent.change(tag, { target: { value: "Case Signals Gold" } });
    fireEvent.blur(tag);
    expect(within(wizard).getByText(/can only use lowercase letters/i)).toBeInTheDocument();

    // Continue is refused with the error summary, which takes focus (#184).
    fireEvent.click(within(wizard).getByRole("button", { name: /^Continue/ }));
    expect(document.activeElement).toHaveAttribute("aria-label", "Validation errors");

    fireEvent.change(tag, { target: { value: "case_signals_gold" } });
    fireEvent.click(continueToResubmit(wizard));

    expect(
      await within(card).findByText(/Service-level agreement \(SLA\): On track/),
    ).toBeInTheDocument();
    const stored = await store.onboarding.get(created.id);
    expect(stored?.intake.datasets[0]).toMatchObject({
      name: "Case signals gold",
      datasetTag: "case_signals_gold",
    });
  });

  it("asks for the answer in the error summary, and focuses it only on a failed attempt", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Clarify.",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    const wizard = openResubmitWizard(card);
    const resubmit = continueToResubmit(wizard);
    // Nothing tried yet: no summary, nothing marked wrong.
    expect(within(wizard).queryByRole("alert")).toBeNull();
    expect(within(card).getByLabelText("Your answer")).not.toHaveAttribute("aria-invalid");

    fireEvent.click(resubmit);
    const summary = within(wizard).getByRole("alert");
    expect(document.activeElement).toBe(summary);
    const link = within(summary).getByRole("link", { name: "Enter an answer for the reviewer." });
    fireEvent.click(link);
    expect(within(card).getByLabelText("Your answer")).toHaveFocus();
    expect(within(card).getByLabelText("Your answer")).toHaveAttribute("aria-invalid", "true");
    expect((await store.onboarding.get(created.id))?.stage).toBe("submitted");

    fireEvent.change(within(card).getByLabelText("Your answer"), { target: { value: "Done." } });
    expect(within(wizard).queryByRole("alert")).toBeNull();
    fireEvent.click(resubmit);
    await waitFor(async () =>
      expect((await store.onboarding.get(created.id))?.stage).toBe("business-roi-review"),
    );
  });

  it("closes the wizard without resubmitting, leaving the request with the provider", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Clarify.",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    const wizard = openResubmitWizard(card);
    fireEvent.click(within(wizard).getByRole("button", { name: "Close without resubmitting" }));
    expect(within(card).queryByRole("region", { name: /^Edit the intake for/ })).toBeNull();
    expect(
      within(card).getByRole("button", { name: "Review the intake and resubmit" }),
    ).toBeInTheDocument();
    expect((await store.onboarding.get(created.id))?.stage).toBe("submitted");
  });

  it("gives every element a unique id when two cards' wizards are open at once", async () => {
    const store = newStore();
    const first = await as(store, PROVIDER).submit(INTAKE);
    const second = await as(store, PROVIDER).submit({
      ...INTAKE,
      initiativeName: "Collections case extracts",
    });
    for (const request of [first, second]) {
      await as(store, BUSINESS_OFFICE).decide(request.id, {
        type: "send-back",
        to: "submitted",
        note: "Fix the dataset metadata.",
      });
    }

    const { container } = renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const cards = [
      await screen.findByRole("article", { name: new RegExp(first.id) }),
      await screen.findByRole("article", { name: new RegExp(second.id) }),
    ];
    for (const card of cards) continueTo(openResubmitWizard(card), "Datasets");

    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`${first.id.toLowerCase()}-resubmit-dataset-1-tag`);
    expect(ids).toContain(`${second.id.toLowerCase()}-resubmit-dataset-1-tag`);
    for (const card of cards) {
      for (const label of Array.from(card.querySelectorAll<HTMLLabelElement>("label[for]"))) {
        expect(card.querySelector(`#${CSS.escape(label.htmlFor)}`)).toBeInstanceOf(HTMLElement);
      }
    }
  });

  it("withdraws a request, which then shows as withdrawn", async () => {
    const store = newStore();
    await as(store, PROVIDER).submit(INTAKE);

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw request" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findAllByText("Withdrawn", { selector: "strong" })).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Withdraw request" })).not.toBeInTheDocument();
  });

  it("shows the rejection reason expanded on a rejected request", async () => {
    const store = newStore();
    const created = await as(store, PROVIDER).submit(INTAKE);
    await as(store, BUSINESS_OFFICE).decide(created.id, {
      type: "reject",
      note: "The expected benefit does not justify the cost.",
    });

    renderAs(store, PROVIDER, <MyOnboardingRequests />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    const reason = within(card).getByRole("region", { name: "Reason for rejection" });
    expect(reason).toHaveTextContent("The expected benefit does not justify the cost.");
    expect(reason).toHaveTextContent(/Bea Office/);
  });

  it("says so when the provider has no requests", async () => {
    renderAs(newStore(), PROVIDER, <MyOnboardingRequests />);
    expect(await screen.findByText(/haven't submitted an onboarding request/)).toBeInTheDocument();
  });
});
