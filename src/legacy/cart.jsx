import React from "react";
import { getData } from "./appDataBridge.js";
// Request cart / builder — checkout-style with de-dup + prerequisite resolution.
function CartScreen({ ctx }) {
  const D = getData();
  const { go, cart } = ctx;
  const [justification, setJustification] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [env, setEnv] = React.useState("Analytics Prod");
  const [err, setErr] = React.useState(false);

  const selDatasets = cart.filter((c) => c.kind === "dataset").map((c) => D.ds(c.id)).filter(Boolean);
  const selBundles = cart.filter((c) => c.kind === "bundle").map((c) => D.bun(c.id)).filter(Boolean);

  // resolve full bundle set: explicit + required-by-dataset + prerequisites
  const resolved = resolveBundles(selDatasets, selBundles);
  const owned = (id) => D.myAccess.bundles.some((b) => b.bundle === id);
  const toRequest = resolved.filter((b) => !owned(b.id));
  const skipped = resolved.filter((b) => owned(b.id));
  const needsBears = toRequest.some((b) => b.bearsRequired);

  // resolved entitlements (deduped components across toRequest)
  const entMap = {};
  toRequest.forEach((b) => b.components.forEach((c) => { entMap[c.type + "|" + c.scope] = c; }));
  const ents = Object.values(entMap);
  const entByType = {};
  ents.forEach((c) => { (entByType[c.type] = entByType[c.type] || []).push(c); });

  // over-request hint: if user selected a heavy bundle but a lighter alternative covers a dataset
  const overReq = detectOverRequest(selDatasets, toRequest);

  const empty = cart.length === 0;

  const submit = () => {
    if (!justification.trim()) { setErr(true); return; }
    const num = 2060 + Math.floor(Math.random() * 39);
    const title = toRequest.length === 1 ? toRequest[0].name : `${toRequest.length}-bundle access request`;
    const subRequests = buildSubRequests(toRequest, needsBears);
    const req = {
      id: "REQ-" + num, title, submittedAt: "Jun 5, 2026", status: "In progress", overall: "Submitted — pending domain owner review",
      purpose: purpose || justification,
      items: [
        ...selDatasets.map((a) => ({ ref: "asset", id: a.id, kind: "Dataset" })),
        ...toRequest.map((b) => ({ bundle: b.id, kind: "Bundle" })),
      ],
      subRequests, stageIndex: 1,
    };
    ctx.submitRequest(req);
    ctx.flash("Request submitted — tracking started");
    go("status", { id: req.id });
  };

  if (empty) {
    return (
      <window.Page>
        <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Request cart" }]} />
        <window.Panel pad={56} style={{ textAlign: "center", maxWidth: 560, margin: "20px auto" }}>
          <div style={{ width: 64, height: 64, borderRadius: "var(--radius-pill)", background: "var(--color-gray-cool-3)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
            <AppIcon name="cart" size={32} color="var(--color-gray-cool-40)" />
          </div>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-lg)", margin: "0 0 8px" }}>Your request cart is empty</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "var(--font-size-2xs)", margin: "0 0 22px", lineHeight: 1.5 }}>Find a dataset or a bundle and add the access you need. We'll resolve the exact entitlements here.</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button onClick={() => go("browse")} style={primaryBtn}><AppIcon name="folder" size={17} color="#fff" /> Browse domains</button>
            <button onClick={() => go("bundles")} style={outlineBtn}><AppIcon name="key" size={17} color="var(--theme-primary)" /> View bundles</button>
          </div>
        </window.Panel>
      </window.Page>
    );
  }

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Request cart" }]} />
      <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 6px" }}>Review your access request</h1>
      <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: "0 0 26px" }}>We de-duplicate overlapping bundles, pull in prerequisites, and skip anything you already hold.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", gap: 28, alignItems: "start" }}>
        {/* LEFT: what you selected */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <window.Panel>
            <window.SectionHead title="What you selected" eyebrow={`${cart.length} item${cart.length !== 1 ? "s" : ""}`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {selDatasets.map((a) => (
                <SelRow key={a.id} icon={<AssetGlyph type={a.assetType} size={36} />} title={a.businessName} sub={`${D.dom(a.domain).name} · dataset`} onRemove={() => ctx.removeItem("dataset", a.id)} onOpen={() => go("dataset", { id: a.id })} />
              ))}
              {selBundles.map((b) => (
                <SelRow key={b.id} icon={<div style={{ width: 36, height: 36, borderRadius: "var(--radius-md)", background: "var(--color-blue-5v)", display: "flex", alignItems: "center", justifyContent: "center" }}><AppIcon name="key" size={20} color="var(--theme-primary)" /></div>} title={b.name} sub={`${b.persona} · bundle`} onRemove={() => ctx.removeItem("bundle", b.id)} onOpen={() => go("bundle", { id: b.id })} />
              ))}
            </div>
          </window.Panel>

          {/* over-request hint */}
          {overReq && (
            <div style={{ background: "var(--theme-warning-lighter)", border: "1px solid var(--theme-warning-light)", borderRadius: "var(--radius-md)", padding: "14px 16px", display: "flex", gap: 12 }}>
              <AppIcon name="info" size={20} color="var(--theme-warning-darker)" style={{ marginTop: 1 }} />
              <div style={{ fontSize: "var(--font-size-2xs)", lineHeight: 1.5 }}>
                <strong>Request the smallest sufficient access.</strong> {overReq}
              </div>
            </div>
          )}

          {/* justification */}
          <window.Panel>
            <window.SectionHead title="Business justification" eyebrow="Required for approval" />
            <label style={lbl}>Why do you need this access? <span style={{ color: "var(--theme-secondary)" }}>*</span></label>
            <textarea value={justification} onChange={(e) => { setJustification(e.target.value); setErr(false); }} rows={3}
              placeholder="e.g. Q3 preparer-oversight analysis requested by the Return Preparer Office."
              style={{ width: "100%", border: `1.5px solid ${err ? "var(--theme-error)" : "var(--border-strong)"}`, borderRadius: "var(--radius-md)", padding: 12, fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", resize: "vertical", marginBottom: err ? 4 : 16 }} />
            {err ? <div style={{ color: "var(--theme-error-dark)", fontSize: "var(--font-size-3xs)", marginBottom: 16, display: "flex", alignItems: "center", gap: 5 }}><AppIcon name="error" size={14} color="var(--theme-error-dark)" /> A justification is required.</div> : null}
            <label style={lbl}>Target workspace</label>
            <select value={env} onChange={(e) => setEnv(e.target.value)} style={{ width: "100%", border: "1.5px solid var(--border-strong)", borderRadius: "var(--radius-md)", padding: "10px 12px", fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", background: "var(--surface-default)" }}>
              <option>Analytics Prod</option><option>Enforcement Analytics</option><option>Engineering</option>
            </select>
          </window.Panel>
        </div>

        {/* RIGHT: what will actually be requested */}
        <div style={{ position: "sticky", top: 130, display: "flex", flexDirection: "column", gap: 16 }}>
          <window.Panel pad={0} style={{ overflow: "hidden" }}>
            <div style={{ background: "var(--color-gray-cool-2)", borderBottom: "1px solid var(--border-default)", padding: "14px 20px" }}>
              <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 7 }}>
                <AppIcon name="tune" size={17} color="var(--theme-primary)" /> What will actually be requested
              </h3>
            </div>
            <div style={{ padding: 20 }}>
              {/* resolved bundles */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                {toRequest.map((b) => (
                  <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--font-size-2xs)" }}>
                    <AppIcon name="key" size={16} color="var(--theme-primary)" />
                    <span style={{ flex: 1, fontWeight: 600 }}>{b.name}</span>
                    {b.bearsRequired ? <Pill bg="var(--color-red-cool-10v)" fg="var(--theme-secondary-darker)">BEARS</Pill> : null}
                  </div>
                ))}
              </div>
              {skipped.length > 0 && (
                <div style={{ background: "var(--theme-success-lighter)", borderRadius: "var(--radius-md)", padding: "10px 12px", marginBottom: 16, fontSize: "var(--font-size-3xs)", color: "var(--theme-success-darker)", lineHeight: 1.5 }}>
                  <strong>Skipped {skipped.length}</strong> bundle{skipped.length !== 1 ? "s" : ""} you already hold: {skipped.map((b) => b.name).join(", ")}.
                </div>
              )}
              {/* entitlement breakdown */}
              <div style={{ borderTop: "1px dashed var(--border-strong)", paddingTop: 14 }}>
                <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text-muted)", marginBottom: 10 }}>Resolved entitlements ({ents.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {Object.keys(entByType).map((t) => {
                    const m = componentMeta(t);
                    return (
                      <div key={t} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--font-size-3xs)" }}>
                        <AppIcon name={m.icon} size={15} color={m.color} />
                        <span style={{ color: "var(--text-muted)", flex: 1 }}>{m.label}</span>
                        <strong>{entByType[t].length}</strong>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </window.Panel>

          {/* approval path summary */}
          <window.Panel pad={16}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)" }}>
              <AppIcon name="schedule" size={16} color="var(--text-muted)" />
              Est. turnaround <strong style={{ color: "var(--text-default)", marginLeft: "auto" }}>{needsBears ? "5–8 business days" : "1–3 business days"}</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", marginTop: 10 }}>
              <AppIcon name="key" size={16} color="var(--text-muted)" />
              BEARS approval <strong style={{ color: "var(--text-default)", marginLeft: "auto" }}>{needsBears ? "Required" : "Not required"}</strong>
            </div>
          </window.Panel>

          <button onClick={submit} style={{ ...primaryBtn, width: "100%", justifyContent: "center", padding: 14, fontSize: "var(--font-size-sm)" }}>
            <AppIcon name="arrow_forward" size={18} color="#fff" /> Submit request{toRequest.length ? ` (${toRequest.length} bundle${toRequest.length !== 1 ? "s" : ""})` : ""}
          </button>
          <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", textAlign: "center", lineHeight: 1.5 }}>
            Pre-filled requests launch in BEARS / SailPoint. Databricks access is provisioned automatically after approval.
          </div>
        </div>
      </div>
    </window.Page>
  );
}

function SelRow({ icon, title, sub, onRemove, onOpen }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)" }}>
      {icon}
      <div onClick={onOpen} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
        <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{sub}</div>
      </div>
      <button onClick={onRemove} aria-label="Remove" style={{ background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: "var(--radius-sm)", color: "var(--text-muted)" }}>
        <AppIcon name="close" size={18} color="var(--text-muted)" />
      </button>
    </div>
  );
}

function resolveBundles(datasets, bundles) {
  const D = getData();
  const set = new Map();
  const add = (b) => { if (b && !set.has(b.id)) set.set(b.id, b); };
  bundles.forEach(add);
  datasets.forEach((a) => a.requiredBundles.filter((rb) => rb.requirement === "required").forEach((rb) => add(D.bun(rb.bundle))));
  // prerequisites
  let changed = true;
  while (changed) {
    changed = false;
    [...set.values()].forEach((b) => (b.prerequisites || []).forEach((p) => { if (!set.has(p)) { add(D.bun(p)); changed = true; } }));
  }
  return [...set.values()];
}

function detectOverRequest(datasets, toRequest) {
  // if requesting analyst-starter but every selected dataset offers a consumer alternative
  const D = getData();
  if (toRequest.some((b) => b.id === "analyst-starter") && datasets.length > 0 &&
      datasets.every((a) => a.requiredBundles.some((rb) => rb.bundle === "domain-consumer"))) {
    return "If you only need to view dashboards, Domain Consumer Access approves in 1–3 days without BEARS — consider it instead of the full Analyst Starter Pack.";
  }
  return null;
}

function buildSubRequests(toRequest, needsBears) {
  const isFti = toRequest.some((b) => b.id === "fti-analyst-reader" || b.approvers.some((a) => a.includes("FTI")));
  const subs = [
    { system: "Access request submitted", status: "done", detail: "Cart resolved to bundles and entitlements" },
    { system: "Domain owner review", status: "active", detail: "Domain steward confirms need-to-know and purpose of use" },
    { system: "EDP access review", status: "pending", detail: isFti ? "FTI safeguards review plus bundle-to-entitlement mapping" : "SBU handling and bundle-to-entitlement mapping check" },
  ];
  subs.push({ system: "BEARS entitlements created", status: "pending", detail: needsBears ? "Automated after approval — no manual EDP step" : "Existing entitlements reused where already held" });
  subs.push({ system: "Databricks provisioning: users, Unity Catalog & compute", status: "pending", detail: "Users, Unity Catalog grants and compute provisioned automatically" });
  subs.push({ system: "Access active, registered & notified", status: "pending", detail: "Requester notified; entitlement tracked for recertification" });
  return subs;
}


const lbl = { display: "block", fontSize: "var(--font-size-2xs)", fontWeight: 700, marginBottom: 7 };

Object.assign(window, { CartScreen, resolveBundles, buildSubRequests });
