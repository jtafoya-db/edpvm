// Pieces shared by the onboarding review inboxes and the provider's status page
// (#86), composed from the injected design-system chrome (./chrome.tsx): the
// page header, notice banners, the SLA and stage pills, the stage track, the
// intake package, a resubmission's new response and the decision record.

import React from "react";

import {
  ONBOARDING_STAGES,
  isOnboardingTerminal,
  onboardingStageLabel,
  pendingResubmission,
  type OnboardingRequest,
  type OnboardingRequestStage,
  type OnboardingReviewStage,
  type OnboardingSlaStatus,
} from "@/data";
import { apiFailureKind } from "@/data/api-response";
import { getFeature } from "@/features/registry";
import { srOnly } from "../AccessRequests/a11y";
import { useChrome } from "./chrome";
import { SLA_TONE } from "./stage-text";
import { TONE, banner, detailLabel, h1, outlineBtn, subtitle, type Tone } from "./styles";

/** Page shell: Trail, then the h1 title row with an optional right-side badge. */
export function PageHeader({
  title,
  intro,
  crumb,
  go,
  badge,
}: {
  title: string;
  intro: React.ReactNode;
  crumb: string;
  go?: ((name: string) => void) | undefined;
  badge?: React.ReactNode;
}) {
  const { Trail } = useChrome();
  return (
    <>
      <Trail
        items={[go ? { label: "Home", go: () => go("home") } : { label: "Home" }, { label: crumb }]}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={h1}>{title}</h1>
          <p style={subtitle}>{intro}</p>
        </div>
        {badge ?? null}
      </div>
    </>
  );
}

/** The tinted notice banner with its icon. Errors are announced as alerts. */
/**
 * A polite live region that says a save is in flight. Always rendered, so the
 * announcement is a change to an existing region that screen readers pick up.
 */
export function SaveStatus({ message }: { message: string | null }) {
  return (
    <div role="status" aria-live="polite" style={srOnly}>
      {message ?? ""}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  focusRef,
  tabIndex,
}: {
  tone?: Tone;
  children: React.ReactNode;
  focusRef?: React.Ref<HTMLDivElement>;
  tabIndex?: number;
}) {
  const { Icon } = useChrome();
  return (
    <div
      ref={focusRef}
      role={tone === "error" ? "alert" : "status"}
      tabIndex={tabIndex}
      style={banner(tone)}
    >
      <Icon name={TONE[tone].icon} size={20} color={TONE[tone].fg} />
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

/**
 * A failed save or load, in words that match what happened (#189): the
 * server's own words when it answered, else what the proxy's answer means.
 * An expired sign-in says nothing was saved and offers a reload; a save whose
 * reply was lost says it's unconfirmed (the same button retries it with the
 * same key, so it can't save twice). Raw parse errors and HTML never show.
 */
export function ActionFailedNotice({ error }: { error: Error }) {
  const kind = apiFailureKind(error);
  return (
    <Notice tone="error">
      {kind === "session-expired" ? (
        <>
          <strong>Your sign-in has expired.</strong> Reload the page to sign in again — nothing was
          saved.
          <div style={{ marginTop: 10 }}>
            <button type="button" style={outlineBtn} onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </>
      ) : kind === "outcome-unknown" ? (
        <>
          <strong>We couldn't confirm this save.</strong> Check the list before trying again.
        </>
      ) : kind === "unavailable" ? (
        <>
          <strong>We couldn't reach the app.</strong> Try again in a moment.
        </>
      ) : (
        error.message
      )}
    </Notice>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The honesty-bar notice for memory mode: onboarding requests are held only in
 * this browser session. It renders nothing when the Delta backend is enabled,
 * where `onboarding-request-persistence` is live and requests are saved.
 */
export function SessionStateNotice() {
  if (import.meta.env["VITE_DATA_BACKEND"] === "delta") return null;
  return (
    <Notice>
      <strong style={{ color: "var(--text-default)" }}>Held in this browser session.</strong>{" "}
      {getFeature("onboarding-request-persistence").notes}
    </Notice>
  );
}

/** The current stage's SLA state as a Pill, or what the request waits on when no SLA applies. */
export function SlaPill({ request }: { request: OnboardingRequest }) {
  const { Pill } = useChrome();
  const sla = request.sla;
  if (!sla) {
    const label =
      request.stage === "submitted"
        ? "Waiting on the data provider"
        : request.stage === "standup"
          ? "Approved — standup has no SLA yet"
          : "Closed — no SLA";
    return (
      <Pill bg="var(--color-gray-5)" fg="var(--color-gray-cool-70)" size="lg">
        {label}
      </Pill>
    );
  }
  const meta = SLA_TONE[sla.state];
  return (
    <span data-sla-state={sla.state}>
      <Pill icon={meta.icon} bg={TONE[meta.tone].bg} fg={TONE[meta.tone].fg} size="lg">
        Service-level agreement (SLA): {meta.label} · {sla.businessDaysElapsed} of {sla.target}{" "}
        business days · due {formatDate(sla.dueAt)}
        {sla.escalationAppropriate ? " · OK to escalate" : ""}
      </Pill>
    </span>
  );
}

/** A request's stage as a Pill (used for terminal stages). */
export function StagePill({ stage }: { stage: OnboardingRequestStage }) {
  const { Pill } = useChrome();
  return (
    <Pill bg="var(--color-gray-5)" fg="var(--color-gray-cool-70)" size="lg">
      {onboardingStageLabel(stage)}
    </Pill>
  );
}

/** The four stages on the USWDS StepIndicator; terminal stages show a Pill instead. */
export function StageTrack({ request }: { request: OnboardingRequest }) {
  const { StepIndicator } = useChrome();
  if (isOnboardingTerminal(request.stage)) return <StagePill stage={request.stage} />;
  const current = ONBOARDING_STAGES.findIndex(({ key }) => key === request.stage);
  return (
    <StepIndicator
      steps={ONBOARDING_STAGES.map((stage) => stage.label)}
      current={current}
      counters
    />
  );
}

const code: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-3xs)",
  background: "var(--color-gray-cool-2)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-sm)",
  padding: "1px 6px",
  color: "var(--color-gray-cool-70)",
};

/** A mono id/tag chip (the legacy MonoPath look). */
export function Mono({ children }: { children: React.ReactNode }) {
  return <code style={code}>{children}</code>;
}

const body: React.CSSProperties = {
  fontSize: "var(--font-size-2xs)",
  color: "var(--color-gray-cool-70)",
  lineHeight: 1.55,
  margin: 0,
};

const DECISION_LABEL: Record<string, string> = {
  submit: "Submitted",
  forward: "Forwarded",
  approve: "Approved",
  "send-back": "Sent back",
  reject: "Rejected",
  withdraw: "Withdrawn",
  resubmit: "Resubmitted",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  color: "var(--text-muted)",
  background: "var(--color-gray-cool-2)",
  borderBottom: "1px solid var(--border-default)",
};

const td: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "var(--font-size-3xs)",
  color: "var(--color-gray-cool-70)",
  borderBottom: "1px solid var(--border-default)",
  verticalAlign: "top",
};

/** Every recorded transition with its actor (SCIM id) and time. */
export function DecisionLog({ request }: { request: OnboardingRequest }) {
  return (
    <details>
      <summary
        style={{
          fontSize: "var(--font-size-2xs)",
          fontWeight: 700,
          color: "var(--link-default)",
          cursor: "pointer",
        }}
      >
        Decision record ({request.decisions.length})
      </summary>
      <div
        style={{
          marginTop: 10,
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Decision</th>
              <th style={th}>By</th>
              <th style={th}>When</th>
              <th style={th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {request.decisions.map((decision, i) => (
              <tr key={i}>
                <td style={td}>
                  {DECISION_LABEL[decision.kind] ?? decision.kind} →{" "}
                  {onboardingStageLabel(decision.to)}
                </td>
                <td style={td}>
                  {decision.actorName} <Mono>{decision.actorId}</Mono>
                </td>
                <td style={td}>
                  <time dateTime={decision.at}>
                    {new Date(decision.at).toLocaleString("en-US")}
                  </time>
                </td>
                <td style={td}>{decision.note || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const quote: React.CSSProperties = { ...body, color: "var(--text-default)" };

/**
 * The data provider's response to a send-back, on the request it returned to
 * the reviewer at `stage` (#221): the question, the answer, and each intake
 * field that changed since the send-back. Shows nothing unless the request's
 * latest decision is a resubmission back to that stage.
 */
export function ResubmissionResponse({
  request,
  stage,
}: {
  request: OnboardingRequest;
  stage: OnboardingReviewStage;
}) {
  const { Icon } = useChrome();
  const pending = pendingResubmission(request, stage);
  if (!pending) return null;
  const headingId = `${request.id}-new-response`;
  const { record, sendBack } = pending;
  const day = (at: string) => new Date(at).toLocaleDateString("en-US");
  return (
    <section aria-labelledby={headingId} style={banner("info")}>
      <Icon name={TONE.info.icon} size={20} color={TONE.info.fg} />
      <div style={{ flex: 1, display: "grid", gap: 8, minWidth: 0 }}>
        <h3
          id={headingId}
          style={{
            margin: 0,
            fontSize: "var(--font-size-2xs)",
            color: "var(--text-default)",
            fontWeight: 700,
          }}
        >
          Resubmitted: new response from the data provider
        </h3>
        <p style={body}>
          Sent back by {sendBack.actorName} on{" "}
          <time dateTime={sendBack.at}>{day(sendBack.at)}</time>, resubmitted on{" "}
          <time dateTime={pending.resubmittedAt}>{day(pending.resubmittedAt)}</time>.
        </p>
        <p style={quote}>
          <strong>Question:</strong> “{sendBack.note}”
        </p>
        <p style={quote}>
          <strong>{pending.providerName} answered:</strong> “{record.answer}”
        </p>
        {!record.changesRecorded ? (
          <p style={body}>
            Field-by-field changes weren&apos;t recorded for this resubmission. Any dataset tag
            changes are in the answer.
          </p>
        ) : record.changes.length === 0 ? (
          <p style={body}>No intake fields changed; only the answer is new.</p>
        ) : (
          <div
            style={{
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              overflow: "hidden",
              background: "var(--color-white, #fff)",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <caption style={{ ...detailLabel, textAlign: "left", padding: "8px 12px 4px" }}>
                What changed since the send-back
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={th}>
                    Field
                  </th>
                  <th scope="col" style={th}>
                    Before
                  </th>
                  <th scope="col" style={th}>
                    Now
                  </th>
                </tr>
              </thead>
              <tbody>
                {record.changes.map((change) => (
                  <tr key={change.field}>
                    <th scope="row" style={{ ...td, fontWeight: 400, textAlign: "left" }}>
                      {change.field}
                    </th>
                    <td style={td}>
                      <del>{change.before || "—"}</del>
                    </td>
                    <td style={td}>
                      <strong style={{ color: "var(--text-default)" }}>
                        {change.after || "—"}
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
