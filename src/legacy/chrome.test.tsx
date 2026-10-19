import "@testing-library/jest-dom/vitest";

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setData } from "./appDataBridge.js";
// Registers window.TopNav / AppFooter / Page / Trail as a side effect.
import "./chrome.jsx";

type AnyProps = Record<string, unknown>;

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}

beforeEach(() => {
  setGlobal("AppIcon", () => null);
});

afterEach(cleanup);

const TopNav = (window as unknown as { TopNav: React.ComponentType<AnyProps> }).TopNav;

describe("primary navigation (MVP)", () => {
  it("offers only the genuinely real surfaces", () => {
    setData({ user: { initials: "JT", isAdmin: true } });
    render(<TopNav route={{ section: "home" }} go={vi.fn()} />);

    // Real surfaces.
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Onboard new data")).toBeInTheDocument();
    expect(screen.getByText("My EIR")).toBeInTheDocument();
    // Every staff function sits behind the one EDP Admin link (#159).
    expect(screen.getByText("EDP Admin")).toBeInTheDocument();
    expect(screen.getByText("Datasets")).toBeInTheDocument();
    expect(screen.getByText("Access requests")).toBeInTheDocument();

    // Mock-backed surfaces are hidden from nav entirely.
    expect(screen.queryByText("Browse domains")).not.toBeInTheDocument();
    expect(screen.queryByText("Access bundles")).not.toBeInTheDocument();
    expect(screen.queryByText("My Requests")).not.toBeInTheDocument();
    expect(screen.queryByText("My Access")).not.toBeInTheDocument();

    // The mock "Ask Genie" search box and the request cart are gone too.
    expect(screen.queryByLabelText("Search data")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Request cart")).not.toBeInTheDocument();
  });

  it("still hides EDP Admin from non-staff", () => {
    setData({ user: { initials: "JT", isAdmin: false } });
    render(<TopNav route={{ section: "home" }} go={vi.fn()} />);

    expect(screen.getByText("Onboard new data")).toBeInTheDocument();
    expect(screen.getByText("My EIR")).toBeInTheDocument();
    expect(screen.getByText("My onboarding requests")).toBeInTheDocument();
    expect(screen.queryByText("EDP Admin")).not.toBeInTheDocument();
  });

  it("reports nav-link hover and focus intent for prefetching", () => {
    const prefetchRoute = vi.fn();
    setData({ user: { initials: "JT", isAdmin: false } });
    render(<TopNav route={{ section: "home" }} go={vi.fn()} prefetchRoute={prefetchRoute} />);

    const datasets = screen.getByRole("link", { name: "Datasets" });
    fireEvent.mouseEnter(datasets);
    fireEvent.focus(datasets);

    expect(prefetchRoute).toHaveBeenCalledWith("datasets", undefined);
    expect(prefetchRoute).toHaveBeenCalledTimes(2);
  });
});

describe("header avatar → Profile link", () => {
  it("renders the user's initials and navigates to the profile page when clicked", () => {
    const go = vi.fn();
    setData({ user: { initials: "JT", isAdmin: false } });
    render(<TopNav route={{ section: "home" }} go={go} />);

    const avatar = screen.getByRole("button", { name: /open your profile/i });
    expect(avatar).toHaveTextContent("JT");

    avatar.click();
    expect(go).toHaveBeenCalledWith("profile");
  });
});
