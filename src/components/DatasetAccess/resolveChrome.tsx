// The chrome the dataset-access screens draw with, injected by the legacy
// shell (src/legacy/App.jsx) from the ported prototype primitives, the same
// way SchemaForm and AdminEditor take theirs. The headless defaults keep the
// screens renderable, and testable, with no shell at all.
import type { CSSProperties, ComponentType, ReactNode } from "react";

export interface TrailItem {
  label: string;
  go?: () => void;
}

export interface DatasetAccessChrome {
  Page: ComponentType<{ children?: ReactNode }>;
  Trail: ComponentType<{ items: TrailItem[] }>;
  Panel: ComponentType<{ pad?: number; style?: CSSProperties; children?: ReactNode }>;
  SectionHead: ComponentType<{ title: string; eyebrow?: string; action?: ReactNode }>;
  Pill: ComponentType<{
    icon?: string;
    bg?: string;
    fg?: string;
    bd?: string;
    size?: "sm" | "md";
    children?: ReactNode;
  }>;
  Icon: ComponentType<{ name: string; size?: number; color?: string }>;
}

const HEADLESS: DatasetAccessChrome = {
  Page: ({ children }) => <div>{children}</div>,
  Trail: ({ items }) => (
    <nav aria-label="Breadcrumb">{items.map((item) => item.label).join(" / ")}</nav>
  ),
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
};

/** The injected chrome, with headless fallbacks for anything not supplied. */
export function resolveChrome(chrome?: Partial<DatasetAccessChrome>): DatasetAccessChrome {
  // Skip undefined entries: the shell passes `window.X`, which is undefined
  // until that primitive is registered.
  const defined = Object.entries(chrome ?? {}).filter(([, value]) => value !== undefined);
  return { ...HEADLESS, ...(Object.fromEntries(defined) as Partial<DatasetAccessChrome>) };
}

/** The slice of the legacy shell's `ctx` these screens use. */
export interface ScreenCtx {
  go: (name: string, params?: { id?: string }) => void;
}

export interface ScreenProps {
  ctx: ScreenCtx;
  params?: { id?: string };
  chrome?: Partial<DatasetAccessChrome>;
}
