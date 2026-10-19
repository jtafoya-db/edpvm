import React from "react";

/**
 * USWDS Tag — a small inline label/pill for metadata, status, or categories.
 */
export function Tag({ children, color = "base", size = "default", style, ...rest }) {
  const palettes = {
    base: ["var(--theme-base-dark)", "var(--color-white)"],
    primary: ["var(--theme-primary)", "var(--color-white)"],
    "primary-dark": ["var(--theme-primary-dark)", "var(--color-white)"],
    secondary: ["var(--theme-secondary)", "var(--color-white)"],
    "accent-cool": ["var(--theme-accent-cool)", "var(--theme-ink)"],
    "accent-warm": ["var(--theme-accent-warm)", "var(--theme-ink)"],
    success: ["var(--theme-success-dark)", "var(--color-white)"],
    light: ["var(--theme-base-lighter)", "var(--theme-ink)"],
  };
  const [bg, color2] = palettes[color] || palettes.base;
  const big = size === "big";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: bg,
        color: color2,
        fontFamily: "var(--font-sans)",
        fontWeight: 700,
        fontSize: big ? "var(--font-size-2xs)" : "var(--font-size-micro)",
        lineHeight: 1,
        letterSpacing: "var(--letter-spacing-1)",
        textTransform: "uppercase",
        padding: big ? "var(--space-05) var(--space-1)" : "2px var(--space-05)",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
