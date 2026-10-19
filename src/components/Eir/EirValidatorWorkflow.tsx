import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PendingActionButton,
  PendingActionStatus,
  disabledPendingStyle,
  usePendingActionGroup,
} from "@/components/PendingAction";
import {
  eirFlags,
  isStructuredEirVersion,
  useDecideEir,
  type EirDecision,
  type EirInboxItem,
  definitionLabel,
} from "@/data";
import { EirAnswers } from "./EirAnswers";
import {
  DocumentLinks,
  EirLoadErrorAlert,
  dangerButton,
  heading,
  input,
  label,
  outlineButton,
  primaryButton,
  saveFailureMessage,
  SelfDecisionTestModeNotice,
  testModeTag,
  statusMeta,
  type EirScreenChrome,
} from "./EirShared";

type Props = {
  principalId: string;
  items: EirInboxItem[];
  /**
   * A PR preview's test mode (from the session; the server checks it again):
   * the validator's own EIR is listed and can be decided.
   */
  selfDecisionTestMode?: boolean;
  isLoading?: boolean;
  isLoadError?: boolean;
  loadError?: unknown;
  retrying?: boolean;
  onRetry?: () => Promise<unknown>;
  /** Shown beside the inbox count once it has loaded (the Refresh control). */
  refresh?: ReactNode;
  chrome: Pick<EirScreenChrome, "Panel" | "Pill" | "Icon" | "SectionHead">;
};

export function EirValidatorWorkflow({
  principalId,
  items,
  selfDecisionTestMode = false,
  isLoading = false,
  isLoadError = false,
  loadError,
  retrying = false,
  onRetry,
  refresh,
  chrome,
}: Props) {
  const { Panel, Pill, Icon, SectionHead } = chrome;
  const decide = useDecideEir();
  const pending = usePendingActionGroup();
  const decisionNoteRef = useRef<HTMLTextAreaElement>(null);
  const decisionMessageRef = useRef<HTMLDivElement>(null);
  const decisionErrorRef = useRef<HTMLDivElement>(null);
  const inboxRetryMessageRef = useRef<HTMLDivElement>(null);
  const [decisionEditor, setDecisionEditor] = useState<{
    principalId: string;
    decision: "questions" | "rejected" | "revoked";
  } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [inboxRetryMessage, setInboxRetryMessage] = useState("");
  const [inboxLoadRetrying, setInboxLoadRetrying] = useState(false);
  const [inboxLoadRetryFailures, setInboxLoadRetryFailures] = useState(0);
  const [inboxLoadErrorFocusKey, setInboxLoadErrorFocusKey] = useState<number | undefined>();
  const [lastInboxLoadError, setLastInboxLoadError] = useState<unknown>(null);
  const [decisionError, setDecisionError] = useState<{
    principalId: string;
    message: string;
    kind: "field" | "request";
  } | null>(null);

  useEffect(() => {
    if (decisionEditor) decisionNoteRef.current?.focus();
  }, [decisionEditor]);
  useEffect(() => {
    if (decisionMessage) decisionMessageRef.current?.focus();
  }, [decisionMessage]);
  useEffect(() => {
    if (inboxRetryMessage) inboxRetryMessageRef.current?.focus();
  }, [inboxRetryMessage]);
  useEffect(() => {
    if (decisionError?.kind === "field") decisionNoteRef.current?.focus();
    if (decisionError?.kind === "request") decisionErrorRef.current?.focus();
  }, [decisionError]);
  useEffect(() => {
    if (loadError) setLastInboxLoadError(loadError);
  }, [loadError]);
  useEffect(() => {
    if (!isLoading && !isLoadError && !retrying && !inboxLoadRetrying) {
      setInboxLoadErrorFocusKey(undefined);
    }
  }, [inboxLoadRetrying, isLoadError, isLoading, retrying]);

  const slaRank = { breached: 0, "due-soon": 1, "on-track": 2 } as const;
  // The signed-in validator's own EIR isn't listed (their stage card already
  // shows it, and the server refuses a decision on it), unless test mode is on.
  const listed = (item: EirInboxItem) => selfDecisionTestMode || item.principalId !== principalId;
  const actionableItems = items
    .filter(
      (item) => listed(item) && (item.stage === "submitted" || item.renewal?.stage === "submitted"),
    )
    .sort(
      (left, right) =>
        slaRank[left.sla.state] - slaRank[right.sla.state] ||
        Date.parse(left.sla.dueAt) - Date.parse(right.sla.dueAt),
    );
  const validItems = items.filter(
    (item) => listed(item) && item.stage === "valid" && item.renewal?.stage !== "submitted",
  );
  const displayedItems = [...actionableItems, ...validItems];
  const inboxLoadError = loadError ?? lastInboxLoadError;
  const hasInboxLoadProblem = isLoadError || inboxLoadRetrying;
  const hasInboxLoadStatus = hasInboxLoadProblem || isLoading;

  const runDecision = async (
    itemPrincipalId: string,
    decisionName: EirDecision,
    note?: string,
    actionId = `decide-${decisionName}`,
  ) => {
    if (pending.isRecordPending(itemPrincipalId)) return;
    setDecisionError(null);
    setDecisionMessage("");
    const version = items.find((item) => item.principalId === itemPrincipalId)?.version;
    try {
      await pending.run({ recordId: itemPrincipalId, actionId, label: "Saving decision" }, () =>
        decide.mutateAsync({
          principalId: itemPrincipalId,
          decision: decisionName,
          actorScimId: principalId,
          ...(note ? { note } : {}),
          ...(version !== undefined ? { expectedVersion: version } : {}),
        }),
      );
      setDecisionEditor(null);
      setDecisionNote("");
      const action =
        decisionName === "valid"
          ? "approved"
          : decisionName === "questions"
            ? "sent back"
            : decisionName;
      setDecisionMessage(`Decision saved: EIR ${action}.`);
    } catch (error) {
      setDecisionError({
        principalId: itemPrincipalId,
        message:
          saveFailureMessage(error) ??
          "We could not save the decision. Refresh the record and try again.",
        kind: "request",
      });
    }
  };

  return (
    <section aria-label="Safeguards validator inbox">
      <SectionHead
        eyebrow="Safeguards validator"
        title="EIR inbox"
        action={
          hasInboxLoadStatus ? undefined : (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
            >
              {refresh}
              <Pill
                icon="description"
                bg="var(--color-blue-5v)"
                fg="var(--theme-primary)"
                bd="var(--color-blue-20v)"
              >
                {actionableItems.length} awaiting action
              </Pill>
            </span>
          )
        }
      />
      {selfDecisionTestMode ? (
        <SelfDecisionTestModeNotice Icon={Icon} style={{ marginBottom: 16 }} />
      ) : null}
      {decisionMessage ? (
        <div
          ref={decisionMessageRef}
          tabIndex={-1}
          role="status"
          style={{
            marginBottom: 16,
            padding: "12px 14px",
            borderLeft: "4px solid var(--theme-success)",
            background: "var(--theme-success-lighter)",
            fontSize: "var(--font-size-2xs)",
          }}
        >
          {decisionMessage}
        </div>
      ) : null}
      {inboxRetryMessage ? (
        <div
          ref={inboxRetryMessageRef}
          tabIndex={-1}
          role="status"
          style={{
            marginBottom: 16,
            padding: "12px 14px",
            borderLeft: "4px solid var(--theme-success)",
            background: "var(--theme-success-lighter)",
            fontSize: "var(--font-size-2xs)",
          }}
        >
          {inboxRetryMessage}
        </div>
      ) : null}
      {hasInboxLoadProblem ? (
        <EirLoadErrorAlert
          subject="the EIR inbox"
          error={inboxLoadError}
          retrying={inboxLoadRetrying || retrying}
          failedRetryCount={inboxLoadRetryFailures}
          {...(inboxLoadErrorFocusKey !== undefined ? { focusKey: inboxLoadErrorFocusKey } : {})}
          onRetry={() => {
            const nextFailureCount = inboxLoadRetryFailures + 1;
            setInboxRetryMessage("");
            setLastInboxLoadError(inboxLoadError);
            setInboxLoadRetrying(true);
            void onRetry?.()
              .then((result) => {
                if (!(result as { isError?: boolean } | undefined)?.isError) {
                  setInboxLoadRetryFailures(0);
                  setInboxLoadErrorFocusKey(undefined);
                  setInboxRetryMessage("Retry loaded the EIR inbox.");
                  return;
                }
                setInboxLoadRetryFailures(nextFailureCount);
                setInboxLoadErrorFocusKey((key) => (key ?? 0) + 1);
              })
              .finally(() => setInboxLoadRetrying(false));
          }}
        />
      ) : null}
      {!hasInboxLoadProblem && isLoading ? (
        <p
          role="status"
          style={{
            margin: "0 0 16px",
            color: "var(--text-muted)",
            fontSize: "var(--font-size-2xs)",
          }}
        >
          Loading the EIR inbox…
        </p>
      ) : null}
      <div style={{ display: "grid", gap: 16 }}>
        {/* Empty only when there's nothing to list, worded like the count above. */}
        {!hasInboxLoadStatus && !displayedItems.length ? (
          <Panel>
            <p
              style={{
                margin: 0,
                color: "var(--text-muted)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              No EIRs are awaiting action.
            </p>
          </Panel>
        ) : null}
        {displayedItems.map((item, index) => {
          const itemMeta = statusMeta[item.stage];
          const hasPendingRenewal = item.renewal?.stage === "submitted";
          const activeEditor =
            decisionEditor?.principalId === item.principalId ? decisionEditor : null;
          const activeError =
            decisionError?.principalId === item.principalId ? decisionError : null;
          const listHeading =
            index === actionableItems.length && validItems.length ? "Valid EIRs" : null;
          return (
            <div key={item.principalId}>
              {listHeading ? (
                <h3 style={{ ...heading, fontSize: "var(--font-size-lg)" }}>{listHeading}</h3>
              ) : null}
              <Panel hover>
                <article>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                      <div
                        style={{
                          width: 42,
                          height: 42,
                          flexShrink: 0,
                          borderRadius: "var(--radius-md)",
                          background: "var(--color-blue-5v)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="person" size={22} color="var(--theme-primary)" />
                      </div>
                      <div>
                        <h3
                          style={{
                            margin: 0,
                            fontFamily: "var(--font-sans)",
                            fontSize: "var(--font-size-md)",
                            color: "var(--text-default)",
                          }}
                        >
                          {item.personName}
                        </h3>
                        <div
                          style={{
                            marginTop: 4,
                            color: "var(--text-muted)",
                            fontSize: "var(--font-size-3xs)",
                          }}
                        >
                          {item.stage === "submitted"
                            ? `SLA ${item.sla.state.replace("-", " ")} · SLA target ${new Date(item.sla.dueAt).toLocaleDateString()}`
                            : item.expiresAt
                              ? `${item.stage === "valid" ? "Valid" : "Was valid"} until ${new Date(item.expiresAt).toLocaleDateString()}`
                              : itemMeta.label}
                        </div>
                      </div>
                    </div>
                    <Pill icon={itemMeta.icon} bg={itemMeta.bg} fg={itemMeta.fg} bd={itemMeta.bd}>
                      {itemMeta.label}
                    </Pill>
                  </div>
                  {hasPendingRenewal ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 14,
                        fontSize: "var(--font-size-2xs)",
                        color: "var(--theme-primary)",
                      }}
                    >
                      <Icon name="schedule" size={17} color="var(--theme-primary)" />
                      <strong>Renewal pending</strong>
                      <span style={{ color: "var(--text-muted)" }}>
                        · SLA {item.sla.state.replace("-", " ")} · SLA target{" "}
                        {new Date(item.sla.dueAt).toLocaleDateString()}
                      </span>
                    </div>
                  ) : null}
                  {(() => {
                    // Sent back and answered: the last questions, beside the person's response.
                    const subject = hasPendingRenewal ? "renewal" : undefined;
                    const onSubject = item.actions.filter((action) => action.subject === subject);
                    const asked = [...onSubject].reverse().find((a) => a.kind === "questions");
                    if (!asked) return null;
                    const answered = onSubject
                      .slice(onSubject.indexOf(asked) + 1)
                      .find((a) => (a.kind === "submitted" || a.kind === "renewed") && a.response);
                    if (!answered || !(item.stage === "submitted" || hasPendingRenewal))
                      return null;
                    return (
                      <div
                        role="note"
                        aria-label={`Questions and response for ${item.personName}`}
                        style={{
                          marginTop: 14,
                          padding: "12px 16px",
                          borderLeft: "4px solid var(--theme-primary)",
                          background: "var(--color-blue-5v)",
                          fontSize: "var(--font-size-2xs)",
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div>
                          <strong>Your questions:</strong> {asked.note ?? "No note provided"}
                          {asked.selfDecisionTestMode ? (
                            <span style={testModeTag}>Test mode</span>
                          ) : null}
                        </div>
                        <div>
                          <strong>Their response:</strong> {answered.response}
                        </div>
                        <div
                          style={{ color: "var(--text-muted)", fontSize: "var(--font-size-3xs)" }}
                        >
                          Responded {new Date(answered.at).toLocaleDateString()}
                        </div>
                      </div>
                    );
                  })()}
                  {(() => {
                    // What the validator decides on: a pending renewal's answers, else the EIR's.
                    const reviewed =
                      hasPendingRenewal && item.renewal
                        ? {
                            values: item.renewal.formValues,
                            version: item.renewal.formVersion,
                            startedAt: item.renewal.formStartedAt,
                            submittedAt: item.renewal.submittedAt,
                            title: "Renewal answers",
                          }
                        : {
                            values: item.formValues,
                            version: item.formVersion,
                            startedAt: item.formStartedAt,
                            submittedAt: item.formSubmittedAt,
                            title: "Answers",
                          };
                    if (!reviewed.values) return null;
                    const flags = eirFlags(reviewed.values, reviewed.version, {
                      formStartedAt: reviewed.startedAt,
                      submittedAt: reviewed.submittedAt,
                    });
                    const awaiting = item.stage === "submitted" || hasPendingRenewal;
                    return (
                      <div style={{ marginTop: 16 }}>
                        {flags.length ? (
                          <div
                            role="note"
                            aria-label={`Flags for ${item.personName}`}
                            style={{
                              padding: "12px 16px",
                              border: "1px solid var(--theme-warning-light)",
                              borderLeft: "4px solid var(--theme-warning)",
                              borderRadius: "var(--radius-md)",
                              background: "var(--theme-warning-lighter)",
                              fontSize: "var(--font-size-2xs)",
                            }}
                          >
                            <strong>
                              {flags.length === 1 ? "1 flag" : `${flags.length} flags`} for your
                              decision
                            </strong>{" "}
                            (none of them stopped the submission)
                            <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                              {flags.map((flag) => (
                                <li key={`${flag.field}-${flag.text}`}>
                                  {flag.label}: {flag.text}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : isStructuredEirVersion(reviewed.version) ? (
                          <p style={{ margin: 0, fontSize: "var(--font-size-2xs)" }}>
                            No flags in these answers.
                          </p>
                        ) : null}
                        <details open={awaiting} style={{ marginTop: 12 }}>
                          <summary
                            style={{
                              cursor: "pointer",
                              fontWeight: 700,
                              fontSize: "var(--font-size-2xs)",
                              color: "var(--theme-primary)",
                            }}
                          >
                            {reviewed.title}
                            {item.recordId ? ` · ${item.recordId}` : ""} ·{" "}
                            {reviewed.version ? definitionLabel(reviewed.version) : "form unknown"}
                          </summary>
                          <div style={{ marginTop: 12 }}>
                            <EirAnswers
                              values={reviewed.values}
                              version={reviewed.version}
                              flags={flags}
                              Icon={Icon}
                              headingLevel={4}
                            />
                          </div>
                        </details>
                      </div>
                    );
                  })()}
                  <DocumentLinks record={item} labelPrefix="Open signed PDF" />
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      marginTop: 18,
                      paddingTop: 16,
                      borderTop: "1px solid var(--border-default)",
                      flexWrap: "wrap",
                    }}
                  >
                    {(
                      (hasPendingRenewal
                        ? [
                            "valid",
                            "questions",
                            "rejected",
                            ...(item.stage === "valid" ? (["revoked"] as const) : []),
                          ]
                        : item.stage === "valid"
                          ? ["revoked"]
                          : ["valid", "questions", "rejected"]) as EirDecision[]
                    ).map((decisionName) => {
                      const text =
                        decisionName === "valid"
                          ? hasPendingRenewal
                            ? "Approve renewal"
                            : "Mark valid"
                          : decisionName === "questions"
                            ? "Send back with questions"
                            : decisionName === "revoked"
                              ? "Revoke"
                              : hasPendingRenewal
                                ? "Reject renewal"
                                : "Reject";
                      const style =
                        decisionName === "valid"
                          ? primaryButton
                          : decisionName === "questions"
                            ? outlineButton
                            : dangerButton;
                      return (
                        <PendingActionButton
                          key={decisionName}
                          type="button"
                          style={style}
                          pending={pending.isActionPending(
                            item.principalId,
                            decisionName === "valid"
                              ? `decide-${decisionName}`
                              : `open-decision-${decisionName}`,
                          )}
                          locked={pending.isRecordPending(item.principalId)}
                          onClick={() => {
                            if (
                              decisionName === "questions" ||
                              decisionName === "rejected" ||
                              decisionName === "revoked"
                            ) {
                              setDecisionError(null);
                              setDecisionNote("");
                              setDecisionEditor({
                                principalId: item.principalId,
                                decision: decisionName,
                              });
                              return;
                            }
                            void runDecision(item.principalId, decisionName);
                          }}
                        >
                          {decisionName === "rejected" || decisionName === "revoked" ? (
                            <Icon name="close" size={16} color="var(--theme-error-dark)" />
                          ) : null}
                          {text}
                        </PendingActionButton>
                      );
                    })}
                    {activeEditor ? (
                      <div style={{ flexBasis: "100%", marginTop: 6 }}>
                        {activeEditor.decision === "revoked" ? (
                          <p style={{ fontSize: "var(--font-size-2xs)" }}>
                            Revoking this EIR means the person loses entry to sensitive
                            environments.
                          </p>
                        ) : null}
                        <label style={label}>
                          {activeEditor.decision === "questions"
                            ? "Questions for the person"
                            : activeEditor.decision === "revoked"
                              ? "Reason for revocation"
                              : "Reason for rejection"}{" "}
                          <span style={{ color: "var(--theme-secondary)" }}>*</span>
                          <textarea
                            ref={decisionNoteRef}
                            id={`eir-decision-note-${item.principalId}`}
                            required
                            value={decisionNote}
                            aria-invalid={activeError?.kind === "field"}
                            aria-describedby={
                              activeError?.kind === "field"
                                ? `eir-decision-note-error-${item.principalId}`
                                : undefined
                            }
                            onChange={(event) => {
                              setDecisionNote(event.target.value);
                              if (activeError?.kind === "field") {
                                setDecisionError(null);
                              }
                            }}
                            style={{
                              ...input,
                              minHeight: 88,
                              resize: "vertical",
                              borderColor:
                                activeError?.kind === "field"
                                  ? "var(--theme-error)"
                                  : input.borderColor,
                            }}
                          />
                        </label>
                        {activeError?.kind === "field" ? (
                          <div
                            id={`eir-decision-note-error-${item.principalId}`}
                            role="alert"
                            style={{
                              marginTop: 6,
                              color: "var(--theme-error-dark)",
                              fontSize: "var(--font-size-2xs)",
                            }}
                          >
                            <Icon name="error" size={16} color="var(--theme-error-dark)" />{" "}
                            {activeError.message}
                          </div>
                        ) : null}
                        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                          <PendingActionButton
                            type="button"
                            style={
                              activeEditor.decision === "questions" ? primaryButton : dangerButton
                            }
                            pending={pending.isActionPending(
                              item.principalId,
                              `confirm-decision-${activeEditor.decision}`,
                            )}
                            locked={pending.isRecordPending(item.principalId)}
                            onClick={() => {
                              if (!decisionNote.trim()) {
                                setDecisionError({
                                  principalId: item.principalId,
                                  message:
                                    activeEditor.decision === "questions"
                                      ? "Enter questions for the person."
                                      : `Enter a reason for ${activeEditor.decision === "revoked" ? "revocation" : "rejection"}.`,
                                  kind: "field",
                                });
                                return;
                              }
                              void runDecision(
                                item.principalId,
                                activeEditor.decision,
                                decisionNote.trim(),
                                `confirm-decision-${activeEditor.decision}`,
                              );
                            }}
                          >
                            {activeEditor.decision === "questions"
                              ? "Send questions"
                              : activeEditor.decision === "revoked"
                                ? "Confirm revocation"
                                : "Confirm rejection"}
                          </PendingActionButton>
                          <button
                            type="button"
                            style={disabledPendingStyle(
                              outlineButton,
                              pending.isRecordPending(item.principalId),
                            )}
                            disabled={pending.isRecordPending(item.principalId)}
                            onClick={() => {
                              setDecisionEditor(null);
                              setDecisionNote("");
                              setDecisionError(null);
                              setDecisionMessage("Decision canceled. No changes were saved.");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {pending.isRecordPending(item.principalId) ? (
                      <div
                        style={{ flexBasis: "100%", margin: 0, fontSize: "var(--font-size-2xs)" }}
                      >
                        <PendingActionStatus pending>
                          Saving the decision. This can take up to a minute when the EIR store is
                          busy.
                        </PendingActionStatus>
                      </div>
                    ) : null}
                    {activeError?.kind === "request" ? (
                      <div
                        ref={decisionErrorRef}
                        tabIndex={-1}
                        role="alert"
                        style={{
                          flexBasis: "100%",
                          marginTop: 6,
                          padding: "12px 14px",
                          border: "1px solid var(--theme-error-light)",
                          borderLeft: "4px solid var(--theme-error)",
                          borderRadius: "var(--radius-md)",
                          background: "var(--theme-error-lighter)",
                          color: "var(--theme-error-dark)",
                          fontSize: "var(--font-size-2xs)",
                        }}
                      >
                        <Icon name="error" size={16} color="var(--theme-error-dark)" />{" "}
                        {activeError.message}
                      </div>
                    ) : null}
                  </div>
                </article>
              </Panel>
            </div>
          );
        })}
      </div>
    </section>
  );
}
