import React from "react";
import { getData } from "./appDataBridge.js";
// Domain detail.
function DomainScreen({ ctx, params }) {
  const D = getData();
  const { go } = ctx;
  const domain = D.dom(params.id);
  if (!domain) return <window.Page><window.Panel>Domain not found.</window.Panel></window.Page>;
  const accent = domainColor(domain), tint = domainTint(domain);
  const datasets = D.datasets.filter((a) => a.domain === domain.id);
  const systems = domain.systems.map(D.sys);
  const bundleIds = [...new Set(datasets.flatMap((a) => a.requiredBundles.map((b) => b.bundle)))];
  const bundles = bundleIds.map(D.bun);
  const ftiCount = datasets.filter((a) => a.classification === "FTI").length;
  const recommended = bundles.find((b) => b.id === "analyst-starter") || bundles[0];

  return (
    <div>
      {/* header band */}
      <div style={{ background: tint, borderBottom: `1px solid var(--border-default)` }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "26px 24px 30px" }}>
          <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Browse domains", go: () => go("browse") }, { label: domain.name }]} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 18 }}>
            <div style={{ width: 60, height: 60, borderRadius: "var(--radius-lg)", background: "#fff", border: `2px solid ${accent}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: accent, flexShrink: 0 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "var(--font-size-lg)", lineHeight: 1 }}>{domain.code.split("-")[0]}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: 0 }}>{domain.name}</h1>
                <MonoPath style={{ background: "#fff" }}>{domain.code}</MonoPath>
              </div>
              <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: "0 0 12px", maxWidth: 720, lineHeight: 1.55 }}>{domain.description}</p>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {domain.aliases.map((a) => <Pill key={a} bg="#fff" fg="var(--color-gray-cool-70)" bd="var(--border-default)">{a}</Pill>)}
              </div>
            </div>
            <div style={{ flexShrink: 0 }}>
              <button onClick={() => { ctx.addBundle(recommended); go("cart"); }} style={primaryBtn}>
                <AppIcon name="cart" size={18} color="#fff" /> Request starter pack
              </button>
            </div>
          </div>
          {/* stat strip */}
          <div style={{ display: "flex", gap: 28, marginTop: 22, paddingTop: 18, borderTop: "1px solid rgba(0,0,0,.08)" }}>
            <Stat n={datasets.length} l="Curated datasets" icon="table" />
            <Stat n={systems.length} l="Source systems" icon="database" />
            <Stat n={bundles.length} l="Access bundles" icon="key" />
            <Stat n={ftiCount} l="FTI datasets" icon="lock" />
          </div>
        </div>
      </div>

      <window.Page bg="var(--color-gray-cool-2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 28, alignItems: "start" }}>
          {/* main */}
          <div>
            <window.SectionHead title="Curated datasets" eyebrow={`${datasets.length} in this domain`} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 40 }}>
              {datasets.map((a) => <DatasetCard key={a.id} asset={a} onOpen={(id) => go("dataset", { id })} onAdd={ctx.addDataset} inCart={ctx.isInCart("dataset", a.id)} />)}
            </div>

            <window.SectionHead title="Recommended access bundles" eyebrow="Reusable access patterns" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
              {bundles.map((b) => <BundleCard key={b.id} bundle={b} onOpen={(id) => go("bundle", { id })} onAdd={ctx.addBundle} inCart={ctx.isInCart("bundle", b.id)} />)}
            </div>
          </div>

          {/* sidebar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 130 }}>
            <window.Panel pad={20}>
              <SideHead icon="person" title="Ownership" />
              <Row k="Domain owner" v={domain.owner} />
              <Row k="Data steward" v={domain.steward} />
              <Row k="Default class" v={ftiCount > 0 ? "Mixed (incl. FTI)" : "Internal"} />
            </window.Panel>
            <window.Panel pad={20}>
              <SideHead icon="database" title="Source systems" />
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {systems.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "var(--radius-sm)", background: "var(--color-gray-cool-3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <AppIcon name="database" size={17} color="var(--color-gray-cool-60)" />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{s.short}</div>
                      <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.type}</div>
                    </div>
                  </div>
                ))}
              </div>
            </window.Panel>
            <window.Panel pad={20}>
              <SideHead icon="star" title="Common use cases" />
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
                {domain.useCases.map((u) => <li key={u} style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", lineHeight: 1.4 }}>{u}</li>)}
              </ul>
            </window.Panel>
          </div>
        </div>
      </window.Page>
    </div>
  );
}

function Stat({ n, l, icon }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <AppIcon name={icon} size={20} color="var(--color-gray-cool-60)" />
      <div>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-lg)", fontWeight: 700, lineHeight: 1 }}>{n}</div>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2 }}>{l}</div>
      </div>
    </div>
  );
}
function SideHead({ icon, title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid var(--border-default)" }}>
      <AppIcon name={icon} size={17} color="var(--theme-primary)" />
      <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0, letterSpacing: ".02em", textTransform: "uppercase", color: "var(--color-gray-cool-70)" }}>{title}</h3>
    </div>
  );
}
function Row({ k, v }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", fontSize: "var(--font-size-2xs)" }}>
      <span style={{ color: "var(--text-muted)" }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: "right" }}>{v}</span>
    </div>
  );
}

const primaryBtn = { display: "inline-flex", alignItems: "center", gap: 8, background: "var(--theme-primary)", color: "#fff", border: "none", borderRadius: "var(--radius-md)", padding: "11px 18px", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
const outlineBtn = { display: "inline-flex", alignItems: "center", gap: 8, background: "var(--surface-default)", color: "var(--theme-primary)", border: "1.5px solid var(--theme-primary)", borderRadius: "var(--radius-md)", padding: "10px 18px", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };

Object.assign(window, { DomainScreen, Stat, SideHead, Row, primaryBtn, outlineBtn });
