// Generic, schema-driven wizard renderer (docs/build-plan-p1.md §2).
//
// <SchemaForm> reproduces the onboarding wizard PURELY from an IntakeSchema: it
// renders every field type the schema uses (text, textarea, select, number,
// card-select, multi-card), gates each step with the schema's canAdvance rules,
// and defers step-specific visuals (the architecture diagram, the sizing
// estimator, review summary and note boxes) to a widget registry keyed by the
// ids the schema references in each step's `layout`. Nothing here is
// IRS-specific: the option lists, validation, sizing and request assembly all
// live in the schema, and the widgets are supplied by the caller.

import React from "react";
import {
  canAdvance,
  getField,
  type FieldDef,
  type IntakeSchema,
  type IntakeState,
  type LeverOption,
  type OptionListName,
  type PatternOption,
  blankDataset,
  validateStep,
} from "../../schema";
import { DatasetListField } from "./DatasetListField";
import { FieldError, datasetInputId } from "./field-helpers";
import { InitiativeOwnerField, type SignedInPerson } from "./InitiativeOwnerField";

// ---- public prop / context types -----------------------------------------

export interface DynamicOption {
  value: string;
  label: string;
}

export type IconComponent = React.ComponentType<{
  name: string;
  size?: number;
  color?: string;
}>;

export type PillComponent = React.ComponentType<{
  bg?: string;
  fg?: string;
  children?: React.ReactNode;
}>;

/** What a widget receives. Widgets are the schema-referenced, app-specific
 * pieces (diagram, estimator, review, note boxes); they read and write the
 * shared form state and reuse the injected chrome so they stay testable. */
export interface SchemaFormWidgetCtx {
  schema: IntakeSchema;
  values: IntakeState;
  setValue: (id: string, value: unknown) => void;
  Icon: IconComponent;
  Pill: PillComponent;
  /** the visible label of the currently-selected value for a select field */
  optionLabel: (fieldId: string) => string;
  /** the runtime option lists the host supplied (e.g. domains) */
  dynamicOptions: Record<string, DynamicOption[]>;
}

export type WidgetComponent = React.ComponentType<{ ctx: SchemaFormWidgetCtx }>;

/** Chrome the host injects. Defaults keep the renderer usable (and testable)
 * with no host at all; the real app passes its USWDS / AppIcon versions. */
export interface SchemaFormChrome {
  Panel: React.ComponentType<{ pad?: number; children?: React.ReactNode }>;
  SectionHead: React.ComponentType<{ title: string; eyebrow?: string | undefined }>;
  StepIndicator: React.ComponentType<{ steps: string[]; step: number }>;
  Icon: IconComponent;
  Pill: PillComponent;
}

export interface SchemaFormProps {
  schema: IntakeSchema;
  /** id -> widget component for the tokens the schema references in layouts */
  widgets: Record<string, WidgetComponent>;
  /** runtime option lists for fields declaring `dynamicOptions` (e.g. domains) */
  dynamicOptions?: Record<string, DynamicOption[]>;
  /** receives the full collected values object when the final step is submitted */
  onSubmit: (values: IntakeState) => void;
  /** invoked by Back on the first step (the wizard's Cancel) */
  onCancel: () => void;
  chrome?: Partial<SchemaFormChrome>;
  /** override the computed initial values (tests, and an intake put back after a refusal) */
  initialValues?: IntakeState;
  /** the step to open on (an intake put back after a refusal opens on its review step) */
  initialStep?: number;
  /** a submit is saving: the final button and Back are disabled until it settles */
  submitting?: boolean;
  /** prefix for every element id, so two wizards on one page (one per request card) never share one */
  idPrefix?: string;
  /** the final button's text, and its text while a submit saves */
  submitLabel?: string;
  submittingLabel?: string;
  /**
   * Problems outside the wizard's own fields that also block submitting (a
   * resubmission's answer box): listed in the error summary on a failed
   * submit, each linking to the element `targetId` names.
   */
  submitIssues?: ReadonlyArray<{ targetId: string; message: string }>;
  /** a submit was refused for {@link submitIssues}, so the host can show their inline errors */
  onInvalidSubmit?: () => void;
  /**
   * The signed-in person, from the server-resolved session, shown when the
   * provider picks Myself as an owner (#103). Display only: the server fills
   * the stored owner from its own session.
   */
  signedIn?: SignedInPerson | undefined;
}

// ---- default chrome (headless-safe) ---------------------------------------

const DefaultIcon: IconComponent = () => null;

const DefaultPill: PillComponent = ({ children }) => <span>{children}</span>;

const DefaultPanel: SchemaFormChrome["Panel"] = ({ children }) => <div>{children}</div>;

const DefaultSectionHead: SchemaFormChrome["SectionHead"] = ({ title, eyebrow }) => (
  <div>
    {eyebrow ? <div>{eyebrow}</div> : null}
    <h2>{title}</h2>
  </div>
);

const DefaultStepIndicator: SchemaFormChrome["StepIndicator"] = ({ steps, step }) => (
  <ol>
    {steps.map((label, i) => (
      <li key={label} aria-current={i === step ? "step" : undefined}>
        {label}
      </li>
    ))}
  </ol>
);

// ---- shared inline styles (ported from the hand-written wizard) -----------

const lbl: React.CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  marginBottom: 7,
};

const req: React.CSSProperties = { color: "var(--theme-secondary)" };

const two: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 16,
};

const inp: React.CSSProperties = {
  width: "100%",
  border: "1.5px solid var(--border-strong)",
  borderRadius: "var(--radius-md)",
  padding: "11px 13px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  background: "var(--surface-default)",
  boxSizing: "border-box",
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

const outlineBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  background: "var(--surface-default)",
  borderRadius: "var(--radius-md)",
  padding: "11px 20px",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
};

// Back, Continue and Submit: at least a 44px touch target (WCAG 2.5.5).
const navTarget: React.CSSProperties = { minHeight: 44 };

// ---- option resolution ----------------------------------------------------

function fieldSelectOptions(
  schema: IntakeSchema,
  field: FieldDef,
  dynamicOptions: Record<string, DynamicOption[]>,
): DynamicOption[] {
  if (field.dynamicOptions) return dynamicOptions[field.dynamicOptions] ?? [];
  if (field.optionsFrom) {
    return schema.optionLists[field.optionsFrom].map((o) => ({ value: o.id, label: o.name }));
  }
  if (field.options) return field.options.map((o) => ({ value: o, label: o }));
  return [];
}

// ---- card sub-components (card-select / multi-card) -----------------------

function PatternCard({
  opt,
  selected,
  onSelect,
  Icon,
  Pill,
}: {
  opt: PatternOption;
  selected: boolean;
  onSelect: () => void;
  Icon: IconComponent;
  Pill: PillComponent;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        textAlign: "left",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        width: "100%",
        cursor: "pointer",
        padding: "13px 15px",
        borderRadius: "var(--radius-md)",
        background: selected ? "var(--color-blue-5v)" : "var(--surface-default)",
        border: selected ? "2px solid var(--theme-primary)" : "1.5px solid var(--border-strong)",
        font: "inherit",
      }}
    >
      <Icon
        name={selected ? "check_circle" : "database"}
        size={19}
        color={selected ? "var(--theme-primary)" : "var(--color-gray-cool-50)"}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "var(--font-size-2xs)",
            fontWeight: 700,
          }}
        >
          {opt.name}
          {opt.approved ? (
            <Pill bg="var(--theme-success-lighter)" fg="var(--theme-success-darker)">
              Approved
            </Pill>
          ) : (
            <Pill bg="var(--color-orange-5v)" fg="var(--theme-accent-warm-darker)">
              Consultation
            </Pill>
          )}
        </span>
        <span
          style={{
            display: "block",
            fontSize: "var(--font-size-3xs)",
            color: "var(--text-muted)",
            marginTop: 3,
            lineHeight: 1.5,
          }}
        >
          {opt.desc}
        </span>
      </span>
    </button>
  );
}

function LeverCard({
  lever,
  selected,
  onToggle,
  Icon,
}: {
  lever: LeverOption;
  selected: boolean;
  onToggle: () => void;
  Icon: IconComponent;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      style={{
        textAlign: "left",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        width: "100%",
        cursor: "pointer",
        padding: "12px 14px",
        borderRadius: "var(--radius-md)",
        font: "inherit",
        background: selected ? "var(--color-blue-5v)" : "var(--surface-default)",
        border: selected ? "2px solid var(--theme-primary)" : "1.5px solid var(--border-strong)",
      }}
    >
      <Icon
        name={selected ? "check_circle" : lever.icon}
        size={18}
        color={selected ? "var(--theme-primary)" : "var(--color-gray-cool-50)"}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>
          {lever.name}
        </span>
        <span
          style={{
            display: "block",
            fontSize: "var(--font-size-3xs)",
            color: "var(--text-muted)",
            marginTop: 3,
            lineHeight: 1.45,
          }}
        >
          {lever.measure}
        </span>
      </span>
    </button>
  );
}

// ---- initial values -------------------------------------------------------

function computeInitialValues(
  schema: IntakeSchema,
  dynamicOptions: Record<string, DynamicOption[]>,
): IntakeState {
  const values: IntakeState = {};
  for (const field of schema.fields) {
    if (field.type === "dataset-list") {
      values[field.id] = [blankDataset()];
    } else if (field.dynamicOptions) {
      const opts = dynamicOptions[field.dynamicOptions] ?? [];
      values[field.id] = field.default ?? opts[0]?.value ?? "";
    } else if (Array.isArray(field.default)) {
      values[field.id] = [...field.default];
    } else {
      values[field.id] = field.default;
    }
  }
  // Non-field gate flags produced by widgets (e.g. the sizing estimator).
  values["estimated"] = false;
  return values;
}

// ---- component ------------------------------------------------------------

export function SchemaForm({
  schema,
  widgets,
  dynamicOptions = {},
  onSubmit,
  onCancel,
  chrome,
  initialValues,
  initialStep = 0,
  submitting = false,
  idPrefix,
  submitLabel = "Submit data onboarding request",
  submittingLabel = "Submitting…",
  submitIssues = [],
  onInvalidSubmit,
  signedIn,
}: SchemaFormProps) {
  const Icon = chrome?.Icon ?? DefaultIcon;
  const Pill = chrome?.Pill ?? DefaultPill;
  const Panel = chrome?.Panel ?? DefaultPanel;
  const SectionHead = chrome?.SectionHead ?? DefaultSectionHead;
  const StepIndicator = chrome?.StepIndicator ?? DefaultStepIndicator;

  const [step, setStep] = React.useState(initialStep);
  const [attempted, setAttempted] = React.useState(false);
  const [attemptCount, setAttemptCount] = React.useState(0);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const errorSummaryRef = React.useRef<HTMLDivElement>(null);
  const [values, setValues] = React.useState<IntakeState>(
    () => initialValues ?? computeInitialValues(schema, dynamicOptions),
  );

  const stepDef = schema.steps[step] ?? schema.steps[0];
  const lastStep = schema.steps.length - 1;

  // Setting a field also invalidates any "isTrue" gate flag its step owns
  // (mirrors the original wizard resetting `estimated` when a sizing input
  // changes). Fully declarative: the flag comes from the step's validation.
  const setValue = React.useCallback(
    (id: string, value: unknown) => {
      setValues((cur) => {
        const next: IntakeState = { ...cur, [id]: value };
        const field = getField(schema, id);
        if (field) {
          const rules = schema.validation[field.step] ?? [];
          for (const rule of rules) {
            if (rule.type === "isTrue" && rule.field !== id) next[rule.field] = false;
          }
        }
        return next;
      });
    },
    [schema],
  );

  const optionLabel = React.useCallback(
    (fieldId: string): string => {
      const field = getField(schema, fieldId);
      if (!field) return String(values[fieldId] ?? "");
      const opts = fieldSelectOptions(schema, field, dynamicOptions);
      const match = opts.find((o) => o.value === values[fieldId]);
      return match?.label ?? String(values[fieldId] ?? "");
    },
    [schema, values, dynamicOptions],
  );

  const widgetCtx: SchemaFormWidgetCtx = {
    schema,
    values,
    setValue,
    Icon,
    Pill,
    optionLabel,
    dynamicOptions,
  };

  const canNext = canAdvance(schema, stepDef?.id ?? "", values);
  const issues = canNext ? [] : validateStep(schema, stepDef?.id ?? "", values);
  const visibleIssues = attempted ? issues : issues.filter((issue) => touched.has(issue.field));
  const issueFor = (fieldId: string) => visibleIssues.find((issue) => issue.field === fieldId);
  const withPrefix = (id: string) => (idPrefix ? `${idPrefix}-${id}` : id);
  const domFieldId = (id: string) => withPrefix(`intake-${id}`);
  const issueTarget = (issue: (typeof issues)[number]) => {
    if (!issue.key) return domFieldId(issue.field);
    // An initiative owner's parts are `<field>-kind`, `-name` and `-email`.
    return getField(schema, issue.field)?.type === "initiative-owner"
      ? `${domFieldId(issue.field)}-${issue.key}`
      : withPrefix(datasetInputId(issue.key));
  };
  const touch = (id: string) => setTouched((current) => new Set(current).add(id));
  // What the error summary lists: this step's problems, and on the last step
  // the host's own (a resubmission's answer).
  const summary = [
    ...issues.map((issue) => ({
      key: `${issue.field}:${issue.key ?? ""}:${issue.message}`,
      message: issue.message,
      target: issue.key || getField(schema, issue.field) ? issueTarget(issue) : undefined,
    })),
    ...(step === lastStep
      ? submitIssues.map((issue) => ({
          key: `submit:${issue.targetId}:${issue.message}`,
          message: issue.message,
          target: issue.targetId,
        }))
      : []),
  ];

  React.useEffect(() => {
    if (attempted && summary.length > 0) errorSummaryRef.current?.focus();
  }, [attemptCount, step]);

  const continueToNextStep = () => {
    if (!canNext) {
      setAttempted(true);
      setAttemptCount((count) => count + 1);
      return;
    }
    setAttempted(false);
    setAttemptCount(0);
    setTouched(new Set());
    setStep(step + 1);
  };

  const toggleInArray = (id: string, optId: string) => {
    const cur = Array.isArray(values[id]) ? (values[id] as string[]) : [];
    setValue(id, cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId]);
  };

  // ---- render one field by type -------------------------------------------
  const renderField = (fieldId: string, marginTop = 0): React.ReactNode => {
    const field = getField(schema, fieldId);
    if (!field || field.step !== stepDef?.id) return null;
    const value = values[fieldId];
    const mark = field.required ? (
      <>
        {" "}
        <span style={req}>*</span>
      </>
    ) : null;
    const labelStyle = marginTop ? { ...lbl, marginTop } : lbl;
    const issue = issueFor(fieldId);
    const inputId = domFieldId(fieldId);
    const errorId = `${inputId}-error`;
    const validationProps = {
      id: inputId,
      required: field.required || undefined,
      "aria-required": field.required || undefined,
      "aria-invalid": Boolean(issue) || undefined,
      "aria-describedby": issue ? errorId : undefined,
      onBlur: () => touch(fieldId),
    };
    const fieldError = issue ? (
      <FieldError id={errorId} Icon={Icon}>
        {issue.message}
      </FieldError>
    ) : null;

    switch (field.type) {
      case "text":
        return (
          <div key={fieldId}>
            <label style={labelStyle} htmlFor={inputId}>
              {field.label}
              {mark}
            </label>
            <input
              {...validationProps}
              value={String(value ?? "")}
              onChange={(e) => setValue(fieldId, e.target.value)}
              placeholder={field.placeholder}
              style={issue ? { ...inp, border: "1.5px solid var(--theme-error)" } : inp}
            />
            {fieldError}
          </div>
        );
      case "textarea":
        return (
          <div key={fieldId}>
            <label style={labelStyle} htmlFor={inputId}>
              {field.label}
              {mark}
            </label>
            <textarea
              {...validationProps}
              value={String(value ?? "")}
              onChange={(e) => setValue(fieldId, e.target.value)}
              rows={field.rows}
              placeholder={field.placeholder}
              style={{
                ...inp,
                resize: "vertical",
                ...(issue ? { border: "1.5px solid var(--theme-error)" } : {}),
              }}
            />
            {fieldError}
          </div>
        );
      case "number": {
        // A text box, not type="number" (USWDS and GOV.UK advise against it):
        // it holds exactly what was typed, so nothing is rewritten under the
        // user. readNumber turns it into a number for validation and the intake.
        const hintId = `${inputId}-hint`;
        const describedBy =
          [field.help ? hintId : null, issue ? errorId : null].filter(Boolean).join(" ") ||
          undefined;
        return (
          <div key={fieldId}>
            <label style={labelStyle} htmlFor={inputId}>
              {field.label}
              {mark}
            </label>
            <input
              {...validationProps}
              aria-describedby={describedBy}
              type="text"
              inputMode={(field.numberFormat ?? "integer") === "integer" ? "numeric" : "decimal"}
              spellCheck={false}
              value={numberInputText(value)}
              onChange={(e) => setValue(fieldId, e.target.value)}
              style={issue ? { ...inp, border: "1.5px solid var(--theme-error)" } : inp}
            />
            {fieldError}
            {field.help ? (
              <div
                id={hintId}
                style={{
                  fontSize: "var(--font-size-3xs)",
                  color: "var(--text-muted)",
                  marginTop: 5,
                  lineHeight: 1.5,
                }}
              >
                {field.help}
              </div>
            ) : null}
          </div>
        );
      }
      case "select": {
        const opts = fieldSelectOptions(schema, field, dynamicOptions);
        const helpId = `${inputId}-help`;
        return (
          <div key={fieldId}>
            <label style={labelStyle} htmlFor={inputId}>
              {field.label}
              {mark}
            </label>
            {field.help ? (
              <p
                id={helpId}
                style={{
                  fontSize: "var(--font-size-3xs)",
                  color: "var(--text-muted)",
                  margin: "0 0 6px",
                  lineHeight: 1.5,
                }}
              >
                {field.help}
              </p>
            ) : null}
            <select
              {...validationProps}
              aria-describedby={
                [field.help ? helpId : null, issue ? errorId : null].filter(Boolean).join(" ") ||
                undefined
              }
              value={String(value ?? "")}
              onChange={(e) => setValue(fieldId, e.target.value)}
              style={issue ? { ...inp, border: "1.5px solid var(--theme-error)" } : inp}
            >
              {field.placeholder ? (
                <option value="" disabled>
                  {field.placeholder}
                </option>
              ) : null}
              {opts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {fieldError}
          </div>
        );
      }
      case "dataset-list":
        return (
          <DatasetListField
            key={fieldId}
            label={field.label}
            help={field.help}
            value={value}
            domains={field.dynamicOptions ? (dynamicOptions[field.dynamicOptions] ?? []) : []}
            onChange={(next) => setValue(fieldId, next)}
            Icon={Icon}
            showAll={attempted}
            idPrefix={idPrefix}
            signedIn={signedIn}
          />
        );
      case "initiative-owner":
        return (
          <div key={fieldId} style={marginTop ? { marginTop } : undefined}>
            <InitiativeOwnerField
              id={inputId}
              label={field.label}
              help={field.help}
              value={value}
              onChange={(next) => setValue(fieldId, next)}
              onBlur={() => touch(fieldId)}
              signedIn={signedIn}
              issues={issues.filter((issue) => issue.field === fieldId)}
              showAll={attempted}
              Icon={Icon}
            />
          </div>
        );
      case "card-select": {
        const list = field.optionList ? cardOptions(schema, field.optionList) : [];
        return (
          <div key={fieldId}>
            <label style={labelStyle}>{field.label}</label>
            <div
              id={inputId}
              tabIndex={-1}
              aria-invalid={Boolean(issue) || undefined}
              aria-describedby={issue ? errorId : undefined}
              style={{ display: "grid", gap: 10, marginTop: 8 }}
            >
              {list.map((opt) => (
                <PatternCard
                  key={opt.id}
                  opt={opt}
                  selected={value === opt.id}
                  onSelect={() => setValue(fieldId, opt.id)}
                  Icon={Icon}
                  Pill={Pill}
                />
              ))}
            </div>
            {fieldError}
          </div>
        );
      }
      case "multi-card": {
        const levers = field.optionList ? leverOptions(schema, field.optionList) : [];
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div key={fieldId}>
            <label style={labelStyle}>
              {field.label}
              {mark}
            </label>
            {field.help ? (
              <div
                style={{
                  fontSize: "var(--font-size-3xs)",
                  color: "var(--text-muted)",
                  margin: "-2px 0 10px",
                  lineHeight: 1.5,
                }}
              >
                {field.help}
              </div>
            ) : null}
            <div
              id={inputId}
              tabIndex={-1}
              aria-invalid={Boolean(issue) || undefined}
              aria-describedby={issue ? errorId : undefined}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 10,
              }}
            >
              {levers.map((lever) => (
                <LeverCard
                  key={lever.id}
                  lever={lever}
                  selected={selected.includes(lever.id)}
                  onToggle={() => toggleInArray(fieldId, lever.id)}
                  Icon={Icon}
                />
              ))}
            </div>
            {fieldError}
          </div>
        );
      }
      default:
        return null;
    }
  };

  // ---- render one layout block (field id, grid group, or widget id) -------
  const renderBlock = (block: string | string[], key: number): React.ReactNode => {
    if (Array.isArray(block)) {
      return (
        <div key={key} style={two}>
          {block.map((fieldId, i) => renderField(fieldId, i > 1 ? 18 : 0))}
        </div>
      );
    }
    if (getField(schema, block)?.step === stepDef?.id) return renderField(block);
    const Widget = widgets[block];
    return Widget ? <Widget key={key} ctx={widgetCtx} /> : null;
  };

  // Prefer the declarative layout; fall back to the step's fields in order.
  const layout: readonly (string | string[])[] =
    stepDef?.layout ?? schema.fields.filter((f) => f.step === stepDef?.id).map((f) => f.id);

  return (
    <>
      <div
        style={{
          background: "var(--surface-default)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          padding: "24px 28px",
          marginBottom: 20,
        }}
      >
        <StepIndicator steps={schema.steps.map((s) => s.label)} step={step} />
      </div>

      <Panel pad={28}>
        <SectionHead title={stepDef?.title ?? ""} eyebrow={stepDef?.eyebrow} />
        {layout.map((block, i) => renderBlock(block, i))}

        {attempted && summary.length > 0 ? (
          <div
            ref={errorSummaryRef}
            role="alert"
            tabIndex={-1}
            aria-label="Validation errors"
            style={{
              marginTop: 22,
              background: "var(--theme-error-lighter)",
              border: "1px solid var(--theme-error-light)",
              borderLeft: "4px solid var(--theme-error)",
              borderRadius: "var(--radius-md)",
              padding: "14px 18px",
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <Icon name="error" size={20} color="var(--theme-error-dark)" />
            <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--color-gray-cool-70)" }}>
              <div style={{ fontWeight: 700, color: "var(--theme-error-darker)", marginBottom: 3 }}>
                To continue:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {summary.map((issue) => (
                  <li key={issue.key}>
                    {issue.target ? (
                      <a
                        href={`#${issue.target}`}
                        onClick={(event) => {
                          event.preventDefault();
                          const target = document.getElementById(issue.target!);
                          target?.focus();
                          target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
                        }}
                        style={{ color: "var(--theme-error-darker)", textDecoration: "underline" }}
                      >
                        {issue.message}
                      </a>
                    ) : (
                      issue.message
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 28,
            paddingTop: 20,
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <button
            type="button"
            disabled={submitting}
            aria-disabled={submitting || undefined}
            onClick={() => (step === 0 ? onCancel() : setStep(step - 1))}
            style={{
              ...outlineBtn,
              ...navTarget,
              border: "1px solid var(--border-strong)",
              color: "var(--color-gray-cool-70)",
              ...(submitting ? { opacity: 0.6, cursor: "not-allowed" } : {}),
            }}
          >
            <Icon name="arrow_back" size={16} color="var(--color-gray-cool-70)" />{" "}
            {step === 0 ? "Cancel" : "Back"}
          </button>
          {step < lastStep ? (
            <button
              type="button"
              onClick={continueToNextStep}
              style={{ ...primaryBtn, ...navTarget }}
            >
              Continue <Icon name="arrow_forward" size={16} color="#fff" />
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              aria-disabled={submitting || undefined}
              onClick={() => {
                if (submitIssues.length > 0) {
                  setAttempted(true);
                  setAttemptCount((count) => count + 1);
                  onInvalidSubmit?.();
                  return;
                }
                onSubmit(values);
              }}
              style={{
                ...primaryBtn,
                ...navTarget,
                ...(submitting ? { opacity: 0.6, cursor: "progress" } : {}),
              }}
            >
              <Icon name="check" size={17} color="#fff" />{" "}
              {submitting ? submittingLabel : submitLabel}
            </button>
          )}
        </div>
      </Panel>
    </>
  );
}

// A number field holds the text typed into it, or a number from the schema
// default or a saved request; a missing value shows as an empty box.
function numberInputText(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return typeof value === "string" ? value : "";
}

// ---- narrow option-list helpers (typed access for card fields) ------------

function cardOptions(schema: IntakeSchema, name: OptionListName): PatternOption[] {
  if (name === "roiLevers") return [];
  return schema.optionLists[name];
}

function leverOptions(schema: IntakeSchema, name: OptionListName): LeverOption[] {
  if (name === "roiLevers") return schema.optionLists.roiLevers;
  return [];
}
