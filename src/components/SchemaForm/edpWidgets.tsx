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
  type PatternOption,
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
}

function annualBenefitFor(ctx: SchemaFormWidgetCtx): number {
  return Number(ctx.values["annualBenefit"]) || 0;
}

function hasCompleteSizing(values: SchemaFormWidgetCtx["values"]): boolean {
  const frequency = String(values["freq"] ?? "");
  const complexity = String(values["complexity"] ?? "");
  return (
    Number(values["sizeGb"]) > 0 &&
    Number(values["users"]) > 0 &&
    Boolean(frequency) &&
    frequency !== "Not sure" &&
    Boolean(complexity) &&
    complexity !== "Not sure"
  );
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
    Federal tax information (FTI) follows IRS Publication 1075 safeguards. Some datasets may need
    extra restrictions; EDP staff will discuss those needs during review.
  </div>
);

const ArchitectureIntro: WidgetComponent = () => (
  <p style={intro}>
    Choose the primary way people will query or analyze this initiative&apos;s data. You will choose
    how each input dataset reaches the Enterprise Data Platform (EDP) on the Datasets step.
  </p>
);

const ArchDiagramWidget: WidgetComponent = ({ ctx }) => {
  const { selections } = derive(ctx);
  const datasets = Array.isArray(ctx.values["datasets"])
    ? (ctx.values["datasets"] as IntakeDatasetInput[])
    : [];
  const complete =
    datasets.length > 0 &&
    datasets.every((dataset) => dataset.sourceSystem?.trim() && dataset.ingestionMethod?.trim());
  if (!complete)
    return (
      <p style={intro}>
        The architecture diagram appears once each dataset has a source system and ingestion method.
      </p>
    );
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
      {datasets.map((dataset) => (
        <div key={dataset.id ?? dataset.datasetTag} style={{ marginTop: 12 }}>
          <ArchDiagram
            source={dataset.sourceSystem!}
            ingest={diagramIngestPattern(ctx, dataset.ingestionMethod)}
            domainName={domainLabel(ctx, dataset.domain)}
            access={selections.accessDef}
            Icon={ctx.Icon}
          />
        </div>
      ))}
    </div>
  );
};

const ArchitectureNote: WidgetComponent = ({ ctx }) => {
  const datasets = Array.isArray(ctx.values["datasets"])
    ? (ctx.values["datasets"] as IntakeDatasetInput[])
    : [];
  if (
    !datasets.length ||
    datasets.some((dataset) => !dataset.sourceSystem?.trim() || !dataset.ingestionMethod?.trim())
  )
    return null;
  const selections = derive(ctx).selections;
  const needsConsult =
    !selections.accessDef.approved ||
    datasets.some(
      (dataset) =>
        !ctx.schema.optionLists.ingestPatterns.find(
          (pattern) => pattern.id === dataset.ingestionMethod,
        )?.approved,
    );
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
    Tell us who will build the pipelines. Your own resources may include IRS employees, contractors,
    or implementation partners. Requests for EDP engineering support are reviewed for available
    capacity.
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
        ? `Mission value basis: ${leverLabels.join(" · ")} — ${annualBenefit > 0 ? `${fmtUsd(annualBenefit)}/yr` : "estimated annual benefit is required"}${hoursSaved > 0 ? ` plus ${hoursSaved.toLocaleString()} staff hours reclaimed` : ""}. Compared with the preliminary sizing estimate in the next step.`
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
  const complete = hasCompleteSizing(ctx.values);

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
        {estimating
          ? "Estimating…"
          : estimated
            ? "Re-run preliminary estimate"
            : "Run preliminary estimate"}
      </button>

      {estimated && !estimating && !complete ? (
        <div style={{ ...noteBox, marginTop: 18 }} role="status">
          <ctx.Icon name="info" size={18} color="var(--theme-primary)" />
          <strong>Estimate pending — EDP staff will refine.</strong>&nbsp;Capacity, cost, and ROI
          stay pending until volume, frequency, transformation complexity, and query users are
          known.
        </div>
      ) : null}
      {estimated && !estimating && complete ? (
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
              Preliminary capacity estimate — {sizing.tier}
            </strong>
            <span style={{ marginLeft: "auto" }}>
              <ctx.Pill bg="var(--color-blue-5v)" fg="var(--theme-primary)">
                EDP staff will revalidate
              </ctx.Pill>
            </span>
          </div>
          <div
            style={{
              padding: 18,
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 16,
            }}
          >
            <MiniStat n={`${sizing.storageTb} TB`} l="Preliminary managed storage" />
            <MiniStat n={fmtUsd(sizing.monthlyCost)} l="Preliminary monthly cost" />
            <MiniStat n={fmtUsd(sizing.annualCost)} l="Preliminary annual cost" />
            <MiniStat
              n={annualBenefitFor(ctx) > 0 ? `${roi.ratio}x` : "Pending"}
              l={
                annualBenefitFor(ctx) > 0
                  ? `ROI · payback ${roi.paybackMonths} mo`
                  : "ROI not yet available"
              }
            />
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
            This initiative-level estimate is preliminary. EDP staff will revalidate capacity and
            cost before provisioning.
          </div>
        </div>
      ) : null}
      {!estimated && !estimating ? (
        <div style={{ ...noteBox, marginTop: 18 }}>
          <ctx.Icon name="info" size={18} color="var(--theme-primary)" />
          Run the preliminary estimate to continue. Unknown answers are accepted and flagged for EDP
          staff to refine.
        </div>
      ) : null}
    </div>
  );
};

const ReviewSummary: WidgetComponent = ({ ctx }) => {
  const { values, Icon } = ctx;
  const { selections, sizing, roi } = derive(ctx);
  const { accessDef, engDef, outcomeDef, leverLabels } = selections;
  const dataName = String(values["dataName"] ?? "");
  const owner = values["initiativeOwner"] as IntakeInitiativeOwner | null | undefined;
  const annualBenefit = readNumber(values["annualBenefit"]) || 0;
  const sizeGb = readNumber(values["sizeGb"]) || 0;
  const freq = String(values["freq"] ?? "");
  const complexity = String(values["complexity"] ?? "");
  const users = readNumber(values["users"]) || 0;
  const completeSizing = hasCompleteSizing(values);
  const inputDatasets = Array.isArray(values["datasets"])
    ? (values["datasets"] as IntakeDatasetInput[])
    : [];
  const architectureComplete =
    inputDatasets.length > 0 &&
    inputDatasets.every(
      (dataset) => dataset.sourceSystem?.trim() && dataset.ingestionMethod?.trim(),
    );
  const consultationDetails = (
    [
      ["Data access", values["accessConsultDetails"]],
      ["Engineering support", values["deliverySupportDetails"]],
      ["Workspace", values["isolationReason"]],
      ...inputDatasets.map(
        (dataset, index) =>
          [`Dataset ${index + 1} ingestion`, dataset.ingestionDetails] as [string, unknown],
      ),
    ] as Array<[string, unknown]>
  ).flatMap(([name, detail]) =>
    typeof detail === "string" && detail.trim() ? [[name, detail.trim()] as [string, string]] : [],
  );
  const needsConsult =
    !accessDef.approved ||
    inputDatasets.some(
      (dataset) =>
        !ctx.schema.optionLists.ingestPatterns.find(
          (pattern) => pattern.id === dataset.ingestionMethod,
        )?.approved,
    );

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <RevRow
          icon="database"
          title={dataName}
          sub={`${inputDatasets.length} input dataset${inputDatasets.length === 1 ? "" : "s"} · access through ${accessDef.name}`}
          Icon={Icon}
        />
        <RevRow
          icon="person"
          title={`Initiative point of contact: ${
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
        <RevRow
          icon="check_circle"
          title={
            outcomeDef
              ? annualBenefit > 0 && completeSizing
                ? `Mission ROI ${roi.ratio}x — ${outcomeDef.name}`
                : `Mission value — ${outcomeDef.name}`
              : "Mission value — Primary outcome: not chosen"
          }
          sub={
            annualBenefit > 0 && completeSizing
              ? `${leverLabels.join(" · ")} · ${fmtUsd(annualBenefit)} benefit vs. ${fmtUsd(sizing.annualCost)} preliminary annual platform cost`
              : `${leverLabels.join(" · ")} · ROI unavailable — estimated annual benefit is required`
          }
          Icon={Icon}
        />
        <RevRow
          icon="tune"
          title={
            completeSizing
              ? `Preliminary initiative sizing — ${sizing.tier}`
              : "Initiative sizing — Pending"
          }
          sub={
            completeSizing
              ? `${sizeGb.toLocaleString()} GB · ${freq} · ${complexity} · ${users} query users · EDP staff will revalidate`
              : "Estimate pending — EDP staff will refine volume, frequency, transformation complexity, query users, capacity, and cost."
          }
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
          title={`Architecture — ${inputDatasets
            .map((dataset) => schemaPatternName(ctx, dataset.ingestionMethod))
            .join("; ")}`}
          sub={`${accessDef.name} · ${needsConsult ? "architecture consultation required" : "approved patterns"}`}
          Icon={Icon}
        />
        {consultationDetails.length > 0 ? (
          <RevRow
            icon="info"
            title="Context for EDP follow-up"
            sub={consultationDetails.map(([name, detail]) => `${name}: ${detail}`).join(" · ")}
            Icon={Icon}
          />
        ) : null}
        <ReviewExtension ctx={ctx} />
      </div>
      <div style={{ marginTop: 18 }}>
        {!architectureComplete ? (
          <p style={intro}>
            The architecture diagram appears once each dataset has a source system and ingestion
            method.
          </p>
        ) : null}
        {architectureComplete
          ? inputDatasets.map((dataset) => (
              <div key={dataset.id ?? dataset.datasetTag} style={{ marginTop: 12 }}>
                <ArchDiagram
                  source={dataset.sourceSystem!}
                  ingest={diagramIngestPattern(ctx, dataset.ingestionMethod)}
                  domainName={domainLabel(ctx, dataset.domain)}
                  access={accessDef}
                  Icon={Icon}
                />
              </div>
            ))
          : null}
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
        <MiniStat n={completeSizing ? fmtUsd(sizing.monthlyCost) : "Pending"} l="Monthly cost" />
        <MiniStat n={annualBenefit > 0 && completeSizing ? `${roi.ratio}x` : "Pending"} l="ROI" />
        <MiniStat
          n={annualBenefit > 0 && completeSizing ? `${roi.paybackMonths} mo` : "Pending"}
          l="Payback"
        />
      </div>
      <div style={{ ...noteBox, alignItems: "flex-start" }}>
        <Icon name="check_circle" size={18} color="var(--theme-primary)" />
        <span>
          <strong>Approval path:</strong> EDP business office reviews business value and preliminary
          ROI; the Change Control Board decides whether to onboard; EDP staff then set up approved
          resources.
          {needsConsult ? " EDP architecture staff will consult on the proposed path first." : ""}
        </span>
      </div>
    </div>
  );
};

const DatasetsIntro: WidgetComponent = () => (
  <p style={intro}>
    Before submitting, check whether the data is already available in EDP. For every new input
    dataset, identify its source, domain, ingestion method, tag, and owners.
  </p>
);

const WorkspaceIntro: WidgetComponent = () => (
  <p style={intro}>
    Most teams work in shared workspaces while data permissions remain separate. Tell us whether the
    code, notebooks, dashboard names, or their contents must be hidden from other EDP teams. EDP
    staff use your answer and reason to assess the rare dedicated-workspace case.
  </p>
);

const WorkspaceCriteria: WidgetComponent = ({ ctx }) => (
  <div style={{ marginTop: 18 }}>
    <FeatureGate id="dedicated-workspace-criteria">
      {/* Right padding leaves room for the gate's "Not yet implemented" badge. */}
      <div style={{ ...noteBox, marginTop: 0, paddingRight: 190 }}>
        <ctx.Icon name="info" size={18} color="var(--theme-primary)" />
        Dedicated-workspace decisions are reviewed by EDP staff. This form records the need and
        rationale; it does not automatically approve or provision a dedicated workspace.
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
  if (domain === OTHER_DOMAIN) return "No domain fits — proposed domain needs EDP consultation";
  return ctx.dynamicOptions["domains"]?.find((o) => o.value === domain)?.label ?? domain;
}

/** Review rows for the #86 extension: each dataset with its owners, then the workspace needs. */
function ReviewExtension({ ctx }: { ctx: SchemaFormWidgetCtx }) {
  const datasets = Array.isArray(ctx.values["datasets"])
    ? (ctx.values["datasets"] as IntakeDatasetInput[])
    : [];
  const isolation = String(ctx.values["isolation"] ?? "");
  const isolationReason = String(ctx.values["isolationReason"] ?? "");
  const teamSize = readNumber(ctx.values["teamSize"]) || 0;
  return (
    <>
      {datasets.map((dataset, i) => (
        <RevRow
          key={i}
          icon="database"
          title={`Dataset — ${dataset.name}`}
          sub={`${domainLabel(ctx, dataset.domain)} · ${schemaPatternName(ctx, dataset.ingestionMethod)} · tag ${dataset.datasetTag} · owners: ${dataset.owners
            .map((o) => `${o.name} <${o.email}>`)
            .join(", ")}`}
          Icon={ctx.Icon}
        />
      ))}
      {isolation ? (
        <RevRow
          icon="group"
          title={`Workspace needs — team of ${teamSize}`}
          sub={`${isolation}${isolationReason ? ` · Reason: ${isolationReason}` : " · No reason provided"} · Data permissions remain separate`}
          Icon={ctx.Icon}
        />
      ) : null}
    </>
  );
}

/**
 * A dataset's ingestion pattern as its diagram lane draws it. An id the schema
 * doesn't list (a stored answer no wizard offered) draws as not chosen and
 * needing consultation, never as an approved pattern.
 */
function diagramIngestPattern(ctx: SchemaFormWidgetCtx, id: string | undefined): PatternOption {
  return (
    ctx.schema.optionLists.ingestPatterns.find((pattern) => pattern.id === id) ?? {
      id: id ?? "",
      name: "Not chosen — needs consultation",
      desc: "",
      approved: false,
      box: "Not chosen — needs consultation",
    }
  );
}

function schemaPatternName(ctx: SchemaFormWidgetCtx, id: string | undefined): string {
  return (
    ctx.schema.optionLists.ingestPatterns.find((pattern) => pattern.id === id)?.name ??
    "Ingestion method not provided"
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
