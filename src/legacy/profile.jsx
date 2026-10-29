import React from "react";
import { getData } from "./appDataBridge.js";
import { presentProfile } from "../features/profile/presenter";
// Profile page (issue #68).
//
// A reachable surface that shows the REAL server-resolved identity from
// /api/session (display name, username/email, stable principal id, admin status
// with how it was derived, and a clear dev-fallback marker), plus three
// scaffolded expansion slots rendered honestly as "not yet connected".
//
// The mapping from the sanitized UserProfile to what we render lives in the
// pure, unit-tested presenter (src/features/profile/presenter.ts) — the named
// test seam. This screen only lays out the resulting view model. Only the
// identity block is real data; every expansion section says it is not connected
// and NEVER shows fabricated perms/waiver/request state.

// One label/value row in the identity detail grid.
function DetailRow({ label, children, mono }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "12px 0",
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      <div
        style={{
          fontSize: "var(--font-size-3xs)",
          fontWeight: 700,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: mono ? "var(--font-size-3xs)" : "var(--font-size-2xs)",
          color: "var(--text-default)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          wordBreak: mono ? "break-all" : "normal",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// The identity-source marker: honest about real vs local-dev-fallback.
function SourceBadge({ identity }) {
  const real = !identity.isDevFallback;
  const bg = real ? "var(--theme-success-lighter)" : "var(--color-gold-5v)";
  const fg = real ? "var(--theme-success-darker)" : "var(--color-gold-70v)";
  const bd = real ? "var(--theme-success-light)" : "var(--color-gold-20v)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: bg,
        color: fg,
        border: `1px solid ${bd}`,
        borderRadius: "var(--radius-pill)",
        padding: "4px 12px",
        fontSize: "var(--font-size-3xs)",
        fontWeight: 700,
        fontFamily: "var(--font-sans)",
      }}
    >
      <AppIcon name={real ? "verified" : "info"} size={14} color={fg} />
      {identity.sourceLabel}
    </span>
  );
}

// A scaffolded expansion slot. Reuses the FeatureGate coming-soon visual
// pattern: a clearly-labelled card that says the section is not yet connected.
function NotConnectedCard({ section }) {
  return (
    <Panel
      style={{ borderTop: "4px solid var(--theme-primary)" }}
      data-profile-section={section.id}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h3
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "var(--font-size-md)",
            fontWeight: 700,
            margin: 0,
          }}
        >
          {section.label}
        </h3>
        <span
          role="status"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "var(--color-gray-cool-2)",
            color: "var(--color-gray-cool-70)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-pill)",
            padding: "4px 11px",
            fontSize: "var(--font-size-3xs)",
            fontWeight: 700,
            letterSpacing: ".03em",
            textTransform: "uppercase",
          }}
        >
          <AppIcon name="schedule" size={13} color="var(--color-gray-cool-70)" />
          {section.statusLabel}
        </span>
      </div>
      <p
        style={{
          margin: "10px 0 0",
          fontSize: "var(--font-size-2xs)",
          color: "var(--color-gray-cool-70)",
          lineHeight: 1.5,
        }}
      >
        {section.description}
      </p>
      <p
        style={{ margin: "10px 0 0", fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}
      >
        Not part of this slice — wires up with {section.wiredUpBy}.
      </p>
    </Panel>
  );
}

function ProfileScreen({ ctx }) {
  const D = getData();
  const go = ctx && ctx.go;
  const vm = presentProfile({ user: D.user });
  const { identity, admin, groups, hasGroups, sections } = vm;

  return (
    <window.Page>
      {go ? (
        <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Profile" }]} />
      ) : null}

      {/* Identity header */}
      <Panel pad={28} style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: "var(--radius-pill)",
              background: "var(--theme-primary)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--font-size-lg)",
              flexShrink: 0,
            }}
          >
            {D.user.initials || <AppIcon name="person" size={30} color="#fff" />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "var(--font-size-xl)",
                fontWeight: 700,
                margin: "0 0 4px",
              }}
            >
              {identity.displayName}
            </h1>
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}>
              {identity.email}
            </div>
          </div>
          <SourceBadge identity={identity} />
        </div>
        {identity.isDevFallback ? (
          <div
            style={{
              marginTop: 16,
              display: "flex",
              gap: 9,
              alignItems: "flex-start",
              background: "var(--color-gold-5v)",
              border: "1px solid var(--color-gold-20v)",
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
            }}
          >
            <AppIcon name="info" size={17} color="var(--color-gold-70v)" />
            <div
              style={{
                fontSize: "var(--font-size-2xs)",
                color: "var(--color-gold-70v)",
                lineHeight: 1.5,
              }}
            >
              {identity.sourceDetail}
            </div>
          </div>
        ) : null}
      </Panel>

      {/* Resolved identity detail — the only real data on this page */}
      <Panel pad={28} style={{ marginBottom: 20 }}>
        <SectionHead eyebrow="Resolved identity" title="Who you are signed in as" />
        <div>
          <DetailRow label="Display name">{identity.displayName}</DetailRow>
          <DetailRow label="Username / email">{identity.email}</DetailRow>
          <DetailRow label="Databricks account ID" mono>
            {identity.principalId}
          </DetailRow>
          <DetailRow label="Identity source">
            {identity.sourceLabel} — {identity.sourceDetail}
          </DetailRow>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 5,
              padding: "12px 0",
              borderBottom: hasGroups ? "1px solid var(--border-default)" : "none",
            }}
          >
            <div
              style={{
                fontSize: "var(--font-size-3xs)",
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
              }}
            >
              EDP staff role
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  background: admin.isAdmin
                    ? "var(--color-violet-10v)"
                    : "var(--color-gray-cool-2)",
                  color: admin.isAdmin ? "var(--color-violet-60v)" : "var(--color-gray-cool-70)",
                  border: `1px solid ${admin.isAdmin ? "var(--color-violet-60v)" : "var(--border-default)"}`,
                  borderRadius: "var(--radius-pill)",
                  padding: "3px 11px",
                  fontSize: "var(--font-size-3xs)",
                  fontWeight: 700,
                }}
              >
                <AppIcon
                  name={admin.isAdmin ? "shield" : "person"}
                  size={13}
                  color={admin.isAdmin ? "var(--color-violet-60v)" : "var(--color-gray-cool-70)"}
                />
                {admin.roleLabel}
              </span>
            </div>
            <div
              style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", marginTop: 2 }}
            >
              {admin.derivation}
            </div>
          </div>

          {/* Group memberships — shown ONLY if the session payload carries them */}
          {hasGroups ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" }}>
              <div
                style={{
                  fontSize: "var(--font-size-3xs)",
                  fontWeight: 700,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                }}
              >
                Group memberships (read-only)
              </div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {groups.map((g) => (
                  <span
                    key={g.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      background: "var(--color-blue-5v)",
                      color: "var(--theme-primary)",
                      border: "1px solid var(--color-blue-20v)",
                      borderRadius: "var(--radius-pill)",
                      padding: "3px 11px",
                      fontSize: "var(--font-size-3xs)",
                      fontWeight: 700,
                    }}
                  >
                    <AppIcon name="group" size={13} color="var(--theme-primary)" />
                    {g.label}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      {/* Expansion slots — honestly not connected */}
      <SectionHead eyebrow="Everything about you" title="Access, EIR & requests" action={null} />
      <p
        style={{
          margin: "-8px 0 18px",
          fontSize: "var(--font-size-2xs)",
          color: "var(--text-muted)",
          maxWidth: 640,
          lineHeight: 1.5,
        }}
      >
        These sections will show your real access, Employee Identity Record (EIR), and request stage
        once the persistence backbone lands. They are not connected yet, so nothing below is real
        data.
      </p>
      <div style={{ display: "grid", gap: 16, marginBottom: 40 }}>
        {sections.map((section) => (
          <NotConnectedCard key={section.id} section={section} />
        ))}
      </div>
    </window.Page>
  );
}

Object.assign(window, { ProfileScreen });
