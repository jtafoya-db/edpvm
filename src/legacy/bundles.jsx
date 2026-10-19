import React from "react";
import { getData } from "./appDataBridge.js";
// Access bundles catalog.
function BundlesScreen({ ctx }) {
  const D = getData();
  const { go } = ctx;
  const [persona, setPersona] = React.useState("all");
  const personas = ["all", ...new Set(D.bundles.map((b) => b.persona))];
  const bundles = persona === "all" ? D.bundles : D.bundles.filter((b) => b.persona === persona);

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Access bundles" }]} />
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 8px" }}>Access bundles</h1>
        <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: 0, maxWidth: 760, lineHeight: 1.55 }}>
          Reusable, persona-based access patterns. Each bundle resolves into the right BEARS roles, SailPoint groups, workspace memberships, and Unity Catalog grants — so you request a product, not a pile of individual entitlements.
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 22, paddingBottom: 18, borderBottom: "1px solid var(--border-default)" }}>
        <AppIcon name="person" size={17} color="var(--text-muted)" />
        <span style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, color: "var(--text-muted)", marginRight: 4 }}>Persona</span>
        {personas.map((p) => {
          const active = p === persona;
          return (
            <button key={p} onClick={() => setPersona(p)} style={{
              border: `1px solid ${active ? "var(--theme-primary)" : "var(--border-strong)"}`, borderRadius: "var(--radius-pill)", padding: "6px 14px", cursor: "pointer",
              background: active ? "var(--color-blue-5v)" : "var(--surface-default)", color: active ? "var(--theme-primary)" : "var(--color-gray-cool-70)",
              fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: active ? 700 : 500,
            }}>{p === "all" ? "All personas" : p}</button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, paddingBottom: 24 }}>
        {bundles.map((b) => <BundleCard key={b.id} bundle={b} onOpen={(id) => go("bundle", { id })} onAdd={ctx.addBundle} inCart={ctx.isInCart("bundle", b.id)} />)}
      </div>
    </window.Page>
  );
}

Object.assign(window, { BundlesScreen });
