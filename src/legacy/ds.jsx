import React from "react";
import * as USWDS from "@/design-system/uswds-design-system-3f2f32";

// Resolves a component from the attached USWDS design system. Kept as a
// render-time lookup (instead of a direct import per screen) so a missing
// component degrades to a plain wrapper element rather than blanking the page
// with "Element type is invalid".
export function ds(name, fallbackTag = "div") {
  const Wrapped = (props) => {
    const legacy = typeof window !== "undefined" ? window.USWDSDesignSystem_fc84de : null;
    const Cmp = USWDS[name] || (legacy && legacy[name]);
    if (typeof Cmp !== "function" && typeof Cmp !== "string") {
      if (typeof console !== "undefined") {
        console.warn(`[uswds] component "${name}" unavailable; rendering fallback`);
      }
      const { children, ...rest } = props || {};
      return React.createElement(fallbackTag, rest, children ?? null);
    }
    return React.createElement(Cmp, props);
  };
  Wrapped.displayName = `USWDS(${name})`;
  return Wrapped;
}
