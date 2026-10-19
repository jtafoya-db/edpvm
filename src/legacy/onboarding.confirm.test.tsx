import "@testing-library/jest-dom/vitest";

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the heavy multi-step SchemaForm with a one-button stand-in that fires
// onSubmit with representative values, so we can exercise the submit -> confirm
// path without driving the whole wizard.
vi.mock("../components/SchemaForm", () => ({
  SchemaForm: ({ onSubmit }: { onSubmit: (values: Record<string, unknown>) => void }) => (
    <button
      onClick={() =>
        onSubmit({
          domain: "collections",
          dataName: "Preparer oversight signals",
          sourceSystem: "CDW",
          useCase: "Detect preparer fraud patterns.",
          annualBenefit: 750000,
          sizeGb: 200,
          users: 12,
          freq: "daily",
          complexity: "medium",
          pattern: "eftu",
          access: "sql",
          engModel: "self",
          outcome: "fraud",
          levers: [],
        })
      }
    >
      MOCK COMPLETE SUBMIT
    </button>
  ),
  edpWidgets: {},
  ArchDiagram: () => null,
  MiniStat: () => null,
}));

import { onboardingStore } from "../components/Onboarding/__tests__/store-wrapper";
import { setData } from "./appDataBridge.js";
import { OnboardingScreen } from "./onboarding.jsx";

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function setGlobal(name: string, value: unknown) {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
  (window as unknown as Record<string, unknown>)[name] = value;
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  setGlobal("AppIcon", () => null);
  setGlobal("Page", ({ children }: AnyProps) => <div>{children}</div>);
  setGlobal("Panel", ({ children }: AnyProps) => <div>{children}</div>);
  setGlobal("Trail", () => null);
  setGlobal("SectionHead", () => null);
  setGlobal("Pill", ({ children }: AnyProps) => <span>{children}</span>);
  setData({
    domains: [{ id: "collections", name: "Enforcement & Collections" }],
    dom: () => ({ name: "Enforcement & Collections" }),
  });
});

afterEach(cleanup);

describe("onboarding submit", () => {
  it("creates the onboarding request, then confirms inline with its id and stage", async () => {
    const go = vi.fn();
    const submitRequest = vi.fn();
    const submitOnboarding = vi
      .fn()
      .mockResolvedValue({ id: "ONB-1001", stage: "business-roi-review" });
    render(<OnboardingScreen ctx={{ go, submitRequest, flash: vi.fn() }} />, {
      wrapper: onboardingStore(submitOnboarding).Wrapper,
    });

    fireEvent.click(screen.getByText("MOCK COMPLETE SUBMIT"));

    // The onboarding request was created through the seam, and nothing else (#176):
    // no old-model request, whose client-made REQ number could collide.
    expect(await screen.findByText("Onboarding request submitted")).toBeVisible();
    expect(submitOnboarding).toHaveBeenCalledTimes(1);
    expect(submitRequest).not.toHaveBeenCalled();
    expect(screen.getByText("ONB-1001")).toBeVisible();
    expect(screen.getAllByText("Business & ROI review").length).toBeGreaterThan(0);
    // The store is in-memory, and the page says so.
    expect(screen.getByText(/Held in this browser session/)).toBeVisible();

    fireEvent.click(screen.getByText("View my onboarding requests"));
    expect(go).toHaveBeenCalledWith("onboarding-requests");
    expect(go).not.toHaveBeenCalledWith("status", expect.anything());
  });

  it("shows the store's error and records nothing when the submission is refused", async () => {
    const submitRequest = vi.fn();
    const submitOnboarding = vi
      .fn()
      .mockRejectedValue(new Error("Onboarding request is incomplete: Add at least one dataset."));
    render(<OnboardingScreen ctx={{ go: vi.fn(), submitRequest, flash: vi.fn() }} />, {
      wrapper: onboardingStore(submitOnboarding).Wrapper,
    });

    fireEvent.click(screen.getByText("MOCK COMPLETE SUBMIT"));

    // Nothing was saved: the form comes back, with the reason.
    expect(await screen.findByRole("alert")).toHaveTextContent(/Add at least one dataset/);
    expect(screen.getByText("MOCK COMPLETE SUBMIT")).toBeVisible();
    expect(submitRequest).not.toHaveBeenCalled();
  });
});
