// Shared pieces for the team-management surfaces (#87).
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { personContact, type DatasetMember } from "@/data/datasets/types";
import type { DatasetAccessChrome } from "./resolveChrome";
import * as s from "./styles";

export const dangerBtn: CSSProperties = {
  ...s.outlineBtn,
  color: "var(--theme-error-dark)",
  borderColor: "var(--color-red-cool-30v)",
};

export const smallBtn: CSSProperties = { padding: "5px 10px", fontSize: "var(--font-size-3xs)" };

export const columnHead: CSSProperties = { ...s.lbl, margin: "0 0 8px" };

/**
 * A ref that takes focus when it mounts: a panel's next step, so focus stays
 * in the panel when the button that led there goes away.
 */
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/**
 * A table's sideways-scrolling region (#114): on a phone the table keeps a
 * readable width and scrolls inside its panel, never the page. Focusable, so
 * keyboard users can scroll it too.
 */
export function TableScroll({
  label,
  id,
  minWidth,
  children,
}: {
  label: string;
  id?: string;
  minWidth: number;
  children: ReactNode;
}) {
  return (
    <div id={id} role="region" aria-label={label} tabIndex={0} style={{ overflowX: "auto" }}>
      <div style={{ minWidth }}>{children}</div>
    </div>
  );
}

/** A confirmation step. It takes focus as it opens, so focus stays in the panel. */
export function ReviewStep({ label, children }: { label: string; children: ReactNode }) {
  const ref = useFocusOnMount<HTMLElement>();
  return (
    <section ref={ref} aria-label={label} tabIndex={-1}>
      {children}
    </section>
  );
}

/** A ref that takes focus each time `attempt` goes up, i.e. on every failed submit. */
export function useFocusOnAttempt<T extends HTMLElement>(attempt: number) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (attempt > 0) ref.current?.focus();
  }, [attempt]);
  return ref;
}

export interface FieldError {
  /** The invalid field's id. */
  id: string;
  message: string;
}

/**
 * A failed submit's errors: announced, focused on each failed submit, and
 * linking to each invalid field. Renders nothing when there are none.
 */
export function ErrorSummary({
  errors,
  attempt,
  chrome,
}: {
  errors: FieldError[];
  attempt: number;
  chrome: DatasetAccessChrome;
}) {
  const ref = useFocusOnAttempt<HTMLDivElement>(attempt);
  const { Icon } = chrome;
  if (errors.length === 0) return null;
  return (
    <div ref={ref} role="alert" tabIndex={-1} style={{ ...s.notice("error"), marginBottom: 18 }}>
      <Icon name="error" size={20} color="var(--theme-error-dark)" />
      <div>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>Fix these to continue</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {errors.map((error) => (
            <li key={error.id}>
              <a
                href={`#${error.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(error.id)?.focus();
                }}
                style={{ color: "inherit", textDecoration: "underline" }}
              >
                {error.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function personLabel(member: Pick<DatasetMember, "person">) {
  return `${member.person.name} (${personContact(member.person)})`;
}

export function entryIds(entries: { id: string }[]) {
  return entries.map((e) => e.id).join(", ");
}
