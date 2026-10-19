import React from "react";

/**
 * USWDS Text Input — labelled text field with optional hint and error state.
 */
export function TextInput({
  label,
  id,
  hint,
  error,
  required = false,
  type = "text",
  width = "default",
  style,
  ...rest
}) {
  const reactId = React.useId();
  const inputId = id || reactId;
  const [focus, setFocus] = React.useState(false);
  const widths = { sm: 120, md: 240, default: 320, lg: 420, full: "100%" };
  const w = widths[width] ?? 320;
  const hasError = Boolean(error);

  return (
    <div style={{
      fontFamily: "var(--font-body)",
      ...(hasError ? { borderLeft: "4px solid var(--theme-error-dark)", paddingLeft: "var(--space-105)" } : {}),
      ...style,
    }}>
      {label && (
        <label htmlFor={inputId} style={{
          display: "block",
          fontFamily: "var(--font-sans)",
          fontWeight: 700,
          fontSize: "var(--font-size-2xs)",
          color: "var(--text-default)",
          marginBottom: "var(--space-05)",
        }}>
          {label}
          {required && <abbr title="required" style={{ color: "var(--theme-secondary)", textDecoration: "none" }}> *</abbr>}
        </label>
      )}
      {hint && (
        <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", marginBottom: "var(--space-05)" }}>{hint}</div>
      )}
      {hasError && (
        <div style={{ fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: "var(--font-size-2xs)", color: "var(--theme-error-dark)", marginBottom: "var(--space-05)" }}>
          {error}
        </div>
      )}
      <input
        id={inputId}
        type={type}
        required={required}
        aria-invalid={hasError || undefined}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          display: "block",
          width: w,
          maxWidth: "100%",
          boxSizing: "border-box",
          fontFamily: "var(--font-body)",
          fontSize: "var(--font-size-sm)",
          lineHeight: 1.3,
          color: "var(--text-default)",
          background: "var(--color-white)",
          border: hasError ? "2px solid var(--theme-error-dark)" : "1px solid var(--theme-base-dark)",
          borderRadius: 0,
          padding: "var(--space-1)",
          outline: focus ? "var(--focus-outline)" : "none",
          outlineOffset: 0,
        }}
        {...rest}
      />
    </div>
  );
}
