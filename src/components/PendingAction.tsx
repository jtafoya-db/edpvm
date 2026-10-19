import {
  useCallback,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";

import { isUnknownOutcome } from "@/data/optimistic-save";

export interface PendingAction {
  recordId: string;
  actionId: string;
  label: string;
}

export interface PendingActionIntent {
  recordId: string;
  actionId: string;
  payloadKey: string;
  idempotencyKey: string;
}

const pendingKey = (recordId: string, actionId: string) => `${recordId}\u0000${actionId}`;
const intentKey = (recordId: string, actionId: string, payloadKey: string) =>
  `${pendingKey(recordId, actionId)}\u0000${payloadKey}`;
const newIntentKey = () => globalThis.crypto.randomUUID();

function pendingDisabledStyle(style: CSSProperties | undefined): CSSProperties {
  const borderWidth =
    typeof style?.border === "string" || typeof style?.borderColor === "string" ? "1px" : "0";
  const linkLike = style?.background === "none" && style?.border === "none";
  return {
    ...style,
    background: linkLike ? style?.background : "var(--color-gray-cool-20)",
    border: linkLike ? style?.border : `${borderWidth} solid var(--color-gray-cool-40)`,
    borderColor: linkLike ? style?.borderColor : "var(--color-gray-cool-40)",
    color: linkLike ? "var(--theme-primary-darker)" : "var(--color-gray-cool-70)",
    cursor: "not-allowed",
    boxShadow: "none",
    opacity: 1,
  };
}

export function disabledPendingStyle(
  style: CSSProperties | undefined,
  disabled: boolean,
): CSSProperties | undefined {
  return disabled ? pendingDisabledStyle(style) : style;
}

/** The same test optimistic saves use (src/data/optimistic-save.ts). */
export const keepIntentForUnknownOutcome = isUnknownOutcome;

export function usePendingActionGroup() {
  const pendingRef = useRef(new Map<string, PendingAction>());
  const intentsRef = useRef(new Map<string, PendingActionIntent>());
  const [pending, setPending] = useState<PendingAction[]>([]);

  const clearIntent = useCallback((recordId: string, actionId: string, payloadKey?: string) => {
    const prefix =
      payloadKey === undefined
        ? `${pendingKey(recordId, actionId)}\u0000`
        : intentKey(recordId, actionId, payloadKey);
    for (const key of Array.from(intentsRef.current.keys())) {
      if (payloadKey === undefined ? key.startsWith(prefix) : key === prefix) {
        intentsRef.current.delete(key);
      }
    }
  }, []);

  const clearRecordIntents = useCallback((recordId: string) => {
    const prefix = `${recordId}\u0000`;
    for (const key of Array.from(intentsRef.current.keys())) {
      if (key.startsWith(prefix)) intentsRef.current.delete(key);
    }
  }, []);

  const makeIntent = useCallback(
    (recordId: string, actionId: string, payloadKey: string): PendingActionIntent => {
      const key = intentKey(recordId, actionId, payloadKey);
      const existing = intentsRef.current.get(key);
      if (existing) return existing;
      const intent = { recordId, actionId, payloadKey, idempotencyKey: newIntentKey() };
      intentsRef.current.set(key, intent);
      return intent;
    },
    [],
  );

  const run = useCallback(
    async <T,>(
      action: PendingAction,
      save: (intent: PendingActionIntent) => Promise<T>,
      options?: { intent?: PendingActionIntent; keepIntentOnError?: (error: unknown) => boolean },
    ): Promise<T | undefined> => {
      if (pendingRef.current.has(action.recordId)) return undefined;
      const currentIntentKey = options?.intent
        ? intentKey(options.intent.recordId, options.intent.actionId, options.intent.payloadKey)
        : null;
      const intent =
        options?.intent && intentsRef.current.get(currentIntentKey ?? "") === options.intent
          ? options.intent
          : options?.intent
            ? makeIntent(
                options.intent.recordId,
                options.intent.actionId,
                options.intent.payloadKey,
              )
            : makeIntent(action.recordId, action.actionId, `run:${Date.now()}:${newIntentKey()}`);
      pendingRef.current.set(action.recordId, action);
      setPending(Array.from(pendingRef.current.values()));
      try {
        const result = await save(intent);
        clearRecordIntents(action.recordId);
        return result;
      } catch (error) {
        if (!options?.keepIntentOnError?.(error)) {
          clearIntent(intent.recordId, intent.actionId, intent.payloadKey);
        }
        throw error;
      } finally {
        if (pendingRef.current.get(action.recordId) === action) {
          pendingRef.current.delete(action.recordId);
          setPending(Array.from(pendingRef.current.values()));
        }
      }
    },
    [clearIntent, clearRecordIntents, makeIntent],
  );

  const isRecordPending = useCallback((recordId: string) => pendingRef.current.has(recordId), []);
  const isActionPending = useCallback(
    (recordId: string, actionId: string) => pendingRef.current.get(recordId)?.actionId === actionId,
    [],
  );

  return {
    pending,
    run,
    makeIntent,
    clearIntent,
    clearRecordIntents,
    isRecordPending,
    isActionPending,
  };
}

export type PendingActionGroup = ReturnType<typeof usePendingActionGroup>;

export function PendingActionButton({
  pending,
  locked,
  children,
  savingLabel = "Saving…",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  locked?: boolean;
  savingLabel?: string;
  children: ReactNode;
}) {
  const unavailable = Boolean(disabled || pending || locked);
  return (
    <button
      {...props}
      disabled={unavailable}
      aria-busy={pending || undefined}
      style={disabledPendingStyle(props.style, unavailable)}
    >
      {pending ? savingLabel : children}
    </button>
  );
}

export function PendingActionStatus({
  pending,
  children = "Saving… this can take a few seconds.",
}: {
  pending: boolean;
  children?: ReactNode;
}) {
  if (!pending) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      style={{ alignSelf: "center", color: "var(--text-muted)" }}
    >
      {children}
    </span>
  );
}
