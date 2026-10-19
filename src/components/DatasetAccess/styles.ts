// Inline style objects for the dataset-access screens, built only from the
// USWDS tokens (see .../uswds/tokens/*.css). Copied from the existing screens
// so these match them: buttons and fields from SchemaForm, table cells from
// the admin console (src/legacy/admin.jsx).
import type { CSSProperties } from "react";

export const h1: CSSProperties = {
  fontFamily: "var(--font-heading)",
  fontSize: "var(--font-size-2xl)",
  fontWeight: 700,
  margin: "0 0 4px",
};

export const subtitle: CSSProperties = {
  margin: 0,
  color: "var(--text-muted)",
  fontSize: "var(--font-size-2xs)",
};

export const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 20,
};

export const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 22 };

export const lbl: CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  marginBottom: 7,
};

export const help: CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  marginTop: 5,
};

export const inp: CSSProperties = {
  width: "100%",
  border: "1.5px solid var(--border-strong)",
  borderRadius: "var(--radius-md)",
  padding: "11px 13px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  background: "var(--surface-default)",
  boxSizing: "border-box",
};

export const primaryBtn: CSSProperties = {
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
  whiteSpace: "nowrap",
};

export const outlineBtn: CSSProperties = {
  ...primaryBtn,
  background: "var(--surface-default)",
  color: "var(--theme-primary)",
  border: "1.5px solid var(--theme-primary)",
  padding: "7px 14px",
};

export const linkBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--link-default)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  cursor: "pointer",
  textDecoration: "none",
};

export const table: CSSProperties = { width: "100%", borderCollapse: "collapse" };

export const headRow: CSSProperties = { background: "var(--color-gray-cool-2)" };

export const th: CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  fontSize: "var(--font-size-micro)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
};

export const td: CSSProperties = {
  padding: "11px 14px",
  fontSize: "var(--font-size-2xs)",
  verticalAlign: "middle",
};

export const row: CSSProperties = { borderTop: "1px solid var(--border-default)" };

export const muted: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: "var(--font-size-3xs)",
};

export const mono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-3xs)",
  background: "var(--color-gray-cool-2)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-sm)",
  padding: "1px 6px",
  color: "var(--color-gray-cool-70)",
  // Ids and group names are read as a unit; never break them mid-name.
  whiteSpace: "nowrap",
};

/** A token-tinted notice box (info, warning, error or success). */
export function notice(kind: "info" | "warning" | "error" | "success"): CSSProperties {
  return {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    background: `var(--theme-${kind}-lighter)`,
    border: `1px solid var(--theme-${kind}-light)`,
    borderLeft: `4px solid var(--theme-${kind})`,
    borderRadius: "var(--radius-md)",
    padding: "14px 18px",
    fontSize: "var(--font-size-2xs)",
  };
}

export const two: CSSProperties = {
  display: "grid",
  // Two columns where there's room; one on a phone.
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 16,
};

/** Field error text, per the cart's pattern (src/legacy/cart.jsx). */
export const fieldError: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  marginTop: 5,
  color: "var(--theme-error-dark)",
  fontSize: "var(--font-size-3xs)",
};

export const cardGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))",
  gap: 12,
  marginTop: 8,
};

/** A selectable card, per SchemaForm's card-select (PatternCard). */
export function roleCard(selected: boolean): CSSProperties {
  return {
    textAlign: "left",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "100%",
    cursor: "pointer",
    padding: "13px 15px",
    borderRadius: "var(--radius-md)",
    background: selected ? "var(--color-blue-5v)" : "var(--surface-default)",
    border: selected ? "2px solid var(--theme-primary)" : "1.5px solid var(--border-strong)",
    font: "inherit",
    color: "var(--text-default)",
  };
}

export const cardGrants: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  lineHeight: 1.5,
};

/** The confirmation summary: a tinted box like the cart's review panel. */
export const summaryBox: CSSProperties = {
  background: "var(--color-blue-5v)",
  border: "1px solid var(--color-blue-20v)",
  borderRadius: "var(--radius-md)",
  padding: "16px 20px",
};
