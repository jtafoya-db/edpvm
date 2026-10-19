import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { eirErrorStatus, type EirRecord, type EirStage } from "@/data";
import { apiFailureKind } from "@/data/api-response";

type PanelProps = { children?: ReactNode; pad?: number; hover?: boolean; style?: CSSProperties };
type PillProps = {
  children?: ReactNode;
  icon?: string;
  bg?: string;
  fg?: string;
  bd?: string;
  size?: string;
};
type IconProps = { name: string; size?: number; color?: string };
type SectionHeadProps = { eyebrow?: string; title: string; action?: ReactNode };
type TrailProps = { items: Array<{ label: string; go?: () => void }> };

export interface EirScreenChrome {
  Page: React.ComponentType<{ children?: ReactNode }>;
  Trail: React.ComponentType<TrailProps>;
  Panel: React.ComponentType<PanelProps>;
  Pill: React.ComponentType<PillProps>;
  Icon: React.ComponentType<IconProps>;
  SectionHead: React.ComponentType<SectionHeadProps>;
}

export const heading: CSSProperties = {
  fontFamily: "var(--font-heading)",
  fontSize: "var(--font-size-2xl)",
  fontWeight: 700,
  margin: "0 0 4px",
  color: "var(--text-default)",
};
export const label: CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  marginBottom: 7,
  color: "var(--text-default)",
};
export const input: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  border: "1.5px solid var(--border-strong)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface-default)",
  padding: "11px 13px",
  fontSize: "var(--font-size-2xs)",
  fontFamily: "var(--font-sans)",
  color: "var(--text-default)",
  marginTop: 7,
};
export const primaryButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  border: "1px solid var(--theme-primary)",
  borderRadius: "var(--radius-md)",
  background: "var(--theme-primary)",
  color: "#fff",
  padding: "11px 20px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  cursor: "pointer",
};
export const outlineButton: CSSProperties = {
  ...primaryButton,
  background: "var(--surface-default)",
  color: "var(--theme-primary)",
};
export const dangerButton: CSSProperties = {
  ...outlineButton,
  color: "var(--theme-error-dark)",
  borderColor: "var(--color-red-cool-30v)",
};
/**
 * A small "Test mode" tag beside a decision taken in a preview's test mode.
 * It comes from the action's structured flag, never from note text.
 */
export const testModeTag: CSSProperties = {
  display: "inline-block",
  marginLeft: 8,
  padding: "1px 8px",
  border: "1px solid var(--theme-warning-light)",
  borderRadius: "var(--radius-sm)",
  background: "var(--theme-warning-lighter)",
  color: "var(--color-gray-cool-80)",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  verticalAlign: "middle",
};

/**
 * A PR preview's EIR test mode is on (`eirSelfDecisionTestMode` on the
 * session): shown on the inbox and on the person's own record, announced.
 */
export function SelfDecisionTestModeNotice({
  Icon,
  style,
}: {
  Icon: EirScreenChrome["Icon"];
  style?: CSSProperties;
}) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "14px 18px",
        border: "1px solid var(--theme-warning-light)",
        borderLeft: "4px solid var(--theme-warning)",
        borderRadius: "var(--radius-md)",
        background: "var(--theme-warning-lighter)",
        color: "var(--color-gray-cool-80)",
        fontSize: "var(--font-size-2xs)",
        lineHeight: 1.55,
        ...style,
      }}
    >
      <Icon name="warning" size={18} color="var(--theme-warning-darker)" />
      <div>
        <strong>Test mode:</strong> you can decide your own EIR on this preview. This is never
        allowed in production.
      </div>
    </div>
  );
}

/** A secondary action that reads as a link (e.g. Cancel), as the onboarding screens' linkBtn. */
export const linkButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "none",
  border: "none",
  padding: "11px 4px",
  color: "var(--link-default)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  textDecoration: "underline",
  cursor: "pointer",
};
export const link: CSSProperties = {
  color: "var(--link-default)",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  textDecoration: "none",
};

export function eirLoadErrorMessage(error: unknown, subject = "your EIR", failedRetryCount = 0) {
  if (apiFailureKind(error) === "session-expired" && error instanceof Error) return error.message;
  const status = eirErrorStatus(error);
  if (status === 401 || status === 403) {
    return subject === "your EIR"
      ? "You don't have access to this EIR data."
      : `You don't have access to ${subject}.`;
  }
  if (status === 404) return `We couldn't find ${subject}.`;
  const prefix =
    failedRetryCount > 0
      ? `Still couldn't load ${subject}.`
      : `We couldn't load ${subject}${status && status >= 500 ? " right now" : ""}.`;
  if (status && status >= 500) {
    return `${prefix} This is a problem on our side, not your connection. Try again, or contact EDP staff if it keeps happening.`;
  }
  return `${prefix} Check your connection and try again.`;
}

export function EirLoadErrorAlert({
  error,
  onRetry,
  retrying = false,
  subject,
  failedRetryCount = 0,
  focusKey,
}: {
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
  subject?: string;
  failedRetryCount?: number;
  focusKey?: number;
}) {
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusKey !== undefined) alertRef.current?.focus();
  }, [focusKey]);

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        ref={alertRef}
        tabIndex={-1}
        role="alert"
        style={{
          padding: "14px 18px",
          border: "1px solid var(--theme-error-light)",
          borderLeft: "4px solid var(--theme-error)",
          borderRadius: "var(--radius-md)",
          background: "var(--theme-error-lighter)",
          color: "var(--theme-error-dark)",
          fontSize: "var(--font-size-2xs)",
          fontWeight: 700,
        }}
      >
        {eirLoadErrorMessage(error, subject, failedRetryCount)}
      </div>
      {retrying ? (
        <p
          role="status"
          aria-live="polite"
          style={{ margin: "10px 0 0", color: "var(--color-gray-cool-70)" }}
        >
          Trying again…
        </p>
      ) : null}
      <button
        type="button"
        aria-disabled={retrying}
        style={{
          ...primaryButton,
          marginTop: 12,
          ...(retrying
            ? {
                background: "var(--color-gray-cool-30)",
                borderColor: "var(--color-gray-cool-30)",
                color: "var(--color-gray-cool-70)",
                cursor: "not-allowed",
              }
            : {}),
        }}
        onClick={() => {
          if (!retrying) onRetry();
        }}
      >
        Retry
      </button>
    </div>
  );
}

export const statusMeta: Record<
  EirStage,
  { label: string; icon: string; bg: string; fg: string; bd: string }
> = {
  "not-started": {
    label: "Not started",
    icon: "description",
    bg: "var(--color-gray-5)",
    fg: "var(--color-gray-cool-70)",
    bd: "var(--border-default)",
  },
  submitted: {
    label: "Submitted",
    icon: "schedule",
    bg: "var(--color-blue-5v)",
    fg: "var(--theme-primary)",
    bd: "var(--color-blue-20v)",
  },
  questions: {
    label: "Sent back",
    icon: "warning",
    bg: "var(--theme-warning-lighter)",
    fg: "var(--color-gray-cool-80)",
    bd: "var(--theme-warning-light)",
  },
  valid: {
    label: "Valid",
    icon: "check_circle",
    bg: "var(--theme-success-lighter)",
    fg: "var(--theme-success-darker)",
    bd: "var(--theme-success-light)",
  },
  rejected: {
    label: "Rejected",
    icon: "error",
    bg: "var(--theme-error-lighter)",
    fg: "var(--theme-error-dark)",
    bd: "var(--theme-error-light)",
  },
  expired: {
    label: "Expired",
    icon: "event_busy",
    bg: "var(--theme-warning-lighter)",
    fg: "var(--color-gray-cool-80)",
    bd: "var(--theme-warning-light)",
  },
  revoked: {
    label: "Revoked",
    icon: "error",
    bg: "var(--theme-error-lighter)",
    fg: "var(--theme-error-dark)",
    bd: "var(--theme-error-light)",
  },
};

export function DocumentLinks({ record, labelPrefix }: { record: EirRecord; labelPrefix: string }) {
  if (!record.submissions.length) return null;
  return (
    <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 7 }}>
      {record.submissions.map((submission, index) => (
        <li key={submission.volumePath}>
          <a
            href={`/api/eir/files?path=${encodeURIComponent(submission.volumePath)}`}
            target="_blank"
            rel="noreferrer"
            style={link}
          >
            {labelPrefix} submission {index + 1}
          </a>{" "}
          <span style={{ color: "var(--text-muted)", fontSize: "var(--font-size-3xs)" }}>
            {new Date(submission.submittedAt).toLocaleDateString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What to say when a save failed, if we know (#189): an expired sign-in, an
 * unconfirmed save, or the server's own words when it refused (a 4xx: a rule,
 * or "This changed since you opened it. Reload to see the latest."). Else
 * nothing, and the screen says what failed.
 *
 * An unconfirmed command can be retried safely: it resends the same key. An
 * unconfirmed submit may have lost the PDF upload's reply, and the upload has
 * no key: a retry stores the file again (docs/eir-volume.md), so it says to
 * check first.
 */
export function saveFailureMessage(
  error: unknown,
  { upload = false }: { upload?: boolean } = {},
): string | undefined {
  if (
    error instanceof Error &&
    (error as Error & { draftWasSaved?: unknown }).draftWasSaved === true
  ) {
    return error.message;
  }
  const kind = apiFailureKind(error);
  if (kind === "outcome-unknown") {
    return upload
      ? "We couldn't confirm this upload. Check your EIR status before submitting again."
      : "We couldn't confirm this save. Try again; it won't be saved twice.";
  }
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && error instanceof Error
    ? error.message
    : undefined;
}
