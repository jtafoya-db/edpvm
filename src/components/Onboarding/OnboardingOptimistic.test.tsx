/**
 * The provider's onboarding saves are optimistic (ADR-0009 phase 1, #195):
 * submit, resubmit and withdraw show their result at once marked Saving…, keep
 * going when the person navigates, say Saved only once the server confirms,
 * roll back only themselves on a refusal (putting what was typed back), and
 * stay Not confirmed on an unknown outcome, retried with the same key.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryStore,
  type DataStore,
  type OnboardingIntake,
  type OnboardingRequest,
  type OnboardingWriteIntent,
  type UserProfile,
} from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { COMPLETE_INTAKE_ANSWERS } from "@/data/onboarding/intake.fixtures";
import {
  backTo,
  continueTo,
  continueToResubmit,
  currentStep,
  openResubmitWizard,
} from "./__tests__/resubmit-wizard";
import { StoreProvider } from "@/data/store-provider";
import { SaveStatusRegion } from "../SaveStatus";
import { MyOnboardingRequests } from "./index";
import { OnboardingIntakeScreen } from "./OnboardingIntake";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function formControl(label: string | RegExp): HTMLElement {
  return screen.getAllByLabelText(label).find((element) => element.tagName !== "BUTTON")!;
}

const BASE_USER = makeSnapshot().user;
const PROVIDER: UserProfile = { ...BASE_USER, principalId: "scim-provider", name: "Pat Provider" };
const BUSINESS_OFFICE: UserProfile = {
  ...BASE_USER,
  principalId: "scim-bo",
  name: "Bea Office",
  onboardingReviewerRoles: ["business-office"],
};

const INTAKE: OnboardingIntake = {
  initiativeName: "Earlier initiative",
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
const DOMAINS = [{ id: "individual-filing", name: "Individual Filing" }];

let signedIn: UserProfile = PROVIDER;

function newStore(): DataStore {
  return createMemoryStore(makeSnapshot(), { currentUser: async () => signedIn });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Hold each call to `method`; the test lets it through, refuses it, or loses its answer. */
function hold<K extends "submit" | "resubmit" | "withdraw">(store: DataStore, method: K) {
  const real = store.onboarding[method].bind(store.onboarding) as (
    ...args: unknown[]
  ) => Promise<OnboardingRequest>;
  const gates: Array<{ args: unknown[]; gate: ReturnType<typeof deferred<void>> }> = [];
  const spy = vi.fn(async (...args: unknown[]) => {
    const gate = deferred<void>();
    gates.push({ args, gate });
    await gate.promise;
    return real(...args);
  });
  (store.onboarding as unknown as Record<K, unknown>)[method] = spy;
  /** The `call`th held call (the latest if omitted), once it has arrived. */
  const at = async (call?: number) => {
    await waitFor(() => expect(gates.length).toBeGreaterThan(call ?? 0));
    return gates[call ?? gates.length - 1]!;
  };
  return {
    spy,
    release: async (call?: number) => (await at(call)).gate.resolve(),
    refuse: async (message: string, call?: number) =>
      (await at(call)).gate.reject(new Error(message)),
    /** The answer is lost on the way back: the browser can't tell if it committed. */
    lose: async (call?: number) => (await at(call)).gate.reject(new TypeError("Failed to fetch")),
    /** The answer is lost after the store committed it. */
    commitThenLose: async (call?: number) => {
      const { args, gate } = await at(call);
      await real(...args);
      gate.reject(new TypeError("Failed to fetch"));
    },
    keyOf: (call: number) => (spy.mock.calls[call]!.at(-1) as OnboardingWriteIntent).key,
  };
}

/** The app shell, enough of it: two screens and the app-wide save region. */
function App({ start = "onboarding" }: { start?: "onboarding" | "onboarding-requests" }) {
  const [route, go] = useState<string>(start);
  return (
    <>
      <nav>
        <button type="button" onClick={() => go("onboarding")}>
          Nav: onboard
        </button>
        <button type="button" onClick={() => go("onboarding-requests")}>
          Nav: my requests
        </button>
        <button type="button" onClick={() => go("home")}>
          Nav: home
        </button>
      </nav>
      {route === "onboarding" ? (
        <OnboardingIntakeScreen ctx={{ go, flash: () => undefined }} domains={DOMAINS} />
      ) : route === "onboarding-requests" ? (
        <MyOnboardingRequests go={go} />
      ) : (
        <h1>Home</h1>
      )}
      <SaveStatusRegion />
    </>
  );
}

function renderApp(store: DataStore, ui: ReactNode = <App />) {
  signedIn = PROVIDER;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

const nav = (to: "onboard" | "my requests" | "home") =>
  fireEvent.click(screen.getByRole("button", { name: `Nav: ${to}` }));

const next = () => fireEvent.click(screen.getByRole("button", { name: /continue/i }));

/** Walk the wizard to its review step with a valid intake. */
function toReview(name = "Collections case signals") {
  vi.useFakeTimers();
  fireEvent.change(formControl(/initiative name/i), { target: { value: name } });
  fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
  fireEvent.change(formControl(/data sensitivity/i), { target: { value: "SBU" } });
  next();
  fireEvent.click(screen.getByRole("button", { name: /All within Databricks/i }));
  next();
  fireEvent.click(screen.getByRole("button", { name: /We have our own resources/i }));
  next();
  fireEvent.change(formControl(/business justification/i), {
    target: { value: "Prioritize balance-due cases across streams." },
  });
  fireEvent.click(screen.getByRole("button", { name: /Reduce fraud and improper payments/i }));
  fireEvent.change(formControl(/primary mission outcome/i), { target: { value: "fraud" } });
  fireEvent.change(formControl(/estimated annual benefit/i), { target: { value: "100000" } });
  next();
  fireEvent.change(formControl("Dataset 1 name"), { target: { value: "Signals" } });
  fireEvent.change(formControl("Dataset 1 source system"), {
    target: { value: "IMF / Individual Master File" },
  });
  fireEvent.change(formControl("Dataset 1 domain"), {
    target: { value: "individual-filing" },
  });
  fireEvent.change(formControl("Dataset 1 ingestion method"), { target: { value: "eftu" } });
  fireEvent.change(formControl("Dataset 1 tag"), { target: { value: "signals" } });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByRole("radio", {
      name: /someone else/i,
    }),
  );
  fireEvent.change(
    within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByLabelText("Owner's name"),
    {
      target: { value: "Olive Owner" },
    },
  );
  fireEvent.change(
    within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByLabelText(
      "Owner's email",
    ),
    {
      target: { value: "olive.owner@example.gov" },
    },
  );
  next();
  fireEvent.change(formControl(/code or work products/i), {
    target: { value: "Not sure — ask EDP staff to assess" },
  });
  fireEvent.change(formControl(/how many people/i), { target: { value: "6" } });
  next();
  fireEvent.change(formControl(/data volume/i), { target: { value: "500" } });
  fireEvent.change(formControl(/load frequency/i), { target: { value: "Daily" } });
  fireEvent.change(formControl(/transformation complexity/i), {
    target: { value: "Moderate — joins and recurring business rules" },
  });
  fireEvent.change(formControl(/business users needing to query/i), { target: { value: "40" } });
  fireEvent.click(screen.getByRole("button", { name: /run preliminary estimate/i }));
  act(() => vi.advanceTimersByTime(900));
  next();
  vi.useRealTimers();
}

const submitButton = () => screen.getByRole("button", { name: /submit data onboarding request/i });
const newCard = (name = "Collections case signals") =>
  screen.getByRole("article", { name: `New request ${name}` });

describe("submitting an intake", () => {
  it("shows the request as Submitted and Saving… before the server answers, then Saved once it confirms", async () => {
    const store = newStore();
    const held = hold(store, "submit");
    renderApp(store);
    toReview();

    fireEvent.click(submitButton());
    expect(
      await screen.findByRole("heading", { name: "Saving your onboarding request…" }),
    ).toBeInTheDocument();

    // The person moves on while it saves: it's in their list, not yet stored.
    nav("my requests");
    const card = await screen.findByRole("article", {
      name: "New request Collections case signals",
    });
    expect(card).toHaveTextContent("Current stage: Submitted");
    expect(card).toHaveTextContent("ID assigned when it's saved");
    expect(within(card).getByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText(/^Submitted ONB-/)).not.toBeInTheDocument();

    await act(() => held.release());
    const saved = await screen.findByText(
      /^Submitted ONB-[0-9A-HJKMNP-TV-Z]{6}: Collections case signals is with/,
    );
    expect(saved.closest("[data-save-state]")).toHaveAttribute("data-save-state", "saved");
    const stored = screen.getByRole("article", {
      name: /^ONB-[0-9A-HJKMNP-TV-Z]{6} Collections case signals$/,
    });
    expect(stored).toHaveTextContent("Current stage: Business & ROI review");
    expect(within(stored).queryByText("Saving…")).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: /^New request/ })).not.toBeInTheDocument();
    expect(held.spy).toHaveBeenCalledTimes(1);
  });

  it("makes one request for rapid clicks", async () => {
    const store = newStore();
    const held = hold(store, "submit");
    renderApp(store);
    toReview();
    const submit = submitButton();
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);
    await act(() => held.release());
    await screen.findByRole("heading", { name: "Onboarding request submitted" });

    signedIn = PROVIDER;
    expect(await store.onboarding.listMine()).toHaveLength(1);
    expect(held.spy).toHaveBeenCalledTimes(1);
  });

  it("rolls back a refusal after the person navigated away, and puts the typed intake back in the form", async () => {
    const store = newStore();
    signedIn = PROVIDER;
    const earlier = await store.onboarding.submit(INTAKE);
    const held = hold(store, "submit");
    renderApp(store);
    toReview();
    fireEvent.click(submitButton());
    nav("my requests");
    await screen.findByRole("article", { name: "New request Collections case signals" });

    await act(() => held.refuse("Dataset tag signals is already used by another dataset."));
    // Only this save is rolled back: the earlier request stays.
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: /^New request/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("article", { name: new RegExp(earlier.id) })).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That onboarding request was refused");
    expect(alert).toHaveTextContent("Dataset tag signals is already used by another dataset.");

    // Back in the wizard: on the review step, with what they typed.
    nav("onboard");
    expect(submitButton()).toBeEnabled();
    expect(screen.getAllByText("Collections case signals").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(formControl("Dataset 1 tag")).toHaveValue("signals");
    expect(
      within(screen.getByRole("group", { name: "Dataset 1 owner 1" })).getByLabelText(
        "Owner's email",
      ),
    ).toHaveValue("olive.owner@example.gov");
  });

  it("stays Not confirmed when the answer is lost, and Try again sends the same key so it's stored once", async () => {
    const store = newStore();
    const held = hold(store, "submit");
    renderApp(store);
    toReview();
    fireEvent.click(submitButton());
    await act(() => held.commitThenLose());

    expect(
      await screen.findByRole("heading", { name: "Your onboarding request isn't confirmed yet" }),
    ).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't confirm this save");
    expect(alert).not.toHaveTextContent(/refused/i);

    nav("my requests");
    const card = await screen.findByRole("article", {
      name: "New request Collections case signals",
    });
    expect(within(card).getByText("Not confirmed")).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2));
    expect(held.keyOf(1)).toBe(held.keyOf(0));
    await act(() => held.release(1));

    await screen.findByText(/^Submitted ONB-[0-9A-HJKMNP-TV-Z]{6}/);
    signedIn = PROVIDER;
    // The server replayed the first commit for the same key: one request.
    expect(await store.onboarding.listMine()).toHaveLength(1);
  });
});

describe("withdrawing and resubmitting", () => {
  async function submitted(store: DataStore, name = INTAKE.initiativeName) {
    signedIn = PROVIDER;
    return store.onboarding.submit({ ...INTAKE, initiativeName: name });
  }

  it("shows a withdrawal as Withdrawn and Saving… before the server answers; it survives leaving the page and says Saved once confirmed", async () => {
    const store = newStore();
    const created = await submitted(store);
    const held = hold(store, "withdraw");
    renderApp(store, <App start="onboarding-requests" />);
    let card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /withdraw request/i }));

    fireEvent.click(within(card).getByRole("button", { name: /confirm withdrawal/i }));
    expect(await within(card).findByText("Saving…")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: Withdrawn");

    nav("home");
    // Away from the screen, the app-wide region still says it's saving.
    expect(screen.getByText(`Saving… Withdraw ${created.id}`)).toBeInTheDocument();
    nav("my requests");
    card = await screen.findByRole("article", { name: new RegExp(created.id) });
    expect(within(card).getByText("Saving…")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: Withdrawn");

    await act(() => held.release());
    expect(
      await within(card).findByText(
        `Withdrew ${created.id}. It's closed and no longer under review.`,
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByText("Saving…")).not.toBeInTheDocument();
    signedIn = PROVIDER;
    expect((await store.onboarding.get(created.id))?.stage).toBe("withdrawn");
  });

  it("rolls back only the refused save when two requests are withdrawn at once", async () => {
    const store = newStore();
    const first = await submitted(store, "First initiative");
    const second = await submitted(store, "Second initiative");
    const held = hold(store, "withdraw");
    renderApp(store, <App start="onboarding-requests" />);
    for (const request of [first, second]) {
      const card = await screen.findByRole("article", { name: new RegExp(request.id) });
      fireEvent.click(within(card).getByRole("button", { name: /withdraw request/i }));
      fireEvent.click(within(card).getByRole("button", { name: /confirm withdrawal/i }));
    }
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2));

    const refusedCall = held.spy.mock.calls.findIndex((call) => call[0] === first.id);
    await act(() => held.refuse("It moved on: reload and try again.", refusedCall));
    const firstCard = screen.getByRole("article", { name: new RegExp(first.id) });
    const secondCard = screen.getByRole("article", { name: new RegExp(second.id) });
    await waitFor(() =>
      expect(firstCard).toHaveTextContent("Current stage: Business & ROI review"),
    );
    expect(within(firstCard).getByRole("alert")).toHaveTextContent("That withdrawal was refused");
    expect(secondCard).toHaveTextContent("Current stage: Withdrawn");
    expect(within(secondCard).getByText("Saving…")).toBeInTheDocument();
  });

  it("puts a refused resubmission's answer back, and retries a lost one with the same key", async () => {
    const store = newStore();
    const created = await submitted(store);
    signedIn = BUSINESS_OFFICE;
    await store.onboarding.decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Which streams use it?",
    });
    const held = hold(store, "resubmit");
    renderApp(store, <App start="onboarding-requests" />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Collections and exam." },
    });
    let wizard = openResubmitWizard(card);
    continueTo(wizard, "Datasets");
    fireEvent.change(within(wizard).getByLabelText("Dataset 1 tag"), {
      target: { value: "case_signals_gold" },
    });
    const resubmit = continueToResubmit(wizard);

    fireEvent.click(resubmit);
    expect(await within(card).findByText("Saving…")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: Business & ROI review");
    expect(card).toHaveTextContent("case_signals_gold");

    // Refused: the send-back is back, with the answer and the wizard as typed,
    // open on its last step as a refused first submit is.
    await act(() => held.refuse("The answer needs the stream names."));
    expect(await within(card).findByLabelText("Your answer")).toHaveValue("Collections and exam.");
    wizard = within(card).getByRole("region", { name: /^Edit the intake for/ });
    expect(currentStep(wizard)).toBe("Review & submit");
    backTo(wizard, "Datasets");
    expect(within(wizard).getByLabelText("Dataset 1 tag")).toHaveValue("case_signals_gold");
    expect(within(card).getAllByRole("alert")[0]).toHaveTextContent(
      "That resubmission was refused",
    );
    expect(card).toHaveTextContent("Current stage: Submitted");

    // Lost: it stays shown as resubmitted, Not confirmed; Try again is the same key.
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Collections and exam streams." },
    });
    fireEvent.click(continueToResubmit(wizard));
    await act(() => held.lose(1));
    expect(await within(card).findByText("Not confirmed")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: Business & ROI review");
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(3));
    expect(held.keyOf(2)).toBe(held.keyOf(1));
    expect(held.keyOf(1)).not.toBe(held.keyOf(0));
    await act(() => held.release(2));
    expect(
      await within(card).findByText(
        `Resubmitted ${created.id}: it's back with the business office.`,
      ),
    ).toBeInTheDocument();
  });
});
