/**
 * The legacy host's load failure: every screen, the onboarding wizard
 * included, gets its data (the Target domain list among it) through one set of
 * seam queries, so a failed load is announced here with a Retry, never shown
 * as empty lists.
 */
export function BackendUnavailableNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" style={{ maxWidth: 520 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: "1.1rem",
          color: "var(--theme-error-dark, #b50909)",
        }}
      >
        Data backend unavailable
      </div>
      <p style={{ color: "var(--text-muted, #565c65)", marginTop: 8 }}>
        The app could not load its state through the data seam, so it can't show screens such as the
        onboarding wizard (including its Target domain list). This is a real backend/config failure
        — no prototype data is being shown.
      </p>
      <pre
        style={{
          marginTop: 12,
          padding: 12,
          background: "var(--color-gray-5, #f0f0f0)",
          borderRadius: 6,
          overflowX: "auto",
          fontSize: "0.8rem",
          textAlign: "left",
        }}
      >
        {message}
      </pre>
      <button type="button" className="usa-button" style={{ marginTop: 12 }} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
