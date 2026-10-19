import React from "react";
import { getData } from "./appDataBridge.js";
import { ds } from "./ds.jsx";
// Request status (timeline) + My Requests list.
//
// This whole surface is mock-backed and gated behind the coming-soon card at
// the shell level (App.jsx routes `requests`/`status` through the
// `request-status-tracking` FeatureGate), so these screens no longer render in
// the MVP. The former in-screen "capability preview" mock panels have been
// removed accordingly.
const StepIndicator = ds("StepIndicator");

const SUB_META = {
  done: { color: "var(--theme-success-dark)", bg: "var(--theme-success-lighter)", icon: "check_circle", label: "Approved" },
  active: { color: "var(--theme-primary)", bg: "var(--color-blue-5v)", icon: "schedule", label: "In review" },
  pending: { color: "var(--color-gray-cool-50)", bg: "var(--color-gray-5)", icon: "hourglass", label: "Waiting" },
  blocked: { color: "var(--theme-error-dark)", bg: "var(--theme-error-lighter)", icon: "error", label: "Failed" },
};

// The status timeline is the StatusStore projection (D.statuses, sourced via
// useStatuses/useRequestStatus → the data seam), not re-derived here. Fall back
// to the request's own seam-sourced fields for a just-submitted request that is
// not yet in the status map (both come from the seam, never window.AppData).
function statusOf(D, req) {
  return (
    D.statuses[req.id] || {
      status: req.status,
      overall: req.overall,
      stageIndex: req.stageIndex,
      stages: D.STAGES,
      subRequests: req.subRequests,
    }
  );
}

function StatusScreen({ ctx, params }) {
  const D = getData();
  const { go } = ctx;
  const req = ctx.requests.find((r) => r.id === params.id);
  if (!req) return <window.Page><window.Panel>Request not found.</window.Panel></window.Page>;
  const st = statusOf(D, req);
  const m = statusMeta(st.status);
  const failed = st.subRequests.some((s) => s.status === "blocked");
  const completed = st.status === "Completed";
  const activeSub = st.subRequests.find((s) => s.status === "active") || st.subRequests.find((s) => s.status === "blocked");

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "My Requests", go: () => go("requests") }, { label: req.id }]} />

      {/* header */}
      <window.Panel pad={0} style={{ overflow: "hidden", marginBottom: 22 }}>
        <div style={{ padding: "22px 24px", display: "flex", alignItems: "flex-start", gap: 16, borderBottom: "1px solid var(--border-default)" }}>
          <div style={{ width: 48, height: 48, borderRadius: "var(--radius-md)", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <AppIcon name={m.icon} size={26} color={m.color} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-xl)", fontWeight: 700, margin: 0 }}>{req.title}</h1>
              <Pill bg={m.bg} fg={m.color} size="lg">{st.overall}</Pill>
            </div>
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", marginTop: 6 }}>{req.id} · Submitted {req.submittedAt}</div>
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", marginTop: 8, lineHeight: 1.5 }}><strong style={{ color: "var(--text-default)" }}>Purpose:</strong> {req.purpose}</div>
          </div>
        </div>
        {/* stage stepper */}
        <div style={{ padding: "22px 24px 8px", overflowX: "auto" }}>
          <StepIndicator steps={st.stages} current={st.stageIndex} counters />
        </div>
      </window.Panel>

      {/* next step / blocker banner */}
      {failed ? (
        <div style={{ background: "var(--theme-error-lighter)", border: "1px solid var(--theme-error-light)", borderLeft: "4px solid var(--theme-error)", borderRadius: "var(--radius-md)", padding: "16px 18px", marginBottom: 22, display: "flex", gap: 12 }}>
          <AppIcon name="error" size={22} color="var(--theme-error-dark)" style={{ marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: "var(--font-size-2xs)", color: "var(--theme-error-darker)", marginBottom: 3 }}>Provisioning failed — your approvals went through</div>
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", lineHeight: 1.5 }}>All approvals completed, but the automated Databricks provisioning step failed: <MonoPath>{activeSub.error}</MonoPath>. The platform team has been notified and can retry — no need to resubmit.</div>
          </div>
          <button onClick={() => go("admin", { tab: "failures" })} style={{ ...outlineBtn, padding: "8px 14px", fontSize: "var(--font-size-3xs)", border: "1px solid var(--theme-error)", color: "var(--theme-error-dark)" }}>View in Admin</button>
        </div>
      ) : completed ? (
        <div style={{ background: "var(--theme-success-lighter)", border: "1px solid var(--theme-success-light)", borderLeft: "4px solid var(--theme-success)", borderRadius: "var(--radius-md)", padding: "16px 18px", marginBottom: 22, display: "flex", gap: 12 }}>
          <AppIcon name="check_circle" size={22} color="var(--theme-success-dark)" style={{ marginTop: 1 }} />
          <div><div style={{ fontWeight: 700, fontSize: "var(--font-size-2xs)", color: "var(--theme-success-darker)", marginBottom: 3 }}>Access is active</div>
          <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)" }}>Everything you requested has been provisioned. Jump to your activated resources below.</div></div>
        </div>
      ) : (
        <div style={{ background: "var(--color-blue-5v)", border: "1px solid var(--color-blue-20v)", borderLeft: "4px solid var(--theme-primary)", borderRadius: "var(--radius-md)", padding: "16px 18px", marginBottom: 22, display: "flex", gap: 12 }}>
          <AppIcon name="schedule" size={22} color="var(--theme-primary)" style={{ marginTop: 1 }} />
          <div><div style={{ fontWeight: 700, fontSize: "var(--font-size-2xs)", color: "var(--color-blue-warm-70v)", marginBottom: 3 }}>Next step: {activeSub ? activeSub.system : "Processing"}</div>
          <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)" }}>{activeSub ? activeSub.detail : "Your request is being processed."} No action is needed from you right now.</div></div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 28, alignItems: "start" }}>
        {/* sub-requests by system */}
        <div>
          <window.SectionHead title="Approval timeline" eyebrow="EDP access flow" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            {st.subRequests.map((s, i) => {
              const sm = SUB_META[s.status];
              const last = i === st.subRequests.length - 1;
              return (
                <div key={i} style={{ display: "flex", gap: 14 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ width: 36, height: 36, borderRadius: "var(--radius-pill)", background: sm.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: s.status === "active" ? "2px solid var(--theme-primary)" : "none" }}>
                      <AppIcon name={sm.icon} size={19} color={sm.color} />
                    </div>
                    {!last ? <div style={{ width: 2, flex: 1, minHeight: 22, background: s.status === "done" ? "var(--theme-success-light)" : "var(--border-strong)", margin: "4px 0" }} /> : null}
                  </div>
                  <div style={{ paddingBottom: last ? 0 : 18, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{s.system}</span>
                      <Pill bg={sm.bg} fg={sm.color}>{sm.label}</Pill>
                      {s.ticket ? <MonoPath>{s.ticket}</MonoPath> : null}
                    </div>
                    <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", marginTop: 3 }}>{s.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* sidebar: items + resources */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 130 }}>
          <window.Panel pad={20}>
            <SideHead icon="cart" title="In this request" />
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {req.items.map((it, i) => {
                if (it.kind === "Onboarding") return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: "var(--color-orange-5v)", display: "flex", alignItems: "center", justifyContent: "center" }}><AppIcon name="database" size={16} color="var(--theme-accent-warm-dark)" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 600 }}>{it.label}</div><div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)" }}>{it.sub}</div></div>
                  </div>
                );
                if (it.kind === "Dataset") { const a = D.ds(it.id); return (
                  <div key={i} onClick={() => go("dataset", { id: a.id })} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <AssetGlyph type={a.assetType} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 600 }}>{a.businessName}</div><div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)" }}>Dataset</div></div>
                  </div>
                ); }

                const b = D.bun(it.bundle); return (
                  <div key={i} onClick={() => go("bundle", { id: b.id })} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <div style={{ width: 30, height: 30, borderRadius: "var(--radius-sm)", background: "var(--color-blue-5v)", display: "flex", alignItems: "center", justifyContent: "center" }}><AppIcon name="key" size={16} color="var(--theme-primary)" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 600 }}>{b.name}</div><div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)" }}>Bundle</div></div>
                  </div>
                );
              })}
            </div>
          </window.Panel>

          {completed && (
            <window.Panel pad={20}>
              <SideHead icon="launch" title="Activated resources" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {["Analytics Prod workspace", "Databricks SQL editor", "Curated Gold tables"].map((r) => (
                  <a key={r} href="#" onClick={(e) => e.preventDefault()} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--font-size-2xs)", color: "var(--link-default)", textDecoration: "none", fontWeight: 600 }}>
                    <AppIcon name="launch" size={16} color="var(--link-default)" /> {r}
                  </a>
                ))}
              </div>
            </window.Panel>
          )}
        </div>
      </div>
    </window.Page>
  );
}

// ---- My Requests list ----
function RequestsScreen({ ctx }) {
  const { go, requests } = ctx;
  const [filter, setFilter] = React.useState("all");
  const filtered = filter === "all" ? requests : requests.filter((r) => r.status === filter);
  const counts = { all: requests.length, "In progress": 0, "Action needed": 0, "Completed": 0 };
  requests.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "My Requests" }]} />
      <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 6px" }}>My requests</h1>
      <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-gray-cool-70)", margin: "0 0 22px" }}>Track every access request from submission through domain owner and EDP review, BEARS entitlements, and automated Databricks provisioning.</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[["all", "All"], ["In progress", "In progress"], ["Action needed", "Action needed"], ["Completed", "Completed"]].map(([v, l]) => {
          const active = v === filter;
          return (
            <button key={v} onClick={() => setFilter(v)} style={{
              border: `1px solid ${active ? "var(--theme-primary)" : "var(--border-strong)"}`, borderRadius: "var(--radius-pill)", padding: "7px 15px", cursor: "pointer",
              background: active ? "var(--color-blue-5v)" : "var(--surface-default)", color: active ? "var(--theme-primary)" : "var(--color-gray-cool-70)",
              fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: active ? 700 : 500,
            }}>{l} <span style={{ opacity: .7 }}>· {counts[v] || 0}</span></button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 24 }}>
        {filtered.map((r) => <RequestDetailRow key={r.id} req={r} go={go} />)}
      </div>
    </window.Page>
  );
}

function RequestDetailRow({ req, go }) {
  const D = getData();
  const st = statusOf(D, req);
  const m = statusMeta(st.status);
  const pct = Math.round((st.stageIndex / (st.stages.length - 1)) * 100);
  return (
    <window.Panel hover onClick={() => go("status", { id: req.id })} style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <div style={{ width: 46, height: 46, borderRadius: "var(--radius-md)", background: m.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <AppIcon name={m.icon} size={24} color={m.color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{req.title}</div>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2 }}>{req.id} · Submitted {req.submittedAt}</div>
        {/* progress bar */}
        <div style={{ marginTop: 10, height: 5, background: "var(--color-gray-cool-5)", borderRadius: "var(--radius-pill)", overflow: "hidden", maxWidth: 360 }}>
          <div style={{ width: pct + "%", height: "100%", background: st.status === "Action needed" ? "var(--theme-error)" : st.status === "Completed" ? "var(--theme-success)" : "var(--theme-primary)" }} />
        </div>
      </div>
      <Pill bg={m.bg} fg={m.color} size="lg">{st.overall}</Pill>
      <AppIcon name="chevron_right" size={20} color="var(--text-muted)" />
    </window.Panel>
  );
}

Object.assign(window, { StatusScreen, RequestsScreen, RequestDetailRow });

export { StatusScreen };
