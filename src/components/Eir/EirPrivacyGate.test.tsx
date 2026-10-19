import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ACTIVE_PRIVACY_NOTICE, createMemoryStore, StoreProvider } from "@/data";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { createMemoryPrivacyAcknowledgmentRepository } from "@/data/privacy/repository";
import { EirScreen } from "./EirScreen";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const acknowledgeActive = (
  repository: ReturnType<typeof createMemoryPrivacyAcknowledgmentRepository>,
) =>
  repository.acknowledge({
    noticeVersion: repository.notice.version,
    contentHash: repository.notice.contentHash,
  });

function setup({
  chrome,
  supportEmail = "edp-help@agency.gov",
}: {
  chrome?: Parameters<typeof EirScreen>[0]["chrome"];
  supportEmail?: string | null;
} = {}) {
  const state = { acknowledgments: [] };
  const privacyAcknowledgmentRepository = createMemoryPrivacyAcknowledgmentRepository({
    state,
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
    clock: () => new Date("2026-10-13T12:00:00.000Z"),
  });
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository });
  store.catalog.getUser = async () => ({
    ...makeSnapshot().user,
    ...(supportEmail ? { supportEmail } : {}),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen {...(chrome ? { chrome } : {})} />
      </StoreProvider>
    </QueryClientProvider>,
  );
  return { privacyAcknowledgmentRepository };
}

it("privacy screen: acknowledge unlocks the EIR journey", async () => {
  setup();
  const user = userEvent.setup();

  expect(await screen.findByRole("heading", { name: /Development privacy notice/ })).toBeVisible();
  expect(screen.getByText(/not an IRS-approved privacy notice/)).toBeVisible();
  await user.tab();
  expect(screen.getByRole("link", { name: "Email the EDP support team" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Acknowledge and continue" })).toHaveFocus();
  await user.keyboard("{Enter}");

  expect(
    await screen.findByRole("heading", { name: "Employee Identity Record (EIR)" }),
  ).toBeVisible();
});

it("privacy screen: shows a disabled form until acknowledgment releases the saved draft", async () => {
  const state = { acknowledgments: [] };
  const privacyAcknowledgmentRepository = createMemoryPrivacyAcknowledgmentRepository({
    state,
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
    clock: () => new Date("2026-10-13T12:00:00.000Z"),
  });
  const acknowledgment =
    deferred<Awaited<ReturnType<typeof privacyAcknowledgmentRepository.acknowledge>>>();
  privacyAcknowledgmentRepository.acknowledge = vi.fn(() => acknowledgment.promise);
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  await store.eir.saveDraft("person-1", { team: "Saved Team" });
  const readEir = vi.spyOn(store.eir, "get");
  const evaluateEir = vi.spyOn(store.eir, "evaluateDraft");
  const saveEir = vi.spyOn(store.eir, "saveDraft");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));

  const team = await screen.findByLabelText(/Team or project/);
  expect(team).toBeVisible();
  expect(team).toBeDisabled();
  const loadingStatus = screen.getByText("Loading your saved answers…");
  expect(loadingStatus).toHaveTextContent("Loading your saved answers…");
  expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  expect(screen.getByLabelText("Signed EIR PDF")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  expect(readEir).not.toHaveBeenCalled();
  expect(evaluateEir).not.toHaveBeenCalled();
  expect(saveEir).not.toHaveBeenCalled();

  await act(async () =>
    acknowledgment.resolve(
      await acknowledgeActive(
        createMemoryPrivacyAcknowledgmentRepository({
          identity: {
            principalId: "person-1",
            displayName: "Synthetic Person",
            actorApp: "tenant",
          },
          clock: () => new Date("2026-10-13T12:00:00.000Z"),
        }),
      ),
    ),
  );
  await waitFor(() => expect(readEir).toHaveBeenCalledTimes(1));
  expect(await screen.findByLabelText(/Team or project/)).toHaveValue("Saved Team");
  expect(screen.getByLabelText(/Team or project/)).toBeEnabled();
  expect(screen.getByText("", { selector: 'p[aria-live="polite"]' })).toBe(loadingStatus);
  expect(loadingStatus).toBeEmptyDOMElement();
  expect(saveEir).not.toHaveBeenCalled();
});

it("privacy screen: restores the gate after bounded write retries without sending EIR data or losing typed answers", async () => {
  const repository = createMemoryPrivacyAcknowledgmentRepository({
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
    clock: () => new Date("2026-10-13T12:00:00.000Z"),
  });
  const failedWrite = deferred<Awaited<ReturnType<typeof repository.acknowledge>>>();
  const acknowledge = vi.fn(() => failedWrite.promise);
  repository.acknowledge = acknowledge;
  const store = createMemoryStore(makeSnapshot(), {
    privacyAcknowledgmentRepository: repository,
  });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  const readEir = vi.spyOn(store.eir, "get");
  const saveEir = vi.spyOn(store.eir, "saveDraft");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));
  const team = await screen.findByLabelText(/Team or project/);
  fireEvent.change(team, { target: { value: "Kept locally" } });
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await act(async () => failedWrite.reject(new Error("warehouse unavailable")));

  expect(await screen.findByRole("alert", {}, { timeout: 2_500 })).toHaveTextContent(
    "We couldn't confirm your acknowledgment",
  );
  expect(screen.getByRole("button", { name: "Retry acknowledgment" })).toHaveFocus();
  expect(acknowledge).toHaveBeenCalledTimes(3);
  expect(readEir).not.toHaveBeenCalled();
  expect(saveEir).not.toHaveBeenCalled();

  acknowledge.mockResolvedValueOnce(
    await acknowledgeActive(
      createMemoryPrivacyAcknowledgmentRepository({
        identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
        clock: () => new Date("2026-10-13T12:00:00.000Z"),
      }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Retry acknowledgment" }));

  expect(await screen.findByLabelText(/Team or project/)).toHaveValue("Kept locally");
  await waitFor(() => expect(readEir).toHaveBeenCalledTimes(1));
  expect(saveEir).not.toHaveBeenCalled();
});

it("privacy screen: does not retry an expired session and tells the person to sign in again", async () => {
  const repository = createMemoryPrivacyAcknowledgmentRepository({
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
  });
  const expired = Object.assign(new Error("proxy sign-in page"), {
    status: 200,
    code: "session-expired",
  });
  const acknowledge = vi.fn().mockRejectedValue(expired);
  repository.acknowledge = acknowledge;
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: repository });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("sign in again");
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

it("privacy screen: a background retry succeeds and releases the EIR read without another click", async () => {
  const repository = createMemoryPrivacyAcknowledgmentRepository({
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
  });
  const first = deferred<Awaited<ReturnType<typeof repository.acknowledge>>>();
  const second = deferred<Awaited<ReturnType<typeof repository.acknowledge>>>();
  const acknowledge = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  repository.acknowledge = acknowledge;
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: repository });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  const readEir = vi.spyOn(store.eir, "get");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));
  await act(async () => first.reject(new Error("temporary warehouse failure")));
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
  expect(readEir).not.toHaveBeenCalled();

  await act(async () =>
    second.resolve(
      await acknowledgeActive(
        createMemoryPrivacyAcknowledgmentRepository({
          identity: {
            principalId: "person-1",
            displayName: "Synthetic Person",
            actorApp: "tenant",
          },
        }),
      ),
    ),
  );

  await waitFor(() => expect(readEir).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: "Retry acknowledgment" })).toBeNull();
});

it("privacy screen: confirms a recorded acknowledgment after a lost write response", async () => {
  const repository = createMemoryPrivacyAcknowledgmentRepository({
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
  });
  const recorded = await acknowledgeActive(repository);
  repository.acknowledge = vi.fn().mockRejectedValue(new Error("lost warehouse response"));
  repository.current = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(recorded);
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: repository });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  const readEir = vi.spyOn(store.eir, "get");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));

  await waitFor(() => expect(readEir).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("We couldn't confirm your acknowledgment")).toBeNull();
  expect(repository.current).toHaveBeenCalledTimes(2);
});

it("privacy screen: rejects a different notice returned after a lost write response", async () => {
  const repository = createMemoryPrivacyAcknowledgmentRepository({
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
  });
  const differentNotice = {
    ...(await acknowledgeActive(repository)),
    noticeVersion: "development-different",
    contentHash: `sha256:${"f".repeat(64)}`,
  };
  repository.acknowledge = vi.fn().mockRejectedValue(new Error("lost warehouse response"));
  repository.current = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(differentNotice);
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: repository });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  const readEir = vi.spyOn(store.eir, "get");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));

  expect(await screen.findByRole("alert", {}, { timeout: 2_500 })).toHaveTextContent(
    "We couldn't confirm your acknowledgment",
  );
  expect(repository.acknowledge).toHaveBeenCalledTimes(3);
  expect(repository.current).toHaveBeenCalledTimes(4);
  expect(readEir).not.toHaveBeenCalled();
});

it("privacy screen: a notice change during the write does not release EIR data", async () => {
  const repository = createMemoryPrivacyAcknowledgmentRepository({
    identity: { principalId: "person-1", displayName: "Synthetic Person", actorApp: "tenant" },
  });
  const first = deferred<Awaited<ReturnType<typeof repository.acknowledge>>>();
  const acknowledge = vi.fn().mockReturnValue(first.promise);
  repository.acknowledge = acknowledge;
  const store = createMemoryStore(makeSnapshot(), { privacyAcknowledgmentRepository: repository });
  store.catalog.getUser = async () => ({ ...makeSnapshot().user, principalId: "person-1" });
  const readEir = vi.spyOn(store.eir, "get");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StoreProvider store={store}>
        <EirScreen />
      </StoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Acknowledge and continue" }));
  await act(async () =>
    first.reject(
      Object.assign(new Error("The privacy notice changed."), {
        status: 409,
        code: "privacy-notice-changed",
      }),
    ),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The privacy notice changed. Reload to read the new notice.",
  );
  expect(screen.queryByRole("button", { name: "Retry acknowledgment" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reload page" })).toHaveFocus();
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith({
    noticeVersion: ACTIVE_PRIVACY_NOTICE.version,
    contentHash: ACTIVE_PRIVACY_NOTICE.contentHash,
  });
  expect(readEir).not.toHaveBeenCalled();
});

it("privacy screen: leave shows help and exit with nothing recorded", async () => {
  const { privacyAcknowledgmentRepository } = setup();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Leave without acknowledging" }));

  expect(screen.getByRole("heading", { name: "You left the EIR journey" })).toHaveFocus();
  expect(screen.getByText(/Nothing about a refusal was recorded/)).toBeVisible();
  expect(await privacyAcknowledgmentRepository.history()).toEqual([]);
});

it("privacy screen: uses the EIR page chrome, breadcrumb, styled actions, and a help link", async () => {
  const Page = ({ children }: { children?: ReactNode }) => (
    <div data-testid="eir-page">{children}</div>
  );
  const Trail = ({ items }: { items: Array<{ label: string }> }) => (
    <nav aria-label="Breadcrumb">{items.map(({ label }) => label).join(" / ")}</nav>
  );

  setup({ chrome: { Page, Trail } });

  expect(await screen.findByTestId("eir-page")).toBeVisible();
  expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Home / My EIR");
  expect(document.querySelector("main")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Acknowledge and continue" })).toHaveStyle({
    background: "var(--theme-primary)",
  });
  expect(screen.getByText(ACTIVE_PRIVACY_NOTICE.help)).toBeVisible();
  const supportLink = screen.getByRole("link", { name: "Email the EDP support team" });
  expect(supportLink.closest("p")).toHaveTextContent("Need help? Email the EDP support team.");
  expect(supportLink).toHaveAttribute("href", "mailto:edp-help@agency.gov");
});

it("privacy screen: shows honest plain text when no support contact is configured", async () => {
  setup({ supportEmail: null });

  expect(
    await screen.findByText("No support contact is configured for this deployment."),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: "Email the EDP support team" })).toBeNull();
});
