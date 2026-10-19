import "@testing-library/jest-dom/vitest";

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setData } from "./appDataBridge.js";
// Registers window.AdminScreen as a side effect.
import "./admin.jsx";

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}

// Capture the real screen before any per-test overrides could shadow it.
const AdminScreen = (window as unknown as { AdminScreen: React.ComponentType<AnyProps> })
  .AdminScreen;

beforeEach(() => {
  setGlobal("AppIcon", () => null);
  setGlobal("Pill", ({ children }: AnyProps) => <span>{children}</span>);
  setGlobal("Page", ({ children }: AnyProps) => <div>{children}</div>);
  setGlobal("Trail", () => null);
  setData({ domains: [] });
});

afterEach(cleanup);

describe("Admin console (MVP)", () => {
  it("shows only the Intake form editor tab and gates every other admin surface", () => {
    // Reach a non-editor tab the way a stale in-session deep-link would.
    render(<AdminScreen ctx={{ go: () => undefined }} params={{ tab: "failures" }} />);

    // The tab bar offers only the one real tab.
    expect(screen.getByText("Intake form editor")).toBeInTheDocument();
    for (const hidden of [
      "Bundle mapping",
      "Provisioning health",
      "Dataset registry",
      "Onboarding flow",
      "Pipeline tracker",
      "Tenant usage & budget",
    ]) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    }

    // The non-editor surface renders the coming-soon card, not mock content.
    expect(screen.getByText("Coming soon")).toBeVisible();
    expect(screen.getByText("Admin operations console")).toBeVisible();
    expect(screen.queryByText("Failed provisioning actions")).not.toBeInTheDocument();
  });
});
