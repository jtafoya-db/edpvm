import React from "react";
import { getData } from "./appDataBridge.js";
// Home / landing page.
//
// MVP landing: the only genuinely real, user-facing capability is the data
// onboarding wizard, so the home page exists to showcase and launch it. The
// former discovery surfaces (featured domains, starter bundles, recent
// requests and the "Ask Genie" search) ran entirely on the window.AppData mock
// seed and have been removed — a lean, honest landing is preferred over fake
// content.
function HomeScreen({ ctx }) {
  const D = getData();
  const { go } = ctx;
  const isAdmin = !!(D.user && D.user.isAdmin);

  const steps = [
    { icon: "database", t: "Describe the source", d: "Source system, sensitivity, domain, ingestion pattern and how it will be consumed." },
    { icon: "sparkle", t: "AI-assisted sizing", d: "Storage, DBUs, cluster and warehouse sizing plus monthly cost derived from your inputs." },
    { icon: "trending", t: "Business case & ROI", d: "Capture the mission value and expected benefit; ROI and payback are computed for you." },
    { icon: "check_circle", t: "Assemble the request", d: "The wizard assembles a complete intake request from your inputs so you can review exactly what it contains." },
  ];

  return (
    <div>
      {/* hero */}
      <div style={{ background: "linear-gradient(180deg, var(--surface-dark) 0%, #1b3a63 100%)", color: "#fff" }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "64px 24px 72px" }}>
          <div style={{ maxWidth: 720 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.18)", borderRadius: "var(--radius-pill)", padding: "5px 13px", fontSize: "var(--font-size-3xs)", fontWeight: 600, marginBottom: 22 }}>
              <AppIcon name="account_balance" size={15} color="#fff" /> A Databricks App for the IRS Enterprise Data Platform
            </div>
            <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-3xl)", fontWeight: 700, lineHeight: 1.1, margin: "0 0 16px", letterSpacing: "-.01em" }}>
              Onboard new data into the Enterprise Data Platform.
            </h1>
            <p style={{ fontSize: "var(--font-size-md)", lineHeight: 1.55, color: "var(--color-blue-20v)", margin: "0 0 28px", maxWidth: 620 }}>
              The onboarding wizard walks a data product owner through the source and the business
              case, computes AI-assisted capacity sizing and ROI locally, and assembles the
              complete intake request from those inputs.
            </p>
            <button
              onClick={() => go("onboarding")}
              style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "var(--theme-primary)", color: "#fff", border: "none", borderRadius: "var(--radius-md)", padding: "14px 24px", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)", fontWeight: 700, cursor: "pointer", boxShadow: "var(--shadow-3)" }}
            >
              <AppIcon name="database" size={19} color="#fff" /> Start the onboarding wizard
              <AppIcon name="arrow_forward" size={18} color="#fff" />
            </button>
          </div>
        </div>
      </div>

      {/* what the wizard does */}
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginTop: -40 }}>
          {steps.map((s, i) => (
            <Panel key={s.t} style={{ position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: "var(--radius-pill)", background: "var(--color-blue-5v)", color: "var(--theme-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)" }}>{i + 1}</div>
                <AppIcon name={s.icon} size={22} color="var(--theme-primary)" />
              </div>
              <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)", fontWeight: 700, margin: "0 0 5px" }}>{s.t}</h3>
              <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", margin: 0, lineHeight: 1.45 }}>{s.d}</p>
            </Panel>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 24px" }}>
        {/* primary CTA card */}
        <div style={{ margin: "48px 0" }}>
          <Panel pad={32} style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap", justifyContent: "space-between", background: "var(--color-blue-5v)", borderColor: "var(--color-blue-20v)" }}>
            <div style={{ maxWidth: 640 }}>
              <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-lg)", fontWeight: 700, margin: "0 0 8px" }}>Ready to onboard a dataset?</h2>
              <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", margin: 0, lineHeight: 1.5 }}>
                The wizard is the featured capability of this release. Discovery, access bundles,
                the request cart and stage tracking are on the roadmap and will appear here as
                they become real.
              </p>
            </div>
            <button
              onClick={() => go("onboarding")}
              style={{ display: "inline-flex", alignItems: "center", gap: 9, background: "var(--theme-primary)", color: "#fff", border: "none", borderRadius: "var(--radius-md)", padding: "13px 22px", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              <AppIcon name="database" size={17} color="#fff" /> Launch onboarding wizard
            </button>
          </Panel>
        </div>

        {/* admin entry — only real for admins */}
        {isAdmin && (
          <div style={{ marginBottom: 48 }}>
            <Panel hover onClick={() => go("admin")} style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: "var(--radius-md)", background: "var(--color-violet-10v)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <AppIcon name="tune" size={24} color="var(--color-violet-60v)" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)", fontWeight: 700, marginBottom: 2 }}>Admin · Intake form editor</div>
                <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}>Edit the onboarding intake schema and emit a PR-ready config diff.</div>
              </div>
              <AppIcon name="chevron_right" size={20} color="var(--text-muted)" />
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { HomeScreen });
