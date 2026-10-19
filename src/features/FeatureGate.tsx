import type { ReactNode } from "react";

import { getMockData } from "@/mock";
import { FeatureMockContext } from "./FeatureMockContext";
import { FEATURES, type FeatureId } from "./registry";

interface FeatureGateProps {
  id: FeatureId;
  children?: ReactNode;
  presentation?: "surface" | "notice";
}

/** Unknown capability ids throw immediately so registry drift fails loudly. */
export function FeatureGate({ id, children, presentation = "surface" }: FeatureGateProps) {
  const feature = FEATURES[id];

  if (!feature) {
    throw new Error(`Unknown feature id: ${String(id)}`);
  }

  if (feature.status === "coming-soon") {
    return (
      <section
        aria-label={`${feature.label}: coming soon`}
        data-feature-gate="coming-soon"
        style={{
          maxWidth: 640,
          margin: "48px auto",
          border: "1px solid var(--border-default)",
          borderTop: "4px solid var(--theme-primary)",
          borderRadius: "var(--radius-lg)",
          background: "var(--surface-default)",
          padding: "32px 34px",
          boxShadow: "var(--shadow-1)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "inline-block",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-blue-5v)",
            color: "var(--theme-primary)",
            padding: "5px 13px",
            fontSize: "var(--font-size-3xs)",
            fontWeight: 700,
            letterSpacing: ".04em",
            textTransform: "uppercase",
          }}
        >
          Coming soon
        </div>
        <h2
          style={{
            margin: "16px 0 8px",
            fontFamily: "var(--font-heading)",
            fontWeight: 700,
            fontSize: "var(--font-size-xl)",
          }}
        >
          {feature.label}
        </h2>
        <p
          style={{
            margin: "0 auto 4px",
            maxWidth: 460,
            color: "var(--text-muted)",
            fontSize: "var(--font-size-2xs)",
            lineHeight: 1.55,
          }}
        >
          {feature.notes}
        </p>
        <p
          style={{
            margin: "12px 0 0",
            color: "var(--text-muted)",
            fontSize: "var(--font-size-3xs)",
          }}
        >
          This feature is not part of the current MVP. Onboarding new data into EDP is available
          today.
        </p>
      </section>
    );
  }

  if (feature.status === "planned") {
    return (
      <section
        aria-label={`${feature.label}: coming in Phase ${feature.phase}`}
        style={{
          border: "1px solid var(--border-default)",
          borderLeft: "4px solid var(--theme-primary)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface-default)",
          padding: "16px 18px",
          boxShadow: "var(--shadow-1)",
        }}
      >
        <div
          style={{
            color: "var(--theme-primary)",
            fontSize: "var(--font-size-3xs)",
            fontWeight: 700,
          }}
        >
          Coming in Phase {feature.phase}
        </div>
        <div style={{ marginTop: 4, fontFamily: "var(--font-heading)", fontWeight: 700 }}>
          {feature.label}
        </div>
        <p
          style={{
            margin: "6px 0 0",
            color: "var(--text-muted)",
            fontSize: "var(--font-size-2xs)",
          }}
        >
          {feature.notes}
        </p>
      </section>
    );
  }

  if (feature.status === "stub" && presentation === "notice") {
    return (
      <aside
        aria-label={`${feature.label} configuration notice`}
        data-feature-gate="stub"
        style={{
          border: "1px solid var(--theme-warning-light)",
          borderLeft: "4px solid var(--theme-warning)",
          borderRadius: "var(--radius-md)",
          background: "var(--theme-warning-lighter)",
          padding: "14px 18px",
          color: "var(--text-default)",
          fontSize: "var(--font-size-2xs)",
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: "var(--text-default)" }}>STUB:</strong> {feature.notes}
        {children}
      </aside>
    );
  }

  const mockData = getMockData(id);

  if (feature.status === "live") {
    return <FeatureMockContext.Provider value={mockData}>{children}</FeatureMockContext.Provider>;
  }

  return (
    <FeatureMockContext.Provider value={mockData}>
      <section
        style={{ position: "relative" }}
        aria-label={`${feature.label}: not yet implemented`}
      >
        <div
          role="status"
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            zIndex: 1,
            borderRadius: "var(--radius-pill)",
            background: "var(--color-gray-cool-80)",
            color: "white",
            padding: "5px 10px",
            fontSize: "var(--font-size-3xs)",
            fontWeight: 700,
          }}
        >
          Not yet implemented
        </div>
        <div
          aria-disabled="true"
          inert
          data-feature-gate="stub"
          style={{
            filter: "grayscale(1)",
            opacity: 0.58,
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          {children}
        </div>
      </section>
    </FeatureMockContext.Provider>
  );
}
