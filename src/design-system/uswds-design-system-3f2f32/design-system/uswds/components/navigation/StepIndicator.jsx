import React from "react";
import { Icon } from "../core/Icon.jsx";

const srOnly = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * Whether every step's counter and longest label word fit in its share of the
 * indicator's width, so no label runs into the next. Measured in the browser
 * only, so it starts true.
 */
function useLabelsFit(rootRef, steps, current, counters, enabled) {
  const [fit, setFit] = React.useState(true);
  const key = steps.join("\n");
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root || typeof ResizeObserver === "undefined") return undefined;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return undefined;
    let live = true;
    const measure = () => {
      const label = root.querySelector("[data-step-label]");
      if (!live || !label) return;
      const { fontSize, fontFamily } = getComputedStyle(label);
      const gap = parseFloat(getComputedStyle(label.parentElement).columnGap) || 0;
      // Each step needs its counter (28px; 32px with the border while
      // upcoming), the gap, and its label's longest word in its weight: the
      // current step's is bold.
      const widest = Math.max(
        ...steps.map((s, i) => {
          context.font = `${i === current ? 700 : 400} ${fontSize} ${fontFamily}`;
          const word = Math.max(
            ...String(s)
              .split(/\s+/)
              .map((w) => context.measureText(w).width),
          );
          return (counters ? (i > current ? 32 : 28) + gap : 0) + word;
        }),
      );
      // A pixel for rounding.
      setFit(root.clientWidth / steps.length >= widest + 1);
    };
    measure();
    // Measure again once the web fonts are in: they set the words' widths.
    document.fonts?.ready.then(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [rootRef, key, current, counters, enabled]);
  return fit;
}

/**
 * USWDS Step Indicator — shows progress through a multi-step process.
 * `steps`: string[] labels. `current`: 0-based index of the active step.
 *
 * Where the labels can't all fit side by side (a phone, a narrow column), it
 * shows the bar segments with "Step X of N" and the current step's label, as
 * USWDS does on small screens. Screen readers still get the whole list, with
 * the current step marked, and only that.
 */
export function StepIndicator({
  steps = [],
  current = 0,
  showLabels = true,
  counters = true,
  style,
  ...rest
}) {
  const rootRef = React.useRef(null);
  const compact = !useLabelsFit(rootRef, steps, current, counters, showLabels && steps.length > 0);
  return (
    // Inline-size containment keeps the labels' widths from sizing the
    // indicator's container, so it takes the width it's given and fits to it.
    <div
      ref={rootRef}
      style={{ fontFamily: "var(--font-body)", contain: "inline-size", ...style }}
      {...rest}
    >
      <ol style={{ display: "flex", listStyle: "none", margin: 0, padding: 0 }}>
        {steps.map((label, i) => {
          const status = i < current ? "complete" : i === current ? "current" : "upcoming";
          const barColor =
            status === "complete"
              ? "var(--theme-primary-dark)"
              : status === "current"
                ? "var(--theme-primary)"
                : "var(--theme-base-lighter)";
          const numBg =
            status === "complete"
              ? "var(--theme-primary-dark)"
              : status === "current"
                ? "var(--theme-primary)"
                : "var(--surface-default)";
          const numColor = status === "upcoming" ? "var(--text-muted)" : "var(--color-white)";
          const numBorder = status === "upcoming" ? "2px solid var(--theme-base-lighter)" : "none";
          return (
            <li
              key={i}
              aria-current={status === "current" ? "step" : undefined}
              style={{
                flex: 1,
                minWidth: 0,
                position: "relative",
                paddingTop: counters ? 0 : "var(--space-05)",
              }}
            >
              {/* progress bar segment */}
              <div style={{ height: 8, background: barColor, marginRight: 2, borderRadius: 1 }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  marginTop: compact ? 0 : "var(--space-1)",
                }}
              >
                {counters && (
                  <span
                    style={{
                      flexShrink: 0,
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      display: compact ? "none" : "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: numBg,
                      color: numColor,
                      border: numBorder,
                      fontFamily: "var(--font-sans)",
                      fontWeight: 700,
                      fontSize: "var(--font-size-2xs)",
                    }}
                  >
                    {status === "complete" ? <Icon name="check" size={18} /> : i + 1}
                  </span>
                )}
                {showLabels && (
                  <span
                    data-step-label=""
                    style={{
                      fontSize: "var(--font-size-2xs)",
                      fontWeight: status === "current" ? 700 : 400,
                      color: status === "upcoming" ? "var(--text-muted)" : "var(--text-default)",
                      lineHeight: 1.2,
                      ...(compact ? srOnly : null),
                    }}
                  >
                    {label}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {/* The list already gives screen readers each step and the current one,
          so this visible summary stays out of the accessibility tree. */}
      {compact && (
        <div
          aria-hidden="true"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            columnGap: "var(--space-1)",
            marginTop: "var(--space-1)",
            fontSize: "var(--font-size-2xs)",
            lineHeight: 1.2,
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>
            Step {current + 1} of {steps.length}
          </span>
          <span style={{ fontWeight: 700, color: "var(--text-default)" }}>{steps[current]}</span>
        </div>
      )}
    </div>
  );
}
