// Presentational atoms shared by the EDP widgets (docs/build-plan-p1.md §2).
// Kept in their own module so the widget registry file exports only the
// registry (Fast Refresh boundaries stay clean). MiniStat and ArchDiagram are
// also re-registered on window by the onboarding entrypoint for parity with the
// globals the original screen exposed.

import React from "react";
import type { PatternOption } from "../../schema";
import type { IconComponent } from "./SchemaForm";

export function MiniStat({ n, l }: { n: React.ReactNode; l: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: "var(--font-size-sm)", fontWeight: 700 }}>{n}</div>
      <div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)", marginTop: 2 }}>
        {l}
      </div>
    </div>
  );
}

function ArchBox({
  label,
  caption,
  tone = "neutral",
}: {
  label: string;
  caption?: string;
  tone?: "neutral" | "primary" | "warn";
}) {
  const tones = {
    neutral: {
      bg: "var(--surface-default)",
      border: "var(--border-strong)",
      fg: "var(--text-default)",
    },
    primary: {
      bg: "var(--color-blue-5v)",
      border: "var(--theme-primary)",
      fg: "var(--theme-primary)",
    },
    warn: {
      bg: "var(--color-orange-5v)",
      border: "var(--theme-accent-warm-dark)",
      fg: "var(--theme-accent-warm-darker)",
    },
  } as const;
  const t = tones[tone];
  return (
    <div
      style={{
        flex: "1 1 130px",
        minWidth: 120,
        background: t.bg,
        border: `2px solid ${t.border}`,
        borderRadius: "var(--radius-md)",
        padding: "12px 12px",
        textAlign: "center",
      }}
    >
      <div
        style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, color: t.fg, lineHeight: 1.35 }}
      >
        {label}
      </div>
      {caption ? (
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 4 }}>
          {caption}
        </div>
      ) : null}
    </div>
  );
}

export function ArchDiagram({
  source,
  ingest,
  domainName,
  access,
  Icon,
}: {
  source: string;
  ingest: PatternOption;
  domainName: string;
  access: PatternOption;
  Icon: IconComponent;
}) {
  const Arrow = () => (
    <div
      style={{
        flex: "0 0 auto",
        color: "var(--color-gray-cool-50)",
        display: "flex",
        alignItems: "center",
      }}
    >
      <Icon name="arrow_forward" size={20} color="var(--color-gray-cool-50)" />
    </div>
  );
  return (
    <div
      style={{
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-gray-cool-1)",
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "stretch", gap: 10, flexWrap: "wrap" }}>
        <ArchBox label={source} caption="Source system" />
        <Arrow />
        <ArchBox
          label={ingest.box}
          caption="Ingestion pattern"
          tone={ingest.approved ? "primary" : "warn"}
        />
        <Arrow />
        <ArchBox
          label={`EDP — ${domainName}`}
          caption="Unity Catalog · bronze/silver/gold"
          tone="primary"
        />
        <Arrow />
        <ArchBox
          label={access.box}
          caption="Consumption"
          tone={access.approved ? "primary" : "warn"}
        />
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: "var(--font-size-3xs)",
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        Governance and entitlements are enforced in Unity Catalog; access is granted through BEARS
        after intake approval.
      </div>
    </div>
  );
}

export function RevRow({
  icon,
  title,
  sub,
  Icon,
}: {
  icon: string;
  title: React.ReactNode;
  sub: React.ReactNode;
  Icon: IconComponent;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 16px",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-gray-cool-1)",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: "var(--radius-md)",
          background: "var(--color-blue-5v)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={22} color="var(--theme-primary)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{sub}</div>
      </div>
    </div>
  );
}
