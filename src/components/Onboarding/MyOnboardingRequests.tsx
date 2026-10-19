// The data provider's onboarding requests (#86): each request's current stage
// and SLA state, the questions of an open send-back with a way to answer and
// resubmit, and withdrawal while the request is still under review. The store
// resolves who the provider is from the signed-in session.

import React from "react";

import { SaveNotices, SavingTag } from "@/components/SaveStatus";
import {
  NEW_ONBOARDING_RECORD,
  intakeAnswers,
  isOnboardingTerminal,
  isSavingOnboardingRequest,
  onboardingRecord,
  onboardingStageLabel,
  resubmitOnboardingSave,
  savingOnboardingId,
  toOnboardingIntake,
  useCatalog,
  useMyOnboardingRequests,
  useUser,
  useWriteIntent,
  withdrawOnboardingSave,
  type OnboardingRequest,
  type ResubmitOnboardingInput,
} from "@/data";
import { useRecordSave, useSave, useSavesUnder, type SaveView } from "@/data/optimistic-save";
import { FeatureGate } from "@/features/FeatureGate";
import { loadSchema, type IntakeState } from "@/schema";
import { SchemaForm, edpWidgets, type SchemaFormChrome } from "../SchemaForm";
import { FieldError } from "../SchemaForm/field-helpers";
import { ChromeProvider, useChrome, type OnboardingChrome } from "./chrome";
import { IntakePackage } from "./IntakePackage";
import {
  ActionFailedNotice,
  DecisionLog,
  Notice,
  PageHeader,
  SessionStateNotice,
  SlaPill,
  StageTrack,
} from "./shared";
import { requestTone, stagePhrase } from "./stage-text";
import {
  banner,
  dangerBtn,
  iconSquare,
  lbl,
  linkBtn,
  muted,
  outlineBtn,
  primaryBtn,
  textarea,
} from "./styles";

const SCHEMA = loadSchema();
const LAST_STEP = SCHEMA.steps.length - 1;

/** The stored intake as the wizard holds it, to start a resubmission from. */
function wizardValues(request: OnboardingRequest): IntakeState {
  return structuredClone(intakeAnswers(request.intake));
}

/**
 * The open send-back (#86): the reviewer's questions and the provider's
 * answer, with the way into the full intake wizard to resubmit (#222).
 */
function SendBackAnswer({
  request,
  answer,
  setAnswer,
  answerBad,
  editing,
  onEdit,
}: {
  request: OnboardingRequest;
  answer: string;
  setAnswer: (answer: string) => void;
  /** A resubmit was tried without an answer. */
  answerBad: boolean;
  /** The wizard is open below. */
  editing: boolean;
  onEdit: () => void;
}) {
  const { Icon } = useChrome();
  const sendBack = request.openSendBack;
  if (!sendBack) return null;
  return (
    <div style={banner("warning")}>
      <Icon name="warning" size={20} color="var(--theme-warning-darker)" />
      <div style={{ flex: 1, display: "grid", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700, color: "var(--text-default)", marginBottom: 3 }}>
            Sent back from {stagePhrase(sendBack.from)} with questions
          </div>
          <div>“{sendBack.questions}”</div>
          <div style={{ marginTop: 3 }}>
            Answer the questions, change anything in the intake that needs it, and resubmit. It goes
            back to {stagePhrase(sendBack.from)}.
          </div>
        </div>
        <div>
          <label style={lbl} htmlFor={`${request.id}-answer`}>
            Your answer <span style={{ color: "var(--theme-secondary)" }}>*</span>
          </label>
          <textarea
            id={`${request.id}-answer`}
            aria-label="Your answer"
            aria-invalid={answerBad || undefined}
            aria-describedby={answerBad ? `${request.id}-answer-error` : undefined}
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            style={textarea}
          />
          {answerBad ? (
            <FieldError id={`${request.id}-answer-error`} Icon={Icon}>
              Enter an answer for the reviewer.
            </FieldError>
          ) : null}
        </div>
        {editing ? null : (
          <div>
            <button type="button" style={primaryBtn} onClick={onEdit}>
              <Icon name="edit" size={17} color="#fff" /> Review the intake and resubmit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The whole intake wizard, prefilled with the stored request (#222): the same
 * steps, fields and validation as the first submit, and every field
 * editable, datasets and owners included. Its last step resubmits with the
 * answer above; ids are prefixed per request, so two cards never share one.
 */
function ResubmitWizard({
  request,
  form,
  answerMissing,
  onAnswerMissing,
  onSubmit,
  onClose,
  saving,
}: {
  request: OnboardingRequest;
  /** The values to open on, and the step: a refused resubmission's reopens on its last. */
  form: { values: IntakeState; n: number; step: number };
  answerMissing: boolean;
  onAnswerMissing: () => void;
  onSubmit: (values: IntakeState) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const chrome = useChrome();
  const catalog = useCatalog();
  const user = useUser();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // Opening the wizard moves the person to it, as the first submit's page does.
  React.useEffect(() => headingRef.current?.focus(), []);
  const idPrefix = `${request.id.toLowerCase()}-resubmit`;
  const headingId = `${idPrefix}-heading`;
  const formChrome: Partial<SchemaFormChrome> = React.useMemo(
    () => ({
      Icon: chrome.Icon,
      Pill: chrome.Pill,
      Panel: chrome.Panel,
      SectionHead: chrome.SectionHead,
      StepIndicator: ({ steps, step }) => (
        <chrome.StepIndicator steps={steps} current={step} counters />
      ),
    }),
    [chrome],
  );
  const domains = (catalog.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }));
  return (
    <section aria-labelledby={headingId} style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          style={{ margin: 0, fontSize: "var(--font-size-sm)", fontWeight: 700, outline: "none" }}
        >
          Edit the intake for {request.id}
        </h3>
        <button type="button" style={linkBtn} onClick={onClose} disabled={saving}>
          Close without resubmitting
        </button>
      </div>
      <p style={{ ...muted, margin: 0 }}>
        Every answer from your intake, ready to change. You can add or remove datasets and owners.
        The last step resubmits it with your answer.
      </p>
      <SchemaForm
        key={form.n}
        schema={SCHEMA}
        widgets={edpWidgets}
        dynamicOptions={{ domains }}
        chrome={formChrome}
        initialValues={form.values}
        initialStep={form.step}
        idPrefix={idPrefix}
        submitLabel="Answer and resubmit"
        submittingLabel="Resubmitting…"
        submitIssues={
          answerMissing
            ? [{ targetId: `${request.id}-answer`, message: "Enter an answer for the reviewer." }]
            : []
        }
        onInvalidSubmit={onAnswerMissing}
        onSubmit={onSubmit}
        onCancel={onClose}
        submitting={saving}
        signedIn={user.data}
      />
    </section>
  );
}

/** What the provider had in a resubmission the server refused, to put back. */
function refusedResubmission(
  save: SaveView | undefined,
): { answer: string; values: IntakeState | undefined } | undefined {
  if (save?.state !== "refused" || save.action !== resubmitOnboardingSave.action) return undefined;
  const input = save.input as ResubmitOnboardingInput | undefined;
  return input ? { answer: input.resubmission.answer, values: input.values } : undefined;
}

/** Why a rejected request was ended, and by whom, shown open on the card. */
function RejectionReason({ request }: { request: OnboardingRequest }) {
  const { Icon } = useChrome();
  if (request.stage !== "rejected") return null;
  const rejection = [...request.decisions].reverse().find((decision) => decision.kind === "reject");
  if (!rejection) return null;
  return (
    <section aria-label="Reason for rejection" style={banner("error")}>
      <Icon name="error" size={20} color="var(--theme-error-dark)" />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: "var(--text-default)", marginBottom: 3 }}>
          Rejected at {rejection.from ? stagePhrase(rejection.from) : "review"} by{" "}
          {rejection.actorName} on{" "}
          <time dateTime={rejection.at}>
            {new Date(rejection.at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
        </div>
        {rejection.note ? <div>“{rejection.note}”</div> : null}
      </div>
    </section>
  );
}

function RequestCard({ request }: { request: OnboardingRequest }) {
  const { Panel, Icon } = useChrome();
  const withdraw = useSave(withdrawOnboardingSave);
  const resubmit = useSave(resubmitOnboardingSave);
  const resubmitIntents = useWriteIntent();
  const withdrawIntents = useWriteIntent();
  const record = onboardingRecord(request.id);
  const save = useRecordSave(record);
  const [confirming, setConfirming] = React.useState(false);
  // The answer outlives the send-back banner, which hides while the resubmission
  // saves; a refused one comes back with what was typed, even after leaving the page.
  const refused = refusedResubmission(save);
  const [answer, setAnswer] = React.useState(() => refused?.answer ?? "");
  const [answerAttempted, setAnswerAttempted] = React.useState(false);
  const [form, setForm] = React.useState(() => ({
    values: refused?.values ?? wizardValues(request),
    n: 0,
    step: refused?.values ? LAST_STEP : 0,
  }));
  const [editing, setEditing] = React.useState(() => refused?.values !== undefined);
  React.useEffect(() => {
    if (!refused) return;
    setAnswer(refused.answer);
    if (refused.values) {
      const values = refused.values;
      setForm((current) => ({ values, n: current.n + 1, step: LAST_STEP }));
      setEditing(true);
    }
    // Once per refusal: the person may edit it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save?.id, save?.state]);
  // One save at a time on this request: a resubmission or a withdrawal.
  const saving = save?.state === "saving";
  const unresolved = saving || save?.state === "unconfirmed";
  const busy = saving
    ? { disabled: true, "aria-disabled": true as const }
    : { disabled: false, "aria-disabled": undefined };
  const answerMissing = answer.trim().length === 0;
  const openWizard = () => {
    // Each opening starts from the request as stored now.
    setForm((current) => ({ values: wizardValues(request), n: current.n + 1, step: 0 }));
    setEditing(true);
  };
  // Each shows at once, marked Saving… (ADR-0009 phase 1, #195). The server
  // checks it against the version on screen; a refusal rolls back only this one.
  // The same answer and intake on a retry is the same intent, under the same key.
  const sendResubmission = (values: IntakeState) => {
    if (saving) return;
    const resubmission = { answer, intake: toOnboardingIntake(values) };
    const intent = resubmitIntents.intentFor({ id: request.id, resubmission }, request.version);
    const started = resubmit(
      { id: request.id, version: request.version, resubmission, values },
      { idempotencyKey: intent.key },
      { onSaved: resubmitIntents.settle },
    );
    if (started) setEditing(false);
  };
  const confirmWithdraw = () => {
    if (saving) return;
    const intent = withdrawIntents.intentFor({ id: request.id, withdraw: true }, request.version);
    const started = withdraw(
      { id: request.id, version: request.version },
      { idempotencyKey: intent.key },
      { onSaved: withdrawIntents.settle },
    );
    if (started) setConfirming(false);
  };
  const canWithdraw = !isOnboardingTerminal(request.stage) && request.stage !== "standup";
  const tone = requestTone(request);

  return (
    <article aria-label={`${request.id} ${request.title}`}>
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
              {request.id} · Submitted {new Date(request.submittedAt).toLocaleDateString("en-US")} ·
              Current stage:{" "}
              <strong style={{ color: "var(--text-default)" }}>
                {onboardingStageLabel(request.stage)}
              </strong>
            </div>
          </div>
          {/* Until the server confirms, the new stage's SLA isn't known. */}
          {unresolved ? <SavingTag save={save} /> : <SlaPill request={request} />}
        </div>

        <div style={{ padding: "4px 24px 20px", display: "grid", gap: 18 }}>
          <SaveNotices prefixes={[record]} label={`Saves on ${request.id}`} />
          <div style={{ overflowX: "auto" }}>
            <StageTrack request={request} />
          </div>
          {request.stage === "standup" ? (
            <Notice tone="success">
              The CCB approved this initiative. EDP staff stand it up next; activation isn&apos;t
              tracked in the app yet.
            </Notice>
          ) : null}
          <RejectionReason request={request} />
          <SendBackAnswer
            request={request}
            answer={answer}
            setAnswer={setAnswer}
            answerBad={answerAttempted && answerMissing}
            editing={editing}
            onEdit={openWizard}
          />
          {request.openSendBack && editing ? (
            <ResubmitWizard
              request={request}
              form={form}
              answerMissing={answerMissing}
              onAnswerMissing={() => setAnswerAttempted(true)}
              onSubmit={sendResubmission}
              onClose={() => setEditing(false)}
              saving={saving}
            />
          ) : null}
          <IntakePackage request={request} />
          <DecisionLog request={request} />
        </div>

        {canWithdraw ? (
          <div
            style={{
              borderTop: "1px solid var(--border-default)",
              background: "var(--color-gray-cool-1)",
              padding: "16px 24px",
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {confirming ? (
              <>
                <span style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>
                  Withdraw this request? This can&apos;t be undone.
                </span>
                <button type="button" style={dangerBtn} {...busy} onClick={confirmWithdraw}>
                  <Icon name="close" size={16} color="var(--theme-error-dark)" /> Confirm withdrawal
                </button>
                <button
                  type="button"
                  style={outlineBtn}
                  {...busy}
                  onClick={() => setConfirming(false)}
                >
                  Keep the request
                </button>
              </>
            ) : (
              <button type="button" style={dangerBtn} {...busy} onClick={() => setConfirming(true)}>
                <Icon name="close" size={16} color="var(--theme-error-dark)" /> Withdraw request
              </button>
            )}
          </div>
        ) : null}
      </Panel>
    </article>
  );
}

/** A new request while its submit saves: what was sent, and that it isn't stored yet. */
function SavingRequestCard({ request }: { request: OnboardingRequest }) {
  const { Panel, Icon } = useChrome();
  const save = useSavesUnder(NEW_ONBOARDING_RECORD).find(
    (s) => s.idempotencyKey !== undefined && savingOnboardingId(s.idempotencyKey) === request.id,
  );
  return (
    <article aria-label={`New request ${request.title}`} aria-busy={save?.state === "saving"}>
      <Panel pad={0} style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "20px 24px" }}>
          <div style={iconSquare("var(--theme-info-lighter)")}>
            <Icon name="schedule" size={24} color="var(--theme-info-darker)" />
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
              ID assigned when it&apos;s saved · Submitted{" "}
              {new Date(request.submittedAt).toLocaleDateString("en-US")} · Current stage:{" "}
              <strong style={{ color: "var(--text-default)" }}>
                {onboardingStageLabel(request.stage)}
              </strong>
            </div>
          </div>
          <SavingTag save={save} />
        </div>
        <div style={{ padding: "4px 24px 20px", display: "grid", gap: 18 }}>
          <div style={{ overflowX: "auto" }}>
            <StageTrack request={request} />
          </div>
          <IntakePackage request={request} />
        </div>
      </Panel>
    </article>
  );
}

function MyRequestsBody({ go }: { go?: ((name: string) => void) | undefined }) {
  const user = useUser();
  const requests = useMyOnboardingRequests();

  if (user.isError) {
    return <Notice tone="error">Could not resolve who you are: {user.error.message}</Notice>;
  }
  if (requests.isError) return <ActionFailedNotice error={requests.error} />;
  if (!requests.data) return <Notice>Loading…</Notice>;
  if (requests.data.length === 0) {
    return (
      <Notice>
        You haven&apos;t submitted an onboarding request in this session.{" "}
        {go ? (
          <button
            type="button"
            style={{ ...outlineBtn, marginLeft: 8 }}
            onClick={() => go("onboarding")}
          >
            Onboard new data
          </button>
        ) : null}
      </Notice>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 24 }}>
      <SaveNotices prefixes={[NEW_ONBOARDING_RECORD]} label="Your new onboarding requests" />
      {requests.data.map((request) =>
        isSavingOnboardingRequest(request) ? (
          <SavingRequestCard key={request.id} request={request} />
        ) : (
          <RequestCard key={request.id} request={request} />
        ),
      )}
    </div>
  );
}

function MyRequestsPage({ go }: { go?: ((name: string) => void) | undefined }) {
  const { Page } = useChrome();
  return (
    <Page>
      <PageHeader
        title="My onboarding requests"
        crumb="My onboarding requests"
        go={go}
        intro="Where each request is, and whether its review is on track."
      />
      <div style={{ marginBottom: 20 }}>
        <SessionStateNotice />
      </div>
      <FeatureGate id="onboarding-request-status">
        <MyRequestsBody go={go} />
      </FeatureGate>
    </Page>
  );
}

export function MyOnboardingRequests({
  go,
  chrome,
}: {
  go?: ((name: string) => void) | undefined;
  chrome?: Partial<OnboardingChrome> | undefined;
}) {
  return (
    <ChromeProvider chrome={chrome}>
      <MyRequestsPage go={go} />
    </ChromeProvider>
  );
}

/** Hash-route entry: `#onboarding-requests`. */
export function MyOnboardingRequestsScreen({
  ctx,
  chrome,
}: {
  ctx?: { go?: (name: string) => void };
  chrome?: Partial<OnboardingChrome>;
}) {
  return <MyOnboardingRequests go={ctx?.go} chrome={chrome} />;
}
