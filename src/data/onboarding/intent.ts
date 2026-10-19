/**
 * One idempotency key per user intent (#131 UAT). A screen asks for the intent
 * when the person confirms a save; the same intent (same record, same decision,
 * same input) keeps its key across retries until it succeeds, so a retry or a
 * double click replays the first write. Anything changed is a new intent.
 */
import { useCallback, useRef } from "react";

import type { OnboardingWriteIntent } from "./types";

export interface WriteIntents {
  /**
   * The intent for this input, confirmed against `version` of the record (none
   * for a new one): the current intent if neither changed, else a fresh key.
   */
  intentFor: (input: unknown, version?: number) => OnboardingWriteIntent;
  /** The intent succeeded; the next confirmation is a new intent. */
  settle: () => void;
}

export function useWriteIntent(
  newKey: () => string = () => globalThis.crypto.randomUUID(),
): WriteIntents {
  const current = useRef<{ signature: string; intent: OnboardingWriteIntent } | null>(null);
  const intentFor = useCallback(
    (input: unknown, version?: number) => {
      const signature = JSON.stringify([input, version ?? null]);
      if (current.current?.signature !== signature) {
        current.current = {
          signature,
          intent: { key: newKey(), ...(version === undefined ? {} : { version }) },
        };
      }
      return current.current.intent;
    },
    [newKey],
  );
  const settle = useCallback(() => {
    current.current = null;
  }, []);
  return { intentFor, settle };
}
