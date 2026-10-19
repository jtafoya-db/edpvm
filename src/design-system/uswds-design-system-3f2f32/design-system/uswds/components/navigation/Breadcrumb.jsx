import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * USWDS Breadcrumb — hierarchical trail. `items`: [{ label, href }].
 * The last item is treated as the current page.
 */
export function Breadcrumb({ items = [], style, ...rest }) {
  return (
    <nav aria-label="Breadcrumbs" style={{ fontFamily: "var(--font-body)", ...style }} {...rest}>
      <ol style={{ display: "flex", flexWrap: "wrap", alignItems: "center", listStyle: "none", margin: 0, padding: 0, gap: "var(--space-05)", fontSize: "var(--font-size-2xs)" }}>
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-05)" }}>
              {last || !it.href ? (
                <span aria-current={last ? "page" : undefined} style={{ color: "var(--text-muted)" }}>{it.label}</span>
              ) : (
                <a href={it.href} style={{ color: "var(--link-default)", textDecoration: "underline" }}>{it.label}</a>
              )}
              {!last && (
                <span aria-hidden="true" style={{ display: "inline-flex", color: "var(--theme-base-light)" }}><Icon name="navigate_next" size={16} /></span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
