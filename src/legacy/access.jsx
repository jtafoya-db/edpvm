import React from "react";
import { getData } from "./appDataBridge.js";
// My Access — what the user already holds.
function AccessScreen({ ctx }) {
  const D = getData();
  const { go } = ctx;
  const ma = D.myAccess;
  const bundles = ma.bundles.map((b) => ({ ...b, def: D.bun(b.bundle) }));
  const expiring = bundles.filter((b) => b.status === "expiring");
  const recentAssets = ma.recentAssets.map(D.ds).filter(Boolean);
  // recommended: bundles user doesn't have that are popular
  const haveIds = bundles.map((b) => b.bundle);
  const recommended = D.bundles.filter((b) => !haveIds.includes(b.id)).slice(0, 3);

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "My Access" }]} />
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 22 }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 6px" }}>My access</h1>
          <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: 0 }}>Everything you currently hold across Databricks and Unity Catalog. Check here before requesting to avoid duplicates.</p>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{D.user.name}</div>
          <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{D.user.title}</div>
          <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{D.user.tenant}</div>
        </div>
      </div>

      {/* expiring banner */}
      {expiring.length > 0 && (
        <div style={{ background: "var(--theme-warning-lighter)", border: "1px solid var(--theme-warning-light)", borderLeft: "4px solid var(--theme-warning-dark)", borderRadius: "var(--radius-md)", padding: "14px 18px", marginBottom: 22, display: "flex", gap: 12, alignItems: "center" }}>
          <AppIcon name="schedule" size={22} color="var(--theme-warning-darker)" />
          <div style={{ flex: 1, fontSize: "var(--font-size-2xs)", lineHeight: 1.5 }}>
            <strong>{expiring[0].def.name}</strong> expires on <strong>{expiring[0].expires}</strong>. Renew now to avoid losing access to {D.dom(expiring[0].domain).name} dashboards.
          </div>
          <button onClick={() => { ctx.addBundle(expiring[0].def); go("cart"); }} style={{ ...primaryBtn, padding: "9px 16px", fontSize: "var(--font-size-3xs)" }}><AppIcon name="refresh" size={15} color="#fff" /> Renew</button>
        </div>
      )}

      {/* stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        <StatCard icon="workspace" n={ma.workspaces.length} l="Workspaces" />
        <StatCard icon="key" n={bundles.length} l="Active bundles" />
        <StatCard icon="folder" n={ma.domains.length} l="Data domains" />
        <StatCard icon="schedule" n={expiring.length} l="Expiring soon" warn={expiring.length > 0} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 28, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {/* bundles */}
          <div>
            <window.SectionHead title="Active access bundles" />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {bundles.map((b) => (
                <window.Panel key={b.bundle} hover onClick={() => go("bundle", { id: b.bundle })} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 42, height: 42, borderRadius: "var(--radius-md)", background: "var(--color-blue-5v)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><AppIcon name="key" size={22} color="var(--theme-primary)" /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{b.def.name}</div>
                    <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2 }}>Active since {b.since}{b.domain ? " · " + D.dom(b.domain).name : ""}</div>
                  </div>
                  {b.status === "expiring"
                    ? <Pill icon="schedule" bg="var(--theme-warning-lighter)" fg="var(--theme-warning-darker)" bd="var(--theme-warning-light)">Expires {b.expires}</Pill>
                    : <Pill icon="check_circle" bg="var(--theme-success-lighter)" fg="var(--theme-success-darker)">Active</Pill>}
                </window.Panel>
              ))}
            </div>
          </div>

          {/* recent assets */}
          <div>
            <window.SectionHead title="Recently activated assets" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
              {recentAssets.map((a) => (
                <window.Panel key={a.id} hover onClick={() => go("dataset", { id: a.id })} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <AssetGlyph type={a.assetType} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.businessName}</div>
                    <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{D.dom(a.domain).name}</div>
                  </div>
                  <AppIcon name="launch" size={17} color="var(--link-default)" />
                </window.Panel>
              ))}
            </div>
          </div>
        </div>

        {/* sidebar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 130 }}>
          <window.Panel pad={20}>
            <SideHead icon="workspace" title="Workspaces" />
            {ma.workspaces.map((w) => (
              <div key={w.name} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{w.name}</div>
                <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2 }}>{w.entitlement}</div>
                <div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)", marginTop: 2 }}>Since {w.since}</div>
              </div>
            ))}
          </window.Panel>
          <window.Panel pad={20}>
            <SideHead icon="star" title="Recommended for you" />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {recommended.map((b) => (
                <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <button onClick={() => go("bundle", { id: b.id })} style={{ ...linkBtn, fontSize: "var(--font-size-2xs)" }}>{b.name}</button>
                    <div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)" }}>{b.sla}</div>
                  </div>
                  <button onClick={() => ctx.addBundle(b)} disabled={ctx.isInCart("bundle", b.id)} style={ctx.isInCart("bundle", b.id) ? addedBtn : addBtn}><AppIcon name={ctx.isInCart("bundle", b.id) ? "check" : "add"} size={13} color={ctx.isInCart("bundle", b.id) ? "var(--theme-success-darker)" : "var(--theme-primary)"} />{ctx.isInCart("bundle", b.id) ? "" : "Add"}</button>
                </div>
              ))}
            </div>
          </window.Panel>
        </div>
      </div>
    </window.Page>
  );
}

function StatCard({ icon, n, l, warn }) {
  return (
    <window.Panel style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 44, height: 44, borderRadius: "var(--radius-md)", background: warn ? "var(--theme-warning-lighter)" : "var(--color-blue-5v)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <AppIcon name={icon} size={24} color={warn ? "var(--theme-warning-darker)" : "var(--theme-primary)"} />
      </div>
      <div>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-xl)", fontWeight: 700, lineHeight: 1 }}>{n}</div>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 3 }}>{l}</div>
      </div>
    </window.Panel>
  );
}

Object.assign(window, { AccessScreen, StatCard });
