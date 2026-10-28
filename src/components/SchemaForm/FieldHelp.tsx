import React from "react";

/** Anchored, non-modal contextual help that does not reflow the form. */
export function FieldHelp({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children?: string | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState({ top: 16, left: 16, maxHeight: 0 });
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLSpanElement>(null);
  const rootRef = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  React.useLayoutEffect(() => {
    if (!open || !buttonRef.current || !panelRef.current) return;
    const place = () => {
      const rect = buttonRef.current!.getBoundingClientRect();
      const width = Math.min(300, Math.max(200, window.innerWidth - 32));
      const maxHeight = Math.max(0, window.innerHeight - 32);
      const height = Math.min(panelRef.current!.scrollHeight, maxHeight);
      const below = rect.bottom + 7;
      setPosition({
        top:
          below + height <= window.innerHeight - 16 ? below : Math.max(16, rect.top - height - 7),
        left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
        maxHeight,
      });
    };
    place();
    panelRef.current.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  if (!children) return null;
  const panelId = `${id}-help`;
  return (
    <span ref={rootRef} style={{ display: "inline-block", position: "relative", flex: "0 0 auto" }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Help for ${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
            buttonRef.current?.focus();
          }
        }}
        style={{
          width: 24,
          height: 24,
          padding: 0,
          border: 0,
          background: "transparent",
          color: "var(--theme-primary)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          className="usa-icon"
          aria-hidden="true"
          focusable="false"
          role="img"
          width="24"
          height="24"
          style={{ display: "block", fill: "currentColor" }}
        >
          <use href="/assets/img/sprite.svg#help_outline" />
        </svg>
      </button>
      {open ? (
        <span
          ref={panelRef}
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label={`About ${label}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
          style={{
            position: "fixed",
            zIndex: 20,
            top: position.top,
            left: position.left,
            width: "min(300px, calc(100vw - 32px))",
            maxHeight: position.maxHeight,
            boxSizing: "border-box",
            overflow: "auto",
            padding: "12px 14px",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 6px 18px rgba(27, 27, 27, .18)",
            background: "var(--surface-default)",
            color: "var(--text-default)",
            fontSize: "var(--font-size-3xs)",
            fontWeight: 400,
            lineHeight: 1.5,
          }}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
