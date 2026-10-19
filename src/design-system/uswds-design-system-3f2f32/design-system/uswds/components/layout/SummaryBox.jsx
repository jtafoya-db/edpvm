import React from "react";

/**
 * USWDS Summary Box — highlights a short, scannable summary of key info,
 * often with a list of jump links. Tinted info background + border.
 */
export function SummaryBox({ heading, children, style, ...rest }) {
  return (
    <div
      role="region"
      aria-label={typeof heading === "string" ? heading : "Summary"}
      style={{
        background: "var(--theme-info-lighter)",
        border: "1px solid var(--theme-info)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-205) var(--space-3)",
        fontFamily: "var(--font-body)",
        color: "var(--text-default)",
        ...style,
      }}
      {...rest}
    >
      {heading && (
        <div style={{
          fontFamily: "var(--font-sans)",
          fontWeight: 700,
          fontSize: "var(--font-size-md)",
          lineHeight: 1.3,
          marginBottom: "var(--space-1)",
        }}>
          {heading}
        </div>
      )}
      <div style={{ fontSize: "var(--font-size-sm)", lineHeight: "var(--line-height-5)" }}>
        {children}
      </div>
    </div>
  );
}
