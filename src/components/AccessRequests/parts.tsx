// Building blocks shared by the access-request screens. They draw with the
// dataset-access chrome and styles (#97), so the screens match the team page.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { AccessRequestSlaConfig } from "@/data/access-requests/config";
import type { AccessRequestSla, DatasetAccessRequest } from "@/data/access-requests/types";
import { getFeature } from "@/features/registry";
import { Notice } from "../DatasetAccess/chrome";
import type { DatasetAccessChrome, ScreenCtx } from "../DatasetAccess/resolveChrome";

/**
 * A wide table that scrolls sideways on a narrow screen instead of clipping.
 * The region takes focus so keyboard users can scroll it too.
 */
export function TableScroll({
  label,
  minWidth,
  children,
}: {
  label: string;
  minWidth: number;
  children: ReactNode;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const measure = () => setOverflows(region.scrollWidth > region.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(region);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label={overflows ? `${label}, scrolls sideways` : label}
      tabIndex={overflows ? 0 : undefined}
      style={{ overflowX: "auto" }}
    >
      <div style={{ minWidth, position: "relative" }}>{children}</div>
    </div>
  );
}

/** The honesty-bar notice: requests aren't persisted (the `access-request-persistence` stub). */
export function RequestStateNotice({ chrome }: { chrome: DatasetAccessChrome }) {
  return (
    <Notice
      kind="info"
      chrome={chrome}
      label="Session-only state"
      title="Your requests and decisions last for this session only"
    >
      {getFeature("access-request-persistence").notes}
    </Notice>
  );
}

const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const SLA_LOOK: Record<AccessRequestSla["state"], { kind: string; icon: string; label: string }> = {
  "on-track": { kind: "success", icon: "schedule", label: "On track" },
  "due-soon": { kind: "warning", icon: "hourglass", label: "Due soon" },
  breached: { kind: "error", icon: "error", label: "Breached" },
};

/** How an open request tracks against the owners' service-level agreement (SLA) target. */
export function SlaPill({ sla, chrome }: { sla: AccessRequestSla; chrome: DatasetAccessChrome }) {
  const { Pill } = chrome;
  const look = SLA_LOOK[sla.state];
  return (
    <span
      title={`${sla.provisional ? "Provisional target" : "Target"}: ${sla.targetBusinessDays} business days`}
    >
      <Pill
        icon={look.icon}
        bg={`var(--theme-${look.kind}-lighter)`}
        fg={`var(--theme-${look.kind}-darker)`}
      >
        {look.label} · due {date(sla.dueAt)}
      </Pill>
    </span>
  );
}

/** The owners' service-level agreement (SLA) target, with its caveat while the business hasn't confirmed it. */
export function SlaTargetNote({ sla }: { sla: AccessRequestSlaConfig }) {
  return (
    <p
      aria-label="Service-level agreement target"
      style={{ margin: 0, fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}
    >
      <strong>
        {sla.provisional
          ? "Provisional service-level agreement (SLA) target"
          : "Service-level agreement (SLA) target"}
        : owners decide within {sla.targetBusinessDays} business days.
      </strong>{" "}
      {sla.note}
    </p>
  );
}

const STATUS_LOOK: Record<
  DatasetAccessRequest["status"],
  { bg: string; fg: string; icon: string; label: string }
> = {
  requested: {
    bg: "var(--color-blue-5v)",
    fg: "var(--theme-primary)",
    icon: "schedule",
    label: "Requested",
  },
  active: {
    bg: "var(--theme-success-lighter)",
    fg: "var(--theme-success-darker)",
    icon: "check_circle",
    label: "Active",
  },
  rejected: {
    bg: "var(--theme-error-lighter)",
    fg: "var(--theme-error-darker)",
    icon: "close",
    label: "Rejected",
  },
  withdrawn: {
    bg: "var(--color-gray-cool-2)",
    fg: "var(--color-gray-cool-70)",
    icon: "close",
    label: "Withdrawn",
  },
};

export function StatusPill({
  status,
  chrome,
}: {
  status: DatasetAccessRequest["status"];
  chrome: DatasetAccessChrome;
}) {
  const { Pill } = chrome;
  const look = STATUS_LOOK[status];
  return (
    <Pill icon={look.icon} bg={look.bg} fg={look.fg}>
      {look.label}
    </Pill>
  );
}

function tab(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    background: "none",
    border: "none",
    padding: "11px 16px",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--font-size-2xs)",
    fontWeight: active ? 700 : 500,
    color: active ? "var(--theme-primary)" : "var(--color-gray-cool-60)",
    borderBottom: active ? "3px solid var(--theme-primary)" : "3px solid transparent",
    marginBottom: -1,
    textDecoration: "none",
  };
}

/** Underline tabs between the person's requests and the owners' inbox, as hash routes. */
export function RequestTabs({
  ctx,
  current,
  inboxCount,
  chrome,
}: {
  ctx: ScreenCtx;
  current: "access-requests" | "access-inbox";
  /** Open requests waiting on the viewer, if known. */
  inboxCount?: number | undefined;
  chrome: DatasetAccessChrome;
}) {
  const { Icon } = chrome;
  const tabs = [
    { id: "access-requests", label: "Your requests", icon: "person" },
    {
      id: "access-inbox",
      label: inboxCount ? `Owner inbox (${inboxCount})` : "Owner inbox",
      icon: "group",
    },
  ] as const;
  return (
    <nav
      aria-label="Access request views"
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border-default)",
        marginBottom: 22,
      }}
    >
      {tabs.map((t) => {
        const active = t.id === current;
        const color = active ? "var(--theme-primary)" : "var(--color-gray-cool-60)";
        return (
          <a
            key={t.id}
            href={`#${t.id}`}
            aria-current={active ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              ctx.go(t.id);
            }}
            style={tab(active)}
          >
            <Icon name={t.icon} size={16} color={color} /> {t.label}
          </a>
        );
      })}
    </nav>
  );
}
