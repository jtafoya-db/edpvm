/**
 * Shown when a submit through the data seam fails. Without it a failed
 * submit only rolls back its optimistic entry, silently.
 *
 * When the server can't tell whether the write landed (`outcome-unknown`:
 * #72's legacy writes have no idempotency key, so a retry could save it
 * twice), the person is told to reload and check before trying again. The
 * wording comes from the server; the notice adds a reload button. An expired
 * sign-in (#189) gets the same button: reloading signs in again.
 */
export interface SaveFailedNoticeProps {
  error: Error & { code?: string };
  onDismiss?: () => void;
  onReload?: () => void;
}

export function SaveFailedNotice({ error, onDismiss, onReload }: SaveFailedNoticeProps) {
  const unknown = error.code === "outcome-unknown";
  // The proxy's sign-in page (#189): nothing reached the server.
  const expired = error.code === "session-expired";
  return (
    <div
      role="alert"
      className="usa-alert usa-alert--error usa-alert--slim"
      style={{ margin: "12px auto", maxWidth: 960 }}
    >
      <div className="usa-alert__body">
        <h2 className="usa-alert__heading" style={{ fontSize: "1rem" }}>
          {expired
            ? "Your sign-in has expired"
            : unknown
              ? "We couldn't confirm your request was saved"
              : "Your request wasn't saved"}
        </h2>
        <p className="usa-alert__text">{error.message}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          {(unknown || expired) && (
            <button
              type="button"
              className="usa-button"
              onClick={onReload ?? (() => window.location.reload())}
            >
              Reload
            </button>
          )}
          {onDismiss && (
            <button type="button" className="usa-button usa-button--unstyled" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
