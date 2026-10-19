import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * USWDS Accordion — vertically stacked, expandable sections.
 * `items`: [{ id, title, content }]. `multiselectable` allows many open.
 */
export function Accordion({ items = [], multiselectable = false, bordered = true, defaultOpen = [], style, ...rest }) {
  const [open, setOpen] = React.useState(() => new Set(defaultOpen));
  const toggle = (id) => {
    setOpen((prev) => {
      const next = new Set(multiselectable ? prev : []);
      if (prev.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div style={{ fontFamily: "var(--font-body)", ...style }} {...rest}>
      {items.map((it, i) => {
        const isOpen = open.has(it.id);
        return (
          <div key={it.id} style={{ border: bordered ? "1px solid var(--border-default)" : "none", borderTop: bordered && i > 0 ? "none" : undefined, marginBottom: bordered ? 0 : "var(--space-05)" }}>
            <h4 style={{ margin: 0 }}>
              <AccordionButton open={isOpen} onClick={() => toggle(it.id)} controls={it.id}>
                {it.title}
              </AccordionButton>
            </h4>
            <div
              id={it.id}
              hidden={!isOpen}
              style={{
                padding: "var(--space-2)",
                background: "var(--surface-default)",
                fontSize: "var(--font-size-sm)",
                lineHeight: "var(--line-height-5)",
                color: "var(--text-default)",
              }}
            >
              {it.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AccordionButton({ children, open, onClick, controls }) {
  const [focus, setFocus] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
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
        transition: "background-color 120ms ease",
      }}
    >
      <span>{children}</span>
      <span aria-hidden="true" style={{ display: "inline-flex", color: "var(--theme-primary)", transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}>
        <Icon name="expand_more" size={24} />
      </span>
    </button>
  );
}
