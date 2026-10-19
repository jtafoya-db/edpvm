import React from "react";
import { AdminEditor } from "../components/AdminEditor";
import { FeatureGate } from "../features/FeatureGate";
import { getData } from "./appDataBridge.js";
// Admin console.
//
// MVP gate: only the "Intake form editor" tab is genuinely real (it edits the
// onboarding schema and emits a PR-ready config diff). The other six tabs
// (bundle mapping, provisioning health, dataset registry, onboarding flow,
// pipeline tracker, tenant/budget) run entirely on the window.AppData mock
// seed, so they are hidden from the tab bar and — if reached via a stale
// deep-link (params.tab) — rendered as the admin-operations coming-soon card
// instead of their mock content. Those tab components remain defined below but
// are not surfaced.
const REAL_TAB = "schema";

function AdminScreen({ ctx, params }) {
  const D = getData();
  const { go } = ctx;
  const [tab, setTab] = React.useState(params.tab || REAL_TAB);
  React.useEffect(() => { if (params.tab) setTab(params.tab); }, [params.tab]);

  const tabs = [
    { id: "schema", label: "Intake form editor", icon: "tune" },
  ];


  return (
    <window.Page>
      <window.Trail items={[{ label: "Home", go: () => go("home") }, { label: "Admin console" }]} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-2xl)", fontWeight: 700, margin: "0 0 4px" }}>Admin console</h1>
          <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", margin: 0 }}>Curate the mapping layer between IRS business metadata and Databricks technical entitlements.</p>
        </div>
        <Pill icon="shield" bg="var(--color-violet-10v)" fg="var(--color-violet-60v)" bd="var(--color-violet-20v)" size="lg">Elevated access</Pill>
      </div>

      {/* tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border-default)", marginBottom: 22 }}>
        {tabs.map((t) => {
          const active = t.id === tab;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: "inline-flex", alignItems: "center", gap: 7, background: "none", border: "none", padding: "11px 16px", cursor: "pointer",
              fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: active ? 700 : 500,
              color: active ? "var(--theme-primary)" : "var(--color-gray-cool-60)", borderBottom: active ? "3px solid var(--theme-primary)" : "3px solid transparent", marginBottom: -1,
            }}><AppIcon name={t.icon} size={16} color={active ? "var(--theme-primary)" : "var(--color-gray-cool-60)"} /> {t.label}</button>
          );
        })}
      </div>

      {tab === REAL_TAB ? (
        <SchemaEditorTab ctx={ctx} />
      ) : (
        <FeatureGate id="admin-operations">
          <div />
        </FeatureGate>
      )}
    </window.Page>
  );
}

// ---- Intake form editor tab (live, repo-backed schema editor, GitHub #5) ----
// Mounts the typed <AdminEditor> (src/components/AdminEditor) with the ported
// USWDS chrome, exactly as onboarding.jsx mounts <SchemaForm>. The editor reads
// the schema via loadSchema(), holds edits in in-app state, previews them live,
// and on Save emits a PR-ready config diff — no runtime/prod write.
function SchemaEditorTab({ ctx }) {
  const D = getData();
  const domains = D.domains.map((d) => ({ value: d.id, label: d.name }));
  const chrome = {
    Icon: window.AppIcon,
    Pill: window.Pill,
    Panel: window.Panel,
    SectionHead: window.SectionHead,
    StepIndicator: ({ steps, step }) =>
      window.StepIndicatorWrap ? React.createElement(window.StepIndicatorWrap, { STEPS: steps, step }) : null,
  };
  const onSaved = (res) => {
    ctx.flash(res.changed ? "Schema change ready — copy the diff into a pull request to deploy" : "No changes to submit yet");
  };
  return <AdminEditor previewDynamicOptions={{ domains }} chrome={chrome} onSaved={onSaved} />;
}

// ---- Bundle mapping tab ----
function BundleMapping({ go }) {
  const D = getData();
  const [sel, setSel] = React.useState(D.bundles[0].id);
  const b = D.bun(sel);
  const find = (t) => b.components.find((c) => c.type === t);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
      {/* table */}
      <window.Panel pad={0} style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border-default)" }}>
          <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0 }}>Access bundle registry · {D.bundles.length}</h3>
          <button style={{ ...primaryBtn, padding: "7px 13px", fontSize: "var(--font-size-3xs)" }}><AppIcon name="add" size={15} color="#fff" /> New bundle</button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--color-gray-cool-2)" }}>
              {["Bundle", "BEARS role", "SailPoint group", "BEARS", "Status"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {D.bundles.map((bd) => {
              const bears = bd.components.find((c) => c.type === "bears_role");
              const sp = bd.components.find((c) => c.type === "sailpoint_group");
              const active = bd.id === sel;
              return (
                <tr key={bd.id} onClick={() => setSel(bd.id)} style={{ cursor: "pointer", background: active ? "var(--color-blue-5v)" : "transparent", borderBottom: "1px solid var(--border-default)" }}>
                  <td style={td}><div style={{ fontWeight: 700 }}>{bd.name}</div><div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)" }}>{bd.persona}</div></td>
                  <td style={td}>{bears ? <MonoPath>{bears.scope}</MonoPath> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                  <td style={td}>{sp ? <MonoPath>{sp.scope}</MonoPath> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                  <td style={td}>{bd.bearsRequired ? <Pill bg="var(--color-red-cool-10v)" fg="var(--theme-secondary-darker)">Req</Pill> : <span style={{ color: "var(--text-muted)" }}>No</span>}</td>
                  <td style={td}><Pill icon="check_circle" bg="var(--theme-success-lighter)" fg="var(--theme-success-darker)">Published</Pill></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </window.Panel>

      {/* detail panel */}
      <div style={{ position: "sticky", top: 130, display: "flex", flexDirection: "column", gap: 16 }}>
        <window.Panel pad={20}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border-default)" }}>
            <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0 }}>{b.name}</h3>
            <button style={{ ...outlineBtn, padding: "5px 11px", fontSize: "var(--font-size-3xs)" }}><AppIcon name="tune" size={14} color="var(--theme-primary)" /> Edit</button>
          </div>
          <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text-muted)", marginBottom: 10 }}>Component mappings ({b.components.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {b.components.map((c, i) => {
              const m = componentMeta(c.type);
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)" }}>
                  <AppIcon name={m.icon} size={16} color={m.color} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 600 }}>{m.label}</div>
                    <MonoPath style={{ fontSize: "var(--font-size-micro)" }}>{c.scope}</MonoPath>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14, fontSize: "var(--font-size-micro)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <AppIcon name="schedule" size={13} color="var(--text-muted)" /> Mapping v3 · last edited by P. Nadar · Jun 1, 2026 · all changes versioned
          </div>
        </window.Panel>
      </div>
    </div>
  );
}

// ---- Provisioning health tab ----
function ProvisioningHealth({ go, ctx }) {
  const D = getData();
  // gather failed provisioning actions from requests
  const failures = D.requests.filter((r) => r.subRequests.some((s) => s.status === "blocked")).map((r) => {
    const s = r.subRequests.find((x) => x.status === "blocked");
    return { req: r, action: "UC grant", target: "sandbox_raas.*", error: s.error, detail: s.detail, when: "Jun 4, 2026 14:22 ET" };
  });
  const [sel, setSel] = React.useState(failures[0] ? failures[0].req.id : null);
  const selF = failures.find((f) => f.req.id === sel);

  return (
    <div>
      {/* health stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 22 }}>
        <window.StatCard icon="check_circle" n="98.2%" l="Provisioning success (30d)" />
        <window.StatCard icon="warning" n={failures.length} l="Open failures" warn={failures.length > 0} />
        <window.StatCard icon="schedule" n="4.6h" l="Avg. approval-to-active" />
        <window.StatCard icon="refresh" n="12" l="Auto-retries (24h)" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 400px", gap: 24, alignItems: "start" }}>
        <window.Panel pad={0} style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-default)" }}>
            <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0 }}>Failed provisioning actions</h3>
          </div>
          {failures.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}><AppIcon name="check_circle" size={28} color="var(--theme-success-light)" /><p>No open failures.</p></div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ background: "var(--color-gray-cool-2)" }}>{["Request", "Action", "Error", "When"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {failures.map((f) => {
                  const active = f.req.id === sel;
                  return (
                    <tr key={f.req.id} onClick={() => setSel(f.req.id)} style={{ cursor: "pointer", background: active ? "var(--theme-error-lighter)" : "transparent", borderBottom: "1px solid var(--border-default)" }}>
                      <td style={td}><div style={{ fontWeight: 700 }}>{f.req.id}</div><div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.req.title}</div></td>
                      <td style={td}>{f.action}</td>
                      <td style={td}><MonoPath style={{ color: "var(--theme-error-dark)" }}>{f.error}</MonoPath></td>
                      <td style={{ ...td, color: "var(--text-muted)", fontSize: "var(--font-size-micro)" }}>{f.when}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </window.Panel>

        {/* failure detail panel */}
        {selF && (
          <div style={{ position: "sticky", top: 130 }}>
            <window.Panel pad={0} style={{ overflow: "hidden", border: "1px solid var(--theme-error-light)" }}>
              <div style={{ background: "var(--theme-error-lighter)", borderBottom: "1px solid var(--theme-error-light)", padding: "14px 18px", display: "flex", alignItems: "center", gap: 9 }}>
                <AppIcon name="error" size={20} color="var(--theme-error-dark)" />
                <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0, color: "var(--theme-error-darker)" }}>Provisioning failure</h3>
              </div>
              <div style={{ padding: 18 }}>
                <Row k="Request" v={<button onClick={() => go("status", { id: selF.req.id })} style={{ ...linkBtn, fontSize: "var(--font-size-2xs)" }}>{selF.req.id}</button>} />
                <Row k="Failed step" v="Databricks provisioning" />
                <Row k="Action type" v={selF.action} />
                <Row k="Target" v={<MonoPath>{selF.target}</MonoPath>} />
                <Row k="Error code" v={<MonoPath style={{ color: "var(--theme-error-dark)" }}>{selF.error}</MonoPath>} />
                <div style={{ marginTop: 12, padding: "11px 13px", background: "var(--color-gray-cool-90)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-mono)", fontSize: "var(--font-size-micro)", color: "#e7eef5", lineHeight: 1.6 }}>
                  <div style={{ color: "var(--color-red-30v)" }}>[ERROR] {selF.error}</div>
                  <div>at apply_uc_grant(catalog="sandbox_raas")</div>
                  <div style={{ color: "var(--color-gray-cool-30)" }}>Catalog does not exist for tenant. Approvals OK; create catalog then retry.</div>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button onClick={() => ctx.flash("Retry queued — provisioning will re-run")} style={{ ...primaryBtn, flex: 1, justifyContent: "center", padding: 11 }}><AppIcon name="refresh" size={16} color="#fff" /> Retry</button>
                  <button onClick={() => ctx.flash("Opened mapping editor")} style={{ ...outlineBtn, flex: 1, justifyContent: "center", padding: 11 }}><AppIcon name="tune" size={16} color="var(--theme-primary)" /> Remap</button>
                </div>
                <div style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)", marginTop: 12, lineHeight: 1.5 }}>Audit history is preserved. The requester is notified automatically; they don't need to resubmit.</div>
              </div>
            </window.Panel>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Dataset registry tab ----
function DatasetRegistry({ go }) {
  const D = getData();
  const unmapped = 3; // synthetic count of orphaned UC assets
  return (
    <div>
      <div style={{ background: "var(--theme-warning-lighter)", border: "1px solid var(--theme-warning-light)", borderRadius: "var(--radius-md)", padding: "12px 16px", marginBottom: 18, display: "flex", alignItems: "center", gap: 10, fontSize: "var(--font-size-2xs)" }}>
        <AppIcon name="warning" size={18} color="var(--theme-warning-darker)" />
        <span><strong>{unmapped} unmapped Unity Catalog assets</strong> were discovered but aren't linked to a domain or bundle yet. <button style={{ ...linkBtn, fontSize: "var(--font-size-2xs)" }}>Review orphans</button></span>
      </div>
      <window.Panel pad={0} style={{ overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-default)" }}>
          <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0 }}>Published datasets · {D.datasets.length}</h3>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ background: "var(--color-gray-cool-2)" }}>{["Dataset", "Domain", "UC path", "Class", "Cert", "Bundles"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {D.datasets.map((a) => (
              <tr key={a.id} onClick={() => go("dataset", { id: a.id })} style={{ cursor: "pointer", borderBottom: "1px solid var(--border-default)" }}>
                <td style={td}><div style={{ fontWeight: 700 }}>{a.businessName}</div></td>
                <td style={td}>{D.dom(a.domain).name}</td>
                <td style={td}><MonoPath>{a.catalog}.{a.schema}</MonoPath></td>
                <td style={td}><ClassPill c={a.classification} /></td>
                <td style={td}>{a.certification === "Certified" ? <AppIcon name="verified" size={16} color="var(--theme-success-dark)" /> : <AppIcon name="schedule" size={16} color="var(--theme-warning-darker)" />}</td>
                <td style={td}>{a.requiredBundles.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </window.Panel>
    </div>
  );
}

const th = { textAlign: "left", padding: "10px 14px", fontSize: "var(--font-size-micro)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text-muted)", whiteSpace: "nowrap" };
const td = { padding: "11px 14px", fontSize: "var(--font-size-2xs)", verticalAlign: "middle" };

// ---- Onboarding flow tab (left-to-right flowchart, standard shapes) ----
const FLOW_MODES = {
  auto: { label: "Automated", fill: "#e7f6ee", stroke: "#2e8540", text: "#1a6b2f", icon: "bolt" },
  manual: { label: "Tenant manual", fill: "#fff6e0", stroke: "#c2850c", text: "#8a5c00", icon: "person" },
  review: { label: "EDP manual review", fill: "#fde8ea", stroke: "#c9403f", text: "#9b2c2b", icon: "group" },
  terminal: { label: "Start / end", fill: "#eef2f7", stroke: "#3d4551", text: "#3d4551", icon: "lineage" },
};

// grid geometry
const PITCH = 240, NW = 190, NH = 62, DH = 84;
const LANE_A = 190, LANE_B = 470, MID = 330, TOP_BAND = 74, BOT_BAND = 606, LOOP_Y = 690;
const cx = (col) => 60 + col * PITCH;

const FLOW_NODES = [
  { id: "start", col: 0, y: MID, shape: "oval", t: "Business need for EDP data", who: "Tenant", mode: "terminal", d: "Every path starts with a business unit that needs data on the Enterprise Data Platform." },
  { id: "dec1", col: 1, y: MID, shape: "diamond", t: "Data already in EDP?", who: "Decision", mode: "manual", d: "If the dataset is already certified in the platform the tenant only requests entitlements. If not, the data must be onboarded through the CCB path." },

  // Lane A — pure data consumers
  { id: "c1", col: 2, y: LANE_A, shape: "rect", t: "Browse domains & datasets", who: "Data consumer", mode: "manual", d: "Consumer discovers certified datasets in the catalog and identifies the access bundles they need." },
  { id: "c2", col: 3, y: LANE_A, shape: "para", t: "Submit access request", who: "Data consumer", mode: "manual", d: "Cart becomes sub-requests. Requesting entitlements is the only manual tenant work on this path." },
  { id: "c3", col: 4, y: LANE_A, shape: "rect", t: "Domain owner review", who: "Domain steward", mode: "review", d: "Steward confirms need-to-know and purpose of use." },
  { id: "c4", col: 5, y: LANE_A, shape: "rect", t: "EDP access review", who: "EDP access team", mode: "review", d: "Platform confirms SBU / FTI handling and bundle-to-entitlement mapping." },
  { id: "cdec", col: 6, y: LANE_A, shape: "diamond", t: "Approved?", who: "Decision", mode: "review", d: "Approval gate for the access request. Denied requests return to the requester with reviewer comments." },
  { id: "creturn", col: 6, y: TOP_BAND, shape: "rect", t: "Returned to requester", who: "Data consumer", mode: "manual", d: "Requester adjusts scope or justification and resubmits the access request." },

  // Lane B — onboarding new data
  { id: "d1", col: 2, y: LANE_B, shape: "rect", t: "Define source & architecture", who: "Data owner", mode: "manual", d: "Tenant defines dataset, sensitivity, steward, ingestion pattern (EFTU, Informatica, EPZ landing zone) and consumption method." },
  { id: "ddec1", col: 3, y: LANE_B, shape: "diamond", t: "Approved pattern?", who: "Decision", mode: "manual", d: "EFTU, Informatica and EPZ landing zone are pre-approved. Anything else requires architecture consultation before intake." },
  { id: "dcons", col: 3, y: BOT_BAND, shape: "rect", t: "Architecture consultation", who: "Platform architects", mode: "review", d: "Manual consultation to fit a non-standard pattern to platform guardrails." },
  { id: "d2", col: 4, y: LANE_B, shape: "rect", t: "Choose delivery model", who: "Data owner", mode: "manual", d: "Tenant declares whether they self-build with EDP patterns and guidelines, or need platform-team data engineering support." },
  { id: "ddec3", col: 5, y: LANE_B, shape: "diamond", t: "Need engineering help?", who: "Decision", mode: "manual", d: "Tenant declares whether they can build the pipeline themselves with EDP patterns and guidelines, or need the platform pipeline team involved." },
  { id: "dpipe", col: 5, y: BOT_BAND, shape: "rect", t: "Pipeline team consultation", who: "Platform data engineering", mode: "review", d: "Manual engagement with the platform pipeline team: scoping, engineering capacity review and build plan before the request enters sizing and intake." },
  { id: "d3", col: 6, y: LANE_B, shape: "rect", t: "AI-assisted / simple sizing", who: "EDP wizard", mode: "auto", d: "Storage, DBUs, cluster, warehouse and monthly cost derived automatically from volume, cadence, complexity and user count." },
  { id: "d4", col: 7, y: LANE_B, shape: "para", t: "Business case & ROI package", who: "Data owner", mode: "manual", d: "Tenant supplies mission priority, expected outcome, annual benefit and hours saved; ROI and payback computed automatically." },
  { id: "d5", col: 8, y: LANE_B, shape: "rect", t: "EDP business & ROI review", who: "EDP business office", mode: "review", d: "Manual evaluation of business value, ROI and funding of the estimated platform cost." },
  { id: "ddec2", col: 9, y: LANE_B, shape: "diamond", t: "Intake CCB approved?", who: "Change control board", mode: "review", d: "Manual review of platform security, architecture conformance, engineering capacity and capacity impact." },
  { id: "drev", col: 9, y: BOT_BAND, shape: "rect", t: "Revise scope or cost", who: "Data owner", mode: "manual", d: "Tenant reworks sizing, funding or architecture and returns to the business & ROI package." },

  // Shared tail — identical for both paths
  { id: "m1", col: 10, y: MID, shape: "rect", t: "BEARS entitlement creation / requests", who: "BEARS automation", mode: "auto", d: "Approved bundles — consumer, owner or engineer — are created and assigned as BEARS entitlements with no manual EDP step. Shared by both paths." },
  { id: "m2", col: 11, y: MID, shape: "rect", t: "Databricks provisioning: users, UC & compute", who: "Infrastructure as code", mode: "auto", d: "Catalog and medallion schemas, groups, Unity Catalog grants, warehouses, clusters and pipeline scaffolding deployed by Terraform. Shared by both paths." },
  { id: "m3", col: 12, y: MID, shape: "para", t: "Access active, dataset registered & notified", who: "Automation", mode: "auto", d: "Requester notified, dataset (or entitlement) registered with lineage and bundle mapping, expiry and recertification tracked automatically. Shared by both paths." },

  { id: "end", col: 13, y: MID, shape: "oval", t: "Data in use & tracked", who: "EDP", mode: "terminal", d: "Access is live, monitored and recertified; the dataset is governed in Unity Catalog." },
];

const NODE_BY_ID = Object.fromEntries(FLOW_NODES.map((n) => [n.id, n]));

const FLOW_EDGES = [
  { from: "start", to: "dec1" },
  { from: "dec1", to: "c1", label: "Yes", route: "fan" },
  { from: "dec1", to: "d1", label: "No", route: "fan" },
  { from: "c1", to: "c2" }, { from: "c2", to: "c3" }, { from: "c3", to: "c4" }, { from: "c4", to: "cdec" },
  { from: "cdec", to: "m1", label: "Yes", route: "mergeDown" },
  { from: "cdec", to: "creturn", label: "No", route: "up" },
  { from: "creturn", to: "c2", route: "backTop" },
  { from: "d1", to: "ddec1" },
  { from: "ddec1", to: "d2", label: "Yes" },
  { from: "ddec1", to: "dcons", label: "No", route: "down" },
  { from: "dcons", to: "d2", route: "upRight" },
  { from: "d2", to: "ddec3" },
  { from: "ddec3", to: "d3", label: "No" },
  { from: "ddec3", to: "dpipe", label: "Yes", route: "down" },
  { from: "dpipe", to: "d3", route: "upRight" },
  { from: "d3", to: "d4" }, { from: "d4", to: "d5" }, { from: "d5", to: "ddec2" },
  { from: "ddec2", to: "m1", label: "Yes", route: "mergeUp" },
  { from: "ddec2", to: "drev", label: "No", route: "down" },
  { from: "drev", to: "d4", route: "backBottom" },
  { from: "m1", to: "m2" }, { from: "m2", to: "m3" }, { from: "m3", to: "end" },
  { from: "m3", to: "dec1", route: "loop", label: "new data now discoverable", dashed: true },
];


function halfW(n) { return n.shape === "diamond" ? NW / 2 + 12 : NW / 2; }
function halfH(n) { return n.shape === "diamond" ? DH / 2 : NH / 2; }

function edgePath(e) {
  const a = NODE_BY_ID[e.from], b = NODE_BY_ID[e.to];
  const ax = cx(a.col), bx = cx(b.col);
  switch (e.route) {
    case "fan": {
      const midX = ax + halfW(a) + 40;
      return `M ${ax + halfW(a)} ${a.y} H ${midX} V ${b.y} H ${bx - halfW(b) - 6}`;
    }
    case "mergeDown":
    case "mergeUp": {
      const midX = bx - halfW(b) - 70;
      return `M ${ax + halfW(a)} ${a.y} H ${midX} V ${b.y} H ${bx - halfW(b) - 6}`;
    }
    case "up": return `M ${ax} ${a.y - halfH(a)} V ${b.y + halfH(b) + 6}`;
    case "down": return `M ${ax} ${a.y + halfH(a)} V ${b.y - halfH(b) - 6}`;
    case "backTop": return `M ${ax - halfW(a)} ${a.y} H ${bx} V ${b.y - halfH(b) - 6}`;
    case "backBottom": return `M ${ax - halfW(a)} ${a.y} H ${bx} V ${b.y + halfH(b) + 6}`;
    case "upRight": return `M ${ax + halfW(a)} ${a.y} H ${bx} V ${b.y + halfH(b) + 6}`;
    case "joinDown": return `M ${ax + halfW(a)} ${a.y} H ${bx} V ${b.y - halfH(b) - 6}`;
    case "joinUp": return `M ${ax + halfW(a)} ${a.y} H ${bx} V ${b.y + halfH(b) + 6}`;
    case "loop": return `M ${ax} ${a.y + halfH(a)} V ${LOOP_Y} H ${bx} V ${b.y + halfH(b) + 6}`;
    default: return `M ${ax + halfW(a)} ${a.y} H ${bx - halfW(b) - 6}`;
  }
}

function edgeLabelPos(e) {
  const a = NODE_BY_ID[e.from], b = NODE_BY_ID[e.to];
  const ax = cx(a.col), bx = cx(b.col);
  if (e.route === "mergeDown" || e.route === "mergeUp") return { x: ax + halfW(a) + 8, y: a.y - 10, anchor: "start" };
  if (e.route === "fan") return { x: ax + halfW(a) + 46, y: (a.y + b.y) / 2 - 4, anchor: "start" };
  if (e.route === "up") return { x: ax + 8, y: a.y - halfH(a) - 12, anchor: "start" };
  if (e.route === "down") return { x: ax + 8, y: a.y + halfH(a) + 18, anchor: "start" };
  if (e.route === "loop") return { x: (ax + bx) / 2, y: LOOP_Y - 8, anchor: "middle" };
  return { x: (ax + halfW(a) + bx - halfW(b)) / 2, y: a.y - 10, anchor: "middle" };
}

function wrapLabel(text, max = 20) {
  const words = String(text).split(" ");
  const lines = [];
  let cur = "";
  words.forEach((w) => {
    if (!cur.length) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function NodeShape({ n, on, onSelect }) {
  const m = FLOW_MODES[n.mode];
  const x = cx(n.col), y = n.y;
  const sw = on ? 3 : 1.6;
  const lines = wrapLabel(n.t, n.shape === "diamond" ? 16 : 22);
  const startY = y - (lines.length - 1) * 7 - (n.shape === "diamond" ? 4 : 5);
  let shape;
  if (n.shape === "oval") {
    shape = <ellipse cx={x} cy={y} rx={NW / 2} ry={NH / 2} fill={m.fill} stroke={on ? "#1b1b1b" : m.stroke} strokeWidth={sw} />;
  } else if (n.shape === "diamond") {
    const w = NW / 2 + 12, h = DH / 2;
    shape = <polygon points={`${x},${y - h} ${x + w},${y} ${x},${y + h} ${x - w},${y}`} fill={m.fill} stroke={on ? "#1b1b1b" : m.stroke} strokeWidth={sw} />;
  } else if (n.shape === "para") {
    const w = NW / 2, h = NH / 2, sk = 18;
    shape = <polygon points={`${x - w + sk},${y - h} ${x + w},${y - h} ${x + w - sk},${y + h} ${x - w},${y + h}`} fill={m.fill} stroke={on ? "#1b1b1b" : m.stroke} strokeWidth={sw} />;
  } else {
    shape = <rect x={x - NW / 2} y={y - NH / 2} width={NW} height={NH} rx={6} fill={m.fill} stroke={on ? "#1b1b1b" : m.stroke} strokeWidth={sw} />;
  }
  return (
    <g onClick={onSelect} style={{ cursor: "pointer" }}>
      {shape}
      {lines.map((ln, i) => (
        <text key={i} x={x} y={startY + i * 14} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#1b1b1b">{ln}</text>
      ))}
      {n.shape !== "diamond" && (
        <text x={x} y={y + NH / 2 - 8} textAnchor="middle" fontSize="9" fontWeight="700" fill={m.text} letterSpacing=".04em">
          {n.who.toUpperCase()}
        </text>
      )}
    </g>
  );
}

const MIN_ZOOM = 0.5, MAX_ZOOM = 6;

function OnboardingFlow() {
  const [selId, setSelId] = React.useState("start");
  const active = NODE_BY_ID[selId];
  const W = cx(13) + NW / 2 + 40;
  const H = LOOP_Y + 40;
  const VB = { x: -30, y: 0, w: W + 60, h: H };

  const svgRef = React.useRef(null);
  const [view, setView] = React.useState({ z: 2.4, x: 100, y: -250 });
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const dragRef = React.useRef(null);
  const movedRef = React.useRef(false);

  // convert a client point into untransformed SVG user space
  const toUser = (clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const u = p.matrixTransform(ctm.inverse());
    return { x: u.x, y: u.y };
  };

  const zoomAt = (factor, clientX, clientY) => {
    const v = viewRef.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z * factor));
    const k = next / v.z;
    const u = toUser(clientX, clientY);
    setView({ z: next, x: u.x - (u.x - v.x) * k, y: u.y - (u.y - v.y) * k });
  };

  const zoomButton = (factor) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  };

  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      zoomAt(Math.exp(-dy * 0.0018), e.clientX, e.clientY);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e) => {
    const u = toUser(e.clientX, e.clientY);
    dragRef.current = { u, start: viewRef.current, moved: false };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const u = toUser(e.clientX, e.clientY);
    const dx = u.x - d.u.x, dy = u.y - d.u.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    setView({ z: d.start.z, x: d.start.x + dx, y: d.start.y + dy });
  };
  const onPointerUp = () => {
    movedRef.current = !!(dragRef.current && dragRef.current.moved);
    dragRef.current = null;
  };

  const bands = [
    { y: LANE_A, title: "Pure data consumers", sub: "Analytics & BI on data already in EDP", accent: "#005ea2" },
    { y: LANE_B, title: "Onboarding new data", sub: "New source system into EDP", accent: "#7f3fbf" },
  ];

  const zoomBtn = {
    width: 32, height: 32, borderRadius: 6, border: "1px solid var(--border-default)",
    background: "var(--surface-default)", cursor: "pointer", fontSize: 15, fontWeight: 700,
    lineHeight: 1, color: "var(--color-gray-cool-70)", display: "inline-flex", alignItems: "center", justifyContent: "center",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", margin: 0, maxWidth: 680, lineHeight: 1.55 }}>
          Flow reads left to right. Scroll to zoom, drag to pan, click any shape for detail. Manual effort is limited to what the tenant must create or request, plus the EDP business/ROI review and intake CCB — entitlements, catalogs, grants and compute are automated with BEARS and Terraform.
        </p>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {Object.keys(FLOW_MODES).map((k) => {
            const m = FLOW_MODES[k];
            return (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: "var(--font-size-3xs)", fontWeight: 600, color: "var(--color-gray-cool-70)" }}>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: m.fill, border: `2px solid ${m.stroke}` }} />{m.label}
              </span>
            );
          })}
        </div>
      </div>

      <div style={{ position: "relative", background: "var(--surface-default)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 12, right: 12, zIndex: 2, display: "flex", gap: 6, alignItems: "center", background: "var(--surface-default)", padding: 4, borderRadius: 8, boxShadow: "0 1px 4px rgba(0,0,0,.12)" }}>
          <span style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, color: "var(--text-muted)", padding: "0 4px" }}>{Math.round(view.z * 100)}%</span>
          <button type="button" style={zoomBtn} onClick={() => zoomButton(1 / 1.3)} aria-label="Zoom out">&minus;</button>
          <button type="button" style={zoomBtn} onClick={() => zoomButton(1.3)} aria-label="Zoom in">+</button>
          <button type="button" style={{ ...zoomBtn, width: "auto", padding: "0 10px", fontSize: 11 }} onClick={() => setView({ z: 1, x: 0, y: 0 })}>Fit</button>
        </div>
        <svg
          ref={svgRef}
          viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`}
          width="100%"
          height="620"
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ display: "block", touchAction: "none", cursor: dragRef.current ? "grabbing" : "grab", fontFamily: "var(--font-sans)" }}
          role="img"
          aria-label="EDP onboarding flowchart, left to right"
        >
          <defs>
            <marker id="fcArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#3d4551" />
            </marker>
            <marker id="fcArrowLoop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#2e8540" />
            </marker>
          </defs>

          <g transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
            {bands.map((b) => (
              <g key={b.title}>
                <rect x={-24} y={b.y - 70} width={W + 20} height={140} rx={10} fill={b.accent} fillOpacity=".05" />
                <text x={-18} y={b.y - 52} fontSize="12" fontWeight="700" fill={b.accent}>{b.title}</text>
                <text x={-18} y={b.y - 37} fontSize="9.5" fill="#5b6672">{b.sub}</text>
              </g>
            ))}

            {FLOW_EDGES.map((e, i) => (
              <g key={i}>
                <path d={edgePath(e)} fill="none" stroke={e.dashed ? "#2e8540" : "#3d4551"} strokeWidth="1.8"
                  strokeDasharray={e.dashed ? "6 5" : "0"} markerEnd={`url(#${e.dashed ? "fcArrowLoop" : "fcArrow"})`} />
                {e.label && (() => {
                  const p = edgeLabelPos(e);
                  return <text x={p.x} y={p.y} textAnchor={p.anchor} fontSize="10" fontWeight="700" fill={e.dashed ? "#1a6b2f" : "#3d4551"}>{e.label}</text>;
                })()}
              </g>
            ))}

            {FLOW_NODES.map((n) => (
              <NodeShape key={n.id} n={n} on={n.id === selId} onSelect={() => { if (!movedRef.current) setSelId(n.id); }} />
            ))}
          </g>
        </svg>
      </div>


      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 20, alignItems: "start" }}>
        <window.Panel pad={18}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <AppIcon name={FLOW_MODES[active.mode].icon} size={17} color={FLOW_MODES[active.mode].stroke} />
            <strong style={{ fontSize: "var(--font-size-2xs)" }}>{active.t}</strong>
            <span style={{ marginLeft: "auto", fontSize: "var(--font-size-micro)", fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: FLOW_MODES[active.mode].text }}>{FLOW_MODES[active.mode].label}</span>
          </div>
          <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{active.who}</div>
          <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)", lineHeight: 1.6 }}>{active.d}</div>
        </window.Panel>
        <window.Panel pad={18}>
          <h3 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: "0 0 12px" }}>Where automation takes over</h3>
          <div style={{ display: "grid", gap: 12 }}>
            <AutoNote icon="bolt" t="Post-BEARS provisioning" d="Once a BEARS entitlement is approved, consumer access is provisioned end-to-end with no EDP touch." />
            <AutoNote icon="workspace" t="Infrastructure as code" d="Catalogs, schemas, groups, grants, clusters and warehouses are deployed by Terraform pipelines." />
            <AutoNote icon="sparkle" t="AI-assisted sizing & ROI" d="Capacity, cost, ROI and payback are generated from intake inputs before any human review." />
          </div>
        </window.Panel>
      </div>
    </div>
  );
}


function AutoNote({ icon, t, d }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <AppIcon name={icon} size={18} color="var(--theme-success-dark)" />
      <div>
        <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{t}</div>
        <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2, lineHeight: 1.45 }}>{d}</div>
      </div>
    </div>
  );
}

// ---- Pipeline tracker tab (all tenants, decisions, Jira) ----
const PSTATE = {
  intake: { label: "Intake", bg: "var(--color-gray-5)", fg: "var(--color-gray-cool-70)", bd: "var(--border-default)" },
  review: { label: "In review", bg: "var(--color-gold-5v)", fg: "#8a5c00", bd: "var(--color-gold-20v)" },
  ccb: { label: "At CCB", bg: "var(--color-violet-10v)", fg: "var(--color-violet-60v)", bd: "var(--color-violet-20v)" },
  provisioning: { label: "Provisioning", bg: "var(--color-blue-5v)", fg: "var(--color-blue-warm-70v)", bd: "var(--color-blue-20v)" },
  live: { label: "Live", bg: "var(--theme-success-lighter)", fg: "var(--theme-success-darker)", bd: "var(--theme-success-light)" },
  blocked: { label: "Blocked", bg: "var(--theme-error-lighter)", fg: "#9b2c2b", bd: "var(--color-red-cool-30v)" },
  returned: { label: "Returned", bg: "var(--theme-error-lighter)", fg: "#9b2c2b", bd: "var(--color-red-cool-30v)" },
};
const DEC_TONE = {
  Approved: "var(--theme-success-dark)", Provisioned: "var(--theme-success-dark)",
  "Entitlements created": "var(--theme-success-dark)", Submitted: "var(--color-gray-cool-60)",
  Conditional: "#c2850c", Returned: "var(--theme-error-dark)", Failed: "var(--theme-error-dark)",
};
const JIRA_BASE = "https://jira.irs.gov/browse/";

function JiraLink({ k }) {
  if (!k) return null;
  return (
    <a href={JIRA_BASE + k} target="_blank" rel="noreferrer"
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--font-size-3xs)", fontWeight: 700, color: "var(--link-default)", textDecoration: "none", fontFamily: "var(--font-mono)" }}>
      {k} <AppIcon name="launch" size={12} color="var(--link-default)" />
    </a>
  );
}

function PipelineTracker({ go, ctx }) {
  const D = getData();
  const items = D.pipeline;
  const [kind, setKind] = React.useState("all");
  const [state, setState] = React.useState("all");
  const [sel, setSel] = React.useState(items[0].id);

  const rows = items.filter((i) => (kind === "all" || i.kind === kind) && (state === "all" || i.state === state));
  const cur = items.find((i) => i.id === sel) || rows[0] || items[0];
  const counts = (k) => items.filter((i) => i.state === k).length;

  const chip = (on) => ({
    background: on ? "var(--theme-primary)" : "var(--surface-default)", color: on ? "#fff" : "var(--color-gray-cool-70)",
    border: on ? "1.5px solid var(--theme-primary)" : "1px solid var(--border-default)", borderRadius: 999,
    padding: "6px 12px", fontSize: "var(--font-size-3xs)", fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)",
  });

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 }}>
        <KPI icon="description" label="Open items" v={items.filter((i) => i.state !== "live").length} sub="Across 5 tenants" />
        <KPI icon="group" label="Awaiting EDP decision" v={counts("review") + counts("ccb")} sub="Business/ROI review + CCB" tone="#8a5c00" />
        <KPI icon="warning" label="Blocked" v={counts("blocked")} sub="Needs consultation or remediation" tone="var(--theme-error-dark)" />
        <KPI icon="bolt" label="Automated in flight" v={counts("provisioning")} sub="BEARS + Terraform, no EDP touch" tone="var(--theme-success-dark)" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {[["all", "All work"], ["onboard", "New data onboarding"], ["access", "Access requests"]].map(([k, l]) => (
          <button key={k} style={chip(kind === k)} onClick={() => setKind(k)}>{l}</button>
        ))}
        <span style={{ width: 1, height: 20, background: "var(--border-default)", margin: "0 4px" }} />
        {[["all", "Any stage"], ["review", "In review"], ["ccb", "At CCB"], ["provisioning", "Provisioning"], ["blocked", "Blocked"], ["live", "Live"]].map(([k, l]) => (
          <button key={k} style={chip(state === k)} onClick={() => setState(k)}>{l}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 400px", gap: 24, alignItems: "start" }}>
        <window.Panel pad={0} style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "var(--surface-subtle)", borderBottom: "1px solid var(--border-default)" }}>
              <tr><th style={th}>Item</th><th style={th}>Tenant</th><th style={th}>Stage</th><th style={th}>Status</th><th style={th}>Age</th><th style={th}>Jira</th></tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const on = i.id === cur.id;
                const m = PSTATE[i.state];
                return (
                  <tr key={i.id} onClick={() => setSel(i.id)} style={{ cursor: "pointer", background: on ? "var(--color-blue-5v)" : "transparent", borderBottom: "1px solid var(--border-default)" }}>
                    <td style={td}>
                      <div style={{ fontWeight: 700 }}>{i.title}</div>
                      <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                        {i.id} · {i.kind === "onboard" ? "New data" : "Access"}
                      </div>
                    </td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)" }}>{i.tenant.split(" — ")[0]}</td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)" }}>{i.stage}</td>
                    <td style={td}><Pill bg={m.bg} fg={m.fg} bd={m.bd}>{m.label}</Pill></td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)", color: i.ageDays > 14 ? "var(--theme-error-dark)" : "var(--text-muted)", fontWeight: 700 }}>{i.ageDays}d</td>
                    <td style={td}><JiraLink k={i.jira} /></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td style={{ ...td, color: "var(--text-muted)" }} colSpan={6}>No items match these filters.</td></tr>}
            </tbody>
          </table>
        </window.Panel>

        <div style={{ display: "grid", gap: 18 }}>
          <window.Panel pad={18}>
            <div style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-sm)", fontWeight: 700, marginBottom: 4 }}>{cur.title}</div>
            <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginBottom: 12 }}>{cur.tenant}</div>
            <div style={{ display: "grid", gap: 2 }}>
              <Row k="Item" v={<span style={{ fontFamily: "var(--font-mono)" }}>{cur.id}</span>} />
              <Row k="Requester" v={cur.requester} />
              <Row k="Submitted" v={cur.submittedAt} />
              <Row k="Current stage" v={cur.stage} />
              <Row k="Owner of next step" v={cur.owner} />
              <Row k="Sensitivity" v={cur.sensitivity} />
              {cur.kind === "onboard" && <Row k="Ingestion pattern" v={cur.pattern} />}
              {cur.kind === "onboard" && <Row k="Delivery model" v={cur.delivery} />}
              {cur.kind === "onboard" && <Row k="Est. monthly cost" v={"$" + cur.monthlyCost.toLocaleString()} />}
              {cur.kind === "onboard" && cur.roi != null && <Row k="ROI" v={cur.roi + "x"} />}
              <Row k="Jira" v={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><JiraLink k={cur.jira} /><span style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{cur.jiraStatus}</span></span>} />
            </div>
            <div style={{ background: "var(--surface-subtle)", borderRadius: "var(--radius-md)", padding: 12, marginTop: 14, fontSize: "var(--font-size-3xs)", lineHeight: 1.5 }}>
              <strong>Next action:</strong> {cur.nextAction}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button onClick={() => ctx.flash("Decision recorded and synced to " + cur.jira)} style={{ ...primaryBtn, flex: 1, justifyContent: "center", padding: 10 }}>
                <AppIcon name="check" size={16} color="#fff" /> Record decision
              </button>
              <a href={JIRA_BASE + cur.jira} target="_blank" rel="noreferrer" style={{ ...outlineBtn, flex: 1, justifyContent: "center", padding: 9, textDecoration: "none" }}>
                <AppIcon name="launch" size={16} color="var(--theme-primary)" /> Open in Jira
              </a>
            </div>
          </window.Panel>

          <window.Panel pad={18}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>Decision log</div>
              <span style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>Synced with Jira · 4 min ago</span>
            </div>
            <div style={{ display: "grid", gap: 14 }}>
              {cur.decisions.map((d, i) => (
                <div key={i} style={{ display: "flex", gap: 10 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: DEC_TONE[d.decision] || "var(--color-gray-cool-60)" }} />
                    {i < cur.decisions.length - 1 && <span style={{ flex: 1, width: 2, background: "var(--border-default)", marginTop: 4 }} />}
                  </div>
                  <div style={{ paddingBottom: 2 }}>
                    <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700, color: DEC_TONE[d.decision] || "var(--text-default)" }}>
                      {d.decision} <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>· {d.at}</span>
                    </div>
                    <div style={{ fontSize: "var(--font-size-3xs)", fontWeight: 600, marginTop: 1 }}>{d.actor}</div>
                    <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2, lineHeight: 1.45 }}>{d.note}</div>
                    <div style={{ marginTop: 3 }}><JiraLink k={d.jira} /></div>
                  </div>
                </div>
              ))}
            </div>
          </window.Panel>
        </div>
      </div>
    </div>
  );
}

// ---- Tenant usage & budget tab ----
const money = (n) => "$" + Math.round(n).toLocaleString();

function KPI({ icon, label, v, sub, tone }) {
  return (
    <window.Panel pad={16}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <AppIcon name={icon} size={16} color={tone || "var(--theme-primary)"} />
        <span style={{ fontSize: "var(--font-size-micro)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text-muted)" }}>{label}</span>
      </div>
      <div style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-xl)", fontWeight: 700, color: tone || "var(--text-default)" }}>{v}</div>
      <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
    </window.Panel>
  );
}

function Meter({ pct, tone }) {
  return (
    <div style={{ height: 8, borderRadius: 999, background: "var(--color-gray-10)", overflow: "hidden", minWidth: 110 }}>
      <div style={{ width: Math.min(100, pct) + "%", height: "100%", background: tone, borderRadius: 999 }} />
    </div>
  );
}

function TenantBudget({ ctx }) {
  const D = getData();
  const [sel, setSel] = React.useState(D.tenants[0].id);
  const t = D.tenants.find((x) => x.id === sel);
  const tot = (k) => D.tenants.reduce((a, x) => a + x[k], 0);
  const usedPct = (x) => (x.fytdSpend / x.fyBudget) * 100;
  const forecastPct = (x) => (x.forecastFy / x.fyBudget) * 100;
  const tone = (x) => (forecastPct(x) > 100 ? "var(--theme-error-dark)" : forecastPct(x) > 90 ? "#c2850c" : "var(--theme-success-dark)");
  const overs = D.tenants.filter((x) => forecastPct(x) > 100);
  const open = (tid) => D.pipeline.filter((p) => p.tenant.startsWith(D.tenants.find((x) => x.id === tid).name.split(" — ")[0]) && p.state !== "live");

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18 }}>
        <KPI icon="account_balance" label="FY26 allocated" v={money(tot("fyBudget"))} sub="Across 5 tenants" />
        <KPI icon="trending" label="FYTD spend" v={money(tot("fytdSpend"))} sub={Math.round((tot("fytdSpend") / tot("fyBudget")) * 100) + "% of allocation"} />
        <KPI icon="bolt" label="DBUs this month" v={tot("dbusMonth").toLocaleString()} sub={tot("storageTb") + " TB under management"} />
        <KPI icon="warning" label="Tenants over forecast" v={overs.length} sub={overs.length ? overs.map((x) => x.name.split(" — ")[0]).join(", ") : "All within allocation"} tone={overs.length ? "var(--theme-error-dark)" : "var(--theme-success-dark)"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
        <window.Panel pad={0} style={{ overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "var(--surface-subtle)", borderBottom: "1px solid var(--border-default)" }}>
              <tr><th style={th}>Tenant</th><th style={th}>FY budget</th><th style={th}>FYTD spend</th><th style={th}>Utilization</th><th style={th}>FY forecast</th><th style={th}>Users</th></tr>
            </thead>
            <tbody>
              {D.tenants.map((x) => {
                const on = x.id === sel;
                return (
                  <tr key={x.id} onClick={() => setSel(x.id)} style={{ cursor: "pointer", background: on ? "var(--color-blue-5v)" : "transparent", borderBottom: "1px solid var(--border-default)" }}>
                    <td style={td}>
                      <div style={{ fontWeight: 700 }}>{x.name.split(" — ")[0]}</div>
                      <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>{x.lead}</div>
                    </td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)" }}>{money(x.fyBudget)}</td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)" }}>{money(x.fytdSpend)}</td>
                    <td style={td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Meter pct={usedPct(x)} tone={tone(x)} />
                        <span style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700 }}>{Math.round(usedPct(x))}%</span>
                      </div>
                    </td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)", fontWeight: 700, color: tone(x) }}>
                      {money(x.forecastFy)} ({Math.round(forecastPct(x))}%)
                    </td>
                    <td style={{ ...td, fontSize: "var(--font-size-3xs)" }}>{x.users}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </window.Panel>

        <window.Panel pad={18}>
          <div style={{ fontFamily: "var(--font-heading)", fontSize: "var(--font-size-sm)", fontWeight: 700, marginBottom: 2 }}>{t.name.split(" — ")[0]}</div>
          <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)", marginBottom: 14 }}>{t.name.split(" — ")[1]} · Lead {t.lead}</div>
          <div style={{ display: "grid", gap: 2 }}>
            <Row k="FY26 allocation" v={money(t.fyBudget)} />
            <Row k="FYTD spend" v={money(t.fytdSpend)} />
            <Row k="Month to date" v={money(t.mtdSpend)} />
            <Row k="FY forecast" v={<span style={{ color: tone(t), fontWeight: 700 }}>{money(t.forecastFy)}</span>} />
            <Row k="Variance to budget" v={<span style={{ color: tone(t), fontWeight: 700 }}>{(t.forecastFy > t.fyBudget ? "+" : "−") + money(Math.abs(t.forecastFy - t.fyBudget))}</span>} />
            <Row k="DBUs / month" v={t.dbusMonth.toLocaleString()} />
            <Row k="Storage" v={t.storageTb + " TB"} />
            <Row k="Entitled users" v={t.users} />
            <Row k="Datasets owned" v={t.datasets} />
          </div>
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border-default)" }}>
            <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, marginBottom: 8 }}>Open pipeline items</div>
            {open(t.id).length ? open(t.id).map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", fontSize: "var(--font-size-3xs)" }}>
                <span>{p.title}</span>
                <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{PSTATE[p.state].label}</span>
              </div>
            )) : <div style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>No items in flight.</div>}
          </div>
          <button onClick={() => ctx.flash("Chargeback statement exported for " + t.name.split(" — ")[0])} style={{ ...outlineBtn, width: "100%", justifyContent: "center", padding: 10, marginTop: 14 }}>
            <AppIcon name="description" size={16} color="var(--theme-primary)" /> Export chargeback statement
          </button>
        </window.Panel>
      </div>
    </div>
  );
}

Object.assign(window, { AdminScreen });
