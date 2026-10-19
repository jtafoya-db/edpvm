import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * USWDS Alert — status messaging with a left rule, tinted background, and icon.
 */
export function Alert({ children, type = "info", heading, slim = false, noIcon = false, style, ...rest }) {
  const map = {
    info:    { bg: "var(--theme-info-lighter)",    bar: "var(--theme-info)",    icon: "info",         iconColor: "var(--theme-info-darker)" },
    warning: { bg: "var(--theme-warning-lighter)", bar: "var(--theme-warning)", icon: "warning",      iconColor: "var(--theme-warning-darker)" },
    error:   { bg: "var(--theme-error-lighter)",   bar: "var(--theme-error)",   icon: "error",        iconColor: "var(--theme-error-darker)" },
    success: { bg: "var(--theme-success-lighter)", bar: "var(--theme-success)", icon: "check_circle", iconColor: "var(--theme-success-darker)" },
    emergency: { bg: "var(--theme-emergency)",     bar: "var(--theme-emergency-dark)", icon: "error", iconColor: "#fff", text: "#fff" },
  };
  const m = map[type] || map.info;
  const textColor = m.text || "var(--theme-ink)";
  return (
    <div
      role={type === "error" || type === "warning" ? "alert" : "status"}
      style={{
        position: "relative",
        background: m.bg,
        borderLeft: "8px solid " + m.bar,
        padding: slim ? "var(--space-1) var(--space-105) var(--space-1) var(--space-6)"
                       : "var(--space-105) var(--space-205) var(--space-105) var(--space-6)",
        fontFamily: "var(--font-body)",
        color: textColor,
        ...style,
      }}
      {...rest}
    >
      {!noIcon && (
        <span
          aria-hidden="true"
          style={{ position: "absolute", left: "var(--space-105)", top: slim ? "var(--space-1)" : "var(--space-105)", color: m.iconColor, display: "inline-flex" }}
        >
          <Icon name={m.icon} size={24} />
        </span>
      )}
      {heading && (
        <div style={{ fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: "var(--font-size-md)", lineHeight: 1.3, marginBottom: "var(--space-05)", color: textColor }}>
          {heading}
        </div>
      )}
      <div style={{ fontSize: "var(--font-size-sm)", lineHeight: "var(--line-height-5)" }}>
        {children}
      </div>
    </div>
  );
}
