import React from "react";
import { Icon } from "./Icon.jsx";

/**
 * USWDS Button. Self-contained: styling references design-system CSS custom
 * properties and handles hover/active/focus via local state so it works
 * anywhere the token stylesheet is linked.
 */
export function Button({
  children,
  variant = "default",
  size = "default",
  disabled = false,
  type = "button",
  icon,
  iconPosition = "left",
  onClick,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const [focus, setFocus] = React.useState(false);

  const state = disabled ? "disabled" : active ? "active" : hover ? "hover" : "default";

  // [bg, color, boxShadow] per variant per state
  const T = {
    default: {
      default: ["var(--theme-primary)", "#fff", "none"],
      hover: ["var(--theme-primary-dark)", "#fff", "none"],
      active: ["var(--theme-primary-darker)", "#fff", "none"],
    },
    secondary: {
      default: ["var(--theme-secondary)", "#fff", "none"],
      hover: ["var(--theme-secondary-dark)", "#fff", "none"],
      active: ["var(--theme-secondary-darker)", "#fff", "none"],
    },
    base: {
      default: ["var(--theme-base)", "#fff", "none"],
      hover: ["var(--theme-base-dark)", "#fff", "none"],
      active: ["var(--theme-base-darker)", "#fff", "none"],
    },
    "accent-cool": {
      default: ["var(--theme-accent-cool)", "var(--theme-ink)", "none"],
      hover: ["var(--theme-accent-cool-dark)", "#fff", "none"],
      active: ["var(--theme-accent-cool-darker)", "#fff", "none"],
    },
    "accent-warm": {
      default: ["var(--theme-accent-warm)", "var(--theme-ink)", "none"],
      hover: ["var(--theme-accent-warm-dark)", "#fff", "none"],
      active: ["var(--theme-accent-warm-darker)", "#fff", "none"],
    },
    outline: {
      default: ["transparent", "var(--theme-primary)", "inset 0 0 0 2px var(--theme-primary)"],
      hover: ["transparent", "var(--theme-primary-dark)", "inset 0 0 0 2px var(--theme-primary-dark)"],
      active: ["transparent", "var(--theme-primary-darker)", "inset 0 0 0 2px var(--theme-primary-darker)"],
    },
    unstyled: {
      default: ["transparent", "var(--link-default)", "none"],
      hover: ["transparent", "var(--link-hover)", "none"],
      active: ["transparent", "var(--link-active)", "none"],
    },
  };

  const isUnstyled = variant === "unstyled";
  const palette = (T[variant] || T.default)[state] || (T[variant] || T.default).default;
  const [bg, color, boxShadow] = disabled
    ? (variant === "outline"
        ? ["transparent", "var(--theme-disabled)", "inset 0 0 0 2px var(--theme-disabled-lighter)"]
        : ["var(--theme-disabled)", "var(--color-white)", "none"])
    : palette;

  const big = size === "big";

  const base = isUnstyled
    ? {
        background: "transparent",
        color,
        border: 0,
        padding: 0,
        font: "inherit",
        fontFamily: "var(--font-sans)",
        textDecoration: "underline",
        cursor: disabled ? "not-allowed" : "pointer",
      }
    : {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        columnGap: "var(--space-1)",
        fontFamily: "var(--font-sans)",
        fontWeight: 700,
        lineHeight: 1,
        fontSize: big ? "var(--font-size-lg)" : "var(--font-size-sm)",
        padding: big ? "var(--space-2) var(--space-3)" : "var(--space-105) var(--space-205)",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: bg,
        color,
        boxShadow,
        textAlign: "center",
        textDecoration: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        appearance: "none",
        transition: "background-color 150ms ease, box-shadow 150ms ease, color 150ms ease",
        outline: focus && !disabled ? "var(--focus-outline)" : "none",
        outlineOffset: focus && !disabled ? "var(--space-05)" : 0,
      };
  if (isUnstyled && focus && !disabled) {
    base.outline = "var(--focus-outline)";
    base.outlineOffset = "var(--space-05)";
  }

  const iconEl = icon ? <Icon name={icon} size="1.2em" /> : null;

  return (
    <button
      type={type}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{ ...base, ...style }}
      {...rest}
    >
      {icon && iconPosition === "left" ? iconEl : null}
      {children}
      {icon && iconPosition === "right" ? iconEl : null}
    </button>
  );
}
