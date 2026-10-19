import React from "react";
import { getData } from "./appDataBridge.js";
// Dataset / data product detail — the most important screen.
// Supports 3 layout variations (the user asked to explore dataset-detail layouts).
function DatasetScreen({ ctx, params }) {
  const D = getData();
  const { go } = ctx;
  const asset = D.ds(params.id);
  const [layout, setLayout] = React.useState("A");
  if (!asset) return <window.Page><window.Panel>Dataset not found.</window.Panel></window.Page>;

  const domain = D.dom(asset.domain);
  const system = D.sys(asset.system);
  const reqBundles = asset.requiredBundles.filter((b) => b.requirement === "required").map((b) => ({ ...b, bundle: D.bun(b.bundle) }));
  const altBundles = asset.requiredBundles.filter((b) => b.requirement !== "required").map((b) => ({ ...b, bundle: D.bun(b.bundle) }));
  const ownedIds = D.myAccess.bundles.filter((b) => b.status !== "expiring" || true).map((b) => b.bundle);
  const owned = (id) => D.myAccess.bundles.some((b) => b.bundle === id);

  const headerBand = (
    <div style={{ background: "var(--surface-default)", borderBottom: "1px solid var(--border-default)" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "24px 24px 26px" }}>
        <window.Trail items={[
          { label: "Home", go: () => go("home") },
          { label: domain.name, go: () => go("domain", { id: domain.id }) },
          { label: asset.businessName },
        ]} />
        <div style={{ display: "flex", alignItems: "flex-start", gap: 18 }}>
          <AssetGlyph type={asset.assetType} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 5 }}>
              <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: 0, lineHeight: 1.1 }}>{asset.businessName}</h1>
              {asset.assetType === "genie" ? <AITag>Genie Space</AITag> : asset.assetType === "dashboard" ? <AITag>AI/BI</AITag> : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <span style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}>{domain.name} · {system.name}</span>
              <MonoPath>{asset.name}</MonoPath>
            </div>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
              <ClassPill c={asset.classification} size="lg" />
              <CertBadge status={asset.certification} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}><AppIcon name="schedule" size={15} color="var(--text-muted)" /> {asset.freshness}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}><AppIcon name="trending" size={15} color="var(--text-muted)" /> {asset.popularity}% request rate</span>
            </div>
          </div>
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 9 }}>
            <button onClick={() => { requestAll(); go("cart"); }} style={primaryBtn}>
              <AppIcon name="cart" size={18} color="#fff" /> Request access
            </button>
            <button onClick={() => ctx.flash("Link copied to clipboard")} style={{ ...outlineBtn, padding: "8px 18px", border: "1px solid var(--border-strong)", color: "var(--color-gray-cool-70)" }}>
              <AppIcon name="copy" size={16} color="var(--color-gray-cool-70)" /> Copy link
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  function requestAll() {
    ctx.addDataset(asset);
    reqBundles.forEach((rb) => { if (!owned(rb.bundle.id)) ctx.addBundle(rb.bundle); });
  }

  // shared panels ----------------------------------------------------------
  const AccessPanel = <DatasetAccess asset={asset} reqBundles={reqBundles} altBundles={altBundles} owned={owned} ctx={ctx} go={go} requestAll={requestAll} />;
  const SummaryP = <DatasetSummary asset={asset} domain={domain} system={system} go={go} />;
  const TechP = <DatasetTech asset={asset} go={go} />;
  const UnlocksP = <DatasetUnlocks asset={asset} />;

  return (
    <div>
      {headerBand}
      <LayoutSwitcher layout={layout} setLayout={setLayout} />
      <window.Page bg="var(--color-gray-cool-2)">
        {layout === "A" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 400px", gap: 28, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              {SummaryP}{TechP}{UnlocksP}
            </div>
            <div style={{ position: "sticky", top: 130 }}>{AccessPanel}</div>
          </div>
        )}
        {layout === "B" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {AccessPanel}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22, alignItems: "start" }}>
              {SummaryP}{UnlocksP}
            </div>
            {TechP}
          </div>
        )}
        {layout === "C" && (
          <DatasetGuided asset={asset} SummaryP={SummaryP} AccessPanel={AccessPanel} TechP={TechP} UnlocksP={UnlocksP} />
        )}
      </window.Page>
    </div>
  );
}

function LayoutSwitcher({ layout, setLayout }) {
  const opts = [["A", "Sticky access rail"], ["B", "Access-first"], ["C", "Guided steps"]];
  return (
    <div style={{ background: "var(--color-blue-warm-80v)", color: "#fff" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "9px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <AppIcon name="tune" size={16} color="var(--color-blue-20v)" />
        <span style={{ fontSize: "var(--font-size-3xs)", color: "var(--color-blue-20v)", fontWeight: 600 }}>Layout exploration</span>
        <div style={{ display: "inline-flex", gap: 4, marginLeft: 4 }}>
          {opts.map(([v, l]) => (
            <button key={v} onClick={() => setLayout(v)} style={{
              border: "1px solid " + (layout === v ? "transparent" : "rgba(255,255,255,.25)"), borderRadius: "var(--radius-sm)", padding: "4px 11px", cursor: "pointer",
              background: layout === v ? "#fff" : "transparent", color: layout === v ? "var(--theme-primary)" : "#fff",
              fontFamily: "var(--font-sans)", fontSize: "var(--font-size-3xs)", fontWeight: 700,
            }}>{l}</button>
          ))}
        </div>
        <span style={{ marginLeft: "auto", fontSize: "var(--font-size-micro)", color: "var(--color-blue-20v)" }}>Same data, three arrangements — compare and pick a direction</span>
      </div>
    </div>
  );
}

// ---- THE STAR: access requirements --------------------------------------
function DatasetAccess({ asset, reqBundles, altBundles, owned, ctx, go, requestAll }) {
  const needed = reqBundles.filter((rb) => !owned(rb.bundle.id));
  const have = reqBundles.filter((rb) => owned(rb.bundle.id));
  const allHave = needed.length === 0;
  return (
    <window.Panel pad={0} style={{ overflow: "hidden", border: "1.5px solid var(--theme-primary)", boxShadow: "var(--shadow-2)" }}>
      <div style={{ background: "var(--theme-primary)", color: "#fff", padding: "14px 20px", display: "flex", alignItems: "center", gap: 9 }}>
        <AppIcon name="key" size={20} color="#fff" />
        <h2 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)", fontWeight: 700, margin: 0 }}>Access you need</h2>
      </div>
      <div style={{ padding: 20 }}>
        {/* status summary */}
        <div style={{ background: allHave ? "var(--theme-success-lighter)" : "var(--color-gray-cool-2)", border: `1px solid ${allHave ? "var(--theme-success-light)" : "var(--border-default)"}`, borderRadius: "var(--radius-md)", padding: 14, marginBottom: 18, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <AppIcon name={allHave ? "check_circle" : "info"} size={20} color={allHave ? "var(--theme-success-dark)" : "var(--theme-primary)"} style={{ marginTop: 1 }} />
          <div style={{ fontSize: "var(--font-size-2xs)", lineHeight: 1.5 }}>
            {allHave
              ? <span><strong>You already have everything you need.</strong> You can open this asset now.</span>
              : <span>This {asset.assetType === "table" ? "table" : asset.assetType === "view" ? "view" : asset.assetType} requires <strong>{reqBundles.length} access bundle{reqBundles.length > 1 ? "s" : ""}</strong>. You already have <strong>{have.length}</strong> — you still need <strong>{needed.length}</strong>.</span>}
          </div>
        </div>

        {/* required bundles */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {reqBundles.map((rb) => (
            <BundleReq key={rb.bundle.id} rb={rb} owned={owned(rb.bundle.id)} inCart={ctx.isInCart("bundle", rb.bundle.id)} onAdd={() => ctx.addBundle(rb.bundle)} onOpen={() => go("bundle", { id: rb.bundle.id })} />
          ))}
        </div>

        {/* alternative paths */}
        {altBundles.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed var(--border-strong)" }}>
            <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text-muted)", marginBottom: 10 }}>Alternative path</div>
            {altBundles.map((rb) => (
              <div key={rb.bundle.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                <AppIcon name="check" size={16} color="var(--theme-success-dark)" />
                <div style={{ flex: 1 }}>
                  <button onClick={() => go("bundle", { id: rb.bundle.id })} style={{ ...linkBtn, fontSize: "var(--font-size-2xs)" }}>{rb.bundle.name}</button>
                  <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{rb.note}</div>
                </div>
                <button onClick={() => ctx.addBundle(rb.bundle)} disabled={ctx.isInCart("bundle", rb.bundle.id)} style={ctx.isInCart("bundle", rb.bundle.id) ? addedBtn : addBtn}>
                  <AppIcon name={ctx.isInCart("bundle", rb.bundle.id) ? "check" : "add"} size={14} color={ctx.isInCart("bundle", rb.bundle.id) ? "var(--theme-success-darker)" : "var(--theme-primary)"} />{ctx.isInCart("bundle", rb.bundle.id) ? "Added" : "Add"}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* CTA */}
        <button onClick={() => { requestAll(); go("cart"); }} style={{ ...primaryBtn, width: "100%", justifyContent: "center", marginTop: 18, padding: "13px" }}>
          <AppIcon name="cart" size={18} color="#fff" /> {allHave ? "Re-request / extend access" : `Add required access to cart (${needed.length})`}
        </button>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", textAlign: "center", marginTop: 10, lineHeight: 1.4 }}>
          We pre-fill BEARS & SailPoint requests and skip anything you already hold.
        </div>
      </div>
    </window.Panel>
  );
}

function BundleReq({ rb, owned, inCart, onAdd, onOpen }) {
  const b = rb.bundle;
  const grouped = {};
  b.components.forEach((c) => { (grouped[c.type] = grouped[c.type] || []).push(c); });
  return (
    <div style={{ border: `1px solid ${owned ? "var(--theme-success-light)" : "var(--border-strong)"}`, borderRadius: "var(--radius-md)", padding: 14, background: owned ? "var(--theme-success-lighter)" : "var(--surface-default)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ marginTop: 1 }}>
          {owned ? <AppIcon name="check_circle" size={20} color="var(--theme-success-dark)" /> : <div style={{ width: 20, height: 20, borderRadius: "var(--radius-pill)", border: "2px solid var(--border-strong)" }} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button onClick={onOpen} style={{ ...linkBtn, fontSize: "var(--font-size-2xs)", color: "var(--text-default)" }}>{b.name}</button>
            {owned ? <Pill bg="var(--theme-success-light)" fg="var(--theme-success-darker)">You have this</Pill> : <Pill bg="var(--color-blue-5v)" fg="var(--theme-primary)" bd="var(--color-blue-20v)">Required</Pill>}
          </div>
          <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", margin: "3px 0 9px", lineHeight: 1.4 }}>{rb.note}</div>
          {/* grant chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.keys(grouped).map((t) => {
              const m = componentMeta(t);
              return <Pill key={t} icon={m.icon} bg="var(--color-gray-cool-2)" fg="var(--color-gray-cool-70)" bd="var(--border-default)">{grouped[t].length}× {m.label}</Pill>;
            })}
          </div>
        </div>
        {!owned && (
          <button onClick={onAdd} disabled={inCart} style={inCart ? addedBtn : addBtn}>
            <AppIcon name={inCart ? "check" : "add"} size={14} color={inCart ? "var(--theme-success-darker)" : "var(--theme-primary)"} />{inCart ? "Added" : "Add"}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- supporting panels ---------------------------------------------------
function DatasetSummary({ asset, domain, system, go }) {
  return (
    <window.Panel>
      <window.SectionHead title="About this data" />
      <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", lineHeight: 1.6, margin: "0 0 18px" }}>{asset.description}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 28px" }}>
        <Row k="Business domain" v={<button onClick={() => go("domain", { id: domain.id })} style={{ ...linkBtn, fontSize: "var(--font-size-2xs)" }}>{domain.name}</button>} />
        <Row k="Source system" v={system.short} />
        <Row k="Usage type" v={asset.usageType} />
        <Row k="Freshness" v={asset.freshness} />
        <Row k="Owner" v={asset.owner} />
        <Row k="Data steward" v={asset.steward} />
        <Row k="Classification" v={<ClassPill c={asset.classification} />} />
        <Row k="Certification" v={<CertBadge status={asset.certification} />} />
      </div>
    </window.Panel>
  );
}

function DatasetTech({ asset, go }) {
  const [tab, setTab] = React.useState("location");
  return (
    <window.Panel pad={0}>
      <div style={{ padding: "20px 24px 0" }}>
        <window.SectionHead title="Technical details" eyebrow="For builders" />
      </div>
      <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: "1px solid var(--border-default)" }}>
        {[["location", "Location"], ["lineage", "Lineage"], ["tags", "Tags"]].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ background: "none", border: "none", padding: "10px 14px", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: tab === v ? 700 : 500, color: tab === v ? "var(--theme-primary)" : "var(--color-gray-cool-60)", borderBottom: tab === v ? "3px solid var(--theme-primary)" : "3px solid transparent", marginBottom: -1 }}>{l}</button>
        ))}
      </div>
      <div style={{ padding: 24 }}>
        {tab === "location" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 16, fontFamily: "var(--font-mono)", fontSize: "var(--font-size-2xs)" }}>
              <AppIcon name="database" size={16} color="var(--color-gray-cool-50)" />
              <PathSeg label={asset.catalog} sub="catalog" />
              <AppIcon name="chevron_right" size={14} color="var(--color-gray-cool-40)" />
              <PathSeg label={asset.schema} sub="schema" />
              <AppIcon name="chevron_right" size={14} color="var(--color-gray-cool-40)" />
              <PathSeg label={asset.object} sub={asset.assetType} hi />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 28px" }}>
              <Row k="Metastore" v="irs_prod_metastore" />
              <Row k="Workspace" v={asset.workspace} />
              <Row k="Object type" v={asset.assetType} />
              <Row k="Governed by" v="Unity Catalog" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button style={{ ...outlineBtn, padding: "8px 14px", fontSize: "var(--font-size-3xs)" }}><AppIcon name="launch" size={15} color="var(--theme-primary)" /> Open in workspace</button>
              <button style={{ ...outlineBtn, padding: "8px 14px", fontSize: "var(--font-size-3xs)", border: "1px solid var(--border-strong)", color: "var(--color-gray-cool-70)" }}><AppIcon name="lineage" size={15} color="var(--color-gray-cool-70)" /> View in Catalog Explorer</button>
            </div>
            <div style={{ marginTop: 14, fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              <AppIcon name="lock" size={14} color="var(--text-muted)" /> Links resolve only after access is granted.
            </div>
          </div>
        )}
        {tab === "lineage" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {asset.lineage.map((node, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: i === asset.lineage.length - 1 ? "var(--theme-primary)" : "var(--color-gray-cool-3)", color: i === asset.lineage.length - 1 ? "#fff" : "var(--color-gray-cool-60)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <AppIcon name={i === 0 ? "database" : i === asset.lineage.length - 1 ? (ASSET_ICON[asset.assetType] || "table") : "folder"} size={16} color={i === asset.lineage.length - 1 ? "#fff" : "var(--color-gray-cool-60)"} />
                  </div>
                  {i < asset.lineage.length - 1 ? <div style={{ width: 2, height: 16, background: "var(--border-strong)" }} /> : null}
                </div>
                <div style={{ paddingBottom: i < asset.lineage.length - 1 ? 16 : 0 }}>
                  <MonoPath style={{ fontSize: "var(--font-size-3xs)" }}>{node}</MonoPath>
                  <div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)", marginTop: 3 }}>{i === 0 ? "Raw source" : i === asset.lineage.length - 1 ? "This asset (Gold)" : "Silver / cleansed"}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === "tags" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {asset.tags.map((t) => <Pill key={t} icon="tag" bg="var(--color-gray-cool-2)" fg="var(--color-gray-cool-70)" bd="var(--border-default)" size="lg">{t}</Pill>)}
          </div>
        )}
      </div>
    </window.Panel>
  );
}
function PathSeg({ label, sub, hi }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column" }}>
      <span style={{ fontWeight: 700, color: hi ? "var(--theme-primary)" : "var(--text-default)" }}>{label}</span>
    </span>
  );
}

function DatasetUnlocks({ asset }) {
  return (
    <window.Panel>
      <window.SectionHead title="What this unlocks" eyebrow="After approval" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {asset.unlocks.map((u) => (
          <div key={u} style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: "var(--theme-success-lighter)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <AppIcon name="check" size={17} color="var(--theme-success-dark)" />
            </div>
            <span style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)" }}>{u}</span>
          </div>
        ))}
      </div>
    </window.Panel>
  );
}

// Layout C — guided need → why → outcome
function DatasetGuided({ asset, SummaryP, AccessPanel, TechP, UnlocksP }) {
  const steps = [
    { n: "1", t: "What is this data?", body: <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>{SummaryP}{TechP}</div> },
    { n: "2", t: "What access do you need?", body: AccessPanel },
    { n: "3", t: "What you'll be able to do", body: UnlocksP },
  ];
  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      {steps.map((s, i) => (
        <div key={s.n} style={{ display: "flex", gap: 18, alignItems: "stretch" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 40, height: 40, borderRadius: "var(--radius-pill)", background: "var(--theme-primary)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontFamily: "var(--font-sans)", flexShrink: 0 }}>{s.n}</div>
            {i < steps.length - 1 ? <div style={{ width: 2, flex: 1, background: "var(--border-strong)", margin: "6px 0" }} /> : null}
          </div>
          <div style={{ flex: 1, paddingBottom: 28 }}>
            <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-lg)", fontWeight: 700, margin: "6px 0 14px" }}>{s.t}</h2>
            {s.body}
          </div>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { DatasetScreen });
