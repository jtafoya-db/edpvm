// Inline styles for the onboarding screens (#86), copied from the design-system
// contract: SchemaForm's buttons/fields, AdminEditor's danger button, the
// legacy linkBtn and the tinted notice banner. USWDS tokens only.
import type React from "react";

export const h1: React.CSSProperties = {
  fontFamily: "var(--font-heading)",
  fontSize: "var(--font-size-2xl)",
  fontWeight: 700,
  margin: "0 0 4px",
};

export const subtitle: React.CSSProperties = {
  fontSize: "var(--font-size-2xs)",
  color: "var(--text-muted)",
  margin: 0,
  lineHeight: 1.5,
};

export const muted: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  lineHeight: 1.55,
};

/** Small uppercase label above a block of request details. */
export const detailLabel: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  marginBottom: 4,
};

export const lbl: React.CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  marginBottom: 7,
};

export const inp: React.CSSProperties = {
  width: "100%",
  border: "1.5px solid var(--border-strong)",
  borderRadius: "var(--radius-md)",
  padding: "11px 13px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  background: "var(--surface-default)",
  boxSizing: "border-box",
};

export const textarea: React.CSSProperties = { ...inp, resize: "vertical" };

export const primaryBtn: React.CSSProperties = {
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

export const outlineBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "var(--surface-default)",
  color: "var(--theme-primary)",
  border: "1.5px solid var(--theme-primary)",
  padding: "10px 19px",
};

export const dangerBtn: React.CSSProperties = {
  ...outlineBtn,
  color: "var(--theme-error-dark)",
  borderColor: "var(--color-red-cool-30v)",
};

export const linkBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--link-default)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  cursor: "pointer",
};

/** Tinted icon square leading a row, as in the legacy request rows. */
export function iconSquare(bg: string): React.CSSProperties {
  return {
    width: 46,
    height: 46,
    borderRadius: "var(--radius-md)",
    background: bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}

export type Tone = "info" | "warning" | "error" | "success";

/** The tinted notice banner: lighter bg, light border, 4px left rule. */
export const TONE: Record<
  Tone,
  { bg: string; border: string; rule: string; fg: string; icon: string }
> = {
  info: {
    bg: "var(--color-blue-5v)",
    border: "var(--color-blue-20v)",
    rule: "var(--theme-primary)",
    fg: "var(--theme-primary)",
    icon: "info",
  },
  warning: {
    bg: "var(--theme-warning-lighter)",
    border: "var(--theme-warning-light)",
    rule: "var(--theme-warning)",
    fg: "var(--theme-warning-darker)",
    icon: "warning",
  },
  error: {
    bg: "var(--theme-error-lighter)",
    border: "var(--theme-error-light)",
    rule: "var(--theme-error)",
    fg: "var(--theme-error-dark)",
    icon: "error",
  },
  success: {
    bg: "var(--theme-success-lighter)",
    border: "var(--theme-success-light)",
    rule: "var(--theme-success)",
    fg: "var(--theme-success-darker)",
    icon: "check_circle",
  },
};

export function banner(tone: Tone): React.CSSProperties {
  const t = TONE[tone];
  return {
    background: t.bg,
    border: `1px solid ${t.border}`,
    borderLeft: `4px solid ${t.rule}`,
    borderRadius: "var(--radius-md)",
    padding: "14px 18px",
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    fontSize: "var(--font-size-2xs)",
    color: "var(--color-gray-cool-70)",
    lineHeight: 1.55,
  };
}

/** Laid over a button whose save is in flight: dimmed, and the cursor says so. */
export const pendingBtn: React.CSSProperties = { opacity: 0.6, cursor: "progress" };
