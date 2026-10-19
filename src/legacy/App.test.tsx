import "@testing-library/jest-dom/vitest";

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- the legacy JSX shell does not publish TypeScript declarations.
import App from "./App.jsx";
import { createMemoryStore } from "../data/adapters/memory";
import { makeSnapshot } from "../data/__tests__/fixture";
import { StoreProvider } from "../data/store-provider";

// The #86 onboarding screens are real TSX on the data seam; stub them here so the
// shell test stays about routing, not the screens (covered in components/Onboarding).
vi.mock("../components/Onboarding", () => ({
  MyOnboardingRequestsScreen: () => <div>MY ONBOARDING REQUESTS</div>,
}));
vi.mock("../components/DatasetAccess", () => ({
  ChangeListScreen: () => <div>READ-ONLY CHANGE LIST</div>,
  DatasetTeamScreen: () => null,
  DatasetsScreen: () => null,
}));
// Likewise the EDP Admin page (#159): its sections are covered in components/EdpAdmin.
vi.mock("../components/EdpAdmin/EdpAdminScreen", () => ({
  EdpAdminScreen: ({ params }: { params?: { id?: string } }) => (
    <div>EDP ADMIN SECTION {params?.id}</div>
  ),
}));

// The #admin guard is covered in components/EdpAdmin; here, only that #admin goes through it.
vi.mock("../components/EdpAdmin/IntakeEditorRoute", () => ({
  IntakeEditorRoute: ({ Screen }: { Screen: React.ComponentType }) => (
    <div>
      STAFF-ONLY GUARD <Screen />
    </div>
  ),
}));

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}

const MOCK = "MOCK_SCREEN_CONTENT_DO_NOT_SHOW";
const data = { requests: [], user: { initials: "JT", isAdmin: false } };

function renderApp(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoreProvider store={createMemoryStore(makeSnapshot())}>{ui}</StoreProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  setGlobal("AppIcon", () => null);
  setGlobal("TopNav", () => <nav data-testid="topnav" />);
  setGlobal("AppFooter", () => <footer />);
  setGlobal("Page", ({ children }: { children?: React.ReactNode }) => <div>{children}</div>);
  // Every mock-backed screen renders the same forbidden marker so a gate leak
  // is caught no matter which screen slips through.
  for (const name of [
    "BrowseScreen",
    "DomainScreen",
    "DatasetScreen",
    "BundleScreen",
    "BundlesScreen",
    "SearchScreen",
    "CartScreen",
    "RequestsScreen",
    "StatusScreen",
    "AccessScreen",
  ]) {
    setGlobal(name, () => <div>{MOCK}</div>);
  }
  // The two real, ungated surfaces render recognizable content instead.
  setGlobal("HomeScreen", () => <div>HOME LANDING</div>);
  setGlobal("OnboardingScreen", () => <div>REAL ONBOARDING WIZARD</div>);
  setGlobal("AdminScreen", () => <div>ADMIN CONSOLE</div>);
});

afterEach(cleanup);

// route hash -> the coming-soon card label its FeatureGate should render.
const GATED = [
  { hash: "search", label: "Data discovery & catalog" },
  { hash: "browse", label: "Data discovery & catalog" },
  { hash: "domain", label: "Data discovery & catalog" },
  { hash: "dataset", label: "Data discovery & catalog" },
  { hash: "bundles", label: "Access bundles" },
  { hash: "bundle", label: "Access bundles" },
  { hash: "cart", label: "Request cart" },
  { hash: "requests", label: "Request stage tracking" },
  { hash: "status", label: "Request stage tracking" },
  { hash: "access", label: "My Access (cross-system view)" },
];

describe("App shell gating", () => {
  it("announces action feedback politely inside the main landmark", () => {
    setGlobal("OnboardingScreen", ({ ctx }: { ctx: { flash: (text: string) => void } }) => (
      <button onClick={() => ctx.flash("Request saved")}>Save request</button>
    ));
    window.location.hash = "#onboarding";
    renderApp(<App data={data} submitRequest={vi.fn()} />);

    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.closest("main")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save request" }));
    expect(status).toHaveTextContent("Request saved");
  });

  it.each(GATED)(
    "renders the coming-soon card (not mock content) for #$hash",
    ({ hash, label }) => {
      window.location.hash = "#" + hash;
      renderApp(<App data={data} submitRequest={vi.fn()} />);

      expect(screen.getByText("Coming soon")).toBeVisible();
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByText(MOCK)).not.toBeInTheDocument();
    },
  );

  it("does NOT gate the real onboarding wizard", () => {
    window.location.hash = "#onboarding";
    renderApp(<App data={data} submitRequest={vi.fn()} />);

    expect(screen.getByText("REAL ONBOARDING WIZARD")).toBeVisible();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
    expect(screen.queryByText(MOCK)).not.toBeInTheDocument();
  });

  it("renders the real Home landing without a gate", () => {
    window.location.hash = "#home";
    renderApp(<App data={data} submitRequest={vi.fn()} />);

    expect(screen.getByText("HOME LANDING")).toBeVisible();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("routes the onboarding request screens without a gate (#86)", () => {
    window.location.hash = "#onboarding-requests";
    const { unmount } = renderApp(<App data={data} submitRequest={vi.fn()} />);
    expect(screen.getByText("MY ONBOARDING REQUESTS")).toBeVisible();
    unmount();

    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("redirects the old review inbox routes to their EDP Admin section (#159)", () => {
    window.location.hash = "#review/ccb";
    renderApp(<App data={data} submitRequest={vi.fn()} />);
    expect(screen.getByText("EDP ADMIN SECTION ccb")).toBeVisible();
    expect(window.location.hash).toBe("#edp-admin/ccb");
  });

  it("redirects #change-list to EDP Admin for staff, and leaves it for an owner (#159)", () => {
    const staff = { ...data, user: { ...data.user, isAdmin: true } };
    window.location.hash = "#change-list";
    const { unmount } = renderApp(<App data={staff} submitRequest={vi.fn()} />);
    expect(screen.getByText("EDP ADMIN SECTION change-list")).toBeVisible();
    expect(window.location.hash).toBe("#edp-admin/change-list");
    unmount();

    window.location.hash = "#change-list";
    renderApp(<App data={data} submitRequest={vi.fn()} />);
    expect(screen.getByText("READ-ONLY CHANGE LIST")).toBeVisible();
    expect(window.location.hash).toBe("#change-list");
  });

  it("renders #admin, the intake form editor, only through the staff-only guard", () => {
    window.location.hash = "#admin";
    renderApp(<App data={data} submitRequest={vi.fn()} />);
    expect(screen.getByText(/STAFF-ONLY GUARD/)).toBeVisible();
    expect(screen.getByText("ADMIN CONSOLE")).toBeVisible();
  });
});
