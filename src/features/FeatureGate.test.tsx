import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FeatureGate } from "./FeatureGate";
import { useFeatureMockData } from "./FeatureMockContext";

function MockConsumer() {
  const mockData = useFeatureMockData();
  return (
    <span>
      {mockData && "suggestions" in mockData ? mockData.suggestions[0].fieldId : "no mock"}
    </span>
  );
}

describe("FeatureGate", () => {
  it("renders live feature children normally", () => {
    render(
      <FeatureGate id="onboarding-wizard">
        <button>Open request</button>
      </FeatureGate>,
    );

    expect(screen.getByRole("button", { name: "Open request" })).toBeEnabled();
    expect(screen.queryByText("Not yet implemented")).not.toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("replaces a coming-soon feature's children with an honest coming-soon card", () => {
    const { container } = render(
      <FeatureGate id="data-discovery">
        <div>Mock discovery content</div>
      </FeatureGate>,
    );

    expect(screen.getByText("Coming soon")).toBeVisible();
    expect(screen.getByText("Data discovery & catalog")).toBeVisible();
    expect(screen.queryByText("Mock discovery content")).not.toBeInTheDocument();
    expect(container.querySelector('[data-feature-gate="coming-soon"]')).toBeInTheDocument();
  });

  it("renders stub children with mock data, a ribbon, and inertness", () => {
    const { container } = render(
      <FeatureGate id="llm-challenger">
        <button>Accept suggestion</button>
        <MockConsumer />
      </FeatureGate>,
    );

    const inertRegion = container.querySelector('[data-feature-gate="stub"]');
    expect(screen.getByText("Not yet implemented")).toBeVisible();
    expect(screen.getByText("businessJustification")).toBeInTheDocument();
    expect(inertRegion).toHaveAttribute("inert");
    expect(inertRegion).toHaveAttribute("aria-disabled", "true");
    expect(inertRegion).toHaveStyle({ pointerEvents: "none" });
  });

  it("renders a stub notice without making its children inert", () => {
    const { container } = render(
      <FeatureGate id="access-request-persistence" presentation="notice">
        <span>Configured form fields</span>
      </FeatureGate>,
    );

    const notice = container.querySelector('aside[data-feature-gate="stub"]');
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent("STUB:");
    expect(notice).toHaveTextContent("Configured form fields");
    expect(notice).toHaveAttribute("data-feature-gate", "stub");
    expect(notice).not.toHaveAttribute("role");
    expect(notice).not.toHaveAttribute("inert");
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeInTheDocument();
    expect(screen.getByText("STUB:")).toHaveStyle({ color: "var(--text-default)" });
  });

  it("replaces planned children with a phase card", () => {
    render(
      <FeatureGate id="automated-provisioning">
        <div>Hidden implementation</div>
      </FeatureGate>,
    );

    expect(screen.getByText("Coming in Phase 3")).toBeVisible();
    expect(screen.queryByText("Hidden implementation")).not.toBeInTheDocument();
  });

  it("throws for an id missing from the governed registry", () => {
    expect(() =>
      render(
        <FeatureGate id={"unknown-capability" as never}>
          <div>Unreachable</div>
        </FeatureGate>,
      ),
    ).toThrow("Unknown feature id: unknown-capability");
  });
});
