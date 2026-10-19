/* eslint-disable react-refresh/only-export-components -- this is a widget
   registry module, not a Fast Refresh boundary: it deliberately exports the
   `edpWidgets` map alongside the widget components it collects. */
// The EDP intake widget set referenced by intake.config.json step layouts
// (docs/build-plan-p1.md §2). These are the schema-referenced, IRS-specific
// pieces the generic <SchemaForm> defers to: the architecture diagram, the
// AI-assisted sizing estimator, the review summary and the contextual note
// boxes. They read/write the shared form state through the widget ctx and reuse
// the ctx-supplied Icon/Pill chrome, so they render identically in the app
// (wired to AppIcon/Pill) and under test (with the headless defaults).

import React from "react";
import {
  computeRoi,
  estimateSizing,
  fmtUsd,
  readNumber,
  resolveSelections,
  OTHER_DOMAIN,
  type IntakeDatasetInput,
  type IntakeInitiativeOwner,
  type RoiResult,
  type SizingResult,
} from "../../schema";
import { FeatureGate } from "../../features/FeatureGate";
import type { SchemaFormWidgetCtx, WidgetComponent } from "./SchemaForm";
import { ArchDiagram, MiniStat, RevRow } from "./atoms";

// ---- shared derivation ----------------------------------------------------

interface Derived {
  selections: ReturnType<typeof resolveSelections>;
  sizing: SizingResult;
  roi: RoiResult;
  domainName: string;
  sourceSystem: string;
}

function derive(ctx: SchemaFormWidgetCtx): Derived {
  const { schema, values } = ctx;
  const selections = resolveSelections(schema, values);
  const sizing = estimateSizing(schema, {
    sizeGb: readNumber(values["sizeGb"]) || 0,
    freq: String(values["freq"] ?? ""),
    complexity: String(values["complexity"] ?? ""),
    users: readNumber(values["users"]) || 0,
  });
  const roi = computeRoi(readNumber(values["annualBenefit"]) || 0, sizing.annualCost);
  return {
    selections,
    sizing,
    roi,
    domainName: ctx.optionLabel("domain"),
    sourceSystem: String(values["sourceSystem"] ?? ""),
  };
}

// ---- shared styles --------------------------------------------------------

const noteBox: React.CSSProperties = {
  marginTop: 18,
  padding: "12px 16px",
  background: "var(--color-blue-5v)",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--font-size-2xs)",
  color: "var(--color-blue-warm-70v)",
  display: "flex",
  gap: 10,
  alignItems: "center",
  lineHeight: 1.5,
};

const intro: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  margin: "0 0 18px",
  lineHeight: 1.55,
};

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  background: "var(--theme-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius-md)",
  padding: "11px 20px",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
};

// ---- widgets --------------------------------------------------------------

const FtiNote: WidgetComponent = ({ ctx }) => (
  <div style={noteBox}>
    <ctx.Icon name="info" size={18} color="var(--theme-primary)" />
    Federal tax information (FTI) adds an IRS Publication 1075 safeguards review to the intake path.
  </div>
);

const ArchitectureIntro: WidgetComponent = () => (
  <p style={intro}>
    Pick how the data reaches EDP and how it will be consumed. Approved patterns move straight to
    intake; anything else requires an architecture consultation.
  </p>
);

const ArchDiagramWidget: WidgetComponent = ({ ctx }) => {
  const { selections, domainName, sourceSystem } = derive(ctx);
  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontSize: "var(--font-size-3xs)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--text-muted)",
          marginBottom: 10,
        }}
      >
        Architecture diagram
      </div>
      <ArchDiagram
        source={sourceSystem || "Source system"}
        ingest={selections.patternDef}
        domainName={domainName}
        access={selections.accessDef}
        Icon={ctx.Icon}
      />
    </div>
  );
};

const ArchitectureNote: WidgetComponent = ({ ctx }) => {
  const { needsConsult } = derive(ctx).selections;
  return (
    <div
      style={
        needsConsult
          ? {
              ...noteBox,
              background: "var(--color-orange-5v)",
              color: "var(--theme-accent-warm-darker)",
            }
          : {
              ...noteBox,
              background: "var(--theme-success-lighter)",
              color: "var(--theme-success-darker)",
            }
      }
    >
      <ctx.Icon
        name={needsConsult ? "info" : "check_circle"}
        size={18}
        color={needsConsult ? "var(--theme-accent-warm-dark)" : "var(--theme-success-dark)"}
      />
      {needsConsult
        ? "This design falls outside the approved patterns — an EDP architecture consultation will be added to the approval path."
        : "This design uses approved patterns only — no architecture consultation needed."}
    </div>
  );
};

const DeliveryIntro: WidgetComponent = () => (
  <p style={intro}>
    Tell us whether you need help with data engineering. Requesting platform-team involvement
    reserves EDP engineering capacity and is weighed at the intake CCB.
  </p>
);

const DeliveryNote: WidgetComponent = ({ ctx }) => {
  const { engDef } = derive(ctx).selections;
  return (
    <div
      style={
        engDef.platform
          ? { ...noteBox, background: "var(--color-blue-5v)", color: "var(--theme-primary)" }
          : {
              ...noteBox,
              background: "var(--theme-success-lighter)",
              color: "var(--theme-success-darker)",
            }
      }
    >
      <ctx.Icon
        name={engDef.platform ? "group" : "check_circle"}
        size={18}
        color={engDef.platform ? "var(--theme-primary)" : "var(--theme-success-dark)"}
      />
      {engDef.platform
        ? "EDP platform engineering will be engaged — a data engineering capacity review is added to the approval path."
        : "Self-service build — you get the approved pattern templates, guidelines and reference notebooks; no platform engineering queue."}
    </div>
  );
};

const BusinessNote: WidgetComponent = ({ ctx }) => {
  const { leverLabels } = derive(ctx).selections;
  const levers = Array.isArray(ctx.values["levers"]) ? (ctx.values["levers"] as string[]) : [];
  const annualBenefit = readNumber(ctx.values["annualBenefit"]) || 0;
  const hoursSaved = readNumber(ctx.values["hoursSaved"]) || 0;
  return (
    <div
      style={{
        ...noteBox,
        background: "var(--theme-success-lighter)",
        color: "var(--theme-success-darker)",
      }}
    >
      <ctx.Icon name="check_circle" size={18} color="var(--theme-success-dark)" />
      {levers.length
        ? `Mission ROI basis: ${leverLabels.join(" · ")} — ${fmtUsd(annualBenefit)}/yr plus ${hoursSaved.toLocaleString()} staff hours reclaimed. Scored against the sizing estimate in the next step.`
        : "Select at least one mission value lever to continue."}
    </div>
  );
};

const SizingEstimator: WidgetComponent = ({ ctx }) => {
  const [estimating, setEstimating] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const { sizing, roi } = derive(ctx);
  const estimated = ctx.values["estimated"] === true;
  const sizeGb = readNumber(ctx.values["sizeGb"]) || 0;
  const freq = String(ctx.values["freq"] ?? "");
  const complexity = String(ctx.values["complexity"] ?? "");
  const users = readNumber(ctx.values["users"]) || 0;

  const runEstimate = () => {
    setEstimating(true);
    ctx.setValue("estimated", false);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setEstimating(false);
      ctx.setValue("estimated", true);
    }, 900);
  };

  return (
    <div>
      <button
        type="button"
        onClick={runEstimate}
        disabled={estimating}
        style={{ ...primaryBtn, marginTop: 20, opacity: estimating ? 0.6 : 1 }}
      >
        <ctx.Icon name="tune" size={17} color="#fff" />{" "}
        {estimating ? "Estimating…" : estimated ? "Re-run AI sizing" : "Run AI sizing"}
      </button>

      {estimated && !estimating ? (
        <div
          style={{
            marginTop: 20,
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "var(--color-gray-cool-2)",
              borderBottom: "1px solid var(--border-default)",
              padding: "12px 18px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <ctx.Icon name="info" size={16} color="var(--theme-primary)" />
            <strong style={{ fontSize: "var(--font-size-2xs)" }}>
              Recommended sizing — {sizing.tier}
            </strong>
            <span style={{ marginLeft: "auto" }}>
              <ctx.Pill bg="var(--color-blue-5v)" fg="var(--theme-primary)">
                {sizing.confidence}% confidence
              </ctx.Pill>
            </span>
          </div>
          <div
            style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}
          >
            <MiniStat n={`${sizing.storageTb} TB`} l="Managed storage" />
            <MiniStat n={sizing.cluster} l="Pipeline cluster" />
            <MiniStat n={`${sizing.dbu.toLocaleString()}`} l="DBU / month" />
            <MiniStat n={sizing.warehouse} l="SQL warehouse" />
          </div>
          <div
            style={{
              padding: "0 18px 18px",
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 16,
            }}
          >
            <MiniStat n={fmtUsd(sizing.monthlyCost)} l="Est. monthly cost" />
            <MiniStat n={fmtUsd(sizing.annualCost)} l="Est. annual cost" />
            <MiniStat n={`${roi.ratio}x`} l={`ROI · payback ${roi.paybackMonths} mo`} />
          </div>
          <div
            style={{
              borderTop: "1px dashed var(--border-strong)",
              padding: "14px 18px",
              fontSize: "var(--font-size-3xs)",
              color: "var(--text-muted)",
              lineHeight: 1.55,
            }}
          >
            Derived from {sizeGb.toLocaleString()} GB at {freq.toLowerCase()} cadence,{" "}
            {complexity.toLowerCase()} transformations and {users} concurrent-capable query users.
            Estimates are indicative and re-validated by capacity approval.
          </div>
        </div>
      ) : null}
      {!estimated && !estimating ? (
        <div style={{ ...noteBox, marginTop: 18 }}>
          <ctx.Icon name="info" size={18} color="var(--theme-primary)" />
          Run the sizing estimate to continue — intake review requires a capacity and cost figure.
        </div>
      ) : null}
    </div>
  );
};

const ReviewSummary: WidgetComponent = ({ ctx }) => {
  const { values, Icon } = ctx;
  const { selections, sizing, roi, domainName, sourceSystem } = derive(ctx);
  const { patternDef, accessDef, engDef, outcomeDef, leverLabels, needsConsult } = selections;
  const dataName = String(values["dataName"] ?? "");
  const sensitivity = String(values["sensitivity"] ?? "");
  const owner = values["initiativeOwner"] as IntakeInitiativeOwner | null | undefined;
  const priority = String(values["priority"] ?? "");
  const annualBenefit = readNumber(values["annualBenefit"]) || 0;
  const sizeGb = readNumber(values["sizeGb"]) || 0;
  const freq = String(values["freq"] ?? "");
  const complexity = String(values["complexity"] ?? "");
  const users = readNumber(values["users"]) || 0;

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <RevRow
          icon="database"
          title={dataName}
          sub={`${sourceSystem} → ${domainName} · ${sensitivity}`}
          Icon={Icon}
        />
        <RevRow
          icon="person"
          title={`Initiative owner: ${
            owner?.kind === "self"
              ? "Myself"
              : owner?.kind === "someone-else"
                ? `${owner.name.trim()} (${owner.email.trim()})`
                : "not chosen"
          }`}
          sub={
            owner?.kind === "self"
              ? "Verified: the account you're signed in with"
              : "Not verified: the app can't confirm who this person is yet"
          }
          Icon={Icon}
        />
        <RevRow icon="bolt" title={`Priority: ${priority}`} sub={outcomeDef.name} Icon={Icon} />
        <RevRow
          icon="check_circle"
          title={`Mission ROI ${roi.ratio}x — ${outcomeDef.name}`}
          sub={`${leverLabels.join(" · ")} · ${fmtUsd(annualBenefit)} benefit vs. ${fmtUsd(
            sizing.annualCost,
          )} annual platform cost`}
          Icon={Icon}
        />
        <RevRow
          icon="tune"
          title={`Sizing — ${sizing.tier}`}
          sub={`${sizeGb.toLocaleString()} GB · ${freq} · ${complexity} · ${users} query users`}
          Icon={Icon}
        />
        <RevRow
          icon="group"
          title={`Delivery — ${engDef.name}`}
          sub={
            engDef.platform
              ? "EDP platform engineering support requested"
              : "Tenant-built using approved patterns and guidelines"
          }
          Icon={Icon}
        />
        <RevRow
          icon="database"
          title={`Architecture — ${patternDef.name}`}
          sub={`${accessDef.name} · ${needsConsult ? "architecture consultation required" : "approved patterns"}`}
          Icon={Icon}
        />
        <ReviewExtension ctx={ctx} />
      </div>
      <div style={{ marginTop: 18 }}>
        <ArchDiagram
          source={sourceSystem || "Source system"}
          ingest={patternDef}
          domainName={domainName}
          access={accessDef}
          Icon={Icon}
        />
      </div>
      <div
        style={{
          display: "flex",
          gap: 20,
          justifyContent: "center",
          marginTop: 20,
          padding: "14px 24px",
          background: "var(--color-gray-cool-1)",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-default)",
        }}
      >
        <MiniStat n={fmtUsd(sizing.monthlyCost)} l="Monthly cost" />
        <MiniStat n={`${roi.ratio}x`} l="ROI" />
        <MiniStat n={`${roi.paybackMonths} mo`} l="Payback" />
        <MiniStat n={needsConsult ? "5 steps" : "4 steps"} l="Approval path" />
      </div>
    </div>
  );
};

const DatasetsIntro: WidgetComponent = () => (
  <p style={intro}>
    List every dataset this initiative brings onto EDP. A dataset can sit in any domain; if none
    fits, choose Other. The dataset tag labels the dataset's data in EDP.
  </p>
);

const WorkspaceIntro: WidgetComponent = () => (
  <p style={intro}>
    A couple of questions about how your team works. EDP uses your answers to decide whether you
    need dedicated workspaces — you don't need to know how the platform is set up.
  </p>
);

const WorkspaceCriteria: WidgetComponent = ({ ctx }) => (
  <div style={{ marginTop: 18 }}>
    <FeatureGate id="dedicated-workspace-criteria">
      {/* Right padding leaves room for the gate's "Not yet implemented" badge. */}
      <div style={{ ...noteBox, marginTop: 0, paddingRight: 190 }}>
        <ctx.Icon name="info" size={18} color="var(--theme-primary)" />
        Dedicated workspaces: EDP will decide from your answers. The decision criteria aren't
        defined yet.
      </div>
    </FeatureGate>
  </div>
);

const ComputePolicyOverview: WidgetComponent = ({ ctx }) => {
  const policy = ctx.schema.computePolicy;
  if (!policy) return null;
  return (
    <section
      aria-label={policy.title}
      style={{
        marginTop: 22,
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ctx.Icon name="tune" size={18} color="var(--theme-primary)" />
        <strong style={{ fontSize: "var(--font-size-2xs)" }}>{policy.title}</strong>
        <span style={{ marginLeft: "auto" }}>
          <ctx.Pill bg="var(--color-gray-5)" fg="var(--color-gray-cool-70)">
            Overview only
          </ctx.Pill>
        </span>
      </div>
      <p style={{ ...intro, margin: "8px 0 12px" }}>{policy.summary}</p>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          gap: "6px 16px",
        }}
      >
        {policy.items.map((item) => (
          <React.Fragment key={item.label}>
            <dt style={{ fontSize: "var(--font-size-3xs)", fontWeight: 700 }}>{item.label}</dt>
            <dd style={{ margin: 0, fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}>
              {item.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p style={{ ...intro, margin: "12px 0 10px", color: "var(--text-default)" }}>
        {policy.changeNote}
      </p>
      <FeatureGate id="compute-policy-change-requests">
        <button type="button" style={{ ...primaryBtn, padding: "8px 14px" }}>
          Request a compute policy change
        </button>
      </FeatureGate>
    </section>
  );
};

function domainLabel(ctx: SchemaFormWidgetCtx, domain: string): string {
  if (domain === OTHER_DOMAIN) return "Other domain";
  return ctx.dynamicOptions["domains"]?.find((o) => o.value === domain)?.label ?? domain;
}

/** Review rows for the #86 extension: each dataset with its owners, then the workspace needs. */
function ReviewExtension({ ctx }: { ctx: SchemaFormWidgetCtx }) {
  const datasets = Array.isArray(ctx.values["datasets"])
    ? (ctx.values["datasets"] as IntakeDatasetInput[])
    : [];
  const isolation = String(ctx.values["isolation"] ?? "");
  const teamSize = readNumber(ctx.values["teamSize"]) || 0;
  return (
    <>
      {datasets.map((dataset, i) => (
        <RevRow
          key={i}
          icon="database"
          title={`Dataset — ${dataset.name}`}
          sub={`${domainLabel(ctx, dataset.domain)} · tag ${dataset.datasetTag} · owners: ${dataset.owners
            .map((o) => `${o.name} <${o.email}>`)
            .join(", ")}`}
          Icon={ctx.Icon}
        />
      ))}
      {isolation ? (
        <RevRow
          icon="group"
          title={`Workspace needs — team of ${teamSize}`}
          sub={isolation}
          Icon={ctx.Icon}
        />
      ) : null}
    </>
  );
}

/** The widget registry the schema's step layouts reference by id. */
export const edpWidgets: Record<string, WidgetComponent> = {
  ftiNote: FtiNote,
  architectureIntro: ArchitectureIntro,
  archDiagram: ArchDiagramWidget,
  architectureNote: ArchitectureNote,
  deliveryIntro: DeliveryIntro,
  deliveryNote: DeliveryNote,
  businessNote: BusinessNote,
  sizingEstimator: SizingEstimator,
  reviewSummary: ReviewSummary,
  datasetsIntro: DatasetsIntro,
  workspaceIntro: WorkspaceIntro,
  workspaceCriteria: WorkspaceCriteria,
  computePolicyOverview: ComputePolicyOverview,
};
