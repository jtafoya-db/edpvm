/**
 * Saves in flight on the onboarding screens (#131 UAT): the button that started
 * a save is disabled and says so, the record's other actions wait, a polite
 * live region announces it, and a double click reaches the store once. One
 * confirmation is one intent: a retry of it sends the same key, a changed
 * decision a new one. Reviewer decisions block with "Saving…" (ADR-0009 keeps
 * staff approvals synchronous); the provider's saves are optimistic (#195),
 * covered further in OnboardingOptimistic.test.tsx.
 */
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import {
  createDeltaStore,
  createMemoryStore,
  isSavingOnboardingRequest,
  submitOnboardingSave,
  useDecideOnboardingRequest,
  useMyOnboardingRequests,
  useOnboardingRequest,
  useWriteIntent,
  withdrawOnboardingSave,
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
import { httpTransport, type CommandBody } from "@/data/adapters/delta";
import { useSave } from "@/data/optimistic-save";
import { MyOnboardingRequests, OnboardingInbox } from "./index";
import { OnboardingIntakeScreen, type OnboardingIntakeCtx } from "./OnboardingIntake";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BASE_USER = makeSnapshot().user;
const PROVIDER: UserProfile = { ...BASE_USER, principalId: "scim-provider", name: "Pat Provider" };
const BUSINESS_OFFICE: UserProfile = {
  ...BASE_USER,
  principalId: "scim-bo",
  name: "Bea Office",
  onboardingReviewerRoles: ["business-office"],
};
const CCB: UserProfile = {
  ...BASE_USER,
  principalId: "scim-ccb",
  name: "Cal Board",
  onboardingReviewerRoles: ["ccb"],
};

const INTAKE: OnboardingIntake = {
  initiativeName: "Collections case signals",
  businessCase: "Prioritize balance-due cases.",
  annualBenefit: 1_250_000,
  levers: ["taxgap"],
  datasets: [
    {
      name: "Case signals",
      domain: "individual-filing",
      datasetTag: "case_signals",
      owners: [{ name: "Olive Owner", email: "olive.owner@example.test" }],
    },
  ],
  workspaceNeeds: { isolation: "Not sure", teamSize: 6 },
  answers: { ...COMPLETE_INTAKE_ANSWERS },
  initiativeOwner: { kind: "self" },
};

let signedIn: UserProfile = PROVIDER;

function newStore(): DataStore {
  return createMemoryStore(makeSnapshot(), { currentUser: async () => signedIn });
}

function wrapper(store: DataStore) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <StoreProvider store={store}>{children}</StoreProvider>
    </QueryClientProvider>
  );
}

function renderAs(store: DataStore, user: UserProfile, ui: ReactNode) {
  signedIn = user;
  const Wrapper = wrapper(store);
  return render(<Wrapper>{ui}</Wrapper>);
}

/** A save the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Hold every call to `method` until the test settles it; the calls are recorded. */
function holdWrites<K extends "submit" | "decide" | "resubmit" | "withdraw">(
  store: DataStore,
  method: K,
) {
  const real = store.onboarding[method].bind(store.onboarding) as (
    ...args: unknown[]
  ) => Promise<OnboardingRequest>;
  const pending: Array<ReturnType<typeof deferred<void>>> = [];
  const spy = vi.fn(async (...args: unknown[]) => {
    const gate = deferred<void>();
    pending.push(gate);
    await gate.promise;
    return real(...args);
  });
  (store.onboarding as unknown as Record<K, unknown>)[method] = spy;
  return {
    spy,
    /** The store's own method, for setup steps that shouldn't be held. */
    real,
    /** Let the latest held call through to the real store. */
    release: async () => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.at(-1)!.resolve();
    },
    /** Fail the latest held call, as a refused save would. */
    fail: async (message: string) => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.at(-1)!.reject(new Error(message));
    },
    intentOf: (call: number) => spy.mock.calls[call]!.at(-1) as OnboardingWriteIntent,
  };
}

async function submitAsProvider(store: DataStore) {
  signedIn = PROVIDER;
  return store.onboarding.submit(INTAKE);
}

const next = () => fireEvent.click(screen.getByRole("button", { name: /continue/i }));

/** Walk the intake wizard to its review step with a valid intake. */
function toReview() {
  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText(/initiative name/i), {
    target: { value: "Collections case signals" },
  });
  fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
  next();
  next();
  next();
  fireEvent.change(screen.getByLabelText(/business justification/i), {
    target: { value: "Prioritize balance-due cases across streams." },
  });
  next();
  fireEvent.change(screen.getByLabelText("Dataset 1 name"), { target: { value: "Signals" } });
  fireEvent.change(screen.getByLabelText("Dataset 1 domain"), {
    target: { value: "individual-filing" },
  });
  fireEvent.change(screen.getByLabelText("Dataset 1 tag"), { target: { value: "signals" } });
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
      target: { value: "olive.owner@example.test" },
    },
  );
  next();
  fireEvent.change(screen.getByLabelText(/isolated from other tenants/i), {
    target: { value: "Not sure" },
  });
  fireEvent.change(screen.getByLabelText(/how many people/i), { target: { value: "6" } });
  next();
  fireEvent.click(screen.getByRole("button", { name: /run ai sizing/i }));
  act(() => vi.advanceTimersByTime(900));
  next();
  vi.useRealTimers();
}

describe("reviewer decisions while a save is in flight", () => {
  it("disables the confirmation, says Saving…, and sends one decision for a double click", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    const held = holdWrites(store, "decide");
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /^approve$/i }));
    const confirm = within(card).getByRole("button", { name: /confirm approval/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    const saving = await within(card).findByRole("button", { name: /saving…/i });
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(within(card).getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(within(card).getByRole("status")).toHaveTextContent(
      `Saving your decision on ${created.id}…`,
    );
    expect(held.spy).toHaveBeenCalledTimes(1);

    await act(() => held.release());
    expect(await screen.findByText(`Approved ${created.title}.`)).toBeInTheDocument();
    expect(held.spy).toHaveBeenCalledTimes(1);
  });

  it("re-enables after a failure, keeps the note, and retries the same intent with the same key", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    const held = holdWrites(store, "decide");
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /^reject$/i }));
    fireEvent.change(within(card).getByLabelText("Reason for rejection"), {
      target: { value: "Duplicates an existing initiative." },
    });
    fireEvent.click(within(card).getByRole("button", { name: /confirm rejection/i }));
    expect(await within(card).findByRole("button", { name: /saving…/i })).toBeDisabled();

    await act(() => held.fail("The warehouse is unavailable."));
    expect(await within(card).findByText("The warehouse is unavailable.")).toBeInTheDocument();
    const retry = within(card).getByRole("button", { name: /confirm rejection/i });
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(within(card).getByLabelText("Reason for rejection")).toHaveValue(
      "Duplicates an existing initiative.",
    );
    expect(within(card).getByRole("status")).toHaveTextContent("");

    // The same decision again is a retry of the same intent: the same key.
    fireEvent.click(retry);
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2));
    expect(held.intentOf(1).key).toBe(held.intentOf(0).key);

    // A changed decision is a new intent: a new key.
    await act(() => held.fail("Still unavailable."));
    await within(card).findByText("Still unavailable.");
    fireEvent.change(within(card).getByLabelText("Reason for rejection"), {
      target: { value: "Out of scope for EDP." },
    });
    fireEvent.click(within(card).getByRole("button", { name: /confirm rejection/i }));
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(3));
    expect(held.intentOf(2).key).not.toBe(held.intentOf(0).key);
  });

  it("gives the next decision on the record a new key once one succeeds", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    signedIn = BUSINESS_OFFICE;
    await store.onboarding.decide(created.id, { type: "approve" });
    const held = holdWrites(store, "decide");
    const first = renderAs(store, CCB, <OnboardingInbox role="ccb" />);

    let card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /send back/i }));
    fireEvent.change(within(card).getByLabelText("Questions"), {
      target: { value: "Which streams use it?" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /send back to/i }));
    await act(() => held.release());
    await screen.findByText(/Sent .* back to/);
    first.unmount();

    // The provider resubmits, straight back to the CCB (#221); the CCB's next
    // decision on the same record is a new intent.
    signedIn = PROVIDER;
    await store.onboarding.resubmit(created.id, { answer: "Collections." });
    renderAs(store, CCB, <OnboardingInbox role="ccb" />);
    card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /send back/i }));
    fireEvent.change(within(card).getByLabelText("Questions"), {
      target: { value: "Which streams use it?" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /send back to/i }));
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2));
    expect(held.intentOf(1).key).not.toBe(held.intentOf(0).key);
  });
});

describe("the onboarding decision hook", () => {
  it("joins a second call made before the re-render to the save already in flight", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    const held = holdWrites(store, "decide");
    signedIn = BUSINESS_OFFICE;
    const { result } = renderHook(() => useDecideOnboardingRequest(), {
      wrapper: wrapper(store),
    });

    let first!: Promise<OnboardingRequest>;
    let second!: Promise<OnboardingRequest>;
    act(() => {
      const intent = { key: "intent-1" };
      first = result.current.mutateAsync({ id: created.id, decision: { type: "approve" }, intent });
      second = result.current.mutateAsync({
        id: created.id,
        decision: { type: "approve" },
        intent,
      });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(held.spy).toHaveBeenCalledTimes(1);

    await act(() => held.release());
    await expect(first).resolves.toMatchObject({ stage: "ccb" });
    await expect(second).resolves.toMatchObject({ stage: "ccb" });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(held.spy).toHaveBeenCalledTimes(1);
  });
});

describe("the provider's resubmit and withdraw while a save is in flight", () => {
  async function sentBack(store: DataStore) {
    const created = await submitAsProvider(store);
    signedIn = BUSINESS_OFFICE;
    await store.onboarding.decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Which streams use it?",
    });
    return created;
  }

  it("shows a resubmission at once marked Saving…, locks Withdraw, and sends one for a double click", async () => {
    const store = newStore();
    const created = await sentBack(store);
    const held = holdWrites(store, "resubmit");
    renderAs(store, PROVIDER, <MyOnboardingRequests />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Collections and exam." },
    });
    const resubmit = continueToResubmit(openResubmitWizard(card));
    fireEvent.click(resubmit);
    fireEvent.click(resubmit);

    // At once: back at business & ROI review, marked Saving…, never as done.
    expect(await within(card).findByText("Saving…")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: Business & ROI review");
    expect(within(card).queryByLabelText("Your answer")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /withdraw request/i })).toBeDisabled();
    expect(
      within(card).getByText(`Saving… Answer the questions on ${created.id} and resubmit it`),
    ).toBeInTheDocument();
    expect(held.spy).toHaveBeenCalledTimes(1);

    await act(() => held.release());
    expect(
      await within(card).findByText(
        `Resubmitted ${created.id}: it's back with the business office.`,
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByText("Saving…")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /withdraw request/i })).toBeEnabled();
    expect(held.spy).toHaveBeenCalledTimes(1);
  });

  it("shows a resubmission after a CCB send-back back at the CCB at once, then says so once saved", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    signedIn = BUSINESS_OFFICE;
    await store.onboarding.decide(created.id, { type: "approve" });
    signedIn = CCB;
    await store.onboarding.decide(created.id, {
      type: "send-back",
      to: "submitted",
      note: "Which streams use it?",
    });
    const held = holdWrites(store, "resubmit");
    renderAs(store, PROVIDER, <MyOnboardingRequests />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.change(within(card).getByLabelText("Your answer"), {
      target: { value: "Collections and exam." },
    });
    fireEvent.click(continueToResubmit(openResubmitWizard(card)));

    expect(await within(card).findByText("Saving…")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: CCB");
    await act(() => held.release());
    expect(
      await within(card).findByText(`Resubmitted ${created.id}: it's back with the CCB.`),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: CCB");
  });

  it("rolls a refused withdrawal back with its reason, and retries the same intent with the same key", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    const held = holdWrites(store, "withdraw");
    renderAs(store, PROVIDER, <MyOnboardingRequests />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /withdraw request/i }));
    const confirm = within(card).getByRole("button", { name: /confirm withdrawal/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await within(card).findByText("Saving…")).toBeInTheDocument();
    expect(card).toHaveTextContent("Current stage: Withdrawn");
    expect(held.spy).toHaveBeenCalledTimes(1);

    await act(() => held.fail("The warehouse is unavailable."));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("That withdrawal was refused");
    expect(alert).toHaveTextContent("The warehouse is unavailable.");
    expect(card).toHaveTextContent("Current stage: Business & ROI review");
    expect(within(card).queryByText("Saving…")).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /withdraw request/i }));
    fireEvent.click(within(card).getByRole("button", { name: /confirm withdrawal/i }));
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2));
    expect(held.intentOf(1).key).toBe(held.intentOf(0).key);
    // Confirmed against the version on screen: the server's expected version (#196).
    expect(held.intentOf(1).version).toBe(created.version);
  });
});

describe("the intake Submit while a save is in flight", () => {
  const DOMAINS = [{ id: "individual-filing", name: "Individual Filing" }];
  const ctx = () => ({ go: vi.fn(), submitRequest: vi.fn(), flash: vi.fn() });

  it("confirms at once saying Saving…, submits once for a double click, then shows the stored id", async () => {
    const store = newStore();
    const held = holdWrites(store, "submit");
    renderAs(store, PROVIDER, <OnboardingIntakeScreen ctx={ctx()} domains={DOMAINS} />);
    toReview();

    const submit = screen.getByRole("button", { name: /submit data onboarding request/i });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(
      screen.getByRole("heading", { name: "Saving your onboarding request…" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Assigned when it's saved")).toBeInTheDocument();
    await waitFor(() => expect(held.spy).toHaveBeenCalled());
    expect(held.spy).toHaveBeenCalledTimes(1);

    await act(() => held.release());
    expect(
      await screen.findByRole("heading", { name: "Onboarding request submitted" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^ONB-[0-9A-HJKMNP-TV-Z]{6}$/)).toBeInTheDocument();
    expect(held.spy).toHaveBeenCalledTimes(1);
  });

  it("keeps Submit disabled, saying Submitting…, while an earlier submit saves", async () => {
    const store = newStore();
    const held = holdWrites(store, "submit");
    renderAs(store, PROVIDER, <OnboardingIntakeScreen ctx={ctx()} domains={DOMAINS} />);
    toReview();
    fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));
    fireEvent.click(screen.getByRole("button", { name: /onboard another initiative/i }));
    toReview();

    const submitting = screen.getByRole("button", { name: /submitting…/i });
    expect(submitting).toBeDisabled();
    expect(submitting).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /back/i })).toBeDisabled();
    fireEvent.click(submitting);
    await waitFor(() => expect(held.spy).toHaveBeenCalled());
    expect(held.spy).toHaveBeenCalledTimes(1);

    await act(() => held.release());
    expect(
      await screen.findByRole("button", { name: /submit data onboarding request/i }),
    ).toBeEnabled();
  });

  it("puts the typed intake back in the form after a refusal, and retries the same intent with the same key", async () => {
    const store = newStore();
    const held = holdWrites(store, "submit");
    renderAs(store, PROVIDER, <OnboardingIntakeScreen ctx={ctx()} domains={DOMAINS} />);
    toReview();
    fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));
    await act(() => held.fail("Dataset tag signals is already used by another dataset."));

    // Back on the review step with what they typed, and why it was refused.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That onboarding request was refused");
    expect(alert).toHaveTextContent("Dataset tag signals is already used by another dataset.");
    const retry = screen.getByRole("button", { name: /submit data onboarding request/i });
    expect(retry).toBeEnabled();
    expect(screen.getAllByText("Collections case signals").length).toBeGreaterThan(0);

    fireEvent.click(retry);
    await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2));
    expect(held.spy.mock.calls[1]![0]).toEqual(held.spy.mock.calls[0]![0]);
    expect(held.intentOf(1).key).toBe(held.intentOf(0).key);
  });

  it("says the provider's sign-in expired when the wizard's submit gets the sign-in page", async () => {
    const transport = httpTransport(
      (async () =>
        new Response("<!DOCTYPE html><html><body>Sign in to Databricks</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    );
    const store = newStore();
    store.onboarding.submit = (intake, intent) =>
      transport
        .command<{ result: OnboardingRequest }>("onboarding", "submit", {
          idempotencyKey: intent?.key ?? "",
          expectedVersion: 0,
          payload: { intake },
        })
        .then((answer) => answer.result);
    renderAs(store, PROVIDER, <OnboardingIntakeScreen ctx={ctx()} domains={DOMAINS} />);
    toReview();
    fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));

    const alert = await screen.findByText(/Your sign-in has expired/);
    const notice = alert.closest("[role=alert]") as HTMLElement;
    expect(notice).toHaveTextContent("nothing was saved");
    expect(notice).not.toHaveTextContent(/refused|Unexpected token|JSON|DOCTYPE/);
  });

  it("writes only the onboarding request through the DataStore, never a legacy request (#176)", async () => {
    const commands: Array<{ area: string; name: string; body: CommandBody<unknown> }> = [];
    const legacyWrites: string[] = [];
    const store = createDeltaStore({
      transport: {
        async read<T>(): Promise<T> {
          return [] as T;
        },
        async command<T>(area: string, name: string, body: CommandBody<unknown>): Promise<T> {
          commands.push({ area, name, body });
          return { result: { id: "ONB-1001", stage: "business-roi-review" } } as T;
        },
        async legacyWrite<T>(area: string, name: string): Promise<T> {
          legacyWrites.push(`${area}/${name}`);
          return { result: {} } as T;
        },
      },
    });
    renderAs(store, PROVIDER, <OnboardingIntakeScreen ctx={ctx()} domains={DOMAINS} />);
    toReview();

    fireEvent.click(screen.getByRole("button", { name: /submit data onboarding request/i }));

    expect(await screen.findByText("ONB-1001")).toBeInTheDocument();
    expect(commands.map((c) => `${c.area}/${c.name}`)).toEqual(["onboarding/submit"]);
    expect(legacyWrites).toEqual([]);
  });
});

describe("onboarding writes don't wait on their re-reads (#131 latency)", () => {
  it("shows a decision's outcome and drops the card while the inbox re-read is still running", async () => {
    const store = newStore();
    signedIn = PROVIDER;
    const created = await store.onboarding.submit(INTAKE);
    const realList = store.onboarding.listInbox.bind(store.onboarding);
    const realDecide = store.onboarding.decide.bind(store.onboarding);
    const reread = deferred<void>();
    let holdReads = false;
    const listInbox = vi.fn(async (role: Parameters<typeof realList>[0]) => {
      if (holdReads) await reread.promise;
      return realList(role);
    });
    const decide = vi.fn(realDecide);
    store.onboarding.listInbox = listInbox;
    store.onboarding.decide = decide;
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });

    holdReads = true; // every inbox read from here on waits
    fireEvent.click(within(card).getByRole("button", { name: /^approve$/i }));
    fireEvent.click(await within(card).findByRole("button", { name: /confirm approval/i }));

    // The command's own result is enough: the outcome shows and the request has
    // left this inbox, though the background re-read hasn't answered.
    expect(await screen.findByText(`Approved ${created.title}.`)).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: new RegExp(created.id) })).toBeNull();
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
    // Confirmed against the version on screen, so the server checks it with no read first.
    expect(decide.mock.calls[0]!.at(-1)).toMatchObject({ version: created.version });

    await act(async () => reread.resolve());
    expect(screen.queryByRole("article", { name: new RegExp(created.id) })).toBeNull();
  });

  it("puts a submitted request first in a cached My requests list, before the re-read", async () => {
    const store = newStore();
    signedIn = PROVIDER;
    const earlier = await store.onboarding.submit({ ...INTAKE, initiativeName: "Earlier" });
    const realMine = store.onboarding.listMine.bind(store.onboarding);
    const reread = deferred<void>();
    let holdReads = false;
    store.onboarding.listMine = vi.fn(async () => {
      if (holdReads) await reread.promise;
      return realMine();
    });
    const Wrapper = wrapper(store);
    const { result } = renderHook(
      () => ({ submit: useSave(submitOnboardingSave), mine: useMyOnboardingRequests() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.mine.data?.map((r) => r.id)).toEqual([earlier.id]));

    holdReads = true;
    act(() => {
      result.current.submit(
        { intake: INTAKE, values: {}, intentKey: "k1" },
        { idempotencyKey: "k1" },
      );
    });

    // The re-read is still held, so this is the command's own result in the cache.
    await waitFor(() => {
      const ids = result.current.mine.data?.map((r) => r.id) ?? [];
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^ONB-/);
      expect(ids[1]).toBe(earlier.id);
    });
    expect(result.current.mine.data?.some(isSavingOnboardingRequest)).toBe(false);
    await act(async () => reread.resolve());
  });
});

describe("useWriteIntent", () => {
  it("keeps the key for the same input and version, and makes a new one when either changes", () => {
    let n = 0;
    const { result } = renderHook(() => useWriteIntent(() => `key-${++n}`));
    const first = result.current.intentFor({ id: "ONB-1", decision: "approve" }, 2);
    expect(first).toEqual({ key: "key-1", version: 2 });
    expect(result.current.intentFor({ id: "ONB-1", decision: "approve" }, 2)).toBe(first);
    // The record moved on and the person confirmed again: a new intent.
    expect(result.current.intentFor({ id: "ONB-1", decision: "approve" }, 3)).toEqual({
      key: "key-2",
      version: 3,
    });
    expect(result.current.intentFor({ id: "ONB-1", decision: "reject" }, 3).key).toBe("key-3");
  });
});

describe("a re-read never overwrites a command's result with older data (#196 review)", () => {
  /** Answer `method` from the real store until `stale()`, then hold and answer with `snapshot`. */
  function staleAfter<T>(real: () => Promise<T>) {
    let snapshot: T | undefined;
    let stale = false;
    const gate = deferred<void>();
    const fn = vi.fn(async () => {
      if (!stale) return real();
      await gate.promise;
      return snapshot as T;
    });
    return {
      fn,
      /** Take the snapshot now (before the write), and serve it to every later read. */
      async freeze() {
        snapshot = await real();
        stale = true;
      },
      release: () => gate.resolve(),
    };
  }

  it("keeps a decided request out of the inbox when the re-read answers with the older version", async () => {
    const store = newStore();
    signedIn = PROVIDER;
    const created = await store.onboarding.submit(INTAKE);
    const listInbox = store.onboarding.listInbox.bind(store.onboarding);
    const inbox = staleAfter(() => listInbox("business-office"));
    store.onboarding.listInbox = inbox.fn;
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);
    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    signedIn = BUSINESS_OFFICE;
    await inbox.freeze(); // the snapshot still has it at business & ROI review, version 2

    fireEvent.click(within(card).getByRole("button", { name: /^approve$/i }));
    fireEvent.click(await within(card).findByRole("button", { name: /confirm approval/i }));
    expect(await screen.findByText(`Approved ${created.title}.`)).toBeInTheDocument();
    await waitFor(() => expect(inbox.fn).toHaveBeenCalledTimes(2)); // the first load, then the re-read

    await act(async () => inbox.release()); // the stale answer lands after the result
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("article", { name: new RegExp(created.id) })).toBeNull();
  });

  it("keeps the newer request in My requests and its detail when the re-reads are older", async () => {
    const store = newStore();
    signedIn = PROVIDER;
    const created = await store.onboarding.submit(INTAKE);
    const listMine = store.onboarding.listMine.bind(store.onboarding);
    const get = store.onboarding.get.bind(store.onboarding);
    const mine = staleAfter(() => listMine());
    const detail = staleAfter(() => get(created.id));
    store.onboarding.listMine = mine.fn;
    store.onboarding.get = detail.fn as typeof store.onboarding.get;
    const { result } = renderHook(
      () => ({
        mine: useMyOnboardingRequests(),
        detail: useOnboardingRequest(created.id),
        withdraw: useSave(withdrawOnboardingSave),
      }),
      { wrapper: wrapper(store) },
    );
    await waitFor(() => expect(result.current.detail.data?.version).toBe(created.version));
    await waitFor(() => expect(result.current.mine.data).toHaveLength(1));
    await mine.freeze();
    await detail.freeze();

    act(() => {
      result.current.withdraw(
        { id: created.id, version: created.version },
        { idempotencyKey: "w1" },
      );
    });
    await waitFor(async () => expect((await get(created.id))?.stage).toBe("withdrawn"));
    const withdrawn = (await get(created.id))!;
    expect(withdrawn.version).toBeGreaterThan(created.version);
    await act(async () => {
      mine.release();
      detail.release();
      await new Promise((r) => setTimeout(r, 20));
    });

    // Both re-reads answered with the pre-withdrawal version; the result stays.
    await waitFor(() => expect(mine.fn.mock.calls.length).toBeGreaterThan(1));
    expect(result.current.mine.data?.[0]).toMatchObject({
      stage: "withdrawn",
      version: withdrawn.version,
    });
    expect(result.current.detail.data).toMatchObject({
      stage: "withdrawn",
      version: withdrawn.version,
    });
  });
});

// #189: the Databricks Apps proxy can answer an onboarding save with its own
// HTML page (an expired sign-in, a gateway error) that never reached the app.
// These saves go through the real browser API client; answers the test doesn't
// script reach the store, as the server would.
describe("onboarding saves when the proxy answers instead of the app", () => {
  const SIGN_IN_PAGE = "<!DOCTYPE html><html><body>Sign in to Databricks</body></html>";
  const html = (status: number) => () =>
    new Response(SIGN_IN_PAGE, { status, headers: { "content-type": "text/html" } });

  /** Send `method` through the HTTP client; the scripted answers come first. */
  function overHttp<K extends "decide" | "withdraw">(
    store: DataStore,
    method: K,
    answers: Array<() => Response>,
  ) {
    const real = store.onboarding[method].bind(store.onboarding) as (
      ...args: unknown[]
    ) => Promise<OnboardingRequest>;
    const keys: string[] = [];
    const transport = httpTransport((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as CommandBody<unknown[]>;
      keys.push(body.idempotencyKey);
      const scripted = answers.shift();
      if (scripted) return scripted();
      return new Response(JSON.stringify({ result: await real(...body.payload) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
    (store.onboarding[method] as unknown) = async (...args: unknown[]) => {
      const intent = args.find(
        (arg): arg is OnboardingWriteIntent =>
          typeof arg === "object" && arg !== null && "key" in arg,
      );
      return (
        await transport.command<{ result: OnboardingRequest }>("onboarding", method, {
          idempotencyKey: intent?.key ?? "",
          expectedVersion: 1,
          payload: args,
        })
      ).result;
    };
    return keys;
  }

  function expectNoRefusalOrRawText(alert: HTMLElement) {
    expect(alert).not.toHaveTextContent(/refused|wasn.t saved/i);
    expect(alert).not.toHaveTextContent(/Unexpected token|JSON|DOCTYPE|<html/);
  }

  it("says a reviewer's sign-in expired and nothing was saved, never a parse error", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    overHttp(store, "decide", [html(200)]);
    renderAs(store, BUSINESS_OFFICE, <OnboardingInbox role="business-office" />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /^approve$/i }));
    fireEvent.click(within(card).getByRole("button", { name: /confirm approval/i }));

    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Your sign-in has expired. Reload the page to sign in again — nothing was saved.",
    );
    expect(within(alert).getByRole("button", { name: "Reload the page" })).toBeInTheDocument();
    expectNoRefusalOrRawText(alert);
    expect(alert).not.toHaveFocus();
    signedIn = BUSINESS_OFFICE;
    expect((await store.onboarding.get(created.id))?.stage).toBe(created.stage);
  });

  it("says a withdrawal behind a gateway page is unconfirmed, and the retry resends the same key", async () => {
    const store = newStore();
    const created = await submitAsProvider(store);
    const keys = overHttp(store, "withdraw", [html(502)]);
    renderAs(store, PROVIDER, <MyOnboardingRequests />);

    const card = await screen.findByRole("article", { name: new RegExp(created.id) });
    fireEvent.click(within(card).getByRole("button", { name: /withdraw request/i }));
    fireEvent.click(within(card).getByRole("button", { name: /confirm withdrawal/i }));

    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't confirm this save");
    expect(alert).toHaveTextContent(
      "Check the list before trying again. Try again sends the same request, so it can't be saved twice.",
    );
    expectNoRefusalOrRawText(alert);
    // Unconfirmed: it may have committed, so it stays shown as withdrawn, not confirmed.
    expect(within(card).getByText("Not confirmed")).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    signedIn = PROVIDER;
    await waitFor(async () =>
      expect((await store.onboarding.get(created.id))?.stage).toBe("withdrawn"),
    );
  });
});
