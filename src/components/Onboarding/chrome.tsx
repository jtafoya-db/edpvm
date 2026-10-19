/* eslint-disable react-refresh/only-export-components -- a chrome-injection
   module: it exports the context and hook alongside the headless defaults. */
// The design-system primitives the onboarding screens (#86) compose: the legacy
// shell's Page, Trail, Panel, SectionHead, Pill and AppIcon, plus the USWDS
// StepIndicator and Accordion. The host injects the real ones (src/legacy/onboarding.jsx);
// these headless defaults keep the screens renderable under test.

import React from "react";

export type ChromeIcon = React.ComponentType<{ name: string; size?: number; color?: string }>;

export interface OnboardingChrome {
  Page: React.ComponentType<{ children?: React.ReactNode }>;
  Trail: React.ComponentType<{ items: Array<{ label: string; go?: () => void }> }>;
  Panel: React.ComponentType<{
    children?: React.ReactNode;
    pad?: number;
    style?: React.CSSProperties;
  }>;
  SectionHead: React.ComponentType<{
    title: string;
    eyebrow?: string | undefined;
    action?: React.ReactNode;
  }>;
  Pill: React.ComponentType<{
    children?: React.ReactNode;
    icon?: string;
    bg?: string;
    fg?: string;
    bd?: string;
    size?: "sm" | "lg";
  }>;
  Icon: ChromeIcon;
  StepIndicator: React.ComponentType<{ steps: string[]; current: number; counters?: boolean }>;
  /** USWDS Accordion: each item an h4 button that shows or hides its content. */
  Accordion: React.ComponentType<{
    items: Array<{ id: string; title: React.ReactNode; content: React.ReactNode }>;
    multiselectable?: boolean;
    defaultOpen?: string[];
  }>;
}

/** The headless Accordion: the design system's markup, without its styling. */
function HeadlessAccordion({
  items,
  multiselectable = false,
  defaultOpen = [],
}: React.ComponentProps<OnboardingChrome["Accordion"]>) {
  const [open, setOpen] = React.useState(() => new Set(defaultOpen));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(multiselectable ? prev : []);
      if (prev.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div>
      {items.map((item) => (
        <div key={item.id}>
          <h4 style={{ margin: 0 }}>
            <button
              type="button"
              aria-expanded={open.has(item.id)}
              aria-controls={item.id}
              onClick={() => toggle(item.id)}
            >
              <span>{item.title}</span>
            </button>
          </h4>
          <div id={item.id} hidden={!open.has(item.id)}>
            {item.content}
          </div>
        </div>
      ))}
    </div>
  );
}

export const HEADLESS_CHROME: OnboardingChrome = {
  Page: ({ children }) => <div>{children}</div>,
  Trail: ({ items }) => <nav aria-label="Breadcrumb">{items.map((i) => i.label).join(" / ")}</nav>,
  Panel: ({ children, style }) => <div style={style}>{children}</div>,
  SectionHead: ({ title, eyebrow, action }) => (
    <div>
      {eyebrow ? <div>{eyebrow}</div> : null}
      <h2>{title}</h2>
      {action}
    </div>
  ),
  Pill: ({ children }) => <span>{children}</span>,
  Icon: () => null,
  StepIndicator: ({ steps, current }) => (
    <ol aria-label="Stages">
      {steps.map((label, i) => (
        <li key={label} aria-current={i === current ? "step" : undefined}>
          {label}
        </li>
      ))}
    </ol>
  ),
  Accordion: HeadlessAccordion,
};

const ChromeContext = React.createContext<OnboardingChrome>(HEADLESS_CHROME);

export function ChromeProvider({
  chrome,
  children,
}: {
  chrome?: Partial<OnboardingChrome> | undefined;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ ...HEADLESS_CHROME, ...chrome }), [chrome]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

export function useChrome(): OnboardingChrome {
  return React.useContext(ChromeContext);
}
