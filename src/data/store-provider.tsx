/**
 * Provides the active {@link DataStore} to everything below it.
 *
 * With no `store` prop it loads the seam default via `loadStore()` (the P1
 * in-memory adapter). Tests pass an explicit store to inject a fixture-backed
 * adapter. This is a plain provider — the TanStack Query client lives higher
 * up, at the router root (src/routes/__root.tsx).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { apiFailureKind } from "./api-response";
import { loadStore } from "./loadStore";
import { StoreContext } from "./store-context";
import type { DataStore } from "./store";

export function StoreProvider({ store, children }: { store?: DataStore; children: ReactNode }) {
  const [loaded, setLoaded] = useState<DataStore | null>(store ?? null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (store) {
      setLoaded(store);
      setError(null);
      return;
    }
    setLoaded(null);
    setError(null);
    void loadStore()
      .then((value) => {
        if (!cancelled) setLoaded(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason : new Error(String(reason)));
      });
    return () => {
      cancelled = true;
    };
  }, [store, attempt]);
  const value = useMemo(() => store ?? loaded, [loaded, store]);
  if (!value) {
    if (error) {
      const signedOut =
        apiFailureKind(error) === "session-expired" ||
        /\/api\/session responded (401|403)/.test(error.message);
      return (
        <main
          role="alert"
          aria-live="assertive"
          style={{
            margin: "3rem auto",
            maxWidth: "44rem",
            padding: "0 1rem",
            color: "var(--text-strong, #1b1b1b)",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
            {signedOut ? "Sign in to continue" : "The app could not load"}
          </h1>
          <p style={{ marginBottom: "1rem" }}>
            {signedOut
              ? "Your session could not be verified. Sign in to Databricks, then retry."
              : "The app could not verify your session, so it did not load local fallback data."}
          </p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </main>
      );
    }
    return (
      <main
        role="status"
        aria-live="polite"
        style={{ margin: "3rem auto", maxWidth: "44rem", padding: "0 1rem" }}
      >
        Loading your session...
      </main>
    );
  }
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
