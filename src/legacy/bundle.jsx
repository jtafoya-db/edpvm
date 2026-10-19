import React from "react";
import { getData } from "./appDataBridge.js";
// Access bundle detail.
function BundleScreen({ ctx, params }) {
  const D = getData();
  const { go } = ctx;
  const b = D.bun(params.id);
  if (!b) return <window.Page><window.Panel>Bundle not found.</window.Panel></window.Page>;
  const inCart = ctx.isInCart("bundle", b.id);
  const owned = D.myAccess.bundles.some((x) => x.bundle === b.id);
  const prereqs = (b.prerequisites || []).map(D.bun);
  // datasets unlocked by this bundle
  const datasets = D.datasets.filter((a) => a.requiredBundles.some((rb) => rb.bundle === b.id));

  return (
    <div>
      <div style={{ background: "var(--surface-default)", borderBottom: "1px solid var(--border-default)" }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "24px 24px 26px" }}>
          <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Access bundles", go: () => go("bundles") }, { label: b.name }]} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 18 }}>
            <div style={{ width: 56, height: 56, borderRadius: "var(--radius-lg)", background: "var(--color-blue-5v)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <AppIcon name="key" size={28} color="var(--theme-primary)" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--theme-primary)", marginBottom: 4 }}>Access bundle · {b.persona}</div>
              <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 10px" }}>{b.name}</h1>
              <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: 0, maxWidth: 720, lineHeight: 1.55 }}>{b.description}</p>
            </div>
            <div style={{ flexShrink: 0 }}>
              {owned ? <Pill icon="check_circle" bg="var(--theme-success-lighter)" fg="var(--theme-success-darker)" bd="var(--theme-success-light)" size="lg">You have this bundle</Pill>
                : <button onClick={() => { ctx.addBundle(b); go("cart"); }} style={primaryBtn}><AppIcon name="cart" size={18} color="#fff" /> Request this bundle</button>}
            </div>
          </div>
        </div>
      </div>

      <window.Page>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 28, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            {/* what's inside */}
            <window.Panel>
              <window.SectionHead title="What's inside this bundle" eyebrow="Included permissions" />
              <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", margin: "-8px 0 18px", lineHeight: 1.5 }}>Requesting this bundle provisions all of the following automatically after approval. Nothing here is requested by hand.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {b.components.map((c, i) => {
                  const m = componentMeta(c.type);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)", background: "var(--color-gray-cool-1)" }}>
                      <div style={{ width: 34, height: 34, borderRadius: "var(--radius-sm)", background: "var(--surface-default)", border: "1px solid var(--border-default)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <AppIcon name={m.icon} size={18} color={m.color} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 600 }}>{c.label}</div>
                        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{c.scope}</div>
                      </div>
                      <Pill bg="var(--surface-default)" fg="var(--color-gray-cool-60)" bd="var(--border-default)">{m.label}</Pill>
                    </div>
                  );
                })}
              </div>
            </window.Panel>

            {/* unlocks */}
            <window.Panel>
              <window.SectionHead title="What this lets you do" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {b.unlocks.map((u) => (
                  <div key={u} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <AppIcon name="check" size={17} color="var(--theme-success-dark)" />
                    <span style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)" }}>{u}</span>
                  </div>
                ))}
              </div>
            </window.Panel>

            {/* datasets it unlocks */}
            {datasets.length > 0 && (
              <window.Panel>
                <window.SectionHead title="Datasets this bundle helps unlock" eyebrow={`${datasets.length} assets`} />
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {datasets.map((a) => (
                    <div key={a.id} onClick={() => go("dataset", { id: a.id })} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: "var(--radius-md)", cursor: "pointer", border: "1px solid var(--border-default)" }}>
                      <AssetGlyph type={a.assetType} size={32} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 600 }}>{a.businessName}</div>
                        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{D.dom(a.domain).name}</div>
                      </div>
                      <ClassPill c={a.classification} />
                      <AppIcon name="chevron_right" size={18} color="var(--text-muted)" />
                    </div>
                  ))}
                </div>
              </window.Panel>
            )}
          </div>

          {/* sidebar: approval facts */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 130 }}>
            <window.Panel pad={20}>
              <SideHead icon="schedule" title="Approval & turnaround" />
              <Row k="Est. turnaround" v={b.sla} />
              <Row k="BEARS required" v={b.bearsRequired ? "Yes" : "No"} />
              <Row k="Persona" v={b.persona} />
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text-muted)", marginBottom: 8 }}>Approval chain</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {b.approvers.map((a, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <div style={{ width: 22, height: 22, borderRadius: "var(--radius-pill)", background: "var(--color-gray-cool-3)", color: "var(--color-gray-cool-60)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>{i + 1}</div>
                        {i < b.approvers.length - 1 ? <div style={{ width: 2, height: 14, background: "var(--border-strong)" }} /> : null}
                      </div>
                      <span style={{ fontSize: "var(--font-size-2xs)", paddingBottom: i < b.approvers.length - 1 ? 14 : 0 }}>{a}</span>
                    </div>
                  ))}
                </div>
              </div>
            </window.Panel>

            {prereqs.length > 0 && (
              <window.Panel pad={20}>
                <SideHead icon="info" title="Prerequisites" />
                {prereqs.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                    <AppIcon name="key" size={15} color="var(--theme-primary)" />
                    <button onClick={() => go("bundle", { id: p.id })} style={{ ...linkBtn, fontSize: "var(--font-size-2xs)" }}>{p.name}</button>
                  </div>
                ))}
                <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 8, lineHeight: 1.4 }}>We'll add any missing prerequisites to your cart automatically.</div>
              </window.Panel>
            )}

            {!owned && (
              <button onClick={() => { ctx.addBundle(b); go("cart"); }} style={{ ...primaryBtn, width: "100%", justifyContent: "center", padding: 13 }}>
                <AppIcon name={inCart ? "check" : "cart"} size={18} color="#fff" /> {inCart ? "In your cart — review" : "Request this bundle"}
              </button>
            )}
          </div>
        </div>
      </window.Page>
    </div>
  );
}

Object.assign(window, { BundleScreen });
