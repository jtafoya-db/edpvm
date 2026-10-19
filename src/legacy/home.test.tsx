import "@testing-library/jest-dom/vitest";

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setData } from "./appDataBridge.js";
// Registers window.HomeScreen as a side effect.
import "./home.jsx";

type AnyProps = Record<string, unknown> & { children?: React.ReactNode; onClick?: () => void };

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}

beforeEach(() => {
  setGlobal("AppIcon", () => null);
  setGlobal("Panel", ({ children, onClick }: AnyProps) => <div onClick={onClick}>{children}</div>);
  setData({ user: { initials: "JT", isAdmin: false } });
});

afterEach(cleanup);

const HomeScreen = (window as unknown as { HomeScreen: React.ComponentType<AnyProps> }).HomeScreen;

describe("Home landing (MVP)", () => {
  it("launches the onboarding wizard and drops all mock discovery sections", () => {
    const go = vi.fn();
    render(<HomeScreen ctx={{ go }} />);

    // Onboarding is prominently featured and launchable.
    const cta = screen.getByText("Start the onboarding wizard");
    fireEvent.click(cta);
    expect(go).toHaveBeenCalledWith("onboarding");

    // None of the former mock-seed discovery sections are present.
    expect(screen.queryByText("Featured data domains")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommended starter packs")).not.toBeInTheDocument();
    expect(screen.queryByText("Your recent requests")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask Genie")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Describe the data you need, in plain language…"),
    ).not.toBeInTheDocument();
  });
});
