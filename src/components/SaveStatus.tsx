/**
 * Where optimistic saves (src/data/optimistic-save.ts, ADR-0009 phase 1) tell
 * the person how they went: "Saving…", then "Saved" only once the server
 * confirms, a refusal with its reason, or "couldn't confirm" with Try again.
 *
 * - {@link SaveNotices} shows a screen's own saves in place, next to what
 *   they change. While it's mounted it claims those records.
 * - {@link SaveStatusRegion}, mounted once in the app shell, shows every save
 *   no screen has claimed: the ones the person navigated away from.
 *
 * Both announce each change without moving focus (#184): saving and saved
 * through a polite live region that's always in the page; a refusal or an
 * unconfirmed save as an alert. Failures say what happened in #189's words
 * (src/components/actionFailure.ts), the same as the blocking saves' notices:
 * "refused" only when the server refused.
 */
import { useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { useSaves, type SaveView } from "@/data/optimistic-save";

import { actionFailureCopy } from "./actionFailure";

// --- Claims: which records a mounted screen is already showing ---------------

const claims = new Map<string, number>();
const listeners = new Set<() => void>();
let claimSnapshot: string[] = [];

function setClaim(prefix: string, delta: number) {
  const next = (claims.get(prefix) ?? 0) + delta;
  if (next > 0) claims.set(prefix, next);
  else claims.delete(prefix);
  claimSnapshot = [...claims.keys()];
  for (const listener of listeners) listener();
}

function useClaims(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => claimSnapshot,
    () => claimSnapshot,
  );
}

function useClaim(prefixes: readonly string[]) {
  const key = prefixes.join("\u0000");
  useEffect(() => {
    const list = key.split("\u0000");
    for (const prefix of list) setClaim(prefix, 1);
    return () => {
      for (const prefix of list) setClaim(prefix, -1);
    };
  }, [key]);
}

// --- One save, in words --------------------------------------------------------

const TONE: Record<SaveView["state"], { bg: string; border: string }> = {
  saving: { bg: "var(--theme-info-lighter)", border: "var(--theme-info)" },
  saved: { bg: "var(--theme-success-lighter)", border: "var(--theme-success)" },
  refused: { bg: "var(--theme-error-lighter)", border: "var(--theme-error)" },
  unconfirmed: { bg: "var(--theme-warning-lighter)", border: "var(--theme-warning)" },
};

const linkButton: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--theme-primary-dark)",
  textDecoration: "underline",
  cursor: "pointer",
  font: "inherit",
};

/** What to say about a save: its heading and, for a failure, #189's words. */
function saveCopy(save: SaveView): { title: string; body: string | null } {
  if (save.state === "saving") return { title: `Saving… ${save.label}`, body: null };
  if (save.state === "saved") return { title: save.label, body: null };
  const copy = actionFailureCopy(save.error ?? new Error(save.reason ?? ""), save.refusedTitle);
  return {
    title: copy.title,
    body:
      save.state === "unconfirmed"
        ? `${copy.body} Try again sends the same request, so it can't be saved twice.`
        : copy.body,
  };
}

function SaveItem({ save }: { save: SaveView }) {
  const tone = TONE[save.state];
  const { title, body } = saveCopy(save);
  const failed = save.state === "refused" || save.state === "unconfirmed";
  return (
    <div
      data-save-state={save.state}
      style={{
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderLeft: `4px solid ${tone.border}`,
        borderRadius: "var(--radius-md)",
        padding: "10px 14px",
        fontSize: "var(--font-size-2xs)",
        color: "var(--text-default, #1b1b1b)",
      }}
    >
      <div style={{ fontWeight: 700 }}>{title}</div>
      {failed ? <div>{save.label}.</div> : null}
      {body ? <div>{body}</div> : null}
      {save.state === "saving" ? null : (
        <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
          {save.state === "unconfirmed" ? (
            <button type="button" style={linkButton} onClick={save.retry}>
              Try again
            </button>
          ) : null}
          {save.failure === "session-expired" ? (
            <button type="button" style={linkButton} onClick={() => window.location.reload()}>
              Reload the page
            </button>
          ) : null}
          <button
            type="button"
            style={linkButton}
            onClick={save.dismiss}
            aria-label={`Dismiss: ${title}`}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A polite live region that's always in the page, for progress, and an alert
 * for what needs the person's attention (a refusal, an unconfirmed save),
 * announced as it appears.
 */
function SaveList({ saves, label }: { saves: SaveView[]; label: string }) {
  const needsAttention = (s: SaveView) => s.state === "refused" || s.state === "unconfirmed";
  const progress = saves.filter((s) => !needsAttention(s));
  const refused = saves.filter(needsAttention);
  const stack: CSSProperties = { display: "grid", gap: 8 };
  return (
    <section aria-label={label} style={stack}>
      <div aria-live="polite" style={stack}>
        {progress.map((save) => (
          <SaveItem key={save.id} save={save} />
        ))}
      </div>
      {refused.length > 0 ? (
        <div role="alert" style={stack}>
          {refused.map((save) => (
            <SaveItem key={save.id} save={save} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Only the latest "Saved": earlier ones have nothing left to say. */
function visible(saves: SaveView[]): SaveView[] {
  const lastSaved = saves
    .filter((s) => s.state === "saved")
    .reduce<SaveView | undefined>((a, b) => (a && a.settledAt > b.settledAt ? a : b), undefined);
  return saves.filter((s) => s.state !== "saved" || s === lastSaved);
}

/**
 * A screen's own saves, in place. `prefixes` name the records it shows
 * (e.g. `member:<dataset id>:`); the app-wide region leaves them to it.
 */
export function SaveNotices({
  prefixes,
  label = "Saves",
}: {
  prefixes: readonly string[];
  label?: string;
}) {
  useClaim(prefixes);
  const saves = visible(useSaves((s) => prefixes.some((p) => s.record.startsWith(p))));
  return <SaveList saves={saves} label={label} />;
}

const SAVED_FADE_MS = 10_000;

/**
 * Every save no mounted screen is showing, in a corner of the app. Mount it
 * once, in the app shell. Also asks the browser to warn before the page is
 * left or reloaded while a save is unconfirmed: in-app navigation keeps it,
 * closing the tab may not.
 */
export function SaveStatusRegion() {
  const all = useSaves();
  const claimed = useClaims();
  const saves = visible(all.filter((s) => !claimed.some((p) => s.record.startsWith(p))));
  const unresolved = all.some((s) => s.state === "saving" || s.state === "unconfirmed");

  useEffect(() => {
    if (!unresolved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved]);

  const savedIds = saves.filter((s) => s.state === "saved").map((s) => s.id);
  const savedKey = savedIds.join(",");
  useEffect(() => {
    if (!savedKey) return;
    const timer = window.setTimeout(() => {
      for (const save of saves) if (savedIds.includes(save.id)) save.dismiss();
    }, SAVED_FADE_MS);
    return () => window.clearTimeout(timer);
    // Only a new "Saved" restarts the fade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1000,
        width: "min(24rem, calc(100vw - 32px))",
        fontFamily: "var(--font-sans)",
      }}
    >
      <SaveList saves={saves} label="Saves in progress" />
    </div>
  );
}

/** A row's marker while its save is unresolved: shown in place of what's not true yet. */
export function SavingTag({
  save,
  children,
}: {
  save: SaveView | undefined;
  children?: ReactNode;
}) {
  if (!save || (save.state !== "saving" && save.state !== "unconfirmed")) return <>{children}</>;
  const saving = save.state === "saving";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: "var(--font-size-3xs, 12px)",
        fontWeight: 700,
        background: saving ? "var(--theme-info-lighter)" : "var(--theme-warning-lighter)",
        // The warning tone's darker shade is 4.1:1 on its lighter one; body text passes AA.
        color: saving ? "var(--theme-info-darker)" : "var(--text-default, #1b1b1b)",
      }}
    >
      {saving ? "Saving…" : "Not confirmed"}
    </span>
  );
}
