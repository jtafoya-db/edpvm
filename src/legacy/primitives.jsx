import React from "react";
import { getData } from "./appDataBridge.js";
import { ds } from "./ds.jsx";
// Shared UI primitives for the Access Broker app.
const Tag = ds("Tag", "span");

// ---------- metadata maps ----------
const CLASS_META = {
  FTI: { label: "FTI", bg: "var(--color-red-cool-10v)", fg: "var(--theme-secondary-darker)", bd: "var(--color-red-cool-30v)", icon: "lock", help: "Federal Tax Information — FTI authorization required" },
  PII: { label: "PII", bg: "var(--color-gold-5v)", fg: "var(--color-gold-70v)", bd: "var(--color-gold-20v)", icon: "lock", help: "Personally Identifiable Information" },
  Internal: { label: "Internal", bg: "var(--color-blue-5v)", fg: "var(--color-blue-warm-70v)", bd: "var(--color-blue-20v)", icon: "shield", help: "Internal use only" },
  Public: { label: "Public", bg: "var(--theme-success-lighter)", fg: "var(--theme-success-darker)", bd: "var(--theme-success-light)", icon: "public", help: "Publicly releasable" },
};
function classMeta(c) { return CLASS_META[c] || CLASS_META.Internal; }

const COMPONENT_META = {
  bears_role: { label: "BEARS role", icon: "key", color: "var(--theme-secondary-dark)" },
  sailpoint_group: { label: "SailPoint group", icon: "group", color: "var(--color-violet-60v)" },
  dbx_workspace: { label: "Workspace membership", icon: "workspace", color: "var(--theme-primary)" },
  dbx_entitlement: { label: "Workspace entitlement", icon: "tune", color: "var(--theme-primary)" },
  dbx_group: { label: "Databricks group", icon: "group", color: "var(--theme-primary)" },
  uc_grant: { label: "Unity Catalog grant", icon: "shield", color: "var(--theme-info-darker)" },
  external_system_access: { label: "External system", icon: "launch", color: "var(--color-gray-cool-60)" },
};
function componentMeta(t) { return COMPONENT_META[t] || COMPONENT_META.external_system_access; }

const STATUS_META = {
  "Completed": { color: "var(--theme-success-darker)", bg: "var(--theme-success-lighter)", icon: "check_circle" },
  "In progress": { color: "var(--color-blue-warm-70v)", bg: "var(--color-blue-5v)", icon: "schedule" },
  "Action needed": { color: "var(--theme-error-dark)", bg: "var(--theme-error-lighter)", icon: "warning" },
  "Draft": { color: "var(--color-gray-cool-60)", bg: "var(--color-gray-5)", icon: "description" },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.Draft; }

// ---------- small atoms ----------
function Pill({ icon, children, bg, fg, bd, size = "sm", style }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: bg || "var(--color-gray-5)", color: fg || "var(--text-default)",
      border: `1px solid ${bd || "transparent"}`, borderRadius: "var(--radius-pill)",
      padding: size === "sm" ? "2px 9px" : "4px 12px",
      fontSize: size === "sm" ? "var(--font-size-3xs)" : "var(--font-size-2xs)",
      fontWeight: 700, fontFamily: "var(--font-sans)", letterSpacing: ".01em", whiteSpace: "nowrap", ...style,
    }}>
      {icon ? <AppIcon name={icon} size={size === "sm" ? 13 : 15} color={fg} /> : null}
      {children}
    </span>
  );
}

function ClassPill({ c, size }) {
  const m = classMeta(c);
  return <Pill icon={m.icon} bg={m.bg} fg={m.fg} bd={m.bd} size={size} >{m.label}</Pill>;
}

function CertBadge({ status }) {
  const ok = status === "Certified";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--font-size-2xs)", fontWeight: 600, color: ok ? "var(--theme-success-darker)" : "var(--theme-warning-darker)", fontFamily: "var(--font-sans)" }}>
      <AppIcon name={ok ? "verified" : "schedule"} size={16} color={ok ? "var(--theme-success-dark)" : "var(--theme-warning-darker)"} />
      {status}
    </span>
  );
}

function AITag({ children = "AI" }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, background: "var(--color-cyan-5)",
      color: "var(--theme-info-darker)", border: "1px solid var(--color-cyan-20)", borderRadius: "var(--radius-pill)",
      padding: "2px 9px", fontSize: "var(--font-size-3xs)", fontWeight: 700, fontFamily: "var(--font-sans)", letterSpacing: ".02em",
    }}>
      <AppIcon name="sparkle" size={12} color="var(--theme-info-dark)" />{children}
    </span>
  );
}

// Domain accent color from token name
function domainColor(d) {
  const map = {
    primary: "var(--theme-primary)", "accent-cool": "var(--theme-accent-cool-darker)",
    "accent-warm": "var(--theme-accent-warm-dark)", success: "var(--theme-success-dark)",
    secondary: "var(--theme-secondary)",
  };
  return map[d && d.color] || "var(--theme-primary)";
}
function domainTint(d) {
  const map = {
    primary: "var(--color-blue-5v)", "accent-cool": "var(--color-cyan-5)",
    "accent-warm": "var(--color-orange-5v)", success: "var(--theme-success-lighter)",
    secondary: "var(--color-red-cool-10v)",
  };
  return map[d && d.color] || "var(--color-blue-5v)";
}

// Section header used across pages
function SectionHead({ eyebrow, title, action }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
      <div>
        {eyebrow ? <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--theme-primary)", marginBottom: 6 }}>{eyebrow}</div> : null}
        <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-lg)", fontWeight: 700, margin: 0, color: "var(--text-default)" }}>{title}</h2>
      </div>
      {action || null}
    </div>
  );
}

// A clean card shell
function Panel({ children, style, pad = 24, hover, onClick }) {
  const [h, setH] = React.useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: "var(--surface-default)", border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)", padding: pad,
        boxShadow: hover && h ? "var(--shadow-3)" : "var(--shadow-1)",
        transition: "box-shadow .15s ease, border-color .15s ease, transform .15s ease",
        borderColor: hover && h ? "var(--border-strong)" : "var(--border-default)",
        cursor: onClick ? "pointer" : "default", ...style,
      }}>
      {children}
    </div>
  );
}

// Asset type glyph in a tinted square
function AssetGlyph({ type, size = 40 }) {
  const tints = {
    table: ["var(--color-blue-5v)", "var(--theme-primary)"],
    view: ["var(--color-cyan-5)", "var(--theme-info-dark)"],
    dashboard: ["var(--color-orange-5v)", "var(--theme-accent-warm-dark)"],
    genie: ["var(--color-violet-10v)", "var(--color-violet-60v)"],
  };
  const [bg, fg] = tints[type] || tints.table;
  return (
    <div style={{ width: size, height: size, borderRadius: "var(--radius-md)", background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <AppIcon name={ASSET_ICON[type] || "table"} size={size * 0.5} color={fg} />
    </div>
  );
}

// Mono path chip
function MonoPath({ children, style }) {
  return <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--font-size-3xs)", background: "var(--color-gray-cool-2)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "1px 6px", color: "var(--color-gray-cool-70)", ...style }}>{children}</code>;
}

// ---------- cards reused across pages ----------
function DatasetCard({ asset, onOpen, onAdd, inCart }) {
  const D = getData();
  const domain = D.dom(asset.domain);
  const system = D.sys(asset.system);
  return (
    <Panel hover pad={0} style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div onClick={() => onOpen(asset.id)} style={{ padding: 20, cursor: "pointer", flex: 1 }}>
        <div style={{ display: "flex", gap: 14, marginBottom: 12 }}>
          <AssetGlyph type={asset.assetType} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-md)", fontWeight: 700, margin: 0, color: "var(--text-default)", lineHeight: 1.25 }}>{asset.businessName}</h3>
              {asset.assetType === "genie" || asset.assetType === "dashboard" ? <AITag>{asset.assetType === "genie" ? "Genie" : "AI/BI"}</AITag> : null}
            </div>
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", marginTop: 3 }}>
              {domain.name} · {system.short}
            </div>
          </div>
        </div>
        <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", margin: "0 0 14px", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{asset.description}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <ClassPill c={asset.classification} />
          <CertBadge status={asset.certification} />
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--border-default)", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-gray-cool-1)" }}>
        <button onClick={() => onOpen(asset.id)} style={linkBtn}>View details <AppIcon name="chevron_right" size={16} /></button>
        <button onClick={() => onAdd(asset)} disabled={inCart} style={inCart ? addedBtn : addBtn}>
          <AppIcon name={inCart ? "check" : "add"} size={15} color={inCart ? "var(--theme-success-darker)" : "var(--theme-primary)"} />
          {inCart ? "Added" : "Add"}
        </button>
      </div>
    </Panel>
  );
}

const linkBtn = { display: "inline-flex", alignItems: "center", gap: 2, background: "none", border: "none", padding: 0, color: "var(--link-default)", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, cursor: "pointer" };
const addBtn = { display: "inline-flex", alignItems: "center", gap: 5, background: "var(--color-blue-5v)", border: "1px solid var(--color-blue-20v)", borderRadius: "var(--radius-md)", padding: "5px 12px", color: "var(--theme-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, cursor: "pointer" };
const addedBtn = { ...addBtn, background: "var(--theme-success-lighter)", border: "1px solid var(--theme-success-light)", color: "var(--theme-success-darker)", cursor: "default" };

function BundleCard({ bundle, onOpen, onAdd, inCart, compact }) {
  return (
    <Panel hover pad={0} style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div onClick={() => onOpen(bundle.id)} style={{ padding: 20, cursor: "pointer", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: "var(--color-blue-5v)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <AppIcon name="key" size={20} color="var(--theme-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)", fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{bundle.name}</h3>
            <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2 }}>{bundle.persona}</div>
          </div>
        </div>
        {!compact ? <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", margin: "0 0 14px", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{bundle.description}</p> : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Pill icon="schedule" bg="var(--color-gray-5)" fg="var(--color-gray-cool-70)">{bundle.sla}</Pill>
          {bundle.bearsRequired ? <Pill icon="key" bg="var(--color-red-cool-10v)" fg="var(--theme-secondary-darker)" bd="var(--color-red-cool-30v)">BEARS</Pill> : <Pill icon="check" bg="var(--theme-success-lighter)" fg="var(--theme-success-darker)">No BEARS</Pill>}
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--border-default)", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--color-gray-cool-1)" }}>
        <button onClick={() => onOpen(bundle.id)} style={linkBtn}>What's inside <AppIcon name="chevron_right" size={16} /></button>
        <button onClick={() => onAdd(bundle)} disabled={inCart} style={inCart ? addedBtn : addBtn}>
          <AppIcon name={inCart ? "check" : "add"} size={15} color={inCart ? "var(--theme-success-darker)" : "var(--theme-primary)"} />
          {inCart ? "Added" : "Add"}
        </button>
      </div>
    </Panel>
  );
}

function DomainCard({ domain, onOpen }) {
  const D = getData();
  const dsCount = D.datasets.filter((a) => a.domain === domain.id).length;
  const bundleCount = new Set(D.datasets.filter((a) => a.domain === domain.id).flatMap((a) => a.requiredBundles.map((b) => b.bundle))).size;
  const accent = domainColor(domain), tint = domainTint(domain);
  return (
    <Panel hover onClick={() => onOpen(domain.id)} pad={0} style={{ overflow: "hidden" }}>
      <div style={{ height: 6, background: accent }} />
      <div style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", background: tint, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${accent}`, color: accent, fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "var(--font-size-2xs)" }}>
              {domain.code.split("-")[0]}
            </div>
            <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-md)", fontWeight: 700, margin: 0 }}>{domain.name}</h3>
          </div>
        </div>
        <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", margin: "0 0 16px", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 42 }}>{domain.description}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", borderTop: "1px solid var(--border-default)", paddingTop: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><AppIcon name="table" size={15} color="var(--text-muted)" /><strong style={{ color: "var(--text-default)" }}>{dsCount}</strong> datasets</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><AppIcon name="key" size={15} color="var(--text-muted)" /><strong style={{ color: "var(--text-default)" }}>{bundleCount}</strong> bundles</span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2, color: accent, fontWeight: 700 }}>Explore <AppIcon name="chevron_right" size={15} color={accent} /></span>
        </div>
      </div>
    </Panel>
  );
}

Object.assign(window, {
  Pill, ClassPill, CertBadge, AITag, SectionHead, Panel, AssetGlyph, MonoPath,
  DatasetCard, BundleCard, DomainCard, classMeta, componentMeta, statusMeta, domainColor, domainTint,
  linkBtn, addBtn, addedBtn,
});
