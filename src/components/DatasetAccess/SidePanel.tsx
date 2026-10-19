// A panel that slides in over the page for one task (#114): the team page's
// add and edit forms. It's a modal dialog: focus moves in when it opens, Tab
// stays inside, Escape or Close dismisses it, and focus goes back to whatever
// opened it (or, if that's gone, to `returnFocusId`).
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import type { DatasetAccessChrome } from "./resolveChrome";
import * as s from "./styles";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]';

export function SidePanel({
  title,
  onClose,
  returnFocusId,
  chrome,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Where focus goes on close when the element that opened the panel has gone. */
  returnFocusId?: string;
  chrome: DatasetAccessChrome;
  children: ReactNode;
}) {
  const { Icon } = chrome;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const fallback = useRef(returnFocusId);
  fallback.current = returnFocusId;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const start =
      ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      ref.current?.querySelector<HTMLElement>("h2");
    start?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
      else if (fallback.current) document.getElementById(fallback.current)?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.tabIndex >= 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const inside = ref.current.contains(document.activeElement);
    if (event.shiftKey && (document.activeElement === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div aria-hidden="true" onClick={onClose} style={backdrop} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        style={sheet}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
          <h2 id={titleId} tabIndex={-1} style={heading}>
            {title}
          </h2>
          <button type="button" onClick={onClose} style={{ ...s.outlineBtn, marginLeft: "auto" }}>
            <Icon name="close" size={16} color="var(--theme-primary)" />
            Close
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

const backdrop = {
  position: "fixed",
  inset: 0,
  background: "var(--surface-dark)",
  opacity: 0.5,
  zIndex: 200,
} as const;

const sheet = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(640px, 100vw)",
  boxSizing: "border-box",
  overflowY: "auto",
  padding: 24,
  background: "var(--surface-default)",
  boxShadow: "var(--shadow-3)",
  zIndex: 201,
} as const;

const heading = {
  fontFamily: "var(--font-heading)",
  fontSize: "var(--font-size-lg)",
  fontWeight: 700,
  margin: 0,
  overflowWrap: "anywhere",
} as const;
