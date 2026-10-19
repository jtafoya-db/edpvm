/* @ds-bundle: {"format":3,"namespace":"USWDSDesignSystem_fc84de","components":[{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"ICON_NAMES","sourcePath":"components/core/Icon.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Alert","sourcePath":"components/feedback/Alert.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Choice","sourcePath":"components/forms/ChoiceField.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"TextInput","sourcePath":"components/forms/TextInput.jsx"},{"name":"Banner","sourcePath":"components/gov/Banner.jsx"},{"name":"Accordion","sourcePath":"components/layout/Accordion.jsx"},{"name":"Card","sourcePath":"components/layout/Card.jsx"},{"name":"SummaryBox","sourcePath":"components/layout/SummaryBox.jsx"},{"name":"Breadcrumb","sourcePath":"components/navigation/Breadcrumb.jsx"},{"name":"Pagination","sourcePath":"components/navigation/Pagination.jsx"},{"name":"StepIndicator","sourcePath":"components/navigation/StepIndicator.jsx"}],"sourceHashes":{"components/core/Button.jsx":"601b86a1dfe9","components/core/Icon.jsx":"93088ba9be38","components/core/Tag.jsx":"51acf267e12c","components/feedback/Alert.jsx":"79f87c7f9554","components/forms/Checkbox.jsx":"ad753007b8d0","components/forms/ChoiceField.jsx":"4f9bd56f5f86","components/forms/Radio.jsx":"43450050b399","components/forms/Select.jsx":"77c471de9c7e","components/forms/TextInput.jsx":"fa27e48dfac0","components/gov/Banner.jsx":"d8eeca081c18","components/layout/Accordion.jsx":"5ce1eef5dc99","components/layout/Card.jsx":"9008f0d16d93","components/layout/SummaryBox.jsx":"2bc421580519","components/navigation/Breadcrumb.jsx":"d1bff650eab5","components/navigation/Pagination.jsx":"0b15e1996da7","components/navigation/StepIndicator.jsx":"18bd2eba54c5","ui_kits/federal-site/Apply.jsx":"ce1b9f615716","ui_kits/federal-site/Benefits.jsx":"d0004e7d31e3","ui_kits/federal-site/Chrome.jsx":"f0497ebe41a6","ui_kits/federal-site/Home.jsx":"0fac7c218ed9"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.USWDSDesignSystem_fc84de = window.USWDSDesignSystem_fc84de || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Icon — renders an inline SVG from the bundled icon registry.
 * Monochrome, inherits `currentColor`, sized in em by default so it scales
 * with text. This is a local, dependency-free subset of the USWDS / Material
 * icon set covering the glyphs used across this design system.
 */
const PATHS = {
  close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  menu: "M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z",
  search: "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  expand_more: "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z",
  expand_less: "M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z",
  navigate_next: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  navigate_before: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  check_circle: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z",
  error: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  info: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  arrow_forward: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z",
  arrow_back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z",
  file_download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  launch: "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z",
  account_balance: "M4 10v7h3v-7H4zm6 0v7h3v-7h-3zM2 22h19v-3H2v3zm14-12v7h3v-7h-3zm-4.5-9L2 6v2h19V6z",
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  attach_money: "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
  medical_services: "M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 8h-3v3h-2v-3H7v-2h3V9h2v3h3v2zm0-8h-4V4h4v2z",
  person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
  mail: "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z",
  public: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
  rss_feed: "M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19 7.38 20 6.18 20 5 20 4 19 4 17.82a2.18 2.18 0 0 1 2.18-2.18zM4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44zm0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z",
  facebook: "M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z"
};
function Icon({
  name,
  size = "1em",
  color = "currentColor",
  title,
  style,
  ...rest
}) {
  const d = PATHS[name];
  return /*#__PURE__*/React.createElement("svg", _extends({
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: color,
    role: title ? "img" : "presentation",
    "aria-hidden": title ? undefined : true,
    "aria-label": title,
    focusable: "false",
    style: {
      display: "inline-block",
      flexShrink: 0,
      verticalAlign: "middle",
      ...style
    }
  }, rest), title ? /*#__PURE__*/React.createElement("title", null, title) : null, d ? /*#__PURE__*/React.createElement("path", {
    d: d
  }) : null);
}

/** Names available in the bundled icon registry. */
const ICON_NAMES = Object.keys(PATHS);
Object.assign(__ds_scope, { Icon, ICON_NAMES });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Button. Self-contained: styling references design-system CSS custom
 * properties and handles hover/active/focus via local state so it works
 * anywhere the token stylesheet is linked.
 */
function Button({
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
      active: ["var(--theme-primary-darker)", "#fff", "none"]
    },
    secondary: {
      default: ["var(--theme-secondary)", "#fff", "none"],
      hover: ["var(--theme-secondary-dark)", "#fff", "none"],
      active: ["var(--theme-secondary-darker)", "#fff", "none"]
    },
    base: {
      default: ["var(--theme-base)", "#fff", "none"],
      hover: ["var(--theme-base-dark)", "#fff", "none"],
      active: ["var(--theme-base-darker)", "#fff", "none"]
    },
    "accent-cool": {
      default: ["var(--theme-accent-cool)", "var(--theme-ink)", "none"],
      hover: ["var(--theme-accent-cool-dark)", "#fff", "none"],
      active: ["var(--theme-accent-cool-darker)", "#fff", "none"]
    },
    "accent-warm": {
      default: ["var(--theme-accent-warm)", "var(--theme-ink)", "none"],
      hover: ["var(--theme-accent-warm-dark)", "#fff", "none"],
      active: ["var(--theme-accent-warm-darker)", "#fff", "none"]
    },
    outline: {
      default: ["transparent", "var(--theme-primary)", "inset 0 0 0 2px var(--theme-primary)"],
      hover: ["transparent", "var(--theme-primary-dark)", "inset 0 0 0 2px var(--theme-primary-dark)"],
      active: ["transparent", "var(--theme-primary-darker)", "inset 0 0 0 2px var(--theme-primary-darker)"]
    },
    unstyled: {
      default: ["transparent", "var(--link-default)", "none"],
      hover: ["transparent", "var(--link-hover)", "none"],
      active: ["transparent", "var(--link-active)", "none"]
    }
  };
  const isUnstyled = variant === "unstyled";
  const palette = (T[variant] || T.default)[state] || (T[variant] || T.default).default;
  const [bg, color, boxShadow] = disabled ? variant === "outline" ? ["transparent", "var(--theme-disabled)", "inset 0 0 0 2px var(--theme-disabled-lighter)"] : ["var(--theme-disabled)", "var(--color-white)", "none"] : palette;
  const big = size === "big";
  const base = isUnstyled ? {
    background: "transparent",
    color,
    border: 0,
    padding: 0,
    font: "inherit",
    fontFamily: "var(--font-sans)",
    textDecoration: "underline",
    cursor: disabled ? "not-allowed" : "pointer"
  } : {
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
    outlineOffset: focus && !disabled ? "var(--space-05)" : 0
  };
  if (isUnstyled && focus && !disabled) {
    base.outline = "var(--focus-outline)";
    base.outlineOffset = "var(--space-05)";
  }
  const iconEl = icon ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: "1.2em"
  }) : null;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    "aria-disabled": disabled || undefined,
    onClick: disabled ? undefined : onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setActive(false);
    },
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false),
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      ...base,
      ...style
    }
  }, rest), icon && iconPosition === "left" ? iconEl : null, children, icon && iconPosition === "right" ? iconEl : null);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Tag — a small inline label/pill for metadata, status, or categories.
 */
function Tag({
  children,
  color = "base",
  size = "default",
  style,
  ...rest
}) {
  const palettes = {
    base: ["var(--theme-base-dark)", "var(--color-white)"],
    primary: ["var(--theme-primary)", "var(--color-white)"],
    "primary-dark": ["var(--theme-primary-dark)", "var(--color-white)"],
    secondary: ["var(--theme-secondary)", "var(--color-white)"],
    "accent-cool": ["var(--theme-accent-cool)", "var(--theme-ink)"],
    "accent-warm": ["var(--theme-accent-warm)", "var(--theme-ink)"],
    success: ["var(--theme-success-dark)", "var(--color-white)"],
    light: ["var(--theme-base-lighter)", "var(--theme-ink)"]
  };
  const [bg, color2] = palettes[color] || palettes.base;
  const big = size === "big";
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
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
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Alert.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Alert — status messaging with a left rule, tinted background, and icon.
 */
function Alert({
  children,
  type = "info",
  heading,
  slim = false,
  noIcon = false,
  style,
  ...rest
}) {
  const map = {
    info: {
      bg: "var(--theme-info-lighter)",
      bar: "var(--theme-info)",
      icon: "info",
      iconColor: "var(--theme-info-darker)"
    },
    warning: {
      bg: "var(--theme-warning-lighter)",
      bar: "var(--theme-warning)",
      icon: "warning",
      iconColor: "var(--theme-warning-darker)"
    },
    error: {
      bg: "var(--theme-error-lighter)",
      bar: "var(--theme-error)",
      icon: "error",
      iconColor: "var(--theme-error-darker)"
    },
    success: {
      bg: "var(--theme-success-lighter)",
      bar: "var(--theme-success)",
      icon: "check_circle",
      iconColor: "var(--theme-success-darker)"
    },
    emergency: {
      bg: "var(--theme-emergency)",
      bar: "var(--theme-emergency-dark)",
      icon: "error",
      iconColor: "#fff",
      text: "#fff"
    }
  };
  const m = map[type] || map.info;
  const textColor = m.text || "var(--theme-ink)";
  return /*#__PURE__*/React.createElement("div", _extends({
    role: type === "error" || type === "warning" ? "alert" : "status",
    style: {
      position: "relative",
      background: m.bg,
      borderLeft: "8px solid " + m.bar,
      padding: slim ? "var(--space-1) var(--space-105) var(--space-1) var(--space-6)" : "var(--space-105) var(--space-205) var(--space-105) var(--space-6)",
      fontFamily: "var(--font-body)",
      color: textColor,
      ...style
    }
  }, rest), !noIcon && /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      position: "absolute",
      left: "var(--space-105)",
      top: slim ? "var(--space-1)" : "var(--space-105)",
      color: m.iconColor,
      display: "inline-flex"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: m.icon,
    size: 24
  })), heading && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-md)",
      lineHeight: 1.3,
      marginBottom: "var(--space-05)",
      color: textColor
    }
  }, heading), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-5)"
    }
  }, children));
}
Object.assign(__ds_scope, { Alert });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Alert.jsx", error: String((e && e.message) || e) }); }

// components/forms/ChoiceField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Shared internal implementation for Checkbox + Radio. Not a public component.

let injected = false;
function ensureStyle() {
  if (injected || typeof document === "undefined") return;
  if (document.getElementById("uswds-choice-style")) {
    injected = true;
    return;
  }
  const el = document.createElement("style");
  el.id = "uswds-choice-style";
  el.textContent = `
    label:has(input:checked) [data-choice-box]{
      background-color: var(--theme-primary) !important;
      border-color: var(--theme-primary) !important;
      background-repeat: no-repeat; background-position: center; background-size: 75%;
    }
    label:has(input[type=checkbox]:checked) [data-choice-box]{
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'><path d='M9 16.2l-3.5-3.5-1.4 1.4L9 19 20 8l-1.4-1.4z'/></svg>");
    }
    label:has(input[type=radio]:checked) [data-choice-box]{
      background-image: radial-gradient(circle, white 0 38%, transparent 42%);
    }
    label:has(input:disabled) [data-choice-box]{
      background-color: var(--theme-disabled-lighter) !important;
      border-color: var(--theme-disabled-light) !important;
    }`;
  document.head.appendChild(el);
  injected = true;
}
function Choice({
  label,
  shape = "checkbox",
  name,
  value,
  checked,
  defaultChecked,
  onChange,
  disabled,
  style,
  ...rest
}) {
  ensureStyle();
  const [focus, setFocus] = React.useState(false);
  const isRadio = shape === "radio";
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--space-1)",
      fontFamily: "var(--font-body)",
      fontSize: "var(--font-size-sm)",
      lineHeight: 1.3,
      color: disabled ? "var(--theme-disabled-dark)" : "var(--text-default)",
      cursor: disabled ? "not-allowed" : "pointer",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      display: "inline-flex",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: isRadio ? "radio" : "checkbox",
    name: name,
    value: value,
    checked: checked,
    defaultChecked: defaultChecked,
    onChange: onChange,
    disabled: disabled,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      position: "absolute",
      opacity: 0,
      width: 20,
      height: 20,
      margin: 0,
      cursor: "inherit"
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    "data-choice-box": true,
    style: {
      width: 20,
      height: 20,
      display: "inline-block",
      border: "2px solid var(--theme-base-dark)",
      borderRadius: isRadio ? "50%" : "var(--radius-sm)",
      background: "var(--color-white)",
      boxShadow: focus && !disabled ? "0 0 0 var(--focus-width) var(--focus-color)" : "none"
    }
  })), label != null && /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { Choice });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/ChoiceField.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** USWDS Checkbox — square custom control with a white checkmark when checked. */
function Checkbox(props) {
  return /*#__PURE__*/React.createElement(__ds_scope.Choice, _extends({}, props, {
    shape: "checkbox"
  }));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** USWDS Radio — circular custom control for mutually-exclusive choices. */
function Radio(props) {
  return /*#__PURE__*/React.createElement(__ds_scope.Choice, _extends({}, props, {
    shape: "radio"
  }));
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** USWDS Select — labelled native dropdown with hint + error support. */
function Select({
  label,
  id,
  hint,
  error,
  required = false,
  children,
  width = "default",
  style,
  ...rest
}) {
  const reactId = React.useId();
  const selectId = id || reactId;
  const [focus, setFocus] = React.useState(false);
  const widths = {
    sm: 120,
    md: 240,
    default: 320,
    lg: 420,
    full: "100%"
  };
  const w = widths[width] ?? 320;
  const hasError = Boolean(error);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-body)",
      ...(hasError ? {
        borderLeft: "4px solid var(--theme-error-dark)",
        paddingLeft: "var(--space-105)"
      } : {}),
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: selectId,
    style: {
      display: "block",
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      color: "var(--text-default)",
      marginBottom: "var(--space-05)"
    }
  }, label, required && /*#__PURE__*/React.createElement("abbr", {
    title: "required",
    style: {
      color: "var(--theme-secondary)",
      textDecoration: "none"
    }
  }, " *")), hint && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--font-size-2xs)",
      color: "var(--text-muted)",
      marginBottom: "var(--space-05)"
    }
  }, hint), hasError && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      color: "var(--theme-error-dark)",
      marginBottom: "var(--space-05)"
    }
  }, error), /*#__PURE__*/React.createElement("select", _extends({
    id: selectId,
    required: required,
    "aria-invalid": hasError || undefined,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
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
      outlineOffset: 0
    }
  }, rest), children));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/TextInput.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Text Input — labelled text field with optional hint and error state.
 */
function TextInput({
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
  const widths = {
    sm: 120,
    md: 240,
    default: 320,
    lg: 420,
    full: "100%"
  };
  const w = widths[width] ?? 320;
  const hasError = Boolean(error);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-body)",
      ...(hasError ? {
        borderLeft: "4px solid var(--theme-error-dark)",
        paddingLeft: "var(--space-105)"
      } : {}),
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: inputId,
    style: {
      display: "block",
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      color: "var(--text-default)",
      marginBottom: "var(--space-05)"
    }
  }, label, required && /*#__PURE__*/React.createElement("abbr", {
    title: "required",
    style: {
      color: "var(--theme-secondary)",
      textDecoration: "none"
    }
  }, " *")), hint && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--font-size-2xs)",
      color: "var(--text-muted)",
      marginBottom: "var(--space-05)"
    }
  }, hint), hasError && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      color: "var(--theme-error-dark)",
      marginBottom: "var(--space-05)"
    }
  }, error), /*#__PURE__*/React.createElement("input", _extends({
    id: inputId,
    type: type,
    required: required,
    "aria-invalid": hasError || undefined,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
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
      outlineOffset: 0
    }
  }, rest)));
}
Object.assign(__ds_scope, { TextInput });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/TextInput.jsx", error: String((e && e.message) || e) }); }

// components/gov/Banner.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const FLAG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAsBAMAAAAncaPMAAAAAXNSR0IArs4c6QAAABtQTFRF////4EAg2z8g2z8f2z4f2j4fHjSyHjOxHTOxQEYPwgAAAIdJREFUeNrNkUENxDAMBEOhFJaCKZiCKZhCKBj2ebV3rdR71+pIq+Qxj1GyqjJ3U8VlHkc07hFm0awBYe91juq6MSI0yhSAEgkzJ4TMKiXyzFw3pgR9lmIBJlqj2AmBedf+IycExmlKZVzvZEJ4A0oBrjBl/m6PCy95B3fFAN6YuQPxhbcB4QMkEj04wQXD5wAAAABJRU5ErkJggg==";
const DOTGOV = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><path fill='%232378C3' fill-rule='evenodd' d='m32 0c17.7 0 32 14.3 32 32s-14.3 32-32 32-32-14.3-32-32 14.3-32 32-32zm0 1.2c-17 0-30.8 13.8-30.8 30.8s13.8 30.8 30.8 30.8 30.8-13.8 30.8-30.8-13.8-30.8-30.8-30.8zm11.4 38.9c.5 0 .9.4.9.8v1.6h-24.6v-1.6c0-.5.4-.8.9-.8zm-17.1-12.3v9.8h1.6v-9.8h3.3v9.8h1.6v-9.8h3.3v9.8h1.6v-9.8h3.3v9.8h.8c.5 0 .9.4.9.8v.8h-21.4v-.8c0-.5.4-.8.9-.8h.8v-9.8zm5.7-8.2 12.3 4.9v1.6h-1.6c0 .5-.4.8-.9.8h-19.6c-.5 0-.9-.4-.9-.8h-1.6v-1.6s12.3-4.9 12.3-4.9z'/></svg>";
const HTTPS = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><path fill='%23719F2A' fill-rule='evenodd' d='M32 0c17.673 0 32 14.327 32 32 0 17.673-14.327 32-32 32C14.327 64 0 49.673 0 32 0 14.327 14.327 0 32 0zm0 1.208C14.994 1.208 1.208 14.994 1.208 32S14.994 62.792 32 62.792 62.792 49.006 62.792 32 49.006 1.208 32 1.208zm0 18.886a7.245 7.245 0 0 1 7.245 7.245v3.103h.52c.86 0 1.557.698 1.557 1.558v9.322c0 .86-.697 1.558-1.557 1.558h-15.53c-.86 0-1.557-.697-1.557-1.558V32c0-.86.697-1.558 1.557-1.558h.52V27.34A7.245 7.245 0 0 1 32 20.094zm0 3.103a4.142 4.142 0 0 0-4.142 4.142v3.103h8.284V27.34A4.142 4.142 0 0 0 32 23.197z'/></svg>";

/**
 * USWDS Banner — the official ".gov" identification banner that appears at the
 * top of every compliant federal site, with an expandable "Here's how you know".
 */
function Banner({
  tld = ".gov",
  style,
  ...rest
}) {
  const [open, setOpen] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  return /*#__PURE__*/React.createElement("section", _extends({
    "aria-label": "Official government website banner",
    style: {
      background: "var(--color-gray-cool-2)",
      fontFamily: "var(--font-body)",
      color: "var(--text-default)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "0 var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-1)",
      padding: "var(--space-05) 0",
      fontSize: "var(--font-size-micro)",
      lineHeight: 1.3
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: FLAG,
    alt: "U.S. flag",
    style: {
      height: 11,
      width: "auto"
    }
  }), /*#__PURE__*/React.createElement("span", null, "An official website of the United States government"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setOpen(o => !o),
    "aria-expanded": open,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 2,
      marginLeft: 2,
      background: "none",
      border: 0,
      padding: "2px 4px",
      cursor: "pointer",
      color: "var(--link-default)",
      fontFamily: "var(--font-body)",
      fontSize: "var(--font-size-micro)",
      textDecoration: "underline",
      outline: focus ? "var(--focus-outline)" : "none"
    }
  }, "Here's how you know", /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      display: "inline-flex",
      transform: open ? "rotate(180deg)" : "none"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "expand_more",
    size: 14
  })))), open && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "var(--space-3)",
      padding: "var(--space-2) 0 var(--space-3)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "var(--space-105)",
      alignItems: "flex-start",
      fontSize: "var(--font-size-2xs)",
      lineHeight: "var(--line-height-4)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: DOTGOV,
    alt: "",
    style: {
      width: 40,
      height: 40,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("strong", null, "Official websites use ", tld), /*#__PURE__*/React.createElement("br", null), "A ", /*#__PURE__*/React.createElement("strong", null, tld), " website belongs to an official government organization in the United States.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "var(--space-105)",
      alignItems: "flex-start",
      fontSize: "var(--font-size-2xs)",
      lineHeight: "var(--line-height-4)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: HTTPS,
    alt: "",
    style: {
      width: 40,
      height: 40,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0
    }
  }, /*#__PURE__*/React.createElement("strong", null, "Secure ", tld, " websites use HTTPS"), /*#__PURE__*/React.createElement("br", null), "A ", /*#__PURE__*/React.createElement("strong", null, "lock"), " or ", /*#__PURE__*/React.createElement("strong", null, "https://"), " means you've safely connected to the ", tld, " website. Share sensitive information only on official, secure websites.")))));
}
Object.assign(__ds_scope, { Banner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/gov/Banner.jsx", error: String((e && e.message) || e) }); }

// components/layout/Accordion.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Accordion — vertically stacked, expandable sections.
 * `items`: [{ id, title, content }]. `multiselectable` allows many open.
 */
function Accordion({
  items = [],
  multiselectable = false,
  bordered = true,
  defaultOpen = [],
  style,
  ...rest
}) {
  const [open, setOpen] = React.useState(() => new Set(defaultOpen));
  const toggle = id => {
    setOpen(prev => {
      const next = new Set(multiselectable ? prev : []);
      if (prev.has(id)) next.delete(id);else next.add(id);
      return next;
    });
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      fontFamily: "var(--font-body)",
      ...style
    }
  }, rest), items.map((it, i) => {
    const isOpen = open.has(it.id);
    return /*#__PURE__*/React.createElement("div", {
      key: it.id,
      style: {
        border: bordered ? "1px solid var(--border-default)" : "none",
        borderTop: bordered && i > 0 ? "none" : undefined,
        marginBottom: bordered ? 0 : "var(--space-05)"
      }
    }, /*#__PURE__*/React.createElement("h4", {
      style: {
        margin: 0
      }
    }, /*#__PURE__*/React.createElement(AccordionButton, {
      open: isOpen,
      onClick: () => toggle(it.id),
      controls: it.id
    }, it.title)), /*#__PURE__*/React.createElement("div", {
      id: it.id,
      hidden: !isOpen,
      style: {
        padding: "var(--space-2)",
        background: "var(--surface-default)",
        fontSize: "var(--font-size-sm)",
        lineHeight: "var(--line-height-5)",
        color: "var(--text-default)"
      }
    }, it.content));
  }));
}
function AccordionButton({
  children,
  open,
  onClick,
  controls
}) {
  const [focus, setFocus] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-expanded": open,
    "aria-controls": controls,
    onClick: onClick,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "var(--space-1)",
      textAlign: "left",
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-sm)",
      lineHeight: 1.3,
      color: "var(--text-default)",
      background: open ? "var(--color-gray-cool-5)" : hover ? "var(--color-gray-cool-3)" : "var(--color-gray-cool-2)",
      border: 0,
      cursor: "pointer",
      padding: "var(--space-105) var(--space-2)",
      outline: focus ? "var(--focus-outline)" : "none",
      outlineOffset: 0,
      transition: "background-color 120ms ease"
    }
  }, /*#__PURE__*/React.createElement("span", null, children), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      display: "inline-flex",
      color: "var(--theme-primary)",
      transform: open ? "rotate(180deg)" : "none",
      transition: "transform 150ms ease"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "expand_more",
    size: 24
  })));
}
Object.assign(__ds_scope, { Accordion });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Accordion.jsx", error: String((e && e.message) || e) }); }

// components/layout/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Card — a bordered content container with optional media, heading,
 * body, and footer. Flat by default (1px hairline + small radius).
 */
function Card({
  heading,
  headingLevel = "h3",
  media,
  mediaAlt = "",
  children,
  footer,
  style,
  ...rest
}) {
  const Heading = headingLevel;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      background: "var(--surface-default)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
      ...style
    }
  }, rest), media && /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: "16 / 9",
      overflow: "hidden",
      background: "var(--color-gray-cool-5)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: media,
    alt: mediaAlt,
    style: {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block"
    }
  })), heading && /*#__PURE__*/React.createElement(Heading, {
    style: {
      fontFamily: "var(--font-heading)",
      fontWeight: 700,
      fontSize: "var(--font-size-lg)",
      lineHeight: 1.2,
      color: "var(--text-default)",
      margin: 0,
      padding: "var(--space-3) var(--space-3) 0"
    }
  }, heading), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: "var(--space-2) var(--space-3)",
      fontFamily: "var(--font-body)",
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-5)",
      color: "var(--text-default)"
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 var(--space-3) var(--space-3)"
    }
  }, footer));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Card.jsx", error: String((e && e.message) || e) }); }

// components/layout/SummaryBox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Summary Box — highlights a short, scannable summary of key info,
 * often with a list of jump links. Tinted info background + border.
 */
function SummaryBox({
  heading,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "region",
    "aria-label": typeof heading === "string" ? heading : "Summary",
    style: {
      background: "var(--theme-info-lighter)",
      border: "1px solid var(--theme-info)",
      borderRadius: "var(--radius-lg)",
      padding: "var(--space-205) var(--space-3)",
      fontFamily: "var(--font-body)",
      color: "var(--text-default)",
      ...style
    }
  }, rest), heading && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-md)",
      lineHeight: 1.3,
      marginBottom: "var(--space-1)"
    }
  }, heading), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-5)"
    }
  }, children));
}
Object.assign(__ds_scope, { SummaryBox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/SummaryBox.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Breadcrumb.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Breadcrumb — hierarchical trail. `items`: [{ label, href }].
 * The last item is treated as the current page.
 */
function Breadcrumb({
  items = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    "aria-label": "Breadcrumbs",
    style: {
      fontFamily: "var(--font-body)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("ol", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      listStyle: "none",
      margin: 0,
      padding: 0,
      gap: "var(--space-05)",
      fontSize: "var(--font-size-2xs)"
    }
  }, items.map((it, i) => {
    const last = i === items.length - 1;
    return /*#__PURE__*/React.createElement("li", {
      key: i,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-05)"
      }
    }, last || !it.href ? /*#__PURE__*/React.createElement("span", {
      "aria-current": last ? "page" : undefined,
      style: {
        color: "var(--text-muted)"
      }
    }, it.label) : /*#__PURE__*/React.createElement("a", {
      href: it.href,
      style: {
        color: "var(--link-default)",
        textDecoration: "underline"
      }
    }, it.label), !last && /*#__PURE__*/React.createElement("span", {
      "aria-hidden": "true",
      style: {
        display: "inline-flex",
        color: "var(--theme-base-light)"
      }
    }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: "navigate_next",
      size: 16
    })));
  })));
}
Object.assign(__ds_scope, { Breadcrumb });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Breadcrumb.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Pagination.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Pagination — page links with previous/next controls.
 */
function Pagination({
  current = 1,
  total = 1,
  onChange,
  style,
  ...rest
}) {
  const go = p => {
    if (p >= 1 && p <= total && p !== current && onChange) onChange(p);
  };

  // Build a compact page list with ellipses.
  const pages = [];
  const add = p => pages.push(p);
  if (total <= 7) {
    for (let i = 1; i <= total; i++) add(i);
  } else {
    add(1);
    if (current > 3) add("…");
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) add(i);
    if (current < total - 2) add("…");
    add(total);
  }
  const Item = ({
    children,
    onClick,
    currentItem,
    disabled,
    arrow
  }) => {
    const [hover, setHover] = React.useState(false);
    const [focus, setFocus] = React.useState(false);
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: onClick,
      disabled: disabled,
      "aria-current": currentItem ? "page" : undefined,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onFocus: () => setFocus(true),
      onBlur: () => setFocus(false),
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        minWidth: arrow ? "auto" : 40,
        height: 40,
        padding: arrow ? "0 var(--space-1)" : "0 var(--space-105)",
        justifyContent: "center",
        fontFamily: "var(--font-body)",
        fontSize: "var(--font-size-sm)",
        fontWeight: currentItem ? 700 : 400,
        color: currentItem ? "var(--color-white)" : "var(--link-default)",
        background: currentItem ? "var(--theme-primary)" : hover && !disabled ? "var(--color-gray-cool-3)" : "transparent",
        border: currentItem ? "none" : "1px solid transparent",
        borderRadius: "var(--radius-md)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        textDecoration: arrow ? "none" : currentItem ? "none" : "underline",
        outline: focus ? "var(--focus-outline)" : "none",
        outlineOffset: 0
      }
    }, children);
  };
  return /*#__PURE__*/React.createElement("nav", _extends({
    "aria-label": "Pagination",
    style: {
      fontFamily: "var(--font-body)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("ul", {
    style: {
      display: "flex",
      alignItems: "center",
      listStyle: "none",
      margin: 0,
      padding: 0,
      gap: "var(--space-05)"
    }
  }, /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement(Item, {
    arrow: true,
    disabled: current === 1,
    onClick: () => go(current - 1)
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "navigate_before",
    size: 20
  }), "Previous")), pages.map((p, i) => /*#__PURE__*/React.createElement("li", {
    key: i
  }, p === "…" ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      color: "var(--text-muted)"
    }
  }, "\u2026") : /*#__PURE__*/React.createElement(Item, {
    currentItem: p === current,
    onClick: () => go(p)
  }, p))), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement(Item, {
    arrow: true,
    disabled: current === total,
    onClick: () => go(current + 1)
  }, "Next", /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "navigate_next",
    size: 20
  })))));
}
Object.assign(__ds_scope, { Pagination });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Pagination.jsx", error: String((e && e.message) || e) }); }

// components/navigation/StepIndicator.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * USWDS Step Indicator — shows progress through a multi-step process.
 * `steps`: string[] labels. `current`: 0-based index of the active step.
 */
function StepIndicator({
  steps = [],
  current = 0,
  showLabels = true,
  counters = true,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      fontFamily: "var(--font-body)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("ol", {
    style: {
      display: "flex",
      listStyle: "none",
      margin: 0,
      padding: 0
    }
  }, steps.map((label, i) => {
    const status = i < current ? "complete" : i === current ? "current" : "upcoming";
    const barColor = status === "complete" ? "var(--theme-primary-dark)" : status === "current" ? "var(--theme-primary)" : "var(--theme-base-lighter)";
    const numBg = status === "complete" ? "var(--theme-primary-dark)" : status === "current" ? "var(--theme-primary)" : "var(--surface-default)";
    const numColor = status === "upcoming" ? "var(--text-muted)" : "var(--color-white)";
    const numBorder = status === "upcoming" ? "2px solid var(--theme-base-lighter)" : "none";
    return /*#__PURE__*/React.createElement("li", {
      key: i,
      style: {
        flex: 1,
        minWidth: 0,
        position: "relative",
        paddingTop: counters ? 0 : "var(--space-05)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        height: 8,
        background: barColor,
        marginRight: 2,
        borderRadius: 1
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        marginTop: "var(--space-1)"
      }
    }, counters && /*#__PURE__*/React.createElement("span", {
      style: {
        flexShrink: 0,
        width: 28,
        height: 28,
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: numBg,
        color: numColor,
        border: numBorder,
        fontFamily: "var(--font-sans)",
        fontWeight: 700,
        fontSize: "var(--font-size-2xs)"
      }
    }, status === "complete" ? /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: "check",
      size: 18
    }) : i + 1), showLabels && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: "var(--font-size-2xs)",
        fontWeight: status === "current" ? 700 : 400,
        color: status === "upcoming" ? "var(--text-muted)" : "var(--text-default)",
        lineHeight: 1.2
      }
    }, label)));
  })));
}
Object.assign(__ds_scope, { StepIndicator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/StepIndicator.jsx", error: String((e && e.message) || e) }); }

// ui_kits/federal-site/Apply.jsx
try { (() => {
// Federal site — multi-step eligibility application with validation + success.
const {
  Button,
  TextInput,
  Select,
  Radio,
  Checkbox,
  Alert,
  StepIndicator,
  Breadcrumb,
  SummaryBox
} = window.USWDSDesignSystem_fc84de;
function ApplyScreen({
  onNavigate
}) {
  const steps = ["Personal info", "Household", "Review", "Done"];
  const [step, setStep] = React.useState(0);
  const [showError, setShowError] = React.useState(false);
  const [data, setData] = React.useState({
    name: "",
    dob: "",
    state: "",
    size: "",
    income: "",
    contact: "email",
    certify: false
  });
  const set = k => e => setData(d => ({
    ...d,
    [k]: e.target.value
  }));
  const next = () => {
    if (step === 0 && (!data.name || !data.dob)) {
      setShowError(true);
      return;
    }
    setShowError(false);
    setStep(s => Math.min(s + 1, steps.length - 1));
    window.scrollTo({
      top: 0
    });
  };
  const back = () => {
    setShowError(false);
    setStep(s => Math.max(s - 1, 0));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-body)",
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-3) var(--space-2) var(--space-6)"
    }
  }, /*#__PURE__*/React.createElement(Breadcrumb, {
    items: [{
      label: "Home",
      href: "#"
    }, {
      label: "Apply"
    }, {
      label: "Eligibility screener"
    }]
  }), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-2xl)",
      margin: "var(--space-2) 0 var(--space-4)"
    }
  }, "Eligibility screener"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 280px",
      gap: "var(--space-6)",
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(StepIndicator, {
    current: step,
    steps: steps
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "var(--space-4)",
      maxWidth: 480
    }
  }, showError && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement(Alert, {
    type: "error",
    heading: "There is a problem"
  }, "Complete all required fields before continuing.")), step === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-205)"
    }
  }, /*#__PURE__*/React.createElement(TextInput, {
    label: "Full name",
    required: true,
    value: data.name,
    onChange: set("name"),
    width: "full",
    error: showError && !data.name ? "Enter your full name." : undefined
  }), /*#__PURE__*/React.createElement(TextInput, {
    label: "Date of birth",
    required: true,
    value: data.dob,
    onChange: set("dob"),
    placeholder: "MM/DD/YYYY",
    width: "md",
    error: showError && !data.dob ? "Enter a date in MM/DD/YYYY format." : undefined
  }), /*#__PURE__*/React.createElement(Select, {
    label: "State of residence",
    value: data.state,
    onChange: set("state"),
    width: "md"
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "- Select -"), /*#__PURE__*/React.createElement("option", null, "California"), /*#__PURE__*/React.createElement("option", null, "New York"), /*#__PURE__*/React.createElement("option", null, "Texas"), /*#__PURE__*/React.createElement("option", null, "Illinois"))), step === 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-205)"
    }
  }, /*#__PURE__*/React.createElement(Select, {
    label: "Household size",
    value: data.size,
    onChange: set("size"),
    width: "sm"
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "-"), /*#__PURE__*/React.createElement("option", null, "1"), /*#__PURE__*/React.createElement("option", null, "2"), /*#__PURE__*/React.createElement("option", null, "3"), /*#__PURE__*/React.createElement("option", null, "4"), /*#__PURE__*/React.createElement("option", null, "5+")), /*#__PURE__*/React.createElement(TextInput, {
    label: "Estimated monthly income",
    value: data.income,
    onChange: set("income"),
    placeholder: "$",
    width: "md",
    hint: "Before taxes, all sources combined."
  }), /*#__PURE__*/React.createElement("fieldset", {
    style: {
      border: 0,
      margin: 0,
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("legend", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      marginBottom: "var(--space-1)"
    }
  }, "Preferred contact method"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-1)"
    }
  }, /*#__PURE__*/React.createElement(Radio, {
    name: "c",
    label: "By email",
    checked: data.contact === "email",
    onChange: () => setData(d => ({
      ...d,
      contact: "email"
    }))
  }), /*#__PURE__*/React.createElement(Radio, {
    name: "c",
    label: "By mail",
    checked: data.contact === "mail",
    onChange: () => setData(d => ({
      ...d,
      contact: "mail"
    }))
  })))), step === 2 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Alert, {
    type: "info",
    slim: true
  }, "Review your answers, then certify and submit."), /*#__PURE__*/React.createElement("dl", {
    style: {
      margin: "var(--space-2) 0",
      display: "grid",
      gridTemplateColumns: "auto 1fr",
      gap: "var(--space-1) var(--space-3)",
      fontSize: "var(--font-size-sm)"
    }
  }, [["Name", data.name || "—"], ["Date of birth", data.dob || "—"], ["State", data.state || "—"], ["Household size", data.size || "—"], ["Monthly income", data.income || "—"], ["Contact", data.contact]].map(([k, v]) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: k
  }, /*#__PURE__*/React.createElement("dt", {
    style: {
      color: "var(--text-muted)"
    }
  }, k), /*#__PURE__*/React.createElement("dd", {
    style: {
      margin: 0,
      fontWeight: 700
    }
  }, v)))), /*#__PURE__*/React.createElement(Checkbox, {
    label: "I certify that the information above is true and complete.",
    checked: data.certify,
    onChange: e => setData(d => ({
      ...d,
      certify: e.target.checked
    }))
  })), step === 3 && /*#__PURE__*/React.createElement(Alert, {
    type: "success",
    heading: "Your screener is complete"
  }, "Based on your answers, you may qualify for ", /*#__PURE__*/React.createElement("strong", null, "3 programs"), ". We've emailed your results and next steps."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "var(--space-2)",
      marginTop: "var(--space-4)"
    }
  }, step > 0 && step < 3 && /*#__PURE__*/React.createElement(Button, {
    variant: "outline",
    onClick: back
  }, "Back"), step < 2 && /*#__PURE__*/React.createElement(Button, {
    onClick: next,
    icon: "navigate_next",
    iconPosition: "right"
  }, "Continue"), step === 2 && /*#__PURE__*/React.createElement(Button, {
    onClick: next,
    disabled: !data.certify
  }, "Submit screener"), step === 3 && /*#__PURE__*/React.createElement(Button, {
    onClick: () => onNavigate("home")
  }, "Return home")))), /*#__PURE__*/React.createElement(SummaryBox, {
    heading: "Need help?"
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 var(--space-1)"
    }
  }, "Call ", /*#__PURE__*/React.createElement("strong", null, "1-800-555-0100"), ", Mon\u2013Fri, 8 a.m.\u20138 p.m. ET."), /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => e.preventDefault(),
    style: {
      color: "var(--link-default)"
    }
  }, "Find an office near you"))));
}
Object.assign(window, {
  ApplyScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/federal-site/Apply.jsx", error: String((e && e.message) || e) }); }

// ui_kits/federal-site/Benefits.jsx
try { (() => {
// Federal site — benefits listing with filters, result collection, pagination.
const {
  Button,
  Tag,
  Pagination,
  Breadcrumb,
  Checkbox,
  Alert,
  Icon
} = window.USWDSDesignSystem_fc84de;
function BenefitsScreen({
  onNavigate
}) {
  const [page, setPage] = React.useState(1);
  const all = [{
    title: "Affordable health coverage",
    cat: "Health",
    agency: "Dept. of Health",
    body: "Low-cost or free health insurance for individuals and families who qualify based on income."
  }, {
    title: "Monthly income assistance",
    cat: "Income",
    agency: "Dept. of Public Services",
    body: "Temporary cash assistance for households experiencing a loss of income or employment."
  }, {
    title: "Rental & utility help",
    cat: "Housing",
    agency: "Housing Authority",
    body: "Help paying rent and utility bills, plus support finding stable, affordable housing."
  }, {
    title: "Food assistance (SNAP)",
    cat: "Food",
    agency: "Dept. of Agriculture",
    body: "Monthly benefits to help buy groceries for eligible low-income households."
  }, {
    title: "Childcare subsidies",
    cat: "Family",
    agency: "Dept. of Public Services",
    body: "Financial help with the cost of childcare for working parents and guardians."
  }];
  const filters = ["Health", "Income", "Housing", "Food", "Family", "Education"];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-body)",
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-3) var(--space-2) var(--space-6)"
    }
  }, /*#__PURE__*/React.createElement(Breadcrumb, {
    items: [{
      label: "Home",
      href: "#"
    }, {
      label: "Benefits"
    }]
  }), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-2xl)",
      margin: "var(--space-2) 0 var(--space-1)"
    }
  }, "Browse all benefits"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "var(--font-size-sm)",
      color: "var(--text-muted)",
      margin: "0 0 var(--space-4)"
    }
  }, "Showing ", all.length, " of 42 programs"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "240px 1fr",
      gap: "var(--space-5)",
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("aside", {
    style: {
      borderTop: "4px solid var(--theme-primary)",
      paddingTop: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "var(--font-size-2xs)",
      textTransform: "uppercase",
      letterSpacing: "var(--letter-spacing-1)",
      margin: "0 0 var(--space-105)"
    }
  }, "Filter by category"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-1)"
    }
  }, filters.map((f, i) => /*#__PURE__*/React.createElement(Checkbox, {
    key: f,
    label: f,
    defaultChecked: i < 1
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "outline",
    size: "default"
  }, "Apply filters"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: "none",
      margin: 0,
      padding: 0,
      display: "flex",
      flexDirection: "column"
    }
  }, all.map((b, i) => /*#__PURE__*/React.createElement("li", {
    key: b.title,
    style: {
      padding: "var(--space-3) 0",
      borderTop: i === 0 ? "none" : "1px solid var(--border-default)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-1)",
      marginBottom: "var(--space-05)"
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    color: "accent-cool"
  }, b.cat), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--font-size-micro)",
      color: "var(--text-muted)"
    }
  }, b.agency)), /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: "0 0 var(--space-05)",
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-lg)"
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNavigate("apply");
    },
    style: {
      color: "var(--link-default)",
      textDecoration: "none"
    }
  }, b.title)), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 var(--space-1)",
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-5)",
      maxWidth: "68ex"
    }
  }, b.body), /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNavigate("apply");
    },
    style: {
      color: "var(--link-default)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      display: "inline-flex",
      alignItems: "center",
      gap: 2
    }
  }, "Check eligibility ", /*#__PURE__*/React.createElement(Icon, {
    name: "navigate_next",
    size: 16
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "var(--space-4)"
    }
  }, /*#__PURE__*/React.createElement(Pagination, {
    current: page,
    total: 9,
    onChange: setPage
  })))));
}
Object.assign(window, {
  BenefitsScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/federal-site/Benefits.jsx", error: String((e && e.message) || e) }); }

// ui_kits/federal-site/Chrome.jsx
try { (() => {
// Federal site — shared header (logo, primary nav, search) and a mega footer.
const {
  Button,
  Icon
} = window.USWDSDesignSystem_fc84de;
function SiteHeader({
  current,
  onNavigate
}) {
  const [q, setQ] = React.useState("");
  const nav = [{
    id: "home",
    label: "Home"
  }, {
    id: "benefits",
    label: "Benefits"
  }, {
    id: "apply",
    label: "Apply"
  }, {
    id: "resources",
    label: "Resources"
  }, {
    id: "about",
    label: "About"
  }];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      fontFamily: "var(--font-body)",
      borderBottom: "1px solid var(--border-default)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-105) var(--space-2)",
      display: "flex",
      alignItems: "center",
      gap: "var(--space-3)"
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNavigate("home");
    },
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-105)",
      textDecoration: "none",
      color: "var(--text-default)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "account_balance",
    size: 36,
    color: "var(--theme-primary)"
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      lineHeight: 1.1
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-md)",
      display: "block",
      fontWeight: 700
    }
  }, "Benefits.gov"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--font-size-micro)",
      color: "var(--text-muted)"
    }
  }, "U.S. Department of Public Services"))), /*#__PURE__*/React.createElement("nav", {
    "aria-label": "Primary",
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: "var(--space-05)"
    }
  }, nav.map(n => {
    const active = current === n.id;
    return /*#__PURE__*/React.createElement("a", {
      key: n.id,
      href: "#",
      onClick: e => {
        e.preventDefault();
        onNavigate(n.id);
      },
      style: {
        padding: "var(--space-105) var(--space-105)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-size-2xs)",
        fontWeight: active ? 700 : 400,
        color: "var(--text-default)",
        textDecoration: "none",
        borderBottom: active ? "4px solid var(--theme-primary)" : "4px solid transparent"
      }
    }, n.label);
  })), /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      onNavigate("search");
    },
    style: {
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement("input", {
    "aria-label": "Search",
    placeholder: "Search",
    value: q,
    onChange: e => setQ(e.target.value),
    style: {
      border: "1px solid var(--theme-base-dark)",
      borderRight: 0,
      borderRadius: 0,
      padding: "var(--space-1)",
      fontFamily: "var(--font-body)",
      fontSize: "var(--font-size-2xs)",
      width: 130,
      boxSizing: "border-box"
    }
  }), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    "aria-label": "Search",
    style: {
      background: "var(--theme-primary)",
      border: 0,
      color: "#fff",
      padding: "0 var(--space-105)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      borderRadius: 0
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 20,
    color: "#fff"
  })))));
}
function SiteFooter({
  onNavigate
}) {
  const cols = [{
    h: "Benefits",
    links: ["Find benefits", "Eligibility", "How to apply", "Appeals"]
  }, {
    h: "Resources",
    links: ["Forms & documents", "Office locator", "FAQ", "Accessibility"]
  }, {
    h: "About",
    links: ["Our agency", "Leadership", "Careers", "Newsroom"]
  }, {
    h: "Connect",
    links: ["Contact us", "Newsletter", "Press", "Open data"]
  }];
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      fontFamily: "var(--font-body)",
      marginTop: "var(--space-8)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--color-gray-cool-2)",
      borderTop: "1px solid var(--border-default)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-6) var(--space-2)",
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "var(--space-4)"
    }
  }, cols.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.h
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: "var(--font-size-2xs)",
      marginBottom: "var(--space-1)"
    }
  }, c.h), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: "none",
      margin: 0,
      padding: 0,
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-05)"
    }
  }, c.links.map(l => /*#__PURE__*/React.createElement("li", {
    key: l
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => e.preventDefault(),
    style: {
      color: "var(--link-default)",
      fontSize: "var(--font-size-2xs)",
      textDecoration: "none"
    }
  }, l)))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--surface-dark)",
      color: "#fff"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-3) var(--space-2)",
      display: "flex",
      alignItems: "center",
      gap: "var(--space-2)",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "account_balance",
    size: 32
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-heading)",
      fontWeight: 700
    }
  }, "U.S. Department of Public Services"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: "var(--space-105)"
    }
  }, ["facebook", "public", "rss_feed", "mail"].map(i => /*#__PURE__*/React.createElement(Icon, {
    key: i,
    name: i,
    size: 22,
    style: {
      opacity: 0.9
    }
  }))))));
}
Object.assign(window, {
  SiteHeader,
  SiteFooter
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/federal-site/Chrome.jsx", error: String((e && e.message) || e) }); }

// ui_kits/federal-site/Home.jsx
try { (() => {
// Federal site — homepage: hero, three-up card collection, and a summary box.
const {
  Button,
  Card,
  Tag,
  SummaryBox,
  Icon
} = window.USWDSDesignSystem_fc84de;
function HomeScreen({
  onNavigate
}) {
  const programs = [{
    tag: "Health",
    icon: "medical_services",
    title: "Health coverage",
    body: "Find low-cost or free health insurance for you and your family."
  }, {
    tag: "Income",
    icon: "attach_money",
    title: "Income support",
    body: "Apply for monthly assistance if you've lost work or income."
  }, {
    tag: "Housing",
    icon: "home",
    title: "Housing assistance",
    body: "Get help paying rent, utilities, or finding stable housing."
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-body)"
    }
  }, /*#__PURE__*/React.createElement("section", {
    style: {
      background: "var(--surface-dark)",
      color: "#fff"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-9) var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 560
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: "var(--font-sans)",
      textTransform: "uppercase",
      letterSpacing: "var(--letter-spacing-2)",
      fontSize: "var(--font-size-2xs)",
      fontWeight: 700,
      color: "var(--theme-accent-cool-light)",
      margin: 0
    }
  }, "An official benefits portal"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-2xl)",
      lineHeight: 1.15,
      margin: "var(--space-105) 0 var(--space-2)"
    }
  }, "Find the government benefits you may be eligible for"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "var(--font-size-md)",
      lineHeight: "var(--line-height-5)",
      margin: "0 0 var(--space-3)",
      color: "var(--theme-base-lighter)"
    }
  }, "Answer a few questions and we'll match you with programs for health care, income, housing, and more \u2014 in about 10 minutes."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "var(--space-2)",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    size: "big",
    icon: "navigate_next",
    iconPosition: "right",
    onClick: () => onNavigate("apply")
  }, "Check your eligibility"), /*#__PURE__*/React.createElement(Button, {
    size: "big",
    variant: "outline",
    onClick: () => onNavigate("benefits"),
    style: {
      color: "#fff",
      boxShadow: "inset 0 0 0 2px var(--theme-base-lighter)"
    }
  }, "Browse all benefits"))))), /*#__PURE__*/React.createElement("section", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-8) var(--space-2)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 620,
      marginBottom: "var(--space-5)"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-xl)",
      margin: "0 0 var(--space-105)"
    }
  }, "Explore programs by category"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-5)",
      margin: 0,
      color: "var(--text-default)"
    }
  }, "These are the most-used federal assistance programs. Select a category to learn who qualifies and how to apply.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: "var(--space-3)"
    }
  }, programs.map(p => /*#__PURE__*/React.createElement(Card, {
    key: p.title,
    heading: p.title,
    footer: /*#__PURE__*/React.createElement(Button, {
      variant: "outline",
      onClick: () => onNavigate("benefits")
    }, "Learn more")
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "var(--space-1)",
      marginBottom: "var(--space-105)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: p.icon,
    size: 28,
    color: "var(--theme-primary)"
  }), /*#__PURE__*/React.createElement(Tag, {
    color: "accent-cool"
  }, p.tag)), p.body)))), /*#__PURE__*/React.createElement("section", {
    style: {
      background: "var(--color-gray-cool-2)",
      borderTop: "1px solid var(--border-default)",
      borderBottom: "1px solid var(--border-default)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1024,
      margin: "0 auto",
      padding: "var(--space-6) var(--space-2)",
      display: "grid",
      gridTemplateColumns: "1.4fr 1fr",
      gap: "var(--space-5)",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: "var(--font-heading)",
      fontSize: "var(--font-size-xl)",
      margin: "0 0 var(--space-105)"
    }
  }, "Not sure where to start?"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "var(--font-size-sm)",
      lineHeight: "var(--line-height-5)",
      margin: "0 0 var(--space-2)"
    }
  }, "The eligibility screener walks you through a short set of questions and points you to every program you may qualify for. Your answers are private and aren't saved unless you create an account."), /*#__PURE__*/React.createElement(Button, {
    onClick: () => onNavigate("apply")
  }, "Start the screener")), /*#__PURE__*/React.createElement(SummaryBox, {
    heading: "What you'll need"
  }, /*#__PURE__*/React.createElement("ul", {
    style: {
      margin: 0,
      paddingLeft: 18,
      lineHeight: 1.9
    }
  }, /*#__PURE__*/React.createElement("li", null, "Your household size and income"), /*#__PURE__*/React.createElement("li", null, "Date of birth for each member"), /*#__PURE__*/React.createElement("li", null, "Your ZIP code"))))));
}
Object.assign(window, {
  HomeScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/federal-site/Home.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.ICON_NAMES = __ds_scope.ICON_NAMES;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Alert = __ds_scope.Alert;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Choice = __ds_scope.Choice;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.TextInput = __ds_scope.TextInput;

__ds_ns.Banner = __ds_scope.Banner;

__ds_ns.Accordion = __ds_scope.Accordion;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.SummaryBox = __ds_scope.SummaryBox;

__ds_ns.Breadcrumb = __ds_scope.Breadcrumb;

__ds_ns.Pagination = __ds_scope.Pagination;

__ds_ns.StepIndicator = __ds_scope.StepIndicator;

})();
