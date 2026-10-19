import type { CSSProperties } from "react";

/** The parts of a query result Refresh needs. */
interface Refreshable {
  refetch: () => Promise<unknown>;
  isFetching: boolean;
  dataUpdatedAt: number;
}

const button: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "var(--surface-default)",
  color: "var(--theme-primary)",
  border: "1.5px solid var(--theme-primary)",
  borderRadius: "var(--radius-md)",
  padding: "7px 14px",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/**
 * Re-reads a work queue now (#80). Inboxes and the change list are trusted for
 * 15 s (src/data/query-policy.ts) and re-read in the background after that, so
 * this is for someone waiting on the next item. It says when the list was last
 * read, so cached data is never mistaken for live data.
 */
export function RefreshButton({ queries, what }: { queries: Refreshable[]; what: string }) {
  const fetching = queries.some((q) => q.isFetching);
  const read = queries.map((q) => q.dataUpdatedAt).filter((at) => at > 0);
  const updatedAt = read.length ? Math.min(...read) : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span
        aria-live="polite"
        style={{ fontSize: "var(--font-size-3xs)", color: "var(--text-muted)" }}
      >
        {fetching ? (
          "Refreshing…"
        ) : updatedAt ? (
          <>
            Updated{" "}
            <time dateTime={new Date(updatedAt).toISOString()}>
              {new Date(updatedAt).toLocaleTimeString()}
            </time>
          </>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={`Refresh ${what}`}
        disabled={fetching}
        onClick={() => {
          for (const q of queries) void q.refetch();
        }}
        style={{ ...button, ...(fetching ? { opacity: 0.6, cursor: "default" } : {}) }}
      >
        Refresh
      </button>
    </span>
  );
}
