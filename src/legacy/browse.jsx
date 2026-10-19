import React from "react";
import { getData } from "./appDataBridge.js";
// Browse domains.
function BrowseScreen({ ctx }) {
  const D = getData();
  const { go } = ctx;
  const [sort, setSort] = React.useState("used");
  const [ftiFilter, setFtiFilter] = React.useState("all"); // all | fti | nonfti

  let domains = D.domains.slice();
  // compute fti presence per domain
  const hasFti = (dId) => D.datasets.some((a) => a.domain === dId && a.classification === "FTI");
  if (ftiFilter === "fti") domains = domains.filter((d) => hasFti(d.id));
  if (ftiFilter === "nonfti") domains = domains.filter((d) => !hasFti(d.id));

  const dsCount = (dId) => D.datasets.filter((a) => a.domain === dId).length;
  if (sort === "used") domains.sort((a, b) => dsCount(b.id) - dsCount(a.id));
  if (sort === "az") domains.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "code") domains.sort((a, b) => a.code.localeCompare(b.code));

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Browse domains" }]} />
      <div style={{ marginBottom: 8 }}>
        <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 8px" }}>Browse data domains</h1>
        <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: 0, maxWidth: 720, lineHeight: 1.55 }}>
          The IRS business-domain catalog — the periodic-table taxonomy mapped to Databricks assets. Pick a domain to see its systems, curated datasets, and recommended access bundles.
        </p>
      </div>

      {/* filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", margin: "24px 0 22px", paddingBottom: 18, borderBottom: "1px solid var(--border-default)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <AppIcon name="filter" size={17} color="var(--text-muted)" />
          <span style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, color: "var(--text-muted)" }}>Data class</span>
          <Segmented value={ftiFilter} onChange={setFtiFilter} options={[["all", "All"], ["fti", "FTI"], ["nonfti", "Non-FTI"]]} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, color: "var(--text-muted)" }}>Sort</span>
          <Segmented value={sort} onChange={setSort} options={[["used", "Most data"], ["az", "A–Z"], ["code", "By code"]]} />
        </div>
        <span style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}>{domains.length} domains</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, paddingBottom: 24 }}>
        {domains.map((d) => <DomainCard key={d.id} domain={d} onOpen={(id) => go("domain", { id })} />)}
      </div>
    </window.Page>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div style={{ display: "inline-flex", background: "var(--color-gray-cool-3)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", padding: 2 }}>
      {options.map(([v, l]) => {
        const active = v === value;
        return (
          <button key={v} onClick={() => onChange(v)} style={{
            border: "none", borderRadius: "var(--radius-sm)", padding: "6px 13px", cursor: "pointer",
            fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: active ? 700 : 500,
            background: active ? "var(--surface-default)" : "transparent",
            color: active ? "var(--theme-primary)" : "var(--color-gray-cool-60)",
            boxShadow: active ? "var(--shadow-1)" : "none",
          }}>{l}</button>
        );
      })}
    </div>
  );
}

Object.assign(window, { BrowseScreen, Segmented });
