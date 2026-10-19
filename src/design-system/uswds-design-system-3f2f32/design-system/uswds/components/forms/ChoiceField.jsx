import React from "react";

// Shared internal implementation for Checkbox + Radio. Not a public component.

let injected = false;
function ensureStyle() {
  if (injected || typeof document === "undefined") return;
  if (document.getElementById("uswds-choice-style")) { injected = true; return; }
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

export function Choice({ label, shape = "checkbox", name, value, checked, defaultChecked, onChange, disabled, style, ...rest }) {
  ensureStyle();
  const [focus, setFocus] = React.useState(false);
  const isRadio = shape === "radio";
  return (
    <label style={{
      display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
      fontFamily: "var(--font-body)", fontSize: "var(--font-size-sm)", lineHeight: 1.3,
      color: disabled ? "var(--theme-disabled-dark)" : "var(--text-default)",
      cursor: disabled ? "not-allowed" : "pointer", ...style,
    }}>
      <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
        <input
          type={isRadio ? "radio" : "checkbox"}
          name={name} value={value} checked={checked} defaultChecked={defaultChecked}
          onChange={onChange} disabled={disabled}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ position: "absolute", opacity: 0, width: 20, height: 20, margin: 0, cursor: "inherit" }}
          {...rest}
        />
        <span aria-hidden="true" data-choice-box style={{
          width: 20, height: 20, display: "inline-block",
          border: "2px solid var(--theme-base-dark)",
          borderRadius: isRadio ? "50%" : "var(--radius-sm)",
          background: "var(--color-white)",
          boxShadow: focus && !disabled ? "0 0 0 var(--focus-width) var(--focus-color)" : "none",
        }} />
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}
