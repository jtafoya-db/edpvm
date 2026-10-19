import React from "react";

/**
 * USWDS Card — a bordered content container with optional media, heading,
 * body, and footer. Flat by default (1px hairline + small radius).
 */
export function Card({ heading, headingLevel = "h3", media, mediaAlt = "", children, footer, style, ...rest }) {
  const Heading = headingLevel;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-default)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        ...style,
      }}
      {...rest}
    >
      {media && (
        <div style={{ aspectRatio: "16 / 9", overflow: "hidden", background: "var(--color-gray-cool-5)" }}>
          <img src={media} alt={mediaAlt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      )}
      {heading && (
        <Heading style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 700,
          fontSize: "var(--font-size-lg)",
          lineHeight: 1.2,
          color: "var(--text-default)",
          margin: 0,
          padding: "var(--space-3) var(--space-3) 0",
        }}>
          {heading}
        </Heading>
      )}
      <div style={{
        flex: 1,
        padding: "var(--space-2) var(--space-3)",
        fontFamily: "var(--font-body)",
        fontSize: "var(--font-size-sm)",
        lineHeight: "var(--line-height-5)",
        color: "var(--text-default)",
      }}>
        {children}
      </div>
      {footer && (
        <div style={{ padding: "0 var(--space-3) var(--space-3)" }}>
          {footer}
        </div>
      )}
    </div>
  );
}
