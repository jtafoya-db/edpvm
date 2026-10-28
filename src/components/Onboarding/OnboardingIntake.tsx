// The onboarding intake screen (#86): the schema-driven wizard and, after a
// successful submit, the inline confirmation. Moved out of src/legacy so the
// legacy module is only a thin mount (src/legacy/onboarding.jsx) that injects
// the design-system chrome and the seam-backed `ctx`.

import React from "react";

import { SaveNotices, SavingTag } from "@/components/SaveStatus";
import { toOnboardingIntake } from "@/data/onboarding/intake";
import { useWriteIntent } from "@/data/onboarding/intent";
import { onboardingStageLabel } from "@/data/onboarding/lifecycle";
import {
  NEW_ONBOARDING_RECORD,
  submitOnboardingSave,
  type SubmitOnboardingInput,
} from "@/data/onboarding/queries";
import type { OnboardingRequest } from "@/data/onboarding/types";
import { useRecordSave, useSave, useSavesUnder, type SaveView } from "@/data/optimistic-save";
import { useUser } from "@/data/queries";
import {
  assembleRequest,
  loadSchema,
  type IntakeState,
  type OnboardingRequest as AssembledRequest,
} from "@/schema";
import { SchemaForm, edpWidgets, type SchemaFormChrome } from "../SchemaForm";
import { ChromeProvider, useChrome, type OnboardingChrome } from "./chrome";
import { Notice, SessionStateNotice } from "./shared";
import { stagePhrase } from "./stage-text";
import { h1, outlineBtn, primaryBtn } from "./styles";

// loadSchema() is the seam that hides where the schema comes from; the screen
// only hands it to <SchemaForm> with the widget registry its layouts reference.
const SCHEMA = loadSchema();

export interface OnboardingIntakeCtx {
  go: (name: string, params?: Record<string, string>) => void;
  flash: (message: string) => void;
}

interface Submitted {
  request: AssembledRequest;
  /** The press of Submit this is: its save's record. */
  intentKey: string;
  /** The stored request, once the server confirms it. */
  onboarding: OnboardingRequest | null;
}

/** What the person typed into the intake the server last refused, to put back in the form. */
function refusedValues(saves: SaveView[]): IntakeState | undefined {
  const latest = saves.filter((s) => s.action === submitOnboardingSave.action).at(-1);
  return latest?.state === "refused"
    ? (latest.input as SubmitOnboardingInput | undefined)?.values
    : undefined;
}

function IntakePage({
  ctx,
  domains,
}: {
  ctx: OnboardingIntakeCtx;
  domains: Array<{ id: string; name: string }>;
}) {
  const chrome = useChrome();
  const { Page, Trail, Icon } = chrome;
  const save = useSave(submitOnboardingSave);
  const user = useUser();
  const intakeSaves = useSavesUnder(NEW_ONBOARDING_RECORD);
  // One new request saves at a time: Submit waits while one is saving, even
  // one started before the person left this screen and came back.
  const saving = intakeSaves.some((s) => s.state === "saving");
  const [submitted, setSubmitted] = React.useState<Submitted | null>(null);
  // The intake the form starts from: a refused one's, so it isn't lost.
  const [form, setForm] = React.useState(() => ({ values: refusedValues(intakeSaves), n: 0 }));
  /** The submit the confirmation shows; a refusal only puts the form back for that one. */
  const showing = React.useRef<string | null>(null);
  const intents = useWriteIntent();

  const dynamicOptions = { domains: domains.map((d) => ({ value: d.id, label: d.name })) };
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

  // Submitting writes the onboarding request and nothing else: no old-model
  // request (#176). The assembled request only feeds the confirmation summary;
  // its REQ number is never shown or stored.
  // One press of Submit is one intent: its key is reused if the same intake is
  // submitted again after a failure, so a retry can't create a second request,
  // and a second click while it saves is the same save, so it's ignored.
  // The confirmation shows at once, saying Saving…, and the request shows in
  // My onboarding requests the same way (ADR-0009 phase 1, #195).
  const onSubmit = (values: IntakeState) => {
    if (saving) return;
    const intake = toOnboardingIntake(values);
    const intentKey = intents.intentFor(intake).key;
    const started = save(
      { intake, values, intentKey },
      { idempotencyKey: intentKey },
      {
        onSaved: (onboarding) => {
          intents.settle();
          if (showing.current !== intentKey) return;
          ctx.flash("Onboarding request submitted for business & ROI review");
          setSubmitted((current) =>
            current?.intentKey === intentKey ? { ...current, onboarding } : current,
          );
        },
        // Refused: nothing was saved. Put what they typed back in the form.
        onRefused: () => {
          if (showing.current !== intentKey) return;
          showing.current = null;
          setSubmitted(null);
          setForm((current) => ({ values, n: current.n + 1 }));
        },
      },
    );
    if (!started) return;
    const num = 2080 + Math.floor(Math.random() * 19);
    const firstDataset = Array.isArray(values["datasets"]) ? values["datasets"][0] : undefined;
    const domainName = domains.find((d) => d.id === firstDataset?.domain)?.name ?? "";
    const domainNames = Object.fromEntries(domains.map((domain) => [domain.id, domain.name]));
    showing.current = intentKey;
    setSubmitted({
      request: assembleRequest(SCHEMA, { values, domainName, domainNames, num }),
      intentKey,
      onboarding: null,
    });
    window.scrollTo({ top: 0 });
  };

  if (submitted) {
    return (
      <SubmittedConfirmation
        submitted={submitted}
        go={ctx.go}
        onReset={() => {
          showing.current = null;
          setSubmitted(null);
          setForm((current) => ({ values: undefined, n: current.n + 1 }));
        }}
      />
    );
  }

  return (
    <Page>
      <Trail items={[{ label: "Home", go: () => ctx.go("home") }, { label: "Onboard new data" }]} />
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "var(--color-orange-5v)",
              color: "var(--theme-accent-warm-darker)",
              borderRadius: "var(--radius-pill)",
              padding: "5px 14px",
              fontSize: "var(--font-size-3xs)",
              fontWeight: 700,
              marginBottom: 14,
            }}
          >
            <Icon name="database" size={15} color="var(--theme-accent-warm-darker)" /> Data provider
          </div>
          <h1 style={{ ...h1, margin: "0 0 8px" }}>Onboard new data into EDP</h1>
          <p
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-gray-cool-70)",
              margin: 0,
            }}
          >
            Describe the initiative and its datasets, make the business case, and let AI-assisted
            sizing estimate platform capacity and cost before intake review.
          </p>
        </div>

        {domains.length === 0 ? (
          // Never a silently empty required list: say why the form can't be finished.
          <div style={{ marginBottom: 16 }}>
            <Notice tone="error">
              <strong>Data domains couldn't be loaded.</strong> The list of business domains is
              empty, so each input dataset's required domain can't be chosen and this request can't
              be submitted yet. This isn't something you did. Reload the page, and if it's still
              empty, tell EDP staff the domain list is missing.
            </Notice>
          </div>
        ) : null}
        <div style={{ marginBottom: 16 }}>
          <SaveNotices prefixes={[NEW_ONBOARDING_RECORD]} label="Your onboarding requests" />
        </div>
        <SchemaForm
          key={form.n}
          schema={SCHEMA}
          widgets={edpWidgets}
          dynamicOptions={dynamicOptions}
          chrome={formChrome}
          onSubmit={onSubmit}
          onCancel={() => ctx.go("home")}
          submitting={saving}
          signedIn={user.data}
          {...(form.values
            ? { initialValues: form.values, initialStep: SCHEMA.steps.length - 1 }
            : {})}
        />
      </div>
    </Page>
  );
}

/** The confirmation, from the moment Submit is pressed: Saving…, then the stored request. */
function SubmittedConfirmation({
  submitted,
  go,
  onReset,
}: {
  submitted: Submitted;
  go: (name: string) => void;
  onReset: () => void;
}) {
  const save = useRecordSave(`${NEW_ONBOARDING_RECORD}${submitted.intentKey}`);
  return (
    <OnboardingConfirmation
      request={submitted.request}
      onboarding={submitted.onboarding}
      save={save}
      go={go}
      onReset={onReset}
    />
  );
}

const eyebrow: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: "var(--text-muted)",
};

/**
 * After submit: while it saves, that it's saving and where it shows; once the
 * server confirms, the request's id and stage, and where to track it.
 */
export function OnboardingConfirmation({
  request,
  onboarding,
  save,
  go,
  onReset,
}: {
  request: AssembledRequest;
  /** The stored request; null until the server confirms it. */
  onboarding: Pick<OnboardingRequest, "id" | "stage"> | null;
  /** The submit's save, while the screen shows it. */
  save?: SaveView | undefined;
  go: (name: string) => void;
  onReset: () => void;
}) {
  const { Page, Trail, Panel, Pill, Icon } = useChrome();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // The wizard the person pressed Submit in is gone: put them on what replaced it.
  React.useEffect(() => headingRef.current?.focus(), []);
  // Not stored yet and not saving: the answer was lost, or the person dismissed it.
  const unconfirmed = !onboarding && save?.state !== "saving";
  return (
    <Page>
      <Trail items={[{ label: "Home", go: () => go("home") }, { label: "Onboard new data" }]} />
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "var(--radius-pill)",
              background: onboarding
                ? "var(--theme-success-lighter)"
                : unconfirmed
                  ? "var(--theme-warning-lighter)"
                  : "var(--theme-info-lighter)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 14,
            }}
          >
            <Icon
              name={onboarding ? "check_circle" : unconfirmed ? "warning" : "schedule"}
              size={30}
              color={
                onboarding
                  ? "var(--theme-success-dark)"
                  : unconfirmed
                    ? "var(--theme-warning-darker)"
                    : "var(--theme-info-darker)"
              }
            />
          </div>
          <h1 ref={headingRef} tabIndex={-1} style={{ ...h1, margin: "0 0 8px", outline: "none" }}>
            {onboarding
              ? "Onboarding request submitted"
              : unconfirmed
                ? "Your onboarding request isn't confirmed yet"
                : "Saving your onboarding request…"}
          </h1>
          <p
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-gray-cool-70)",
              margin: 0,
            }}
          >
            {onboarding ? (
              <>
                It is now with the EDP business office for {stagePhrase(onboarding.stage)}. Track
                it, and answer any questions, on your onboarding requests page.
              </>
            ) : unconfirmed ? (
              <>
                We couldn&apos;t confirm it was saved. Check your onboarding requests before trying
                again.
              </>
            ) : (
              <>
                You can keep working or leave this page: it keeps saving. It shows in your
                onboarding requests marked Saving… until it&apos;s saved.
              </>
            )}
          </p>
        </div>
        {save ? (
          <div style={{ marginBottom: 20 }}>
            <SaveNotices prefixes={[save.record]} label="Your onboarding request" />
          </div>
        ) : null}

        <Panel pad={0} style={{ overflow: "hidden", marginBottom: 20 }}>
          <div
            style={{
              padding: "18px 22px",
              borderBottom: "1px solid var(--border-default)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={eyebrow}>Onboarding request</div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-lg)",
                  fontWeight: 700,
                  marginTop: 2,
                }}
              >
                {onboarding ? onboarding.id : "Assigned when it's saved"}
              </div>
            </div>
            {onboarding ? (
              <Pill icon="schedule" bg="var(--color-blue-5v)" fg="var(--theme-primary)" size="lg">
                {onboardingStageLabel(onboarding.stage)}
              </Pill>
            ) : (
              <SavingTag save={save} />
            )}
          </div>
          <div style={{ padding: "18px 22px" }}>
            <div style={{ fontSize: "var(--font-size-md)", fontWeight: 700, marginBottom: 6 }}>
              {request.title}
            </div>
            <p
              style={{
                fontSize: "var(--font-size-2xs)",
                color: "var(--color-gray-cool-70)",
                margin: 0,
                lineHeight: 1.6,
              }}
            >
              {request.purpose}
            </p>
          </div>
          {request.items.length ? (
            <div style={{ padding: "0 22px 18px" }}>
              <div style={{ ...eyebrow, margin: "6px 0 10px" }}>In this request</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {request.items.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <Icon name="database" size={16} color="var(--theme-accent-warm-dark)" />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "var(--font-size-2xs)", fontWeight: 600 }}>
                        {item.label}
                      </div>
                      {item.sub ? (
                        <div
                          style={{
                            fontSize: "var(--font-size-3xs)",
                            color: "var(--text-muted)",
                            marginTop: 2,
                          }}
                        >
                          {item.sub}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Panel>

        {/* Honest disclosure: the store is session-only and nothing downstream is connected. */}
        <div style={{ display: "grid", gap: 12, marginBottom: 22 }}>
          <SessionStateNotice />
          <Notice>
            Nothing is sent to JIRA, BEARS or Databricks, and standup after CCB approval is not
            connected yet.
          </Notice>
        </div>

        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={() => go("onboarding-requests")} style={primaryBtn}>
            <Icon name="arrow_forward" size={16} color="#fff" /> View my onboarding requests
          </button>
          <button type="button" onClick={onReset} style={outlineBtn}>
            <Icon name="add" size={16} color="var(--theme-primary)" /> Onboard another initiative
          </button>
          <button type="button" onClick={() => go("home")} style={outlineBtn}>
            Back to home
          </button>
        </div>
      </div>
    </Page>
  );
}

/** The wizard screen with its chrome; `domains` come from the seam via the legacy host. */
export function OnboardingIntakeScreen({
  ctx,
  domains,
  chrome,
}: {
  ctx: OnboardingIntakeCtx;
  domains: Array<{ id: string; name: string }>;
  chrome?: Partial<OnboardingChrome> | undefined;
}) {
  return (
    <ChromeProvider chrome={chrome}>
      <IntakePage ctx={ctx} domains={domains} />
    </ChromeProvider>
  );
}
