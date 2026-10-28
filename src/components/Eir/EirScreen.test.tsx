import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ACTIVE_PRIVACY_NOTICE, createMemoryStore, StoreProvider } from "@/data";
import { httpTransport } from "@/data/adapters/delta";
import { EIR_READ_RETRY_ATTEMPTS, EIR_READ_RETRY_DELAY_MS } from "@/data/queries";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { uploadEirPdf } from "@/data/eir/delta-repository";
import {
  createMemoryEirRepository,
  FORM_CHANGED_REFUSAL,
  type MemoryEirRepository,
} from "@/data/eir/repository";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import { createMemoryPrivacyAcknowledgmentRepository } from "@/data/privacy/repository";
import { EIR_VALUES } from "@/data/__tests__/eir-fixtures";
import { EirScreen, type EirScreenProps } from "./EirScreen";
import { EirValidatorSection } from "./EirValidatorSection";

const values = EIR_VALUES;
const PRIVACY_ACKNOWLEDGED_AT = "2026-10-01T12:00:00.000Z";

function createAcknowledgedMemoryStore(
  ...[seed, options = {}]: Parameters<typeof createMemoryStore>
) {
  const identity = {
    principalId: "acknowledged-test-person",
    displayName: "Acknowledged Test Person",
    actorApp: "tenant" as const,
  };
  return createMemoryStore(seed, {
    ...options,
    privacyAcknowledgmentRepository: createMemoryPrivacyAcknowledgmentRepository({
      identity,
      state: {
        acknowledgments: [
          {
            noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
            contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
            principalId: identity.principalId,
            actorDisplay: identity.displayName,
            actorApp: identity.actorApp,
            acknowledgedAt: PRIVACY_ACKNOWLEDGED_AT,
          },
        ],
      },
    }),
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const memoryEir = (store: ReturnType<typeof createAcknowledgedMemoryStore>) =>
  store.eir as MemoryEirRepository;
const flushPromises = () => Promise.resolve();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const TonePill = ({
  children,
  bg,
  fg,
  bd,
}: {
  children?: ReactNode;
  bg?: string;
  fg?: string;
  bd?: string;
}) => (
  <span data-bg={bg} data-fg={fg} data-bd={bd}>
    {children}
  </span>
);

// A validator's two pages: My EIR (their own EIR only) and the EIR validation
// section of the EDP Admin page (#159), side by side.
const ValidatorPages = (props: EirScreenProps) => (
  <>
    <EirScreen {...props} />
    <EirValidatorSection {...(props.chrome ? { chrome: props.chrome } : {})} />
  </>
);

describe("My EIR for a safeguards validator (#159)", () => {
  it("shows only their own EIR: no validator section, inbox, valid list, actions or test-mode notice", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
      eirSelfDecisionTestMode: true,
    });
    await memoryEir(store).submit(
      "validator-1",
      "Safeguards Validator",
      "/Volumes/eir/own.pdf",
      values,
    );
    await memoryEir(store).submit("person-2", "Other Person", "/Volumes/eir/two.pdf", values);
    await memoryEir(store).submit("person-3", "Valid Person", "/Volumes/eir/three.pdf", values);
    await store.eir.decide("person-3", "valid", "validator-2");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Current stage")).toBeInTheDocument();
    expect(screen.getByText(/With a safeguards validator\. SLA target/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Safeguards validator inbox" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "EIR inbox" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Valid EIRs" })).toBeNull();
    expect(screen.queryByText("Other Person")).toBeNull();
    expect(screen.queryByText("Valid Person")).toBeNull();
    expect(screen.queryByText(/awaiting action/)).toBeNull();
    expect(screen.queryByText(/Test mode:/)).toBeNull();
    for (const name of ["Mark valid", /Send back/, "Reject", "Revoke", /Approve/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

describe("EirScreen query-hook wiring", () => {
  it("bounds a failing My EIR read, explains server failures plainly, and Retry recovers with focus", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      isSafeguardsValidator: false,
    });
    let shouldFail = true;
    const readMine = vi.spyOn(store.eir, "get").mockImplementation(async () => {
      if (shouldFail) {
        throw Object.assign(new Error("TABLE_OR_VIEW_NOT_FOUND secret_catalog.eir__eirs"), {
          status: 500,
        });
      }
      return createMemoryEirRepository().get("person-1");
    });
    const client = new QueryClient();

    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading privacy notice…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(screen.getByText("Still loading your EIR…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't load your EIR right now.");
    expect(alert).toHaveTextContent("This is a problem on our side, not your connection.");
    expect(alert).not.toHaveTextContent("TABLE_OR_VIEW_NOT_FOUND");
    expect(readMine).toHaveBeenCalledTimes(EIR_READ_RETRY_ATTEMPTS + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(readMine).toHaveBeenCalledTimes(EIR_READ_RETRY_ATTEMPTS + 1);

    shouldFail = false;
    vi.useRealTimers();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await flushPromises();
    expect(
      await screen.findByRole("heading", { name: "Employee Identity Record (EIR)" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Current stage")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Retry loaded your EIR."));
    vi.useRealTimers();
  });

  it("shows network-failure copy for status-less EIR read failures", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      isSafeguardsValidator: false,
    });
    vi.spyOn(store.eir, "get").mockRejectedValue(new TypeError("Failed to fetch"));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("We couldn't load your EIR.");
    expect(alert).toHaveTextContent("Check your connection and try again.");
    expect(alert).not.toHaveTextContent("Failed to fetch");
  });

  it("does not retry 4xx EIR refusals and uses neutral access copy", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      isSafeguardsValidator: false,
    });
    const readMine = vi
      .spyOn(store.eir, "get")
      .mockRejectedValue(Object.assign(new Error("Forbidden raw body"), { status: 403 }));

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("You don't have access to this EIR data.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Forbidden raw body");
    expect(readMine).toHaveBeenCalledTimes(1);
  });

  it("shows in-flight Retry progress, then re-announces a failed My EIR retry", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      isSafeguardsValidator: false,
    });
    let holdRetry = false;
    let failHeldRetry: (() => void) | undefined;
    vi.spyOn(store.eir, "get").mockImplementation(async () => {
      if (holdRetry) {
        return new Promise((_, reject) => {
          failHeldRetry = () =>
            reject(Object.assign(new Error("TABLE_OR_VIEW_NOT_FOUND retry"), { status: 500 }));
        });
      }
      throw Object.assign(new Error("TABLE_OR_VIEW_NOT_FOUND initial"), { status: 500 });
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
    });
    holdRetry = true;
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Trying again…");
    fireEvent.click(retry);
    expect(document.activeElement).toBe(retry);

    await act(async () => {
      holdRetry = false;
      failHeldRetry?.();
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
      await flushPromises();
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Still couldn't load your EIR.");
    expect(document.activeElement).toBe(alert);
  });

  it("bounds a failing validator inbox read and retries without a request storm", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    let shouldFail = true;
    const readInbox = vi.spyOn(store.eir, "listValidatorInbox").mockImplementation(async () => {
      if (shouldFail) throw Object.assign(new Error("HTTP 500"), { status: 500 });
      return [];
    });
    const client = new QueryClient();

    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <EirValidatorSection />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
    });
    const inbox = screen.getByRole("region", { name: "Safeguards validator inbox" });
    expect(within(inbox).getByRole("alert")).toHaveTextContent(
      "We couldn't load the EIR inbox right now.",
    );
    expect(readInbox).toHaveBeenCalledTimes(EIR_READ_RETRY_ATTEMPTS + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(readInbox).toHaveBeenCalledTimes(EIR_READ_RETRY_ATTEMPTS + 1);

    shouldFail = false;
    vi.useRealTimers();
    fireEvent.click(within(inbox).getByRole("button", { name: "Retry" }));
    await flushPromises();
    expect(await within(inbox).findByText("No EIRs are awaiting action.")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows inbox loading status, not an empty inbox, while the first inbox read is pending", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    vi.spyOn(store.eir, "listValidatorInbox").mockImplementation(
      () => new Promise(() => undefined),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirValidatorSection />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    expect(within(inbox).getByRole("status")).toHaveTextContent("Loading the EIR inbox…");
    expect(within(inbox).queryByText("No EIRs are awaiting action.")).toBeNull();
    expect(within(inbox).queryByText("0 awaiting action")).toBeNull();
  });

  it("keeps the first failing inbox read out of the empty state while it auto-retries", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    vi.spyOn(store.eir, "listValidatorInbox").mockRejectedValue(
      Object.assign(new Error("HTTP 500"), { status: 500 }),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirValidatorSection />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();
    });
    const inbox = screen.getByRole("region", { name: "Safeguards validator inbox" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS + 1);
    });
    expect(within(inbox).getByRole("status")).toHaveTextContent("Loading the EIR inbox…");
    expect(within(inbox).queryByText("No EIRs are awaiting action.")).toBeNull();
    expect(within(inbox).queryByText("0 awaiting action")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 2 + 100);
    });
    expect(within(inbox).getByRole("alert")).toHaveTextContent(
      "We couldn't load the EIR inbox right now.",
    );
    vi.useRealTimers();
  });

  it("keeps the validator inbox error visible during Retry and refocuses it after another failure", async () => {
    vi.useFakeTimers();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    let holdRetry = false;
    let failHeldRetry: (() => void) | undefined;
    const readInbox = vi.spyOn(store.eir, "listValidatorInbox").mockImplementation(async () => {
      if (holdRetry) {
        return new Promise((_, reject) => {
          failHeldRetry = () => reject(Object.assign(new Error("HTTP 500 retry"), { status: 500 }));
        });
      }
      throw Object.assign(new Error("HTTP 500 initial"), { status: 500 });
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirValidatorSection />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
    });
    const inbox = screen.getByRole("region", { name: "Safeguards validator inbox" });
    expect(within(inbox).getByRole("alert")).toHaveTextContent(
      "We couldn't load the EIR inbox right now.",
    );

    holdRetry = true;
    const retry = within(inbox).getByRole("button", { name: "Retry" });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    const callsBeforeRetry = readInbox.mock.calls.length;
    fireEvent.click(retry);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(within(inbox).getByRole("button", { name: "Retry" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(inbox).getByRole("status")).toHaveTextContent("Trying again…");
    expect(within(inbox).getByRole("alert")).toHaveTextContent(
      "We couldn't load the EIR inbox right now.",
    );
    expect(within(inbox).queryByText("No EIRs are awaiting action.")).toBeNull();
    expect(within(inbox).queryByText("0 awaiting action")).toBeNull();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(readInbox).toHaveBeenCalledTimes(callsBeforeRetry + 1);

    await act(async () => {
      holdRetry = false;
      failHeldRetry?.();
      await vi.advanceTimersByTimeAsync(EIR_READ_RETRY_DELAY_MS * 3 + 100);
      await flushPromises();
    });
    const alert = within(inbox).getByRole("alert");
    expect(alert).toHaveTextContent("Still couldn't load the EIR inbox.");
    expect(document.activeElement).toBe(alert);
  });

  it("does not move focus from the My EIR form when the validator inbox read fails", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
    });
    vi.spyOn(store.eir, "listValidatorInbox").mockRejectedValue(
      Object.assign(new Error("HTTP 500"), { status: 500 }),
    );

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const userId = await screen.findByLabelText(/User ID/);
    userId.focus();
    expect(document.activeElement).toBe(userId);

    const inbox = screen.getByRole("region", { name: "Safeguards validator inbox" });
    await waitFor(
      () =>
        expect(within(inbox).getByRole("alert")).toHaveTextContent(
          "We couldn't load the EIR inbox right now.",
        ),
      { timeout: EIR_READ_RETRY_DELAY_MS * 4 },
    );
    expect(document.activeElement).toBe(userId);
  });

  it("renders the person's status, the current form (2.0), and the validator inbox with every answer through the store seam", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot(), {
      clock: () => new Date("2026-10-01T12:00:00Z"),
    });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit(
      "person-1",
      "Test Person",
      "/Volumes/edp/docs/eir/person-1/one.pdf",
      values,
    );
    await store.eir.decide("person-1", "questions", "validator-1", "Clarify the need");
    await memoryEir(store).submit(
      "person-1",
      "Test Person",
      "/Volumes/edp/docs/eir/person-1/two.pdf",
      values,
      "Quarterly review",
    );
    await store.eir.decide("person-1", "valid", "validator-1");
    await memoryEir(store).renew(
      "person-1",
      "person-1",
      "/Volumes/edp/docs/eir/person-1/three.pdf",
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <ValidatorPages chrome={{ Pill: TonePill }} />
        </StoreProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Employee Identity Record (EIR)" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        name: "Enterprise Data Platform - Employee Identity Record (EIR)",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/STUB:/)).toBeNull();
    // The validator sees the renewal's answers, by section, with nothing to flag.
    const answers = await screen.findByText(
      /^Renewal answers · EIR-[0-9A-HJKMNP-TV-Z]{6} · bootstrap-2 \(version 0\)$/,
    );
    expect(answers.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("No flags in these answers.")).toBeInTheDocument();
    expect(within(answers.closest("details")!).getByText("A1B2C")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "EIR inbox" })).toBeInTheDocument();
    expect(screen.getByText("1 awaiting action")).toBeInTheDocument();
    expect(await screen.findByText("Test Person")).toBeInTheDocument();
    expect(await screen.findByText("Renewal pending")).toBeInTheDocument();
    expect(screen.getByText(/Valid until/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve renewal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    const documents = screen.getAllByRole("link", { name: /Open signed PDF submission/ });
    expect(documents).toHaveLength(3);
    expect(documents[0]).toHaveAttribute("href", expect.stringContaining("one.pdf"));
    expect(documents[1]).toHaveAttribute("href", expect.stringContaining("two.pdf"));
    expect(documents[2]).toHaveAttribute("href", expect.stringContaining("three.pdf"));
    expect(documents[0]).toHaveStyle({ color: "var(--link-default)", fontWeight: "700" });
    expect(screen.getByText("Valid").closest("[data-bg]")).toHaveAttribute(
      "data-bg",
      "var(--theme-success-lighter)",
    );

    store.eir.decide = async () => {
      throw new Error("A renewal cannot be reviewed for this EIR stage.");
    };
    fireEvent.click(screen.getByRole("button", { name: "Approve renewal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not save the decision");

    fireEvent.click(screen.getByRole("button", { name: "Send back with questions" }));
    const note = screen.getByRole("textbox", { name: /Questions for the person/ });
    expect(note).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send questions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send questions" }));
    expect(note).toHaveAttribute("aria-invalid", "true");
    const fieldError = await screen.findByRole("alert");
    expect(fieldError).toHaveTextContent("Enter questions for the person.");
    expect(note).toHaveAttribute("aria-describedby", fieldError.id);
    expect(note).toHaveAccessibleDescription("Enter questions for the person.");
    fireEvent.change(note, { target: { value: "Clarify the business need" } });
    expect(note).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a decision whose reply was a proxy page is unconfirmed, not 'could not save' (#189)", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot(), {
      clock: () => new Date("2026-10-01T12:00:00Z"),
    });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit(
      "person-1",
      "Test Person",
      "/Volumes/edp/docs/eir/person-1/one.pdf",
      values,
    );
    const gateway = httpTransport(
      vi.fn(
        async () =>
          new Response("<!DOCTYPE html><html>502 Bad Gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
      ) as unknown as typeof fetch,
    );
    store.eir.decide = () =>
      gateway.command("eir", "decide", {
        idempotencyKey: "k1",
        expectedVersion: 1,
        payload: {},
      });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <ValidatorPages chrome={{ Pill: TonePill }} />
        </StoreProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mark valid" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "We couldn't confirm this save. Try again; it won't be saved twice.",
    );
    expect(alert).not.toHaveTextContent(/could not save|refused|Unexpected token|DOCTYPE/);
  });

  it("leaves a validator's own EIR out of their inbox; the stage card shows it", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit(
      "validator-1",
      "Safeguards Validator",
      "/Volumes/edp/docs/eir/validator-1/own.pdf",
      values,
    );
    // The inbox read still returns it; the screen is what leaves it out.
    expect(await store.eir.listValidatorInbox()).toEqual([
      expect.objectContaining({ principalId: "validator-1", stage: "submitted" }),
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    expect(await within(inbox).findByText("0 awaiting action")).toBeInTheDocument();
    // Nothing is listed, so the empty state says what the count says.
    expect(within(inbox).getByText("No EIRs are awaiting action.")).toBeInTheDocument();
    expect(within(inbox).queryByRole("article")).not.toBeInTheDocument();
    expect(within(inbox).queryByText("Safeguards Validator")).not.toBeInTheDocument();
    expect(within(inbox).queryByText(/another validator must decide/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/another safeguards validator must review/i)).toBeNull();
    // Test mode is off: no trace of it.
    expect(screen.queryByText(/Test mode/)).toBeNull();
    for (const name of ["Mark valid", /Send back/, "Reject", "Revoke"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    // The person's own stage card carries it instead (once its form has loaded, #201).
    expect(await screen.findByText("Current stage")).toBeInTheDocument();
    expect(screen.getByText(/With a safeguards validator\. SLA target/)).toBeInTheDocument();
  });

  const ownEirScreen = async (eirRepository?: MemoryEirRepository) => {
    const store = createAcknowledgedMemoryStore(
      makeSnapshot(),
      eirRepository ? { eirRepository } : {},
    );
    // The profile says test mode is on: it decides what the screen shows, never what the store allows.
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
      eirSelfDecisionTestMode: true,
    });
    await memoryEir(store).submit(
      "validator-1",
      "Safeguards Validator",
      "/Volumes/edp/docs/eir/validator-1/own.pdf",
      values,
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    return { store, inbox, own: await within(inbox).findByRole("article") };
  };

  it("in test mode, lists the validator's own EIR with every decision, and says so in the inbox", async () => {
    const { inbox, own } = await ownEirScreen();
    expect(within(own).getByText("Safeguards Validator")).toBeInTheDocument();
    for (const name of ["Mark valid", "Send back with questions", "Reject"]) {
      expect(within(own).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(inbox).getByText("1 awaiting action")).toBeInTheDocument();
    const notices = screen
      .getAllByRole("status")
      .filter((notice) => /^Test mode:/.test(notice.textContent ?? ""));
    // Only the inbox says so now: My EIR carries no validator content (#159).
    expect(notices).toHaveLength(1);
    expect(inbox.contains(notices[0]!)).toBe(true);
  });

  it("still refuses the self-decision in the store when only the profile says test mode is on", async () => {
    const { store, own } = await ownEirScreen();
    fireEvent.click(within(own).getByRole("button", { name: "Mark valid" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Safeguards validators can't decide their own EIR.",
    );
    expect((await store.eir.get("validator-1")).stage).toBe("submitted");
  });

  it("decides it only when the store itself was built with test mode, and marks it", async () => {
    const { store, own } = await ownEirScreen(
      createMemoryEirRepository({ selfDecisionTestMode: true }),
    );
    fireEvent.click(within(own).getByRole("button", { name: "Mark valid" }));
    expect(await screen.findByText("Decision saved: EIR approved.")).toBeInTheDocument();
    const decided = await store.eir.get("validator-1");
    expect(decided.stage).toBe("valid");
    expect(decided.actions.at(-1)).toMatchObject({
      kind: "valid",
      actorScimId: "validator-1",
      selfDecisionTestMode: true,
    });
    expect(decided.actions.at(-1)?.note).toBeUndefined();
  });

  it("ignores the test-mode flag for someone who isn't a validator", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      isSafeguardsValidator: false,
      eirSelfDecisionTestMode: true,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Current stage")).toBeInTheDocument();
    expect(screen.queryByText(/Test mode/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Safeguards validator inbox" })).toBeNull();
  });

  it("lists another person's EIR, without an empty card, beside a validator's own", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot(), {
      clock: () => new Date("2026-10-01T12:00:00Z"),
    });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit(
      "validator-1",
      "Safeguards Validator",
      "/Volumes/edp/docs/eir/validator-1/own.pdf",
      values,
    );
    await memoryEir(store).submit(
      "person-2",
      "Sample Applicant",
      "/Volumes/edp/docs/eir/person-2/one.pdf",
      { ...values, userId: "Z9Y8X", firstName: "Sample", lastName: "Applicant" },
    );

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <ValidatorPages chrome={{ Pill: TonePill }} />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    const rows = await within(inbox).findAllByRole("article");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Sample Applicant")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("button", { name: "Mark valid" })).toBeInTheDocument();
    expect(within(inbox).getByText("1 awaiting action")).toBeInTheDocument();
    expect(within(inbox).queryByText(/No EIRs/)).not.toBeInTheDocument();
    expect(within(inbox).queryByText("Safeguards Validator")).not.toBeInTheDocument();
    expect(within(inbox).queryByText("A1B2C")).not.toBeInTheDocument();

    // The person's own EIR, after submitting: its answers once, read-only;
    // its stage once; its signed PDF and SLA target only in the stage card.
    expect(screen.getByRole("heading", { name: "Submitted EIR form" })).toBeInTheDocument();
    expect(screen.getAllByText("A1B2C")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: /^User ID/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /I agree/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Step \d$/i)).not.toBeInTheDocument();
    const outsideInbox = (elements: HTMLElement[]) =>
      elements.filter((element) => !inbox.contains(element));
    expect(outsideInbox(Array.from(document.querySelectorAll("[data-bg]")))).toHaveLength(1);
    expect(outsideInbox(screen.getAllByText("Submitted"))).toHaveLength(1);
    const ownPdf = screen
      .getAllByRole("link", { name: /Open signed PDF/ })
      .filter((anchor) => anchor.getAttribute("href")?.includes("own.pdf"));
    expect(ownPdf).toHaveLength(1);
    expect(inbox.contains(ownPdf[0]!)).toBe(false);
    expect(outsideInbox(screen.getAllByText(/SLA target/))).toHaveLength(1);
  });

  it("doesn't show the empty card when only valid EIRs are listed", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "valid", "validator-2");

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const inbox = await screen.findByRole("region", { name: "Safeguards validator inbox" });
    expect(await within(inbox).findByRole("heading", { name: "Valid EIRs" })).toBeInTheDocument();
    expect(within(inbox).getByText("0 awaiting action")).toBeInTheDocument();
    expect(within(inbox).queryByText(/No EIRs/)).not.toBeInTheDocument();
  });

  it("shows current validity and a pending renewal to the person", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot(), {
      clock: () => new Date("2026-10-01T12:00:00Z"),
    });
    const user = {
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    };
    store.catalog.getUser = async () => user;
    await memoryEir(store).submit(
      "person-1",
      "Test Person",
      "/Volumes/edp/docs/eir/person-1/one.pdf",
      values,
    );
    await store.eir.decide("person-1", "valid", "validator-1");
    await store.eir.saveDraft("person-1", { ...values, team: "Senior Team" });
    await memoryEir(store).renew("person-1", "person-1", "/Volumes/edp/docs/eir/person-1/two.pdf");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <EirScreen chrome={{ Pill: TonePill }} />
        </StoreProvider>
      </QueryClientProvider>,
    );

    // The stage shows once: the stage card's pill.
    expect(await screen.findAllByText("Valid")).toHaveLength(1);
    expect(document.querySelectorAll("[data-bg]")).toHaveLength(1);
    expect(await screen.findByText("Renewal pending")).toBeInTheDocument();
    expect(screen.getByText(/Current EIR remains valid until/)).toBeInTheDocument();
    // The renewal's answers, once, as a read-only summary: no greyed form.
    const summary = screen.getByRole("heading", { name: "Submitted EIR form" });
    expect(summary).toBeInTheDocument();
    expect(screen.getAllByText("Senior Team")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /I agree/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "EIR form" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Step \d$/i)).not.toBeInTheDocument();
    // Its Record ID, a display code.
    expect(screen.getByText(/^EIR-[0-9A-HJKMNP-TV-Z]{6}$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download PDF to sign" })).not.toBeInTheDocument();
  });

  it("does not offer revoke for an expired EIR with a pending renewal", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const store = createAcknowledgedMemoryStore(makeSnapshot(), { clock: () => now });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit(
      "person-1",
      "Test Person",
      "/Volumes/edp/docs/eir/person-1/one.pdf",
      values,
    );
    await store.eir.decide("person-1", "valid", "validator-1");
    await memoryEir(store).renew("person-1", "person-1", "/Volumes/edp/docs/eir/person-1/two.pdf");
    now = new Date("2028-10-04T12:00:00Z");
    expect(await store.eir.listValidatorInbox()).toEqual([
      expect.objectContaining({ principalId: "person-1", stage: "expired" }),
    ]);

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const row = (await screen.findByText("Test Person")).closest("article");
    expect(row).not.toBeNull();
    expect(within(row!).getByRole("button", { name: "Approve renewal" })).toBeInTheDocument();
    expect(within(row!).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("reviews a selected PDF without submitting until the explicit action", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await store.eir.saveDraft("person-1", values);
    const submitted = {
      principalId: "person-1",
      personName: "Test Person",
      stage: "submitted" as const,
      formValues: values,
      submissions: [
        {
          volumePath: "/Volumes/edp/docs/eir/person-1/new.pdf",
          submittedAt: "2026-10-01T12:00:00.000Z",
        },
      ],
      actions: [],
    };
    const submission = vi.spyOn(store.eir, "submitWithFile").mockResolvedValue(submitted);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const fullName = await screen.findByRole("textbox", { name: /^First name/ });
    fireEvent.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    expect(await screen.findByText(/PDF generated/)).toBeInTheDocument();
    // Generating the PDF starts the record (its Record ID goes in the PDF) and
    // saves an unsigned draft, never the EIR's signed values (#104).
    const started = await store.eir.get("person-1");
    expect(started).toMatchObject({ stage: "not-started", draftValues: values });
    expect(started.recordId).toMatch(/^EIR-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(screen.getByText(started.recordId!)).toBeInTheDocument();
    expect((await store.eir.get("person-1")).formValues).toBeUndefined();
    fireEvent.change(fullName, { target: { value: "Test Updated" } });
    const file = new File(["%PDF-review"], "signed-eir.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), { target: { files: [file] } });

    expect(await screen.findByRole("heading", { name: "Review and submit" })).toBeInTheDocument();
    // The answers show once, in the review; the form is locked away and its
    // buttons with it, so only the review's actions are offered.
    expect(screen.getAllByText("Test Updated")).toHaveLength(1);
    expect(fullName).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "EIR form" })).not.toBeInTheDocument();
    for (const name of ["Download PDF to sign", "Save draft", "Discard unsaved changes"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole("heading", { name: "User details" })).toHaveLength(1);
    expect(screen.getByText("signed-eir.pdf")).toBeInTheDocument();
    expect(
      screen.getByText(/The form has changed since you downloaded the PDF/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open selected PDF" })).toHaveAttribute(
      "href",
      "blob:review",
    );
    expect(submission).not.toHaveBeenCalled();
    expect((await store.eir.get("person-1")).stage).toBe("not-started");

    // Edit form leaves review and opens the form, with the answers kept.
    fireEvent.click(screen.getByRole("button", { name: "Edit form" }));
    expect(screen.queryByRole("heading", { name: "Review and submit" })).not.toBeInTheDocument();
    const reopened = screen.getByRole("textbox", { name: /^First name/ });
    expect(reopened).toHaveValue("Test Updated");
    await waitFor(() => expect(screen.getByRole("textbox", { name: /^User ID/ })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Submit for validation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF to sign" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), { target: { files: [file] } });
    expect(await screen.findByRole("heading", { name: "Review and submit" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace file" }));
    const replacement = new File(["%PDF-replacement"], "replacement.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByLabelText("Replacement signed EIR PDF"), {
      target: { files: [replacement] },
    });
    expect(await screen.findByText("replacement.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Review and submit" })).not.toBeInTheDocument();
    expect(submission).not.toHaveBeenCalled();
    expect((await store.eir.get("person-1")).stage).toBe("not-started");
    fireEvent.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    await waitFor(async () =>
      expect((await store.eir.get("person-1")).draftValues?.["firstName"]).toBe("Test Updated"),
    );
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
      target: { files: [replacement] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit for validation" }));

    await waitFor(() => expect(submission).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Submitted for validation. With a safeguards validator/),
    ).toBeInTheDocument();
  });

  it("disables Save draft while it saves, ignores a double click, and re-enables it", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    const gate = deferred<Awaited<ReturnType<typeof store.eir.saveDraft>>>();
    const real = store.eir.saveDraft.bind(store.eir);
    let capturedSaveDraft!: Parameters<typeof store.eir.saveDraft>;
    const saveDraft = vi.fn((...args: Parameters<typeof store.eir.saveDraft>) => {
      capturedSaveDraft = args;
      return gate.promise;
    });
    store.eir.saveDraft = saveDraft;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const save = await screen.findByRole("button", { name: "Save draft" });
    fireEvent.click(save);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.click(save);
    expect(saveDraft).toHaveBeenCalledTimes(1);

    const [principalId, savedValues, expectedVersion, formVersion] = capturedSaveDraft;
    // The save names the form on screen (#201), and the real repository checks it.
    expect(formVersion).toBe("bootstrap-2");
    gate.resolve(await real(principalId, savedValues, expectedVersion, formVersion));
    expect(await screen.findByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("keeps the form editable while a draft saves, and says saved only once confirmed", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    const gate = deferred<Awaited<ReturnType<typeof store.eir.saveDraft>>>();
    const real = store.eir.saveDraft.bind(store.eir);
    let captured!: Parameters<typeof store.eir.saveDraft>;
    store.eir.saveDraft = vi.fn((...args: Parameters<typeof store.eir.saveDraft>) => {
      captured = args;
      return gate.promise;
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const team = await screen.findByLabelText(/Team or project/);
    fireEvent.change(team, { target: { value: "Saved Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const draft = screen.getByRole("region", { name: "Your draft" });
    expect(await within(draft).findByText("Saving… Save your EIR draft")).toBeVisible();
    expect(draft).not.toHaveTextContent("Draft saved");

    // The person keeps working while it saves.
    expect(team).toBeEnabled();
    fireEvent.change(team, { target: { value: "Typed while saving" } });

    const [principalId, values, version, formVersion] = captured;
    expect(values["team"]).toBe("Saved Team");
    // The save names the form on screen (#201), and the real repository checks it.
    expect(formVersion).toBe("bootstrap-2");
    gate.resolve(await real(principalId, values, version, formVersion));
    expect(await within(draft).findByText(/^Draft saved\./)).toBeVisible();
    // The server's answer doesn't overwrite what was typed after the click.
    expect(team).toHaveValue("Typed while saving");
  });

  it("refuses a Save draft on a form that changed since it was shown, saying so, and saves nothing (#201)", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    // A Safeguards member, so the same store can activate another definition.
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: true,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    // The screen shows the fallback built-in form, bootstrap-2.
    const team = await screen.findByLabelText(/Team or project/);
    expect(screen.getByText("User details")).toBeInTheDocument();
    fireEvent.change(team, { target: { value: "Typed on bootstrap-2" } });

    // Meanwhile Safeguards activates version 1; the open screen still shows bootstrap-2.
    const next = readBootstrapEirSource()!.replace(
      "      title: User details\n",
      "      title: User details (v2)\n",
    );
    await store.eirDefinitions.publish({ sourceYaml: next, expectedVersion: 0 });
    await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });
    expect(screen.queryByText("User details (v2)")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const draft = screen.getByRole("region", { name: "Your draft" });
    expect(await within(draft).findByText("We could not save the draft")).toBeVisible();
    expect(draft).toHaveTextContent(FORM_CHANGED_REFUSAL);
    expect(draft).not.toHaveTextContent("Draft saved");
    expect(team).toHaveValue("Typed on bootstrap-2");
    const stored = await store.eir.get("person-1");
    expect(stored.draftValues).toBeUndefined();
    expect(stored.draftFormVersion).toBeUndefined();
  });

  it("after a held privacy acknowledgment, a Save draft on a form that changed is still refused, with nothing saved (#201 with #202)", async () => {
    const identity = {
      principalId: "person-1",
      displayName: "Test Person",
      actorApp: "tenant" as const,
    };
    const privacy = createMemoryPrivacyAcknowledgmentRepository({ identity });
    const acknowledgment = deferred<Awaited<ReturnType<typeof privacy.acknowledge>>>();
    const realAcknowledge = privacy.acknowledge.bind(privacy);
    privacy.acknowledge = vi.fn(() => acknowledgment.promise);
    const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: privacy });
    // A Safeguards member, so the same store can activate another definition.
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: true,
    });
    const readEir = vi.spyOn(store.eir, "get");
    const saveDraft = vi.spyOn(store.eir, "saveDraft");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));

    // While the acknowledgment is on its way: the active form (1.3), read-only, and no EIR traffic.
    const team = await screen.findByLabelText(/Team or project/);
    expect(team).toBeDisabled();
    expect(screen.getByText("User details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(readEir).not.toHaveBeenCalled();

    await act(async () =>
      acknowledgment.resolve(
        await realAcknowledge({
          noticeVersion: privacy.notice.version,
          contentHash: privacy.notice.contentHash,
        }),
      ),
    );
    await waitFor(() => expect(team).toBeEnabled());
    fireEvent.change(team, { target: { value: "Typed on bootstrap-2" } });

    // Meanwhile Safeguards activates version 1; the open screen still shows bootstrap-2.
    const next = readBootstrapEirSource()!.replace(
      "      title: User details\n",
      "      title: User details (v2)\n",
    );
    await store.eirDefinitions.publish({ sourceYaml: next, expectedVersion: 0 });
    await store.eirDefinitions.activate({ versionNumber: 1, expectedVersion: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const draft = screen.getByRole("region", { name: "Your draft" });
    expect(await within(draft).findByText("We could not save the draft")).toBeVisible();
    expect(draft).toHaveTextContent(FORM_CHANGED_REFUSAL);
    // It went through the acknowledgment queue to the server, naming the form shown.
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0]![3]).toBe("bootstrap-2");
    expect(team).toHaveValue("Typed on bootstrap-2");
    const stored = await store.eir.get("person-1");
    expect(stored.draftValues).toBeUndefined();
    expect(stored.draftFormVersion).toBeUndefined();
  });

  it("disables Download PDF to sign while saving the draft and ignores a double click", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await store.eir.saveDraft("person-1", values);
    const gate = deferred<Awaited<ReturnType<typeof store.eir.saveDraft>>>();
    const real = store.eir.saveDraft.bind(store.eir);
    let capturedSaveDraft!: Parameters<typeof store.eir.saveDraft>;
    const saveDraft = vi.fn((...args: Parameters<typeof store.eir.saveDraft>) => {
      capturedSaveDraft = args;
      return gate.promise;
    });
    store.eir.saveDraft = saveDraft;
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:draft");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const download = await screen.findByRole("button", { name: "Download PDF to sign" });
    fireEvent.click(download);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.click(download);
    expect(saveDraft).toHaveBeenCalledTimes(1);

    const [principalId, savedValues, expectedVersion, formVersion] = capturedSaveDraft;
    // The save names the form on screen (#201), and the real repository checks it.
    expect(formVersion).toBe("bootstrap-2");
    gate.resolve(await real(principalId, savedValues, expectedVersion, formVersion));
    expect(await screen.findByRole("button", { name: "Download PDF to sign" })).toBeEnabled();
  });

  it("after a lost upload reply, says to check the EIR status first, never that it won't be saved twice (#189)", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await store.eir.saveDraft("person-1", values);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    expect(await screen.findByText(/PDF generated/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
      target: { files: [new File(["%PDF"], "signed.pdf", { type: "application/pdf" })] },
    });
    // The upload is stored, but its reply is the gateway's page: it has no
    // idempotency key, so a retry would store the PDF again.
    const gateway = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    store.eir.submitWithFile = async (input) => {
      await uploadEirPdf(input.file, gateway);
      throw new Error("unreachable");
    };

    fireEvent.click(await screen.findByRole("button", { name: "Submit for validation" }));

    const alert = await screen.findByText(
      "We couldn't confirm this upload. Check your EIR status before submitting again.",
    );
    expect(alert.closest("[role=alert]")).not.toHaveTextContent(
      /won't be saved twice|could not submit|Unexpected token|DOCTYPE/,
    );
  });

  it("keeps focus and every keystroke in a field while an earlier save error is shown (#184)", async () => {
    const user = userEvent.setup();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    store.eir.saveDraft = async () => {
      throw Object.assign(new Error("lost"), { code: "outcome-unknown", status: 0 });
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const save = await screen.findByRole("button", { name: "Save draft" });
    await user.click(save);
    // Save draft doesn't block (ADR-0009): the outcome is announced as an
    // alert in #189's words, and focus stays where the person was (#184).
    const outcome = await within(screen.getByRole("region", { name: "Your draft" })).findByRole(
      "alert",
    );
    expect(outcome).toHaveTextContent(/We couldn't confirm this save.*can't be saved twice/);
    expect(outcome).not.toHaveTextContent(/refused|Unexpected token|DOCTYPE/);
    expect(outcome).not.toHaveFocus();
    expect(save).toHaveFocus();

    const team = screen.getByRole("textbox", { name: /^Team/ });
    await user.clear(team);
    await user.type(team, "Senior Team");
    expect(team).toHaveFocus();
    expect(team).toHaveValue("Senior Team");
    expect(outcome).toBeInTheDocument();
  });

  it("announces a load error a background refetch hits, without moving focus (#184)", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const team = await screen.findByRole("textbox", { name: /^Team/ });
    team.focus();

    // A 4xx isn't retried, so the refetch fails at once.
    vi.spyOn(store.eir, "get").mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    await act(async () => {
      await client.refetchQueries();
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You don't have access to this EIR data.");
    expect(alert).not.toHaveFocus();
  });

  it("disables Submit for validation while pending and ignores a double click", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await store.eir.saveDraft("person-1", values);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download PDF to sign" }));
    expect(await screen.findByText(/PDF generated/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
      target: { files: [new File(["%PDF"], "signed.pdf", { type: "application/pdf" })] },
    });
    const gate = deferred<Awaited<ReturnType<typeof store.eir.submitWithFile>>>();
    const real = store.eir.submitWithFile.bind(store.eir);
    let capturedSubmit!: Parameters<typeof store.eir.submitWithFile>[0];
    const submit = vi.fn((input: Parameters<typeof store.eir.submitWithFile>[0]) => {
      capturedSubmit = input;
      return gate.promise;
    });
    store.eir.submitWithFile = submit;

    const button = await screen.findByRole("button", { name: "Submit for validation" });
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);

    gate.resolve(await real(capturedSubmit));
    expect(await screen.findByText(/Submitted for validation/)).toBeInTheDocument();
  });

  it("keeps focus in the reason field while a failed decision's error is shown (#184)", async () => {
    const user = userEvent.setup();
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "valid", "validator-2");
    store.eir.decide = async () => {
      throw Object.assign(new Error("Something went wrong saving or loading this."), {
        status: 500,
      });
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    const reason = screen.getByRole("textbox", { name: /Reason for revocation/ });
    await user.type(reason, "Access no longer required");
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }));
    // Right after the person's own failed action, the error takes focus.
    const error = await screen.findByText(/We could not save the decision/);
    await waitFor(() => expect(error.closest("[tabindex='-1']")).toHaveFocus());

    await user.click(reason);
    await user.type(reason, " now");
    expect(reason).toHaveFocus();
    expect(reason).toHaveValue("Access no longer required now");
    expect(screen.getByText(/We could not save the decision/)).toBeInTheDocument();
  });

  it("requires a reason before revoking and confirms the consequence", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "valid", "validator-2");

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(screen.getByText(/loses entry to sensitive environments/i)).toBeInTheDocument();
    const reason = screen.getByRole("textbox", { name: /Reason for revocation/ });
    expect(reason).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a reason for revocation");
    fireEvent.change(reason, { target: { value: "Access no longer required" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    // While it saves, the buttons are disabled and a status says so.
    expect(screen.getByRole("status")).toHaveTextContent("Saving the decision");
    expect(screen.getAllByRole("button", { name: "Saving…" })[0]).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("EIR revoked"));
  });

  it("disables a validator decision while pending and ignores a double click", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    const gate = deferred<Awaited<ReturnType<typeof store.eir.decide>>>();
    const real = store.eir.decide.bind(store.eir);
    let capturedDecision!: Parameters<typeof store.eir.decide>;
    const decide = vi.fn((...args: Parameters<typeof store.eir.decide>) => {
      capturedDecision = args;
      return gate.promise;
    });
    store.eir.decide = decide;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    const markValid = await screen.findByRole("button", { name: "Mark valid" });
    fireEvent.click(markValid);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.click(markValid);
    expect(decide).toHaveBeenCalledTimes(1);

    gate.resolve(await real(...capturedDecision));
    expect(await screen.findByText("Decision saved: EIR approved.")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("disables validator revocation confirmation while pending and ignores a double click", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "valid", "validator-2");
    const gate = deferred<Awaited<ReturnType<typeof store.eir.decide>>>();
    const real = store.eir.decide.bind(store.eir);
    let capturedDecision!: Parameters<typeof store.eir.decide>;
    const decide = vi.fn((...args: Parameters<typeof store.eir.decide>) => {
      capturedDecision = args;
      return gate.promise;
    });
    store.eir.decide = decide;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Reason for revocation/ }), {
      target: { value: "Access no longer required" },
    });
    const confirm = screen.getByRole("button", { name: "Confirm revocation" });
    fireEvent.click(confirm);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(confirm);
    expect(decide).toHaveBeenCalledTimes(1);

    gate.resolve(await real(...capturedDecision));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("EIR revoked"));
  });

  it("shows a rejected person the decision note, date, and next step", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot(), {
      clock: () => new Date("2026-10-01T12:00:00Z"),
    });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "rejected", "validator-1", "Signature is missing");

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Decision: Rejected")).toBeInTheDocument();
    expect(screen.getByText("Validator note: Signature is missing")).toBeInTheDocument();
    expect(screen.getByText("Date: 10/1/2026")).toBeInTheDocument();
    expect(screen.getByText("Next step: Correct and resubmit.")).toBeInTheDocument();
    expect(screen.getByText("Not valid")).toBeInTheDocument();
  });

  it("validates a safeguards answer on submit and clears the error when answered", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "questions", "validator-1", "Clarify handling");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");

    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );

    // A new PDF is the Correct my answers path; Send response needs none.
    fireEvent.click(await screen.findByRole("button", { name: "Correct my answers" }));
    const file = new File(["%PDF"], "signed.pdf", { type: "application/pdf" });
    fireEvent.change(await screen.findByLabelText("Signed EIR PDF"), {
      target: { files: [file] },
    });
    expect(screen.queryByText(/Answer the safeguards questions before submitting/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit for validation" }));
    expect(
      await screen.findByText("Answer the safeguards questions before submitting."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Your response/ }), {
      target: { value: "Encrypted at rest" },
    });
    expect(screen.queryByText(/Answer the safeguards questions before submitting/)).toBeNull();
  });

  const sentBackScreen = async (eirRepository?: MemoryEirRepository) => {
    const store = createAcknowledgedMemoryStore(
      makeSnapshot(),
      eirRepository ? { eirRepository } : {},
    );
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "questions", "validator-1", "Clarify handling");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("textbox", { name: /Your response/ });
    return store;
  };

  it("after a send-back, offers Send response and Correct my answers under Your response", async () => {
    await sentBackScreen();
    const send = screen.getByRole("button", { name: "Send response" });
    expect(send).toBeEnabled();
    expect(screen.getByRole("button", { name: "Correct my answers" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Your response/ })).toHaveAttribute(
      "aria-required",
      "true",
    );
    // The answers are as signed: the form and upload wait for Correct my answers.
    expect(screen.queryByRole("form", { name: "EIR form" })).toBeNull();
    expect(screen.queryByLabelText("Signed EIR PDF")).toBeNull();
    expect(screen.getByText(/Next step: Answer the questions below, then send your response/));
  });

  it("refuses a blank Send response on screen, announced and focused", async () => {
    const store = await sentBackScreen();
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    const error = await screen.findByText("Enter your response to the safeguards questions.");
    expect(error).toHaveAttribute("role", "alert");
    const box = screen.getByRole("textbox", { name: /Your response/ });
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription(/Enter your response/);
    expect((await store.eir.get("person-1")).stage).toBe("questions");
  });

  it("sends the response with the same answers and the signed PDF, no new PDF", async () => {
    const store = await sentBackScreen();
    const before = await store.eir.get("person-1");
    fireEvent.change(screen.getByRole("textbox", { name: /Your response/ }), {
      target: { value: "Encrypted at rest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    expect(
      await screen.findByText("Response sent. Your EIR is back with a safeguards validator."),
    ).toHaveAttribute("role", "status");
    const after = await store.eir.get("person-1");
    expect(after).toMatchObject({ stage: "submitted", response: "Encrypted at rest" });
    expect(after.submissions).toEqual(before.submissions);
    expect(after.formValues).toEqual(before.formValues);
    expect(after.actions.at(-1)).toMatchObject({
      kind: "submitted",
      response: "Encrypted at rest",
    });
  });

  it("disables Send response while pending, ignores a double click, and re-enables it", async () => {
    const repo = createMemoryEirRepository();
    const store = await sentBackScreen(repo);
    const gate = deferred<Awaited<ReturnType<typeof repo.respond>>>();
    const real = repo.respond.bind(repo);
    const respond = vi.fn(() => gate.promise);
    repo.respond = respond;
    fireEvent.change(screen.getByRole("textbox", { name: /Your response/ }), {
      target: { value: "Encrypted at rest" },
    });

    const button = screen.getByRole("button", { name: "Send response" });
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Correct my answers" })).toBeDisabled();
    fireEvent.click(button);
    expect(respond).toHaveBeenCalledTimes(1);

    gate.reject(new Error("temporary outage"));
    expect(await screen.findByRole("button", { name: "Send response" })).toBeEnabled();
    expect((await store.eir.get("person-1")).stage).toBe("questions");
  });

  it("disables Send response once the answers change, and carries the response through review", async () => {
    const store = await sentBackScreen();
    fireEvent.change(screen.getByRole("textbox", { name: /Your response/ }), {
      target: { value: "Team corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Correct my answers" }));
    const team = await screen.findByRole("textbox", { name: /^Team or project/ });
    expect(team).toHaveValue(values["team"]);
    fireEvent.change(team, { target: { value: "Corrected Team" } });
    const send = screen.getByRole("button", { name: "Send response" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      /You changed your answers, so you need to sign a new PDF/,
    );
    expect(screen.getByRole("textbox", { name: /Your response/ })).toHaveValue("Team corrected");

    fireEvent.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    await screen.findByText(/PDF generated/);
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
      target: { files: [new File(["%PDF"], "corrected.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByRole("heading", { name: "Review and submit" })).toBeInTheDocument();
    expect(screen.getByText("Your answer:").parentElement).toHaveTextContent(
      "Your answer: Team corrected",
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit for validation" }));
    expect(
      await screen.findByText("Submitted for validation. With a safeguards validator."),
    ).toBeInTheDocument();
    const after = await store.eir.get("person-1");
    expect(after).toMatchObject({ stage: "submitted", response: "Team corrected" });
    expect(after.submissions).toHaveLength(2);
    expect(after.submissions[1]).toMatchObject({ kind: "resubmission" });
    expect(after.formValues?.["team"]).toBe("Corrected Team");
  });

  it("shows a test-mode decision as a tag, never as text inside the validator's note", async () => {
    const repo = createMemoryEirRepository({ selfDecisionTestMode: true });
    const store = createAcknowledgedMemoryStore(makeSnapshot(), { eirRepository: repo });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      name: "Safeguards Validator",
      isSafeguardsValidator: true,
      eirSelfDecisionTestMode: true,
    });
    await repo.submit("validator-1", "Safeguards Validator", "/Volumes/eir/own.pdf", values);
    await repo.decide("validator-1", "questions", "validator-1", "Confirm the team");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <EirScreen />
        </StoreProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Validator note: Confirm the team")).toBeInTheDocument();
    expect(screen.getByText("Decision: Sent back").parentElement).toHaveTextContent(
      "Decision: Sent backTest mode",
    );
    expect(screen.queryByText(/Self-decision under preview test mode/)).toBeNull();
  });

  it("shows the validator the questions beside the person's response", async () => {
    const repo = createMemoryEirRepository();
    const store = createAcknowledgedMemoryStore(makeSnapshot(), { eirRepository: repo });
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "validator-1",
      isSafeguardsValidator: true,
    });
    await repo.submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await repo.decide("person-1", "questions", "validator-1", "Clarify handling");
    await repo.respond({ principalId: "person-1", values, response: "Encrypted at rest" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StoreProvider store={store}>
          <ValidatorPages />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const note = await screen.findByRole("note", {
      name: "Questions and response for Test Person",
    });
    expect(note).toHaveTextContent("Your questions: Clarify handling");
    expect(note).toHaveTextContent("Their response: Encrypted at rest");
    expect(screen.getByRole("button", { name: "Mark valid" })).toBeInTheDocument();
  });

  it("persists a rejected-record correction draft and uses it as the cross-visit PDF baseline", async () => {
    const store = createAcknowledgedMemoryStore(makeSnapshot());
    store.catalog.getUser = async () => ({
      ...makeSnapshot().user,
      principalId: "person-1",
      name: "Test Person",
      isSafeguardsValidator: false,
    });
    await memoryEir(store).submit("person-1", "Test Person", "/Volumes/eir/one.pdf", values);
    await store.eir.decide("person-1", "rejected", "validator-1", "Correct the signature");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:review");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const renderScreen = () =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <StoreProvider store={store}>
            <EirScreen />
          </StoreProvider>
        </QueryClientProvider>,
      );

    renderScreen();
    const team = await screen.findByRole("textbox", { name: /Team or project/ });
    fireEvent.change(team, { target: { value: "Senior Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Download PDF to sign" }));
    await waitFor(async () =>
      expect((await store.eir.get("person-1")).draftValues?.["team"]).toBe("Senior Team"),
    );
    expect((await store.eir.get("person-1")).formValues?.["team"]).toBe("Test Team");

    cleanup();
    renderScreen();
    const restored = await screen.findByRole("textbox", { name: /Team or project/ });
    await waitFor(() => expect(restored).toHaveValue("Senior Team"));
    fireEvent.change(restored, { target: { value: "Director Team" } });
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
      target: {
        files: [new File(["%PDF"], "corrected.pdf", { type: "application/pdf" })],
      },
    });

    expect(await screen.findByText(/form has changed since you downloaded the PDF/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit for validation" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit form" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Team or project/ }), {
      target: { value: "Senior Team" },
    });
    fireEvent.change(screen.getByLabelText("Signed EIR PDF"), {
      target: {
        files: [new File(["%PDF"], "corrected.pdf", { type: "application/pdf" })],
      },
    });
    expect(await screen.findByRole("heading", { name: "Review and submit" })).toBeInTheDocument();
    expect(screen.queryByText(/form has changed since you downloaded the PDF/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Submit for validation" }));
    expect(
      await screen.findByText("Submitted for validation. With a safeguards validator."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Renewal pending with a safeguards validator/)).toBeNull();
  });
});
