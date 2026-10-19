// EDP admin editor — live, repo-backed schema editing (docs/build-plan-p1.md
// §2, OQ-7; GitHub #5).
//
// An EDP admin edits the IntakeSchema WITHOUT touching code: the highest-churn
// surfaces first — option-lists (ingest/access patterns, ENG models, ROI
// levers), field labels/required flags, and the sizing coefficients
// (FREQ_FACTOR/CPLX_FACTOR). Edits are held in in-app React state (a deep clone
// of the loaded schema); the live <SchemaForm> preview re-renders from that
// edited state. Nothing is written to the repo/prod at runtime: on Save the
// injected SchemaSaveHandler emits a PR-ready config diff + the full new
// intake.config.json (the P1 default handler; a later phase swaps in a Delta/UC
// writer through the same seam). Step/field STRUCTURE editing (add/reorder) is
// an explicit later-phase stub here, as the build plan allows.

import React from "react";
import {
  PendingActionButton,
  PendingActionStatus,
  usePendingActionGroup,
} from "@/components/PendingAction";
import { loadSchema, type FieldDef, type IntakeSchema } from "../../schema";
import { diffOnlySaveHandler, cloneSchema, type SchemaSaveResult } from "../../schema/store";
import {
  SchemaForm,
  edpWidgets,
  type DynamicOption,
  type IconComponent,
  type PillComponent,
} from "../SchemaForm";
import { applyEdit, type EditAction, type PatternListName } from "./reducer";
import "./AdminEditor.css";

// ---- chrome (injectable, headless-safe like <SchemaForm>) -----------------

export interface AdminEditorChrome {
  Panel: React.ComponentType<{
    pad?: number;
    children?: React.ReactNode;
    style?: React.CSSProperties;
  }>;
  SectionHead: React.ComponentType<{ title: string; eyebrow?: string | undefined }>;
  StepIndicator: React.ComponentType<{ steps: string[]; step: number }>;
  Icon: IconComponent;
  Pill: PillComponent;
}

const DefaultIcon: IconComponent = () => null;
const DefaultPill: PillComponent = ({ children }) => <span>{children}</span>;
const DefaultPanel: AdminEditorChrome["Panel"] = ({ children, style }) => (
  <div style={style}>{children}</div>
);
const DefaultSectionHead: AdminEditorChrome["SectionHead"] = ({ title, eyebrow }) => (
  <div>
    {eyebrow ? <div>{eyebrow}</div> : null}
    <h2>{title}</h2>
  </div>
);
const DefaultStepIndicator: AdminEditorChrome["StepIndicator"] = ({ steps, step }) => (
  <ol>
    {steps.map((label, i) => (
      <li key={label} aria-current={i === step ? "step" : undefined}>
        {label}
      </li>
    ))}
  </ol>
);

function PreviewStepIndicator({
  StepIndicator,
  ...props
}: React.ComponentProps<AdminEditorChrome["StepIndicator"]> & {
  StepIndicator: AdminEditorChrome["StepIndicator"];
}) {
  return (
    <div
      className="admin-editor__step-indicator"
      tabIndex={0}
      role="region"
      aria-label="Preview steps"
    >
      <StepIndicator {...props} />
    </div>
  );
}

// ---- props ----------------------------------------------------------------

export interface AdminEditorProps {
  /** the schema to start from; defaults to loadSchema() (the read seam) */
  initialSchema?: IntakeSchema;
  /** the write seam; defaults to the P1 diff-only handler (no runtime write) */
  saveHandler?: (
    original: IntakeSchema,
    edited: IntakeSchema,
  ) => SchemaSaveResult | Promise<SchemaSaveResult>;
  /** runtime option lists for the preview's dynamic fields (e.g. domains) */
  previewDynamicOptions?: Record<string, DynamicOption[]>;
  chrome?: Partial<AdminEditorChrome>;
  /** notified on Save with the emitted result (diff + full config) */
  onSaved?: (result: SchemaSaveResult) => void;
}

type EditorTab = "options" | "fields" | "sizing" | "structure" | "preview" | "export";

const TABS: Array<{ id: EditorTab; label: string }> = [
  { id: "options", label: "Option lists" },
  { id: "fields", label: "Fields" },
  { id: "sizing", label: "Sizing coefficients" },
  { id: "structure", label: "Structure" },
  { id: "preview", label: "Live preview" },
  { id: "export", label: "Save & export diff" },
];

const PATTERN_LISTS: Array<{ name: PatternListName; title: string; hasPlatform: boolean }> = [
  { name: "source", title: "Source systems", hasPlatform: false },
  { name: "ingestPatterns", title: "Ingest patterns", hasPlatform: false },
  { name: "accessPatterns", title: "Access patterns", hasPlatform: false },
  { name: "engModels", title: "Engineering delivery models", hasPlatform: true },
];

// ---- styles ---------------------------------------------------------------

const input: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "1.5px solid var(--border-strong)",
  borderRadius: "var(--radius-md)",
  padding: "8px 11px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  background: "var(--surface-default)",
  boxSizing: "border-box",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: "var(--text-muted)",
  marginBottom: 5,
};

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  background: "var(--theme-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius-md)",
  padding: "10px 18px",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
};

const outlineBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "var(--surface-default)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-md)",
  padding: "8px 14px",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  fontFamily: "var(--font-sans)",
  color: "var(--theme-primary)",
  cursor: "pointer",
};

const dangerBtn: React.CSSProperties = {
  ...outlineBtn,
  color: "var(--theme-error-dark)",
  borderColor: "var(--color-red-cool-30v)",
};

const pre: React.CSSProperties = {
  background: "var(--color-gray-cool-90)",
  color: "#e7eef5",
  borderRadius: "var(--radius-md)",
  padding: 16,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-micro)",
  lineHeight: 1.55,
  overflow: "auto",
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
  maxHeight: 420,
  whiteSpace: "pre",
  margin: 0,
};

const optionCard: React.CSSProperties = {
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  padding: 14,
  marginBottom: 12,
  background: "var(--surface-default)",
  minWidth: 0,
};

const rowGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "repeat(auto-fit, minmax(min(100%, max(200px, calc((100% - 12px) / 2))), 1fr))",
  gap: 12,
  marginBottom: 10,
};

const checkRow: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  fontSize: "var(--font-size-2xs)",
  fontWeight: 600,
  cursor: "pointer",
};

// ---- component ------------------------------------------------------------

export function AdminEditor({
  initialSchema,
  saveHandler,
  previewDynamicOptions = {},
  chrome,
  onSaved,
}: AdminEditorProps) {
  const Icon = chrome?.Icon ?? DefaultIcon;
  const Pill = chrome?.Pill ?? DefaultPill;
  const Panel = chrome?.Panel ?? DefaultPanel;
  const SectionHead = chrome?.SectionHead ?? DefaultSectionHead;
  const StepIndicator = chrome?.StepIndicator ?? DefaultStepIndicator;
  const PreviewStepIndicatorWithChrome = React.useMemo<AdminEditorChrome["StepIndicator"]>(
    () => (props) => <PreviewStepIndicator StepIndicator={StepIndicator} {...props} />,
    [StepIndicator],
  );

  // The original (loaded) schema is the immutable diff base; edits live in a
  // separate clone driven by the reducer.
  const [original] = React.useState<IntakeSchema>(() => cloneSchema(initialSchema ?? loadSchema()));
  const [edited, dispatch] = React.useReducer(applyEdit, original, cloneSchema);

  const [tab, setTab] = React.useState<EditorTab>("options");
  const [result, setResult] = React.useState<SchemaSaveResult | null>(null);
  const [previewKey, setPreviewKey] = React.useState(0);
  const [copied, setCopied] = React.useState<string | null>(null);
  const pending = usePendingActionGroup();

  const handler = saveHandler ?? diffOnlySaveHandler;

  const applySaveResult = (res: SchemaSaveResult) => {
    setResult(res);
    setTab("export");
    onSaved?.(res);
  };
  const save = () => {
    if (pending.isRecordPending("admin-intake-editor")) return;
    const maybeResult = handler(original, edited);
    if (maybeResult && typeof (maybeResult as Promise<SchemaSaveResult>).then === "function") {
      void pending
        .run(
          { recordId: "admin-intake-editor", actionId: "save", label: "Saving editor changes" },
          () =>
            (maybeResult as Promise<SchemaSaveResult>).then((res) => {
              applySaveResult(res);
              return res;
            }),
        )
        .catch(() => undefined);
      return;
    }
    applySaveResult(maybeResult as SchemaSaveResult);
  };

  const resetAll = () => {
    dispatch({ kind: "reset", schema: original });
    setResult(null);
    setPreviewKey((k) => k + 1);
  };

  const copy = (text: string, which: string) => {
    // Guarded: clipboard is unavailable in some (test/headless) environments.
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav?.clipboard?.writeText) {
      void nav.clipboard.writeText(text);
      setCopied(which);
    }
  };

  const download = (text: string, filename: string) => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const set = (action: EditAction) => dispatch(action);

  // ---- option-lists tab ---------------------------------------------------
  const renderOptions = () => (
    <div>
      {PATTERN_LISTS.map(({ name, title, hasPlatform }) => (
        <div key={name} style={{ marginBottom: 26 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <h2 style={{ fontSize: "var(--font-size-sm)", fontWeight: 700, margin: 0 }}>{title}</h2>
            <button
              type="button"
              style={outlineBtn}
              onClick={() => set({ kind: "addPattern", list: name })}
            >
              <Icon name="add" size={15} color="var(--theme-primary)" /> Add option
            </button>
          </div>
          {edited.optionLists[name].map((opt) => (
            <div key={opt.id} style={optionCard}>
              <div style={rowGrid}>
                <div>
                  <label style={label} htmlFor={`name-${name}-${opt.id}`}>
                    Name
                  </label>
                  <input
                    id={`name-${name}-${opt.id}`}
                    aria-label={`Name for ${name} option ${opt.id}`}
                    style={input}
                    value={opt.name}
                    onChange={(e) =>
                      set({
                        kind: "setPatternText",
                        list: name,
                        id: opt.id,
                        field: "name",
                        value: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label style={label} htmlFor={`box-${name}-${opt.id}`}>
                    Diagram box label
                  </label>
                  <input
                    id={`box-${name}-${opt.id}`}
                    aria-label={`Box label for ${name} option ${opt.id}`}
                    style={input}
                    value={opt.box}
                    onChange={(e) =>
                      set({
                        kind: "setPatternText",
                        list: name,
                        id: opt.id,
                        field: "box",
                        value: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={label} htmlFor={`desc-${name}-${opt.id}`}>
                  Description
                </label>
                <textarea
                  id={`desc-${name}-${opt.id}`}
                  aria-label={`Description for ${name} option ${opt.id}`}
                  style={{ ...input, resize: "vertical" }}
                  rows={2}
                  value={opt.desc}
                  onChange={(e) =>
                    set({
                      kind: "setPatternText",
                      list: name,
                      id: opt.id,
                      field: "desc",
                      value: e.target.value,
                    })
                  }
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
                <label style={checkRow}>
                  <input
                    type="checkbox"
                    aria-label={`Approved: ${name} option ${opt.id}`}
                    checked={opt.approved}
                    onChange={(e) =>
                      set({
                        kind: "setPatternApproved",
                        list: name,
                        id: opt.id,
                        value: e.target.checked,
                      })
                    }
                  />
                  Approved (no consultation)
                </label>
                {hasPlatform ? (
                  <label style={checkRow}>
                    <input
                      type="checkbox"
                      aria-label={`Platform engineering: ${opt.id}`}
                      checked={opt.platform === true}
                      onChange={(e) =>
                        set({ kind: "setPatternPlatform", id: opt.id, value: e.target.checked })
                      }
                    />
                    Engages platform engineering
                  </label>
                ) : null}
                <span
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--font-size-micro)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {opt.id}
                  </span>
                  <button
                    type="button"
                    style={dangerBtn}
                    aria-label={`Remove ${name} option ${opt.id}`}
                    onClick={() => set({ kind: "removePattern", list: name, id: opt.id })}
                  >
                    <Icon name="delete" size={14} color="var(--theme-error-dark)" /> Remove
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* ROI levers */}
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: "var(--font-size-sm)", fontWeight: 700, margin: 0 }}>
            ROI levers (mission value)
          </h2>
          <button type="button" style={outlineBtn} onClick={() => set({ kind: "addLever" })}>
            <Icon name="add" size={15} color="var(--theme-primary)" /> Add lever
          </button>
        </div>
        {edited.optionLists.roiLevers.map((lever) => (
          <div key={lever.id} style={optionCard}>
            <div style={rowGrid}>
              <div>
                <label style={label} htmlFor={`lever-name-${lever.id}`}>
                  Name
                </label>
                <input
                  id={`lever-name-${lever.id}`}
                  aria-label={`Name for ROI lever ${lever.id}`}
                  style={input}
                  value={lever.name}
                  onChange={(e) =>
                    set({
                      kind: "setLeverText",
                      id: lever.id,
                      field: "name",
                      value: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label style={label} htmlFor={`lever-icon-${lever.id}`}>
                  Icon
                </label>
                <input
                  id={`lever-icon-${lever.id}`}
                  aria-label={`Icon for ROI lever ${lever.id}`}
                  style={input}
                  value={lever.icon}
                  onChange={(e) =>
                    set({
                      kind: "setLeverText",
                      id: lever.id,
                      field: "icon",
                      value: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={label} htmlFor={`lever-measure-${lever.id}`}>
                Measure (how EDP scores it)
              </label>
              <textarea
                id={`lever-measure-${lever.id}`}
                aria-label={`Measure for ROI lever ${lever.id}`}
                style={{ ...input, resize: "vertical" }}
                rows={2}
                value={lever.measure}
                onChange={(e) =>
                  set({
                    kind: "setLeverText",
                    id: lever.id,
                    field: "measure",
                    value: e.target.value,
                  })
                }
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-micro)",
                  color: "var(--text-muted)",
                  marginLeft: "auto",
                }}
              >
                {lever.id}
              </span>
              <button
                type="button"
                style={dangerBtn}
                aria-label={`Remove ROI lever ${lever.id}`}
                onClick={() => set({ kind: "removeLever", id: lever.id })}
              >
                <Icon name="delete" size={14} color="var(--theme-error-dark)" /> Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ---- fields tab ---------------------------------------------------------
  const fieldsByStep = edited.steps.map((s) => ({
    step: s,
    fields: edited.fields.filter((f) => f.step === s.id),
  }));

  const renderFields = () => (
    <div>
      <p
        style={{
          fontSize: "var(--font-size-3xs)",
          color: "var(--text-muted)",
          margin: "0 0 18px",
          lineHeight: 1.55,
        }}
      >
        Rename any field and toggle whether it&rsquo;s required. Field structure
        (add/remove/reorder) is managed under Structure.
      </p>
      {fieldsByStep.map(({ step, fields }) => (
        <div key={step.id} style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: "var(--font-size-3xs)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              color: "var(--theme-primary)",
              marginBottom: 10,
            }}
          >
            {step.label}
          </div>
          {fields.map((field: FieldDef) => (
            <div
              className="admin-editor__field-row"
              key={field.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                padding: "8px 0",
                borderBottom: "1px solid var(--border-default)",
              }}
            >
              <input
                aria-label={`Label for field ${field.id}`}
                style={{ ...input, flex: "1 1 200px" }}
                value={field.label}
                onChange={(e) =>
                  set({ kind: "setFieldLabel", id: field.id, value: e.target.value })
                }
              />
              <label style={{ ...checkRow, whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  aria-label={`Required: field ${field.id}`}
                  checked={field.required}
                  onChange={(e) =>
                    set({ kind: "setFieldRequired", id: field.id, value: e.target.checked })
                  }
                />
                Required
              </label>
              <span
                className="admin-editor__field-id"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-micro)",
                  color: "var(--text-muted)",
                  width: 120,
                  textAlign: "right",
                  overflowWrap: "anywhere",
                  marginLeft: "auto",
                }}
              >
                {field.id} · {field.type}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  // ---- sizing tab ---------------------------------------------------------
  const renderSizing = () => (
    <div>
      <p
        style={{
          fontSize: "var(--font-size-3xs)",
          color: "var(--text-muted)",
          margin: "0 0 18px",
          lineHeight: 1.55,
        }}
      >
        Tune the sizing coefficients the AI-assisted estimator multiplies by (FREQ_FACTOR /
        CPLX_FACTOR). Larger factors push the recommended tier, DBUs and cost up.
      </p>
      {(["freqFactor", "cplxFactor"] as const).map((group) => (
        <div key={group} style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: "var(--font-size-3xs)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".06em",
              color: "var(--theme-primary)",
              marginBottom: 10,
            }}
          >
            {group === "freqFactor" ? "Load frequency factor" : "Transformation complexity factor"}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, max(200px, calc((100% - 12px) / 2))), 1fr))",
              gap: 12,
            }}
          >
            {Object.keys(edited.sizing[group]).map((key) => (
              <div key={key}>
                <label style={label} htmlFor={`coeff-${group}-${key}`}>
                  {key}
                </label>
                <input
                  id={`coeff-${group}-${key}`}
                  aria-label={`Coefficient ${group} ${key}`}
                  type="number"
                  step="0.1"
                  style={input}
                  value={edited.sizing[group][key] ?? 0}
                  onChange={(e) =>
                    set({ kind: "setSizingCoeff", group, key, value: Number(e.target.value) })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  // ---- structure tab (explicit later-phase stub) --------------------------
  const renderStructure = () => (
    <div>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "12px 16px",
          background: "var(--color-orange-5v)",
          color: "var(--theme-accent-warm-dark)",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--font-size-2xs)",
          lineHeight: 1.5,
          marginBottom: 18,
        }}
      >
        <Icon name="info" size={18} color="var(--theme-accent-warm-dark)" />
        Adding, removing and reordering steps and fields is a later-phase capability. The current
        step/field structure is shown below for reference; edit labels and required flags under
        Fields.
      </div>
      {edited.steps.map((step, i) => (
        <div
          key={step.id}
          style={{
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: 14,
            marginBottom: 10,
            opacity: 0.85,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-micro)",
                color: "var(--text-muted)",
              }}
            >
              {i + 1}
            </span>
            <strong style={{ fontSize: "var(--font-size-2xs)" }}>{step.label}</strong>
            <span style={{ fontSize: "var(--font-size-micro)", color: "var(--text-muted)" }}>
              {step.title}
            </span>
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: "var(--font-size-micro)",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {edited.fields
              .filter((f) => f.step === step.id)
              .map((f) => f.id)
              .join(", ") || "—"}
          </div>
        </div>
      ))}
    </div>
  );

  // ---- preview tab --------------------------------------------------------
  const renderPreview = () => (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <p
          style={{
            fontSize: "var(--font-size-3xs)",
            color: "var(--text-muted)",
            margin: 0,
            lineHeight: 1.55,
            maxWidth: 620,
          }}
        >
          The tenant wizard rendered from your edited schema. Labels, options and sizing update
          live; use Restart to re-seed defaults after structural or option changes.
        </p>
        <button type="button" style={outlineBtn} onClick={() => setPreviewKey((k) => k + 1)}>
          <Icon name="refresh" size={14} color="var(--theme-primary)" /> Restart preview
        </button>
      </div>
      <SchemaForm
        key={previewKey}
        schema={edited}
        widgets={edpWidgets}
        dynamicOptions={previewDynamicOptions}
        onSubmit={() => undefined}
        onCancel={() => undefined}
        chrome={{ Icon, Pill, Panel, SectionHead, StepIndicator: PreviewStepIndicatorWithChrome }}
      />
    </div>
  );

  // ---- export tab ---------------------------------------------------------
  const renderExport = () => (
    <div>
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "12px 16px",
          background: "var(--color-blue-5v)",
          color: "var(--color-blue-warm-70v)",
          borderRadius: "var(--radius-md)",
          fontSize: "var(--font-size-2xs)",
          lineHeight: 1.5,
          marginBottom: 18,
        }}
      >
        <Icon name="info" size={18} color="var(--theme-primary)" />
        <span style={{ minWidth: 0 }}>
          Repo-backed editor: nothing is written to production. Save emits a PR-ready diff against{" "}
          <code style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
            {result?.path ?? "intake.config.json"}
          </code>{" "}
          — copy or download it and open a pull request to deploy the change.
        </span>
      </div>

      {result == null ? (
        <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}>
          No diff yet — make edits, then click <strong>Save changes</strong>.
        </p>
      ) : !result.changed ? (
        <p style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)" }}>
          No changes to submit — the edited schema matches the loaded configuration.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <h3 style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0 }}>
                Config diff
              </h3>
              <button type="button" style={outlineBtn} onClick={() => copy(result.diff, "diff")}>
                <Icon name="content_copy" size={14} color="var(--theme-primary)" />
                {copied === "diff" ? "Copied" : "Copy diff"}
              </button>
            </div>
            <pre style={pre} aria-label="Config diff">
              {result.diff}
            </pre>
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <h3 style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700, margin: 0 }}>
                Full new intake.config.json
              </h3>
              <span
                className="admin-editor__export-actions"
                style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}
              >
                <button
                  type="button"
                  style={outlineBtn}
                  onClick={() => copy(result.config, "config")}
                >
                  <Icon name="content_copy" size={14} color="var(--theme-primary)" />
                  {copied === "config" ? "Copied" : "Copy JSON"}
                </button>
                <button
                  type="button"
                  style={outlineBtn}
                  onClick={() => download(result.config, "intake.config.json")}
                >
                  <Icon name="download" size={14} color="var(--theme-primary)" /> Download
                </button>
              </span>
            </div>
            <pre style={pre} aria-label="Full new config">
              {result.config}
            </pre>
          </div>
        </div>
      )}
    </div>
  );

  const body =
    tab === "options"
      ? renderOptions()
      : tab === "fields"
        ? renderFields()
        : tab === "sizing"
          ? renderSizing()
          : tab === "structure"
            ? renderStructure()
            : tab === "preview"
              ? renderPreview()
              : renderExport();

  return (
    <div className="admin-editor" style={{ minWidth: 0, maxWidth: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 18,
          flexWrap: "wrap",
        }}
      >
        <p
          style={{
            fontSize: "var(--font-size-2xs)",
            color: "var(--text-muted)",
            margin: 0,
            maxWidth: 640,
            lineHeight: 1.55,
          }}
        >
          Edit the intake schema without touching code. Changes are held in-app and previewed live;
          Save emits a PR-ready config diff — no production write.
        </p>
        <div
          className="admin-editor__actions"
          style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}
        >
          <button type="button" style={outlineBtn} onClick={resetAll}>
            <Icon name="refresh" size={14} color="var(--theme-primary)" /> Reset
          </button>
          <PendingActionButton
            type="button"
            style={primaryBtn}
            onClick={save}
            pending={pending.isActionPending("admin-intake-editor", "save")}
            locked={pending.isRecordPending("admin-intake-editor")}
          >
            <Icon name="check" size={16} color="#fff" /> Save changes
          </PendingActionButton>
          <PendingActionStatus pending={pending.isRecordPending("admin-intake-editor")} />
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border-default)",
          marginBottom: 22,
          flexWrap: "wrap",
        }}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              style={{
                background: "none",
                border: "none",
                padding: "10px 14px",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-size-2xs)",
                fontWeight: active ? 700 : 500,
                color: active ? "var(--theme-primary)" : "var(--color-gray-cool-60)",
                borderBottom: active ? "3px solid var(--theme-primary)" : "3px solid transparent",
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {body}
    </div>
  );
}
