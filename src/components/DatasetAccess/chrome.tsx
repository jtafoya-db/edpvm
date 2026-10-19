// Shared building blocks for the dataset-access screens, drawn with the
// injected chrome (see resolveChrome.tsx).
import { activeBackend } from "../../data/loadStore";
import type { ReactNode } from "react";

import { actionFailureCopy } from "../actionFailure";
import type { DatasetAccessChrome } from "./resolveChrome";

import { notice, outlineBtn } from "./styles";

/** A recorded ISO timestamp, shown in the viewer's locale with the raw value on hover. */
export function Timestamp({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {new Date(iso).toLocaleString()}
    </time>
  );
}

/** A token-tinted notice with an icon. */
export function Notice({
  kind,
  title,
  children,
  chrome,
  role = "note",
  label,
}: {
  kind: "info" | "warning" | "error" | "success";
  title: string;
  children?: ReactNode;
  chrome: DatasetAccessChrome;
  role?: "note" | "alert" | "status";
  label?: string;
}) {
  const { Icon } = chrome;
  return (
    <div role={role} aria-label={label} style={notice(kind)}>
      <Icon
        name={kind === "success" ? "check_circle" : kind}
        size={20}
        color={`var(--theme-${kind}-dark)`}
      />
      <div>
        <div style={{ fontWeight: 700, marginBottom: children ? 2 : 0 }}>{title}</div>
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * The honesty-bar notice: on the memory backend (local development) this
 * state lasts for the tab only. On Delta it's saved (#123), so there's nothing to say.
 */
export function SessionStateNotice({ chrome }: { chrome: DatasetAccessChrome }) {
  if (activeBackend() === "delta") return null;
  return (
    <Notice
      kind="info"
      chrome={chrome}
      label="Session-only state"
      title="Changes last for this session only"
    >
      This app is running on the memory backend (local development), so team members, owners, team
      history and change-list entries are kept in this browser tab only. Reloading the page discards
      them.
    </Notice>
  );
}

/**
 * A failed action, in words that match what happened (#189): "refused" only
 * when the server refused. An expired sign-in says nothing was saved; a lost
 * or unreadable answer says the save is unconfirmed. The action's own button
 * stays, and pressing it again resends the same idempotency key (#182), so it
 * can't save twice. Announced as an alert, without moving focus.
 */
export function ActionErrorNotice({
  error,
  refusedTitle,
  chrome,
}: {
  error: Error;
  refusedTitle: string;
  chrome: DatasetAccessChrome;
}) {
  const { kind, title, body } = actionFailureCopy(error, refusedTitle);
  return (
    <Notice kind="error" role="alert" chrome={chrome} title={title}>
      {body}
      {kind === "session-expired" ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => window.location.reload()} style={outlineBtn}>
            Reload the page
          </button>
        </div>
      ) : null}
    </Notice>
  );
}

/** Loading and error states shared by the screens. Renders children only once data is ready. */
export function QueryGate({
  isPending,
  error,
  chrome,
  children,
}: {
  isPending: boolean;
  error: Error | null;
  chrome: DatasetAccessChrome;
  children: ReactNode;
}) {
  if (error) {
    return (
      <Notice kind="error" role="alert" chrome={chrome} title="Couldn't load from the data store">
        {error.message}
      </Notice>
    );
  }
  if (isPending) return <p style={{ color: "var(--text-muted)" }}>Loading…</p>;
  return <>{children}</>;
}

/** What a role grants, as a ticked list. */
export function GrantList({ grants, chrome }: { grants: string[]; chrome: DatasetAccessChrome }) {
  const { Icon } = chrome;
  return (
    <ul
      aria-label="Grants"
      style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}
    >
      {grants.map((grant) => (
        <li key={grant} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <Icon name="check" size={16} color="var(--theme-success-dark)" />
          <span>{grant}</span>
        </li>
      ))}
    </ul>
  );
}
