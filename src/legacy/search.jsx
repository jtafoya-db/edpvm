import React from "react";
import { getData } from "./appDataBridge.js";
// Search results with a natural-language (Genie) interpretation accent.
function SearchScreen({ ctx, params }) {
  const D = getData();
  const { go } = ctx;
  const [query, setQuery] = React.useState(params.q || "");
  const [submitted, setSubmitted] = React.useState(params.q || "");
  const [fClass, setFClass] = React.useState("all");
  const [fType, setFType] = React.useState("all");
  const [fDomain, setFDomain] = React.useState("all");

  React.useEffect(() => { setQuery(params.q || ""); setSubmitted(params.q || ""); }, [params.q]);

  const q = submitted.toLowerCase();
  // simple NL interpretation
  const interp = interpret(q);

  // score datasets
  let results = D.datasets.map((a) => {
    const dom = D.dom(a.domain), sysn = D.sys(a.system);
    const hay = [a.businessName, a.name, a.description, a.tags.join(" "), dom.name, sysn.name, sysn.short].join(" ").toLowerCase();
    let score = 0;
    if (!q) score = a.popularity;
    else q.split(/\s+/).filter(Boolean).forEach((w) => { if (hay.includes(w)) score += 10; });
    if (a.businessName.toLowerCase().includes(q) && q) score += 20;
    if (a.certification === "Certified") score += 2;
    return { a, score };
  }).filter((r) => q ? r.score > 0 : true);

  // apply interpretation defaults + manual filters
  const effClass = fClass !== "all" ? fClass : interp.classFilter;
  results = results.filter((r) => {
    if (effClass && effClass !== "all" && r.a.classification !== effClass) return false;
    if (fType !== "all" && r.a.assetType !== fType) return false;
    if (fDomain !== "all" && r.a.domain !== fDomain) return false;
    return true;
  });
  results.sort((x, y) => y.score - x.score);

  const matchingBundles = q ? D.bundles.filter((b) => (b.name + " " + b.persona + " " + b.description).toLowerCase().includes(q)).slice(0, 3) : [];

  const submit = (e) => { e && e.preventDefault(); setSubmitted(query); go("search", { q: query }); };

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Search" }]} />
      {/* big search */}
      <form onSubmit={submit} style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center" }}>
          <AppIcon name="sparkle" size={20} color="var(--theme-info-dark)" style={{ position: "absolute", left: 14 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Describe the data you need…"
            style={{ width: "100%", border: "1.5px solid var(--border-strong)", borderRadius: "var(--radius-md)", padding: "13px 14px 13px 44px", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)", background: "var(--surface-default)" }} />
        </div>
        <button type="submit" style={{ ...primaryBtn, padding: "0 22px" }}><AppIcon name="search" size={18} color="#fff" /> Search</button>
      </form>

      {/* Genie interpretation */}
      {q && (
        <div style={{ background: "var(--color-cyan-5)", border: "1px solid var(--color-cyan-20)", borderRadius: "var(--radius-md)", padding: "14px 18px", marginBottom: 24, display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ width: 30, height: 30, borderRadius: "var(--radius-pill)", background: "var(--surface-default)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <AppIcon name="sparkle" size={17} color="var(--theme-info-dark)" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, color: "var(--theme-info-darker)", marginBottom: 3 }}>Genie understood your request</div>
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", lineHeight: 1.5 }}>{interp.summary} <span style={{ color: "var(--text-muted)" }}>Showing {results.length} matching asset{results.length !== 1 ? "s" : ""}.</span></div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "230px 1fr", gap: 28, alignItems: "start" }}>
        {/* filters */}
        <div style={{ position: "sticky", top: 130, display: "flex", flexDirection: "column", gap: 20 }}>
          <FilterGroup title="Data class" value={fClass} onChange={setFClass} options={[["all", "All"], ["FTI", "FTI"], ["PII", "PII"], ["Internal", "Internal"], ["Public", "Public"]]} />
          <FilterGroup title="Asset type" value={fType} onChange={setFType} options={[["all", "All"], ["table", "Tables"], ["view", "Views"], ["dashboard", "Dashboards"], ["genie", "Genie Spaces"]]} />
          <FilterGroup title="Domain" value={fDomain} onChange={setFDomain} options={[["all", "All domains"], ...D.domains.map((d) => [d.id, d.name])]} />
        </div>

        {/* results */}
        <div>
          {matchingBundles.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)", marginBottom: 10 }}>Matching access bundles</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {matchingBundles.map((b) => <BundleCard key={b.id} bundle={b} compact onOpen={(id) => go("bundle", { id })} onAdd={ctx.addBundle} inCart={ctx.isInCart("bundle", b.id)} />)}
              </div>
            </div>
          )}
          <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)", marginBottom: 10 }}>Data assets · {results.length}</div>
          {results.length === 0 ? (
            <window.Panel pad={40} style={{ textAlign: "center" }}>
              <AppIcon name="search" size={32} color="var(--color-gray-cool-30)" />
              <p style={{ color: "var(--text-muted)", marginTop: 10 }}>No assets match. Try a broader term or clear filters.</p>
            </window.Panel>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, paddingBottom: 24 }}>
              {results.map((r) => <DatasetCard key={r.a.id} asset={r.a} onOpen={(id) => go("dataset", { id })} onAdd={ctx.addDataset} inCart={ctx.isInCart("dataset", r.a.id)} />)}
            </div>
          )}
        </div>
      </div>
    </window.Page>
  );
}

function interpret(q) {
  if (!q) return { summary: "", classFilter: "all" };
  let classFilter = "all";
  const parts = [];
  if (/non-?fti|without fti|view|consume|dashboard|report/.test(q)) { parts.push("you're looking for lighter, consumer-friendly access"); }
  if (/\bfti\b/.test(q)) { classFilter = "FTI"; parts.push("filtered to Federal Tax Information (FTI) datasets"); }
  const domains = getData().domains.filter((d) => q.includes(d.name.toLowerCase().split(" ")[0]) || d.aliases.some((a) => q.includes(a.toLowerCase())));
  if (domains.length) parts.push(`focused on the ${domains.map((d) => d.name).join(", ")} domain`);
  const summary = parts.length ? `Interpreted as: ${parts.join("; ")}.` : `Matching on keywords across dataset names, descriptions, tags, domains, and systems.`;
  return { summary, classFilter };
}

function FilterGroup({ title, value, onChange, options }) {
  return (
    <div>
      <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--color-gray-cool-70)", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--border-default)" }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {options.map(([v, l]) => {
          const active = v === value;
          return (
            <button key={v} onClick={() => onChange(v)} style={{
              textAlign: "left", border: "none", background: active ? "var(--color-blue-5v)" : "transparent", color: active ? "var(--theme-primary)" : "var(--color-gray-cool-70)",
              borderRadius: "var(--radius-sm)", padding: "7px 10px", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: active ? 700 : 500,
            }}>{l}</button>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { SearchScreen });
