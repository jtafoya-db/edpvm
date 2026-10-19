import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import {
  EIR_FORM,
  type EirFieldConfig,
  type EirFormConfig,
  type EirFieldError,
  type EirFormValues,
  type EirLayoutBlock,
  type EirSectionConfig,
  definitionLabel,
} from "@/data";
import { input, label, type EirScreenChrome } from "./EirShared";

export const eirFieldDomId = (id: string) => `eir-field-${id}`;

type Props = {
  values: EirFormValues;
  onChange: (values: EirFormValues) => void;
  /** The Record ID, once the record has been started. */
  recordId?: string | undefined;
  errors: EirFieldError[];
  /**
   * Counts failed download attempts. The summary takes focus each time it goes
   * up, and only then: typing re-validates and must leave focus in the field.
   */
  attempt: number;
  Icon: EirScreenChrome["Icon"];
  disabled?: boolean;
  /** The form's actions (save, download, cancel). */
  children?: ReactNode;
  /** The form to render (#201): the one the next save uses. The bootstrap's when unset. */
  form?: EirFormConfig;
};

const hint: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-muted)",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 400,
  lineHeight: 1.5,
};
const fieldError: CSSProperties = {
  margin: "6px 0 0",
  display: "flex",
  gap: 5,
  alignItems: "flex-start",
  color: "var(--theme-error-dark)",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
};
const sectionLegend: CSSProperties = {
  padding: 0,
  fontFamily: "var(--font-heading)",
  fontSize: "var(--font-size-lg)",
  fontWeight: 700,
  color: "var(--text-default)",
};
const groupLegend: CSSProperties = {
  padding: 0,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  color: "var(--text-default)",
};
const plainFieldset: CSSProperties = { border: 0, padding: 0, margin: 0, minWidth: 0 };
/** Each section after the first starts on a thin divider. */
const divided: CSSProperties = {
  borderTop: "1px solid var(--border-default)",
  marginTop: 28,
  paddingTop: 26,
};
/** The form reads as one column: fields don't stretch across a wide page. */
const COLUMN = 800;

/** A row's fields side by side when there's room, stacked when there isn't. */
const row = (count: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${count >= 3 ? 200 : 280}px), 1fr))`,
  columnGap: 20,
  rowGap: 18,
  alignItems: "start",
});

function RequiredMark({ required }: { required: boolean }) {
  return required ? (
    <span aria-hidden="true" style={{ color: "var(--theme-secondary-dark)" }}>
      {" "}
      *
    </span>
  ) : (
    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> (optional)</span>
  );
}

/**
 * The current EIR form, from its configuration: four sections (each a
 * fieldset with a legend and one hint), their fields laid out by the config's
 * rows, each yes/no an explicit Yes / No radio pair. Errors come in as one
 * list: a summary at the top (focused on each failed attempt, updated politely
 * as answers are fixed, each entry moving focus to its field without changing
 * the URL), and each field marked invalid with its own message (USWDS
 * validation pattern).
 */
export function EirForm({
  values,
  onChange,
  recordId,
  errors,
  attempt,
  Icon,
  disabled = false,
  children,
  form = EIR_FORM,
}: Props) {
  const fieldById = new Map(form.sections.flatMap((s) => s.fields).map((f) => [f.id, f]));
  const attestation = form.declaration.attestation.id;
  const summaryRef = useRef<HTMLDivElement>(null);
  // Only an attempt made while the form is open moves focus: one counted
  // before it mounted (e.g. before Edit form) leaves focus where it was put.
  const focusedAttempt = useRef(attempt);
  useEffect(() => {
    if (attempt === focusedAttempt.current) return;
    focusedAttempt.current = attempt;
    if (errors.length) summaryRef.current?.focus();
  }, [attempt, errors.length]);
  const errorOf = (id: string) => errors.find((error) => error.field === id)?.message;
  const set = (id: string, value: string) => onChange({ ...values, [id]: value });

  const errorLine = (id: string, error: string) => (
    <p id={`${id}-error`} style={fieldError}>
      <Icon name="error" size={14} color="var(--theme-error-dark)" />
      <span>{error}</span>
    </p>
  );

  const yesNo = (field: EirFieldConfig) => {
    const id = eirFieldDomId(field.id);
    const error = errorOf(field.id);
    const value = values[field.id] ?? "";
    return (
      <fieldset
        key={field.id}
        role="radiogroup"
        aria-labelledby={`${id}-legend`}
        aria-required={field.required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        style={plainFieldset}
      >
        <legend id={`${id}-legend`} style={{ ...label, padding: 0, marginBottom: 0 }}>
          {field.label}
          <RequiredMark required={field.required} />
        </legend>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          {(["yes", "no"] as const).map((option, index) => {
            const checked = value === option;
            return (
              <label
                key={option}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 104,
                  padding: "10px 16px",
                  border: `1.5px solid ${
                    checked
                      ? "var(--theme-primary)"
                      : error
                        ? "var(--theme-error)"
                        : "var(--border-strong)"
                  }`,
                  borderRadius: "var(--radius-md)",
                  background: checked ? "var(--color-blue-5v)" : "var(--surface-default)",
                  fontSize: "var(--font-size-sm)",
                  fontWeight: checked ? 700 : 400,
                  cursor: "pointer",
                }}
              >
                <input
                  // The first choice carries the field's ID: the error summary focuses it.
                  id={index === 0 ? id : `${id}-${option}`}
                  type="radio"
                  name={id}
                  value={option}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => set(field.id, option)}
                  style={{
                    width: 20,
                    height: 20,
                    margin: 0,
                    accentColor: "var(--theme-primary)",
                  }}
                />
                {option === "yes" ? "Yes" : "No"}
              </label>
            );
          })}
        </div>
        {error ? errorLine(id, error) : null}
      </fieldset>
    );
  };

  const control = (field: EirFieldConfig) => {
    if (field.kind === "yes-no") return yesNo(field);
    const id = eirFieldDomId(field.id);
    const error = errorOf(field.id);
    const describedBy = [field.help ? `${id}-help` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <div key={field.id} style={{ minWidth: 0 }}>
        <label htmlFor={id} style={{ ...label, marginBottom: 0 }}>
          {field.label}
          <RequiredMark required={field.required} />
        </label>
        {field.help ? (
          <p id={`${id}-help`} style={hint}>
            {field.help}
          </p>
        ) : null}
        <input
          id={id}
          type={field.kind === "email" ? "email" : field.kind === "date" ? "date" : "text"}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          autoComplete={
            field.prefill === "email"
              ? "email"
              : field.prefill === "first-name"
                ? "given-name"
                : field.prefill === "last-name"
                  ? "family-name"
                  : "off"
          }
          maxLength={field.maxLength}
          disabled={disabled}
          value={values[field.id] ?? ""}
          onChange={(e) => set(field.id, e.target.value)}
          style={{
            ...input,
            marginTop: 8,
            // The colour alone changes on an error, so nothing shifts.
            ...(error ? { borderColor: "var(--theme-error)" } : {}),
            ...(field.size === "short" ? { maxWidth: 220 } : {}),
          }}
        />
        {error ? errorLine(id, error) : null}
      </div>
    );
  };

  const rows = (block: EirLayoutBlock) => (
    <div style={{ display: "grid", gap: 18 }}>
      {block.rows.map((ids) => {
        const fields = ids
          .map((id) => fieldById.get(id))
          .filter((field): field is EirFieldConfig => Boolean(field));
        // A yes/no question takes the whole row: the question reads in one line.
        if (fields.length === 1 && fields[0]!.kind === "yes-no") return control(fields[0]!);
        return (
          <div key={ids.join("+")} style={row(fields.length)}>
            {fields.map(control)}
          </div>
        );
      })}
    </div>
  );

  const section = (config: EirSectionConfig, index: number) => {
    const layout: readonly EirLayoutBlock[] = config.layout ?? [
      { rows: config.fields.map((field) => [field.id]) },
    ];
    return (
      <div key={config.id} style={index ? divided : undefined}>
        <fieldset
          style={plainFieldset}
          aria-describedby={config.help ? `eir-section-${config.id}-hint` : undefined}
        >
          <legend style={sectionLegend}>{config.title}</legend>
          {config.help ? (
            <p
              id={`eir-section-${config.id}-hint`}
              style={{ ...hint, margin: "6px 0 18px", fontSize: "var(--font-size-2xs)" }}
            >
              {config.help}
            </p>
          ) : null}
          <div style={{ display: "grid", gap: 26 }}>
            {layout.map((block, blockIndex) =>
              block.legend ? (
                <fieldset
                  key={block.legend}
                  style={plainFieldset}
                  aria-describedby={block.hint ? `eir-group-${config.id}-${blockIndex}` : undefined}
                >
                  <legend style={groupLegend}>{block.legend}</legend>
                  {block.hint ? (
                    <p
                      id={`eir-group-${config.id}-${blockIndex}`}
                      style={{ ...hint, margin: "4px 0 12px" }}
                    >
                      {block.hint}
                    </p>
                  ) : null}
                  {rows(block)}
                </fieldset>
              ) : (
                <div key={`rows-${blockIndex}`}>{rows(block)}</div>
              ),
            )}
          </div>
        </fieldset>
      </div>
    );
  };

  const attestationError = errorOf(attestation);
  const attestationId = eirFieldDomId(attestation);
  const sections: readonly EirSectionConfig[] = form.sections;
  return (
    <div>
      <div style={{ margin: "4px 0 24px" }}>
        <h3
          style={{
            margin: 0,
            fontFamily: "var(--font-sans)",
            fontSize: "var(--font-size-md)",
            fontWeight: 700,
          }}
        >
          {form.title}
        </h3>
        <p
          style={{
            margin: "6px 0 8px",
            maxWidth: COLUMN,
            fontSize: "var(--font-size-2xs)",
            color: "var(--color-gray-cool-70)",
            lineHeight: 1.55,
          }}
        >
          {form.intro}
        </p>
        <p style={{ ...hint, margin: 0 }}>
          <span>Record ID</span>{" "}
          <strong style={{ color: "var(--text-default)" }}>
            {recordId ?? "assigned when you download the PDF"}
          </strong>
          <span aria-hidden="true"> · </span>
          <span>EIR definition</span>{" "}
          <strong style={{ color: "var(--text-default)" }}>{definitionLabel(form.version)}</strong>
          <span aria-hidden="true"> · </span>
          <span>Fields marked * are required.</span>
        </p>
      </div>

      {errors.length ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="region"
          aria-live="polite"
          aria-labelledby="eir-error-summary-heading"
          style={{
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            maxWidth: COLUMN,
            boxSizing: "border-box",
            marginBottom: 24,
            padding: "14px 18px",
            border: "1px solid var(--theme-error-light)",
            borderLeft: "4px solid var(--theme-error)",
            borderRadius: "var(--radius-md)",
            background: "var(--theme-error-lighter)",
            fontSize: "var(--font-size-2xs)",
            color: "var(--color-gray-cool-70)",
          }}
        >
          <Icon name="error" size={20} color="var(--theme-error-dark)" />
          <div>
            <h3
              id="eir-error-summary-heading"
              style={{
                margin: 0,
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-size-xs)",
                color: "var(--theme-error-darker)",
              }}
            >
              {errors.length === 1 ? "Check 1 answer" : `Check ${errors.length} answers`}
            </h3>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
              {errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  <a
                    href={`#${eirFieldDomId(error.field)}`}
                    style={{ color: "var(--theme-error-dark)" }}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(eirFieldDomId(error.field))?.focus();
                    }}
                  >
                    {error.message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div style={{ maxWidth: COLUMN }}>
        {sections.map(section)}

        <div style={divided}>
          <fieldset style={plainFieldset}>
            <legend style={sectionLegend}>Declaration</legend>
            <p
              id="eir-declaration-text"
              style={{
                margin: "14px 0 16px",
                padding: "16px 20px",
                borderRadius: "var(--radius-md)",
                background: "var(--color-gray-cool-2)",
                fontSize: "var(--font-size-sm)",
                lineHeight: 1.65,
                color: "var(--text-default)",
              }}
            >
              {form.declaration.text}
            </p>
            <label
              htmlFor={attestationId}
              style={{
                display: "inline-flex",
                gap: 10,
                alignItems: "center",
                fontSize: "var(--font-size-sm)",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <input
                id={attestationId}
                type="checkbox"
                aria-required
                aria-invalid={attestationError ? true : undefined}
                aria-describedby={[
                  "eir-declaration-text",
                  attestationError ? `${attestationId}-error` : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                checked={values[attestation] === "yes"}
                disabled={disabled}
                onChange={(e) => set(attestation, e.target.checked ? "yes" : "")}
                style={{ width: 20, height: 20, margin: 0, accentColor: "var(--theme-primary)" }}
              />
              {form.declaration.attestation.label}
              <RequiredMark required />
            </label>
            {attestationError ? errorLine(attestationId, attestationError) : null}
          </fieldset>
        </div>
      </div>
      {children ? (
        <div
          style={{
            marginTop: 28,
            paddingTop: 22,
            borderTop: "1px solid var(--border-default)",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
