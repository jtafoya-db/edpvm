/**
 * The onboarding wizard's required Target domain list (UAT bug on #128): on
 * the Delta backend it came back empty, so the wizard couldn't be finished.
 *
 * - Delta serves the domain list from the same checked-in seed memory uses.
 * - The wizard never shows a silently empty required list: it announces it.
 * - A failed load is announced by the host with a Retry that recovers.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeltaStore, type DeltaApiTransport } from "@/data/adapters/delta";
import { createMemoryStore } from "@/data/adapters/memory";
import { makeSnapshot } from "@/data/__tests__/fixture";
import { useLegacyAppData } from "@/data/legacy-bridge";
import type { DataStore } from "@/data/store";
import { StoreProvider } from "@/data/store-provider";
import { BackendUnavailableNotice } from "../BackendUnavailableNotice";
import { OnboardingIntakeScreen, type OnboardingIntakeCtx } from "./OnboardingIntake";
import { onboardingStore } from "./__tests__/store-wrapper";

afterEach(cleanup);

const DOMAINS = makeSnapshot().domains;

const ctx: OnboardingIntakeCtx = {
  go: vi.fn(),
  flash: vi.fn(),
};

function domainSelect(): HTMLSelectElement {
  return screen.getByLabelText(/Target domain/) as HTMLSelectElement;
}

describe("Target domain options", () => {
  it("come from the checked-in seed on the Delta backend, with no API call", async () => {
    const transport: DeltaApiTransport = { read: vi.fn(), command: vi.fn(), legacyWrite: vi.fn() };
    const store = createDeltaStore({ transport, domains: () => DOMAINS });
    expect((await store.catalog.listDomains()).map((d) => d.id)).toEqual(DOMAINS.map((d) => d.id));
    expect(await store.catalog.getDomain(DOMAINS[0]!.id)).toEqual(DOMAINS[0]);
    expect(transport.read).not.toHaveBeenCalled();
  });

  it("list every domain in the wizard, with no domain alert", () => {
    render(<OnboardingIntakeScreen ctx={ctx} domains={DOMAINS} />, {
      wrapper: onboardingStore().Wrapper,
    });
    const options = [...domainSelect().options].map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(DOMAINS.map((d) => d.name)));
    expect(screen.queryByText(/Target domains couldn't be loaded/)).toBeNull();
  });

  it("when empty, the wizard announces it instead of showing a silently empty required list", () => {
    render(<OnboardingIntakeScreen ctx={ctx} domains={[]} />, {
      wrapper: onboardingStore().Wrapper,
    });
    const alert = screen
      .getAllByRole("alert")
      .find((el) => el.textContent?.includes("Target domains couldn't be loaded"));
    expect(alert).toBeDefined();
    expect(alert!.textContent).toContain("can't be submitted yet");
    expect(alert!.textContent).toContain("Reload the page");
  });

  it("when the load fails, the host announces it with a Retry that recovers", async () => {
    const base = createMemoryStore(makeSnapshot());
    let fail = true;
    const store: DataStore = {
      ...base,
      catalog: {
        ...base.catalog,
        listDomains: async () => {
          if (fail) throw new Error("[delta] /api/reads/catalog/domains responded 503");
          return base.catalog.listDomains();
        },
      },
    };
    function Host() {
      const legacy = useLegacyAppData();
      if (legacy.isError) {
        return (
          <BackendUnavailableNotice message={legacy.error?.message ?? ""} onRetry={legacy.retry} />
        );
      }
      return legacy.data ? <p>{legacy.data.domains.length} domains</p> : <p>Loading</p>;
    }
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoreProvider store={store}>
          <Host />
        </StoreProvider>
      </QueryClientProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Data backend unavailable");
    expect(alert.textContent).toContain("responded 503");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText(`${DOMAINS.length} domains`)).toBeTruthy());
  });
});
