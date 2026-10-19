import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * USWDS Pagination — page links with previous/next controls.
 */
export function Pagination({ current = 1, total = 1, onChange, style, ...rest }) {
  const go = (p) => { if (p >= 1 && p <= total && p !== current && onChange) onChange(p); };

  // Build a compact page list with ellipses.
  const pages = [];
  const add = (p) => pages.push(p);
  if (total <= 7) {
    for (let i = 1; i <= total; i++) add(i);
  } else {
    add(1);
    if (current > 3) add("…");
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) add(i);
    if (current < total - 2) add("…");
    add(total);
  }

  const Item = ({ children, onClick, currentItem, disabled, arrow }) => {
    const [hover, setHover] = React.useState(false);
    const [focus, setFocus] = React.useState(false);
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={currentItem ? "page" : undefined}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 2,
          minWidth: arrow ? "auto" : 40, height: 40, padding: arrow ? "0 var(--space-1)" : "0 var(--space-105)",
          justifyContent: "center",
          fontFamily: "var(--font-body)", fontSize: "var(--font-size-sm)",
          fontWeight: currentItem ? 700 : 400,
          color: currentItem ? "var(--color-white)" : "var(--link-default)",
          background: currentItem ? "var(--theme-primary)" : hover && !disabled ? "var(--color-gray-cool-3)" : "transparent",
          border: currentItem ? "none" : "1px solid transparent",
          borderRadius: "var(--radius-md)",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
          textDecoration: arrow ? "none" : (currentItem ? "none" : "underline"),
          outline: focus ? "var(--focus-outline)" : "none", outlineOffset: 0,
        }}
      >
        {children}
      </button>
    );
  };

  return (
    <nav aria-label="Pagination" style={{ fontFamily: "var(--font-body)", ...style }} {...rest}>
      <ul style={{ display: "flex", alignItems: "center", listStyle: "none", margin: 0, padding: 0, gap: "var(--space-05)" }}>
        <li>
          <Item arrow disabled={current === 1} onClick={() => go(current - 1)}>
            <Icon name="navigate_before" size={20} />Previous
          </Item>
        </li>
        {pages.map((p, i) => (
          <li key={i}>
            {p === "…" ? (
              <span style={{ display: "inline-flex", width: 40, height: 40, alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>…</span>
            ) : (
              <Item currentItem={p === current} onClick={() => go(p)}>{p}</Item>
            )}
          </li>
        ))}
        <li>
          <Item arrow disabled={current === total} onClick={() => go(current + 1)}>
            Next<Icon name="navigate_next" size={20} />
          </Item>
        </li>
      </ul>
    </nav>
  );
}
