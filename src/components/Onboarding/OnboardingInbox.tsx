// The role-scoped onboarding inbox (#86): the EDP business office sees only the
// requests at business & ROI review, the CCB only those at the CCB, each with
// that stage's SLA state. Reviewers approve, send back with questions, or reject;
// a resubmission comes back to the stage that sent it, marked as a new response.
// Who may act is decided by the store from the signed-in session; the profile's
// roles here only decide what to show.

import React from "react";

import {
  REVIEWER_LABEL,
  ONBOARDING_SEND_BACK_STAGE,
  STAGE_FOR_REVIEWER,
  onboardingStageLabel,
  pendingResubmission,
  useDecideOnboardingRequest,
  useOnboardingInbox,
  useUser,
  useWriteIntent,
  type OnboardingRequest,
  type OnboardingReviewDecision,
  type OnboardingReviewerRole,
} from "@/data";
import { FeatureGate } from "@/features/FeatureGate";
import { RefreshButton } from "../RefreshButton";
import { ChromeProvider, useChrome, type OnboardingChrome } from "./chrome";
import { IntakePackage } from "./IntakePackage";
import { OwnerMatchingPanel } from "./OwnerMatching";
import {
  ActionFailedNotice,
  DecisionLog,
  Notice,
  PageHeader,
  ResubmissionResponse,
  SaveStatus,
  SessionStateNotice,
  SlaPill,
} from "./shared";
import { requestTone, stagePhrase } from "./stage-text";
import {
  dangerBtn,
  iconSquare,
  lbl,
  muted,
  outlineBtn,
  pendingBtn,
  primaryBtn,
  textarea,
} from "./styles";

function targetLabel(target: typeof ONBOARDING_SEND_BACK_STAGE): string {
  return stagePhrase(target);
}

function InboxItem({
  request,
  role,
  onDecisionComplete,
}: {
  request: OnboardingRequest;
  role: OnboardingReviewerRole;
  onDecisionComplete: (message: string) => void;
}) {
  const { Panel, Icon } = useChrome();
  const user = useUser();
  const decide = useDecideOnboardingRequest();
  const intents = useWriteIntent();
  // While a decision saves, every action on this request waits for it.
  const saving = decide.isPending;
  const busy = saving
    ? { disabled: true, "aria-disabled": true as const }
    : { disabled: false, "aria-disabled": undefined };
  const [mode, setMode] = React.useState<"idle" | "approve" | "send-back" | "reject">("idle");
  const [note, setNote] = React.useState("");
  const [noteMissing, setNoteMissing] = React.useState(false);
  const noteRef = React.useRef<HTMLTextAreaElement>(null);
  const approvePromptRef = React.useRef<HTMLParagraphElement>(null);
  const articleRef = React.useRef<HTMLElement>(null);
  const openerActionRef = React.useRef<"approve" | "send-back" | "reject">("approve");
  const restoreOpenerRef = React.useRef(false);
  const target = ONBOARDING_SEND_BACK_STAGE;
  const tone = requestTone(request);
  const datasets = request.intake.datasets.length;
  const approvalDestination = role === "business-office" ? "ccb" : "standup";
  const noteId = `${request.id}-note`;
  const noteErrorId = `${noteId}-error`;

  // Confirming is the intent: the same decision on this request keeps its key
  // if it's confirmed again after a failure; a changed decision gets a new one.
  const submit = (decision: OnboardingReviewDecision) =>
    decide.mutate(
      {
        id: request.id,
        decision,
        // Confirmed against the version on screen: the server refuses it if the
        // request has changed since, rather than deciding on something unseen.
        intent: intents.intentFor({ id: request.id, decision }, request.version),
      },
      {
        onSuccess: () => {
          intents.settle();
          const action =
            decision.type === "approve"
              ? `Approved ${request.title}.`
              : decision.type === "reject"
                ? `Rejected ${request.title}.`
                : `Sent ${request.title} back to ${targetLabel(decision.to)}.`;
          onDecisionComplete(action);
          setMode("idle");
        },
      },
    );

  const open = (next: "approve" | "send-back" | "reject") => {
    if (saving) return;
    openerActionRef.current = next;
    setNote("");
    setNoteMissing(false);
    decide.reset();
    setMode(next);
  };

  const cancel = () => {
    if (saving) return;
    restoreOpenerRef.current = true;
    setMode("idle");
  };

  React.useEffect(() => {
    if (mode === "approve") approvePromptRef.current?.focus();
    if (mode === "send-back" || mode === "reject") noteRef.current?.focus();
    if (mode === "idle" && restoreOpenerRef.current) {
      restoreOpenerRef.current = false;
      articleRef.current
        ?.querySelector<HTMLButtonElement>(`[data-review-action="${openerActionRef.current}"]`)
        ?.focus();
    }
  }, [mode]);

  const confirmNote = () => {
    if (note.trim().length === 0) {
      setNoteMissing(true);
      noteRef.current?.focus();
      return;
    }
    submit(
      mode === "send-back" ? { type: "send-back", to: target, note } : { type: "reject", note },
    );
  };

  return (
    <article ref={articleRef} aria-label={`${request.id} ${request.title}`}>
      <Panel pad={0} style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "20px 24px" }}>
          <div style={iconSquare(tone.bg)}>
            <Icon name={tone.icon} size={24} color={tone.fg} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-size-sm)",
                fontWeight: 700,
                margin: 0,
              }}
            >
              {request.title}
            </h2>
            <div style={{ ...muted, marginTop: 2 }}>
              {request.id} · From {request.providerName} · Submitted{" "}
              {new Date(request.submittedAt).toLocaleDateString("en-US")} · {datasets} dataset
              {datasets === 1 ? "" : "s"}
            </div>
          </div>
          <SlaPill request={request} />
        </div>

        <div style={{ padding: "0 24px 20px", display: "grid", gap: 16 }}>
          <ResubmissionResponse request={request} stage={STAGE_FOR_REVIEWER[role]} />
          <IntakePackage
            request={request}
            changes={pendingResubmission(request, STAGE_FOR_REVIEWER[role])?.record.changes}
          />
          {/* Matching is EDP staff's (#103, 103-B); the store refuses anyone else. */}
          {user.data?.isAdmin ? (
            <FeatureGate id="owner-matching">
              <OwnerMatchingPanel request={request} />
            </FeatureGate>
          ) : null}
          <DecisionLog request={request} />
        </div>

        <div
          style={{
            borderTop: "1px solid var(--border-default)",
            background: "var(--color-gray-cool-1)",
            padding: "16px 24px",
          }}
        >
          {mode === "idle" ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                data-review-action="approve"
                style={primaryBtn}
                {...busy}
                onClick={() => open("approve")}
              >
                <Icon name="check" size={17} color="#fff" /> Approve
              </button>
              <button
                type="button"
                data-review-action="send-back"
                style={outlineBtn}
                {...busy}
                onClick={() => open("send-back")}
              >
                <Icon name="arrow_back" size={16} color="var(--theme-primary)" /> Send back with
                questions
              </button>
              <button
                type="button"
                data-review-action="reject"
                style={dangerBtn}
                {...busy}
                onClick={() => open("reject")}
              >
                <Icon name="close" size={16} color="var(--theme-error-dark)" /> Reject
              </button>
            </div>
          ) : mode === "approve" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <p
                ref={approvePromptRef}
                tabIndex={-1}
                style={{ margin: 0, fontSize: "var(--font-size-2xs)", lineHeight: 1.55 }}
              >
                <strong>Approve this initiative?</strong> It moves to{" "}
                <strong>{onboardingStageLabel(approvalDestination)}</strong>
                {role === "ccb"
                  ? ", where EDP staff stand it up; it can't be sent back or rejected after that"
                  : ", where the CCB reviews it"}
                . The approval is recorded as yours:{" "}
                <strong>
                  {user.data?.name ?? "you"}
                  {user.data ? ` (${user.data.principalId})` : ""}
                </strong>
                .
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  style={saving ? { ...primaryBtn, ...pendingBtn } : primaryBtn}
                  {...busy}
                  onClick={() => submit({ type: "approve" })}
                >
                  <Icon name="check" size={17} color="#fff" />{" "}
                  {saving ? "Saving…" : "Confirm approval"}
                </button>
                <button type="button" style={outlineBtn} {...busy} onClick={cancel}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={lbl} htmlFor={noteId}>
                  {mode === "send-back" ? "Questions" : "Reason for rejection"}{" "}
                  <span aria-hidden="true" style={{ color: "var(--theme-secondary)" }}>
                    *
                  </span>
                </label>
                {mode === "reject" ? (
                  <div id={`${noteId}-hint`} style={{ ...muted, marginBottom: 7 }}>
                    Rejection ends the request for good. The data provider sees this reason.
                  </div>
                ) : null}
                <textarea
                  ref={noteRef}
                  id={noteId}
                  aria-label={mode === "send-back" ? "Questions" : "Reason for rejection"}
                  aria-required="true"
                  required
                  aria-invalid={noteMissing || undefined}
                  aria-describedby={
                    [mode === "reject" ? `${noteId}-hint` : "", noteMissing ? noteErrorId : ""]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  rows={3}
                  readOnly={saving}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    if (e.target.value.trim()) setNoteMissing(false);
                  }}
                  placeholder={
                    mode === "send-back"
                      ? "What does the data provider need to answer?"
                      : "Why is this request rejected?"
                  }
                  style={
                    noteMissing
                      ? { ...textarea, border: "1.5px solid var(--theme-error)" }
                      : textarea
                  }
                />
                {noteMissing ? (
                  <div
                    id={noteErrorId}
                    role="alert"
                    style={{
                      color: "var(--theme-error-dark)",
                      fontSize: "var(--font-size-3xs)",
                      marginTop: 5,
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <Icon name="error" size={14} color="var(--theme-error-dark)" />
                    {mode === "send-back"
                      ? "Enter the questions the data provider needs to answer."
                      : "Enter the reason for rejection. The data provider sees it."}
                  </div>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  style={{
                    ...(mode === "reject" ? dangerBtn : primaryBtn),
                    ...(saving ? pendingBtn : {}),
                  }}
                  {...busy}
                  onClick={confirmNote}
                >
                  {saving
                    ? "Saving…"
                    : mode === "send-back"
                      ? `Send back to ${targetLabel(target)}`
                      : "Confirm rejection"}
                </button>
                <button type="button" style={outlineBtn} {...busy} onClick={cancel}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <SaveStatus message={saving ? `Saving your decision on ${request.id}…` : null} />
          {decide.error ? (
            <div style={{ marginTop: 12 }}>
              <ActionFailedNotice error={decide.error} />
            </div>
          ) : null}
        </div>
      </Panel>
    </article>
  );
}

function InboxBody({ role }: { role: OnboardingReviewerRole }) {
  const user = useUser();
  const isMember = user.data?.onboardingReviewerRoles?.includes(role) ?? false;
  const inbox = useOnboardingInbox(role, isMember);
  const [outcome, setOutcome] = React.useState("");
  const outcomeRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (outcome) outcomeRef.current?.focus();
  }, [outcome]);

  React.useEffect(() => {
    setOutcome("");
  }, [role]);

  if (user.isError) {
    return <Notice tone="error">Could not resolve who you are: {user.error.message}</Notice>;
  }
  if (!user.data) return <Notice>Loading…</Notice>;
  if (inbox.isError) return <ActionFailedNotice error={inbox.error} />;
  if (!inbox.data) return <Notice>Loading…</Notice>;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <RefreshButton queries={[inbox]} what={`the ${REVIEWER_LABEL[role]} inbox`} />
      </div>
      {outcome ? (
        <div style={{ marginBottom: 16 }}>
          <Notice focusRef={outcomeRef} tabIndex={-1}>
            {outcome}
          </Notice>
        </div>
      ) : null}
      {inbox.data.length === 0 ? (
        <Notice>Nothing is waiting on {stagePhrase(STAGE_FOR_REVIEWER[role])} right now.</Notice>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 24 }}>
          {inbox.data.map((request) => (
            <InboxItem
              key={request.id}
              request={request}
              role={role}
              onDecisionComplete={setOutcome}
            />
          ))}
        </div>
      )}
    </>
  );
}

function InboxPage({
  role,
  go,
}: {
  role: OnboardingReviewerRole;
  go?: ((name: string) => void) | undefined;
}) {
  const { Page, Pill } = useChrome();
  const stage = onboardingStageLabel(STAGE_FOR_REVIEWER[role]);
  return (
    <Page>
      <PageHeader
        title={`${stage} inbox`}
        crumb={`${stage} inbox`}
        go={go}
        intro={
          <>
            Onboarding requests waiting on the {REVIEWER_LABEL[role]}, oldest first, with each
            stage&apos;s service-level agreement (SLA) state.
          </>
        }
        badge={
          <Pill icon="group" bg="var(--color-blue-5v)" fg="var(--theme-primary)" size="lg">
            {REVIEWER_LABEL[role]}
          </Pill>
        }
      />
      <div style={{ marginBottom: 20 }}>
        <SessionStateNotice />
      </div>
      <FeatureGate id="onboarding-review">
        <InboxBody role={role} />
      </FeatureGate>
    </Page>
  );
}

export function OnboardingInbox({
  role,
  go,
  chrome,
}: {
  role: OnboardingReviewerRole;
  go?: ((name: string) => void) | undefined;
  chrome?: Partial<OnboardingChrome> | undefined;
}) {
  return (
    <ChromeProvider chrome={chrome}>
      <InboxPage role={role} go={go} />
    </ChromeProvider>
  );
}

/** Hash-route entry: `#review/business-office` or `#review/ccb`. */
export function OnboardingInboxScreen({
  ctx,
  params,
  chrome,
}: {
  ctx?: { go?: (name: string) => void };
  params?: { id?: string };
  chrome?: Partial<OnboardingChrome>;
}) {
  const role: OnboardingReviewerRole = params?.id === "ccb" ? "ccb" : "business-office";
  return <OnboardingInbox role={role} go={ctx?.go} chrome={chrome} />;
}
