import React from "react";

/** USWDS Select — labelled native dropdown with hint + error support. */
export function Select({ label, id, hint, error, required = false, children, width = "default", style, ...rest }) {
  const reactId = React.useId();
  const selectId = id || reactId;
  const [focus, setFocus] = React.useState(false);
  const widths = { sm: 120, md: 240, default: 320, lg: 420, full: "100%" };
  const w = widths[width] ?? 320;
  const hasError = Boolean(error);
  return (
    <div style={{ fontFamily: "var(--font-body)", ...(hasError ? { borderLeft: "4px solid var(--theme-error-dark)", paddingLeft: "var(--space-105)" } : {}), ...style }}>
      {label && (
        <label htmlFor={selectId} style={{ display: "block", fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: "var(--font-size-2xs)", color: "var(--text-default)", marginBottom: "var(--space-05)" }}>
          {label}
          {required && <abbr title="required" style={{ color: "var(--theme-secondary)", textDecoration: "none" }}> *</abbr>}
        </label>
      )}
      {hint && <div style={{ fontSize: "var(--font-size-2xs)", color: "var(--text-muted)", marginBottom: "var(--space-05)" }}>{hint}</div>}
      {hasError && <div style={{ fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: "var(--font-size-2xs)", color: "var(--theme-error-dark)", marginBottom: "var(--space-05)" }}>{error}</div>}
      <select
        id={selectId}
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
          background: "var(--color-white) url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%231b1b1b'><path d='M7 10l5 5 5-5z'/></svg>\") no-repeat right var(--space-1) center / 20px",
          border: hasError ? "2px solid var(--theme-error-dark)" : "1px solid var(--theme-base-dark)",
          borderRadius: 0,
          padding: "var(--space-1)",
          paddingRight: "var(--space-5)",
          appearance: "none",
          outline: focus ? "var(--focus-outline)" : "none",
          outlineOffset: 0,
        }}
        {...rest}
      >
        {children}
      </select>
    </div>
  );
}
