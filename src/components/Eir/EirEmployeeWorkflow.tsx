import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PendingActionButton,
  PendingActionStatus,
  disabledPendingStyle,
  usePendingActionGroup,
} from "@/components/PendingAction";
import {
  EIR_FORMS,
  EIR_UNAVAILABLE_MESSAGE,
  LEGACY_EIR_FORMS,
  isStructuredEirVersion,
  useEir,
  describeEirErrors,
  emptyAnswersOn,
  prefilledAnswersOn,
  useEirForms,
  eirErrorStatus,
  eirFormsFrom,
  formForNextSave,
  useSaveEirDraft,
  useEvaluateEirDraft,
  useGenerateEirPdf,
  useStartEir,
  useRespondEir,
  useSubmitEirFile,
  useUser,
  validateAnswersOn,
  type EirFieldError,
  type EirFormConfig,
  type EirFormValues,
  type EirRecord,
  type EirEvaluation,
  definitionLabel,
  eirFormName,
} from "@/data";
import { SaveNotices } from "@/components/SaveStatus";
import { useRecordSave, useSave } from "@/data/optimistic-save";
import { eirRecord, saveEirDraftSave } from "@/data/queries";
import { EirAnswers } from "./EirAnswers";
import { EirForm } from "./EirForm";
import {
  DocumentLinks,
  EirLoadErrorAlert,
  dangerButton,
  heading,
  input,
  label,
  link,
  linkButton,
  outlineButton,
  primaryButton,
  saveFailureMessage,
  testModeTag,
  statusMeta,
  type EirScreenChrome,
} from "./EirShared";

/**
 * The saved answers to show, with the form version they were given under: a
 * pending renewal's, else the draft's, else the signed EIR's. Answers under a
 * structured version (1.2 or later) open in the current form; #98's migrated
 * checklist doesn't, it's shown as legacy answers.
 */
function savedForm(
  record: EirRecord | undefined,
): { values: EirFormValues; version: string } | undefined {
  const structured = (values: EirFormValues | undefined, version: string | undefined) =>
    values && version && isStructuredEirVersion(version) ? { values, version } : undefined;
  // A renewal in review or sent back: its own signed answers.
  return (
    (record?.renewal?.stage === "submitted" || record?.renewal?.stage === "questions"
      ? structured(record.renewal.formValues, record.renewal.formVersion)
      : undefined) ??
    structured(record?.draftValues, record?.draftFormVersion) ??
    structured(record?.formValues, record?.formVersion)
  );
}
const savedFormValues = (record: EirRecord | undefined) => savedForm(record)?.values;
/** Same answers on every question either has: the form's questions come from its definition (#201). */
const sameAnswers = (a: Partial<EirFormValues>, b: Partial<EirFormValues>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (id) => (a[id] ?? "") === (b[id] ?? ""),
  );

export interface EirScreenProps {
  ctx?: { go?: (route: string) => void };
  chrome?: Partial<EirScreenChrome>;
}

const DefaultPage: EirScreenChrome["Page"] = ({ children }) => <div>{children}</div>;
const DefaultTrail: EirScreenChrome["Trail"] = () => null;
const DefaultPanel: EirScreenChrome["Panel"] = ({ children, style }) => (
  <section style={style}>{children}</section>
);
const DefaultPill: EirScreenChrome["Pill"] = ({ children }) => <span>{children}</span>;
const DefaultIcon: EirScreenChrome["Icon"] = () => null;
const DefaultSectionHead: EirScreenChrome["SectionHead"] = ({ eyebrow, title, action }) => (
  <div>
    {eyebrow ? <div>{eyebrow}</div> : null}
    <h2>{title}</h2>
    {action}
  </div>
);

function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;

/**
 * My EIR, on the form the server says the person's next save uses (#201):
 * their draft's, else the active EIR definition's. Without one (the
 * definition couldn't be loaded, #200) it says so and offers nothing to fill
 * in, save, sign or upload.
 */
export function EirEmployeeWorkflow(props: EirScreenProps = {}) {
  return <EirEmployeeJourney {...props} />;
}

/**
 * The form versions a record's answers were given under (its draft's, its
 * EIR's, its renewal's) that only the server knows: a published definition's.
 * The ones the app ships with need no read.
 */
const storedVersions = (record: EirRecord | undefined): string[] =>
  [record?.draftFormVersion, record?.formVersion, record?.renewal?.formVersion].filter(
    (version, i, all): version is string =>
      Boolean(version) &&
      all.indexOf(version) === i &&
      !EIR_FORMS[version!] &&
      !LEGACY_EIR_FORMS[version!],
  );

function EirUnavailable({ ctx, chrome }: EirScreenProps) {
  const Page = chrome?.Page ?? DefaultPage;
  const Trail = chrome?.Trail ?? DefaultTrail;
  return (
    <Page>
      <Trail
        items={[
          { label: "Home", ...(ctx?.go ? { go: () => ctx.go?.("home") } : {}) },
          { label: "My EIR" },
        ]}
      />
      <div style={{ padding: 32, fontFamily: "var(--font-sans)" }}>
        <h1 style={heading}>Employee Identity Record (EIR)</h1>
        <div
          role="alert"
          style={{
            maxWidth: 720,
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
          <p style={{ margin: 0 }}>{EIR_UNAVAILABLE_MESSAGE}</p>
          <p style={{ margin: "6px 0 0", fontWeight: 400 }}>
            This is a problem on our side. Try again later, or contact EDP staff if it keeps
            happening.
          </p>
        </div>
        <p style={{ marginTop: 16 }}>
          <a
            href="#home"
            style={link}
            onClick={(event) => {
              if (!ctx?.go) return;
              event.preventDefault();
              ctx.go("home");
            }}
          >
            Go to Home
          </a>
        </p>
      </div>
    </Page>
  );
}

/** The answer IDs a form stores: its fields and the attestation. */
const answerIdsOf = (form: EirFormConfig) => [
  ...form.sections.flatMap((section) => section.fields.map((field) => field.id)),
  form.declaration.attestation.id,
];

function EirEmployeeJourney({ ctx, chrome }: EirScreenProps) {
  const Page = chrome?.Page ?? DefaultPage;
  const Trail = chrome?.Trail ?? DefaultTrail;
  const Panel = chrome?.Panel ?? DefaultPanel;
  const Pill = chrome?.Pill ?? DefaultPill;
  const Icon = chrome?.Icon ?? DefaultIcon;
  const SectionHead = chrome?.SectionHead ?? DefaultSectionHead;
  const user = useUser();
  const principalId = user.data?.principalId ?? "";
  const record = useEir(principalId);
  const formsRead = useEirForms(storedVersions(record.data));
  // The form the next save uses: the draft's, else the active definition's (#201).
  // Until the saved answers load it's the active one, shown read-only (#202).
  let currentForm: EirFormConfig | undefined;
  let formUnavailable = formsRead.isError && eirErrorStatus(formsRead.error) === 503;
  if (formsRead.data) {
    try {
      currentForm = formForNextSave(record.data ?? {}, eirFormsFrom(formsRead.data));
    } catch {
      formUnavailable = true;
    }
  }
  const definitionForms = formsRead.data ? eirFormsFrom(formsRead.data) : undefined;
  const submitFile = useSubmitEirFile();
  const saveDraft = useSaveEirDraft();
  const evaluateDraft = useEvaluateEirDraft();
  const generatePdf = useGenerateEirPdf();
  const startEir = useStartEir();
  const respondEir = useRespondEir();
  const pending = usePendingActionGroup();
  // Save draft doesn't block: the person keeps typing while it saves (ADR-0009 phase 1).
  const saveDraftNow = useSave(saveEirDraftSave);
  const draftSave = useRecordSave(eirRecord(principalId));
  const draftSaving = draftSave?.state === "saving";
  /** The answers this screen just saved as a draft: its own save landing doesn't reset the form. */
  const ownDraft = useRef<EirFormValues | null>(null);
  // Other actions use the draft's version, so they wait for a draft save on its way.
  const busy = pending.isRecordPending(principalId) || draftSaving || record.isLoading;
  const [values, setValues] = useState<EirFormValues>({});
  const fieldIds = currentForm ? answerIdsOf(currentForm) : [];
  const [formErrors, setFormErrors] = useState<EirFieldError[]>([]);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [response, setResponse] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [downloadedValues, setDownloadedValues] = useState<EirFormValues | null>(null);
  const [evaluation, setEvaluation] = useState<EirEvaluation | null>(null);
  const [evaluationStale, setEvaluationStale] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const reviewErrorRef = useRef<HTMLDivElement>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);
  const [editRequested, setEditRequested] = useState(0);
  // Sent back: Correct my answers opens the form; until then it stays as signed.
  const [correcting, setCorrecting] = useState(false);
  const [responseError, setResponseError] = useState("");
  const [showSlowLoad, setShowSlowLoad] = useState(false);
  const [loadAnnouncement, setLoadAnnouncement] = useState("");
  const [loadRetrying, setLoadRetrying] = useState(false);
  const [loadRetryFailures, setLoadRetryFailures] = useState(0);
  // Undefined until a Retry the person pressed fails: a load error that shows
  // up on its own (a background refetch) is announced, never focused (#184).
  const [loadErrorFocusKey, setLoadErrorFocusKey] = useState<number | undefined>();
  const [lastLoadError, setLastLoadError] = useState<unknown>(null);
  const responseRef = useRef<HTMLTextAreaElement>(null);
  const responseErrorRef = useRef<HTMLParagraphElement>(null);

  const formsLoading = formsRead.isLoading;
  useEffect(() => {
    if (!user.isLoading && !record.isLoading && !formsLoading) {
      setShowSlowLoad(false);
      return;
    }
    setShowSlowLoad(false);
    const timer = window.setTimeout(() => setShowSlowLoad(true), 1200);
    return () => window.clearTimeout(timer);
  }, [record.isLoading, user.isLoading, formsLoading]);

  const formsError = formUnavailable ? null : formsRead.error;
  useEffect(() => {
    setLoadAnnouncement(
      record.isLoading
        ? showSlowLoad
          ? "Still loading your EIR…"
          : "Loading your saved answers…"
        : "",
    );
  }, [record.isLoading, showSlowLoad]);

  useEffect(() => {
    const error = record.error ?? user.error ?? formsError;
    if (error) setLastLoadError(error);
  }, [record.error, user.error, formsError]);

  useEffect(() => {
    if (!currentForm) return;
    const savedValues = savedFormValues(record.data);
    // The draft this screen saved: the form has those answers already, and maybe newer typing.
    if (savedValues && ownDraft.current && sameAnswers(savedValues, ownDraft.current)) {
      ownDraft.current = null;
      return;
    }
    // Nothing saved yet: start from what the session (SCIM /Me) knows.
    setValues(
      savedValues
        ? { ...emptyAnswersOn(currentForm), ...savedValues }
        : user.data
          ? prefilledAnswersOn(currentForm, user.data)
          : emptyAnswersOn(currentForm),
    );
    const persistedEvaluation = record.data?.evaluation ?? null;
    setEvaluation(persistedEvaluation);
    setEvaluationStale(
      Boolean(
        persistedEvaluation &&
        record.data?.draftVersion &&
        persistedEvaluation.evaluatedDraftVersion !== record.data.draftVersion,
      ),
    );
  }, [record.data, user.data, currentForm]);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  useEffect(() => {
    if (reviewError) reviewErrorRef.current?.focus();
  }, [reviewError]);

  useEffect(() => {
    if (responseError) responseRef.current?.focus();
  }, [responseError]);

  // "Edit form" leaves review: the form is back, so take the person to it.
  useEffect(() => {
    if (!editRequested) return;
    formRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    formRef.current?.querySelector<HTMLInputElement>("input, select, textarea")?.focus();
  }, [editRequested]);

  // No current form: say so, and offer nothing to fill in, save, sign or upload.
  if (formUnavailable) {
    return <EirUnavailable {...(ctx ? { ctx } : {})} {...(chrome ? { chrome } : {})} />;
  }
  if (!loadRetrying && (user.isLoading || formsLoading)) {
    return (
      <div role="status" style={{ padding: 32, fontFamily: "var(--font-sans)" }}>
        {showSlowLoad ? "Still loading your EIR…" : "Loading EIR…"}
      </div>
    );
  }
  if (!user.data || record.isError || user.isError || formsRead.isError || loadRetrying) {
    const loadError = record.error ?? user.error ?? formsRead.error ?? lastLoadError;
    return (
      <Page>
        <Trail
          items={[
            { label: "Home", ...(ctx?.go ? { go: () => ctx.go?.("home") } : {}) },
            { label: "My EIR" },
          ]}
        />
        <div style={{ padding: 32, fontFamily: "var(--font-sans)" }}>
          <h1 style={heading}>Employee Identity Record (EIR)</h1>
          <EirLoadErrorAlert
            error={loadError}
            retrying={loadRetrying || record.isFetching || user.isFetching || formsRead.isFetching}
            failedRetryCount={loadRetryFailures}
            {...(loadErrorFocusKey !== undefined ? { focusKey: loadErrorFocusKey } : {})}
            onRetry={() => {
              const nextFailureCount = loadRetryFailures + 1;
              setLastLoadError(loadError);
              setLoadRetrying(true);
              void Promise.all([
                user.refetch(),
                record.refetch(),
                ...(formsRead.isError ? [formsRead.refetch()] : []),
              ])
                .then((results) => {
                  if (results.every((result) => !result.isError)) {
                    setLoadRetryFailures(0);
                    setMessage("Retry loaded your EIR.");
                    return;
                  }
                  setLoadRetryFailures(nextFailureCount);
                  setLoadErrorFocusKey((key) => (key ?? 0) + 1);
                })
                .finally(() => setLoadRetrying(false));
            }}
          />
        </div>
      </Page>
    );
  }

  // Loaded: the record and its forms are here.
  if (!currentForm) return null;
  const form: EirFormConfig = currentForm;

  const draftInput = () => ({
    principalId,
    values,
    formVersion: form.version,
    expectedDraftVersion: record.data?.draftVersion ?? 0,
  });

  /**
   * Save the unsigned draft: it never changes a submitted EIR (#104). The form
   * stays editable; Draft says Saving…, then Saved once the server confirms.
   */
  const keepDraft = () => {
    if (busy) return;
    const started = saveDraftNow(draftInput(), {
      idempotencyKey: globalThis.crypto.randomUUID(),
    });
    if (!started) return;
    ownDraft.current = { ...values };
    setFormErrors([]);
    setMessage("");
  };

  /** Check the answers, start the record (its Record ID goes in the PDF), save, and download. */
  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const errors = validateAnswersOn(form, values);
    setFormErrors(errors);
    if (errors.length) {
      setFailedAttempts((count) => count + 1);
      setMessage("");
      return;
    }
    try {
      const started = await pending.run(
        { recordId: principalId, actionId: "download-pdf", label: "Saving draft" },
        async () => {
          let next = record.data;
          if (!next?.recordId) {
            next = await startEir.mutateAsync({ principalId, personName: user.data.name });
          }
          await saveDraft.mutateAsync(draftInput());
          const evaluated = await evaluateDraft.mutateAsync(principalId);
          setEvaluation(evaluated);
          setEvaluationStale(false);
          if (evaluated.outcome === "blocking") {
            setFormErrors(
              evaluated.outcomes
                .filter((item) => item.disposition === "blocking")
                .map((item) => ({ field: item.field, message: item.guidance })),
            );
            throw new Error("Correct the highlighted fields before downloading the PDF.");
          }
          return {
            record: next,
            evaluation: evaluated,
            bytes: await generatePdf.mutateAsync(principalId),
          };
        },
      );
      if (!started) return;
      download(started.bytes, `employee-identity-record-${started.record.recordId ?? "draft"}.pdf`);
      setDownloadedValues({ ...values });
      setMessage(
        started.evaluation.outcome === "warning"
          ? "PDF generated with pre-check warnings. Review them, sign the PDF digitally, then upload the signed copy."
          : started.evaluation.outcome === "manual-review"
            ? "PDF generated for manual Safeguards handling. Sign it digitally, then upload the signed copy."
            : "PDF generated after the saved draft passed the EIR pre-check. Sign it digitally, then upload the signed copy.",
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Correct the highlighted")) {
        // The pre-check blocked (#217): like a refused answer on screen, the
        // error summary takes focus and lists what to do; no competing message.
        setFailedAttempts((count) => count + 1);
        setMessage("");
      } else {
        setMessage(
          saveFailureMessage(error) ??
            "The pre-check couldn't be completed or recorded. Nothing was saved. Try again.",
        );
      }
    }
  };

  /** Cancel request: discard what isn't saved, and store nothing. */
  const cancelRequest = () => {
    const saved = savedFormValues(record.data);
    setValues(saved ? { ...emptyAnswersOn(form), ...saved } : prefilledAnswersOn(form, user.data));
    setFormErrors([]);
    clearSelectedFile();
    setMessage("Changes discarded. Nothing was saved.");
  };

  const stage = record.data?.stage ?? "not-started";
  const meta = statusMeta[stage];
  const renewal = record.data?.renewal;
  const isSubmitted = stage === "submitted" || renewal?.stage === "submitted";
  // Submitted: the answers under review, read-only. Under another form version
  // they're already shown once, as legacy answers in the stage card.
  const submitted = isSubmitted ? savedForm(record.data) : undefined;
  const questions = renewal?.stage === "questions" ? renewal.questions : record.data?.questions;
  const signedFor = downloadedValues ?? savedFormValues(record.data);
  const pdfIsOutOfDate = Boolean(
    signedFor && fieldIds.some((id) => (signedFor[id] ?? "") !== (values[id] ?? "")),
  );
  const legacyOnFile =
    record.data?.formValues && !isStructuredEirVersion(record.data.formVersion)
      ? record.data
      : undefined;
  const slaTarget = record.data?.sla?.dueAt
    ? new Date(record.data.sla.dueAt).toLocaleDateString()
    : null;
  const lastDecision = [...(record.data?.actions ?? [])]
    .reverse()
    .find((action) => ["questions", "rejected", "revoked"].includes(action.kind));
  // Sent back: the answers and PDF signed for the questions, and whether they're
  // still the answers on screen (Send response reuses them; changes need a new PDF).
  const signedForQuestions = questions
    ? renewal?.stage === "questions"
      ? { values: renewal.formValues, version: renewal.formVersion }
      : { values: record.data?.formValues, version: record.data?.formVersion }
    : undefined;
  // Signed on an EIR definition's form, it can still be answered as signed (#201).
  const signedOnCurrentForm = Boolean(
    signedForQuestions?.values &&
    signedForQuestions.version &&
    (signedForQuestions.version === form.version ||
      definitionForms?.byVersion(signedForQuestions.version)),
  );
  const answersChanged = Boolean(
    signedForQuestions?.values &&
    fieldIds.some(
      (id) => (signedForQuestions.values?.[id] ?? "").trim() !== (values[id] ?? "").trim(),
    ),
  );
  const canSendResponse = signedOnCurrentForm && !answersChanged;
  // The form is collapsed while the answers are as signed and the person hasn't chosen to correct them.
  const formLocked = Boolean(questions) && canSendResponse && !correcting && !selectedFile;
  const clearSelectedFile = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(null);
    setPreviewUrl("");
    setReviewError("");
  };
  const chooseFile = (file?: File) => {
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setMessage("");
    setReviewError(
      file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")
        ? "Choose a PDF file."
        : "",
    );
  };
  /** Send response: the same answers and the PDF already signed, with the person's answer. */
  const sendResponse = async () => {
    if (busy) return;
    if (!response.trim()) {
      setResponseError("Enter your response to the safeguards questions.");
      return;
    }
    if (!canSendResponse) return;
    setResponseError("");
    try {
      const sent = await pending.run(
        { recordId: principalId, actionId: "send-response", label: "Sending response" },
        () =>
          respondEir.mutateAsync({
            principalId,
            personName: user.data.name,
            values,
            response: response.trim(),
            ...(record.data?.version !== undefined ? { expectedVersion: record.data.version } : {}),
          }),
      );
      if (!sent) return;
      setResponse("");
      setCorrecting(false);
      setMessage(
        sent.renewal?.stage === "submitted"
          ? "Response sent. Your renewal is back with a safeguards validator."
          : "Response sent. Your EIR is back with a safeguards validator.",
      );
    } catch (error) {
      setResponseError(
        saveFailureMessage(error) ??
          "We could not send your response. Check your connection and try again.",
      );
    }
  };
  const confirmSubmission = async () => {
    if (!selectedFile) return;
    const error =
      selectedFile.type !== "application/pdf" || !selectedFile.name.toLowerCase().endsWith(".pdf")
        ? "Choose a PDF file."
        : questions && !response.trim()
          ? "Answer the safeguards questions before submitting."
          : "";
    if (error) {
      setReviewError(error);
      return;
    }
    // The same check the server runs; compliance answers never refuse.
    const answerErrors = validateAnswersOn(form, values);
    if (answerErrors.length) {
      setFormErrors(answerErrors);
      setReviewError(describeEirErrors(answerErrors));
      return;
    }
    if (busy) return;
    try {
      const submitted = await pending.run(
        { recordId: principalId, actionId: "submit-eir", label: "Submitting EIR" },
        () =>
          submitFile.mutateAsync({
            principalId,
            personName: user.data.name,
            file: selectedFile,
            values,
            formVersion: form.version,
            ...(response.trim() ? { response: response.trim() } : {}),
            ...(record.data?.version !== undefined ? { expectedVersion: record.data.version } : {}),
          }),
      );
      if (!submitted) return;
      clearSelectedFile();
      setResponse("");
      setCorrecting(false);
      setMessage(
        submitted.renewal?.stage === "submitted"
          ? "Submitted for validation. Renewal pending with a safeguards validator."
          : "Submitted for validation. With a safeguards validator.",
      );
    } catch (error) {
      setReviewError(
        saveFailureMessage(error, { upload: true }) ??
          "We could not submit the EIR. Check your connection and try again.",
      );
    }
  };

  return (
    <Page>
      <Trail
        items={[
          { label: "Home", ...(ctx?.go ? { go: () => ctx.go?.("home") } : {}) },
          { label: "My EIR" },
        ]}
      />
      {/* The stage is shown once, in the stage card below, with its expiry. */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={heading}>Employee Identity Record (EIR)</h1>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--font-size-sm)" }}>
          Complete, sign, and track the attestation tied to your identity.
        </p>
      </div>

      <p aria-live="polite" aria-atomic="true">
        {loadAnnouncement}
      </p>

      <div style={{ display: "grid", gap: 22 }}>
        <Panel>
          <SectionHead eyebrow="Your record" title="EIR stage" />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
              alignItems: "start",
            }}
          >
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: "var(--font-size-3xs)" }}>
                Current stage
              </div>
              <div style={{ marginTop: 6 }}>
                <Pill icon={meta.icon} bg={meta.bg} fg={meta.fg} bd={meta.bd}>
                  {meta.label}
                </Pill>
              </div>
            </div>
            <div>
              <div style={{ color: "var(--text-muted)", fontSize: "var(--font-size-3xs)" }}>
                Expiry
              </div>
              <div style={{ marginTop: 6, fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>
                {stage === "rejected" || stage === "revoked"
                  ? "Not valid"
                  : record.data?.expiresAt
                    ? new Date(record.data.expiresAt).toLocaleDateString()
                    : "Not yet valid"}
              </div>
            </div>
          </div>
          {renewal ? (
            <div
              style={{
                marginTop: 18,
                padding: "14px 18px",
                border: "1px solid var(--color-blue-20v)",
                borderLeft: "4px solid var(--theme-primary)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-blue-5v)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong>
                  {renewal.stage === "submitted"
                    ? "Renewal pending"
                    : renewal.stage === "questions"
                      ? "Renewal needs a response"
                      : "Renewal rejected"}
                </strong>
                {stage === "valid" && record.data?.expiresAt ? (
                  <span>
                    Current EIR remains valid until{" "}
                    {new Date(record.data.expiresAt).toLocaleDateString()}.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {questions ? (
            <div
              role="alert"
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                background: "var(--theme-warning-lighter)",
                border: "1px solid var(--theme-warning-light)",
                borderLeft: "4px solid var(--theme-warning)",
                borderRadius: "var(--radius-md)",
                padding: "14px 18px",
                marginTop: 18,
                fontSize: "var(--font-size-2xs)",
              }}
            >
              <Icon name="warning" size={18} color="var(--theme-warning-darker)" />
              <div>
                <strong>Safeguards questions:</strong> {questions}
              </div>
            </div>
          ) : null}
          {["questions", "rejected", "revoked"].includes(stage) && lastDecision ? (
            <div
              style={{
                marginTop: 18,
                padding: "14px 18px",
                borderLeft: "4px solid var(--theme-primary)",
                background: "var(--color-blue-5v)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              <strong>Decision: {statusMeta[stage].label}</strong>
              {lastDecision.selfDecisionTestMode ? (
                // The structured marker, never part of the validator's note.
                <span style={testModeTag}>Test mode</span>
              ) : null}
              <div>Validator note: {lastDecision.note ?? "No note provided"}</div>
              <div>Date: {new Date(lastDecision.at).toLocaleDateString()}</div>
              <div style={{ marginTop: 6 }}>
                <strong>
                  Next step:{" "}
                  {stage === "revoked"
                    ? "Start a new EIR."
                    : stage === "questions"
                      ? "Answer the questions below, then send your response."
                      : "Correct and resubmit."}
                </strong>
              </div>
            </div>
          ) : null}
          {stage === "expired" ? (
            <div
              style={{
                marginTop: 18,
                padding: "14px 18px",
                borderLeft: "4px solid var(--theme-primary)",
                background: "var(--color-blue-5v)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              <strong>
                Next step: Update the form below, download it, sign it, and upload it.
              </strong>
            </div>
          ) : null}
          {record.data?.draftValues && ["valid", "expired"].includes(stage) ? (
            <div
              role="note"
              style={{
                marginTop: 18,
                padding: "14px 18px",
                borderLeft: "4px solid var(--theme-primary)",
                background: "var(--color-blue-5v)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              <strong>Unsubmitted changes</strong> — your approved EIR is unchanged.
            </div>
          ) : null}
          {questions ? (
            <div style={{ marginTop: 18 }}>
              <label htmlFor="eir-response" style={label}>
                Your response <span style={{ color: "var(--theme-secondary)" }}>*</span>
              </label>
              {responseError ? (
                <p
                  ref={responseErrorRef}
                  id="eir-response-error"
                  role="alert"
                  style={{
                    margin: "0 0 6px",
                    color: "var(--theme-error-dark)",
                    fontSize: "var(--font-size-3xs)",
                    fontWeight: 700,
                  }}
                >
                  {responseError}
                </p>
              ) : null}
              <textarea
                ref={responseRef}
                id="eir-response"
                value={response}
                onChange={(event) => {
                  setResponse(event.target.value);
                  if (responseError && event.target.value.trim()) setResponseError("");
                  if (reviewError.includes("safeguards questions")) setReviewError("");
                }}
                required
                aria-required
                aria-invalid={responseError ? true : undefined}
                aria-describedby={
                  [
                    responseError ? "eir-response-error" : "",
                    !canSendResponse ? "eir-response-why" : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                style={{
                  ...input,
                  marginTop: 0,
                  minHeight: 96,
                  resize: "vertical",
                  ...(responseError ? { borderColor: "var(--theme-error)" } : {}),
                }}
              />
              {!selectedFile ? (
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                    marginTop: 12,
                  }}
                >
                  <PendingActionButton
                    type="button"
                    style={primaryButton}
                    disabled={!canSendResponse}
                    pending={pending.isActionPending(principalId, "send-response")}
                    locked={busy}
                    aria-describedby="eir-response-why"
                    onClick={() => void sendResponse()}
                  >
                    Send response
                  </PendingActionButton>
                  {!correcting && canSendResponse ? (
                    <button
                      type="button"
                      style={disabledPendingStyle(outlineButton, busy)}
                      disabled={busy}
                      onClick={() => {
                        setCorrecting(true);
                        setEditRequested((count) => count + 1);
                      }}
                    >
                      Correct my answers
                    </button>
                  ) : null}
                  <PendingActionStatus pending={pending.isRecordPending(principalId)} />
                </div>
              ) : null}
              <p
                id="eir-response-why"
                style={{
                  margin: "8px 0 0",
                  color: "var(--text-muted)",
                  fontSize: "var(--font-size-3xs)",
                }}
              >
                {!signedOnCurrentForm
                  ? `Your EIR was signed on an earlier form, so you need to sign a new PDF on the current form (EIR definition ${definitionLabel(form.version)}): correct your answers below, then download, sign and upload it. Your response is sent with it.`
                  : answersChanged
                    ? "You changed your answers, so you need to sign a new PDF. Download it below, sign it and upload it; your response is sent with it."
                    : correcting
                      ? "Send response sends your answers as you signed them. If you change them, download and sign a new PDF below instead."
                      : "Send response sends your answer with the answers and PDF you already signed."}
              </p>
            </div>
          ) : null}
          {legacyOnFile?.formValues ? (
            <div style={{ marginTop: 18 }}>
              <EirAnswers
                values={legacyOnFile.formValues}
                version={legacyOnFile.formVersion}
                Icon={Icon}
              />
              <p style={{ margin: 0, fontSize: "var(--font-size-2xs)" }}>
                Your next submission uses the form below ({eirFormName(form.version)}).
              </p>
            </div>
          ) : null}
          {record.data ? (
            <DocumentLinks record={record.data} labelPrefix="Open signed PDF" />
          ) : null}
          {message ? (
            <p
              ref={messageRef}
              tabIndex={-1}
              role="status"
              style={{
                margin: "14px 0 0",
                color: "var(--color-gray-cool-70)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              {message}
            </p>
          ) : null}
          {stage === "submitted" && slaTarget ? (
            <p style={{ margin: "14px 0 0", fontSize: "var(--font-size-2xs)" }}>
              {message ? "SLA target" : "With a safeguards validator. SLA target"} {slaTarget}.
            </p>
          ) : null}
        </Panel>

        {isSubmitted ? (
          submitted ? (
            <Panel>
              <SectionHead title="Submitted EIR form" />
              <p
                style={{
                  margin: "-4px 0 20px",
                  color: "var(--text-muted)",
                  fontSize: "var(--font-size-3xs)",
                }}
              >
                <span>Record ID</span>{" "}
                <strong style={{ color: "var(--text-default)" }}>
                  {record.data?.recordId ?? "not assigned"}
                </strong>
                <span aria-hidden="true"> · </span>
                <span>EIR definition</span>{" "}
                <strong style={{ color: "var(--text-default)" }}>
                  {definitionLabel(submitted.version)}
                </strong>
              </p>
              <EirAnswers
                values={submitted.values}
                version={submitted.version}
                Icon={Icon}
                layout="list"
              />
            </Panel>
          ) : null
        ) : formLocked ? (
          // Sent back, answers as signed: Send response needs no form; Correct my answers opens it.
          <Panel>
            <SectionHead eyebrow="Step 1" title="Complete the EIR form" />
            <p style={{ margin: 0, fontSize: "var(--font-size-2xs)" }}>
              Your answers are as you signed them. To change them, choose Correct my answers above.
            </p>
          </Panel>
        ) : selectedFile ? (
          // Under review the answers show once, in Review and submit below.
          <Panel>
            <SectionHead eyebrow="Step 1" title="Complete the EIR form" />
            <p style={{ margin: 0, fontSize: "var(--font-size-2xs)" }}>
              Your answers are shown in Review and submit below. Choose Edit form to change them.
            </p>
          </Panel>
        ) : (
          <form ref={formRef} onSubmit={generate} noValidate aria-label="EIR form">
            <Panel>
              <SectionHead eyebrow="Step 1" title="Complete the EIR form" />
              {evaluationStale ? (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    marginBottom: 16,
                    padding: "12px 16px",
                    border: "1px solid var(--theme-warning-light)",
                    borderLeft: "4px solid var(--theme-warning)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--theme-warning-lighter)",
                    color: "var(--color-gray-cool-80)",
                  }}
                >
                  <Icon name="warning" size={18} color="var(--theme-warning-darker)" />
                  <span>
                    The EIR pre-check is out of date because you edited the draft. Download PDF to
                    sign checks the current draft again; the older PDF cannot be uploaded.
                  </span>
                </div>
              ) : null}
              {evaluation && evaluation.outcome !== "pass" && !evaluationStale ? (
                <div
                  role={evaluation.outcome === "blocking" ? "alert" : "status"}
                  style={{ marginBottom: 16, color: "var(--color-gray-cool-80)" }}
                >
                  <strong>
                    {evaluation.outcome === "warning"
                      ? "Warnings do not prevent PDF generation."
                      : evaluation.outcome === "manual-review"
                        ? "This EIR will require manual handling."
                        : "Correct the highlighted fields."}
                  </strong>
                  {evaluation.outcomes.map((item) => (
                    <div key={item.ruleId}>{item.guidance}</div>
                  ))}
                </div>
              ) : null}
              <EirForm
                form={form}
                values={values}
                disabled={record.isLoading}
                onChange={(next) => {
                  setValues(next);
                  if (evaluation) setEvaluationStale(true);
                  if (formErrors.length) setFormErrors(validateAnswersOn(form, next));
                }}
                recordId={record.data?.recordId}
                errors={formErrors}
                attempt={failedAttempts}
                Icon={Icon}
              >
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <PendingActionButton
                    style={primaryButton}
                    type="submit"
                    pending={pending.isActionPending(principalId, "download-pdf")}
                    locked={busy}
                  >
                    <Icon name="description" size={16} color="#fff" />
                    Download PDF to sign
                  </PendingActionButton>
                  <PendingActionButton
                    type="button"
                    style={outlineButton}
                    pending={draftSaving}
                    locked={busy}
                    onClick={keepDraft}
                  >
                    Save draft
                  </PendingActionButton>
                  <button
                    type="button"
                    style={disabledPendingStyle(linkButton, busy)}
                    onClick={cancelRequest}
                    disabled={busy}
                  >
                    Cancel request
                  </button>
                  <PendingActionStatus pending={pending.isRecordPending(principalId)} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <SaveNotices prefixes={[eirRecord(principalId)]} label="Your draft" />
                </div>
              </EirForm>
            </Panel>
          </form>
        )}

        {stage !== "submitted" && renewal?.stage !== "submitted" && !selectedFile && !formLocked ? (
          <Panel>
            <SectionHead eyebrow="Step 2" title="Upload the signed PDF" />
            <p
              style={{
                margin: "-8px 0 16px",
                color: "var(--text-muted)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              Sign the downloaded document outside the app, then upload the PDF here.
            </p>
            <input
              aria-label="Signed EIR PDF"
              type="file"
              accept="application/pdf,.pdf"
              disabled={record.isLoading}
              onChange={(event) => chooseFile(event.target.files?.[0])}
              style={{ ...input, maxWidth: 620 }}
            />
          </Panel>
        ) : null}

        {selectedFile ? (
          <Panel>
            <SectionHead eyebrow="Step 2" title="Review and submit" />
            <p
              style={{
                margin: "-8px 0 18px",
                color: "var(--text-muted)",
                fontSize: "var(--font-size-2xs)",
              }}
            >
              Nothing is uploaded or submitted until you choose Submit for validation.
            </p>
            {pdfIsOutOfDate ? (
              <div
                role="alert"
                style={{
                  marginBottom: 18,
                  padding: "12px 14px",
                  border: "1px solid var(--theme-warning-light)",
                  borderLeft: "4px solid var(--theme-warning)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--theme-warning-lighter)",
                  color: "var(--color-gray-cool-80)",
                  fontSize: "var(--font-size-2xs)",
                }}
              >
                <Icon name="warning" size={16} color="var(--color-gray-cool-80)" /> The form has
                changed since you downloaded the PDF. Download and sign it again.
              </div>
            ) : null}
            <EirAnswers values={values} version={form.version} Icon={Icon} layout="list" />
            {questions ? (
              <div
                style={{
                  marginTop: 18,
                  padding: 16,
                  borderLeft: "4px solid var(--theme-warning)",
                  background: "var(--theme-warning-lighter)",
                  fontSize: "var(--font-size-2xs)",
                }}
              >
                <div>
                  <strong>Safeguards questions:</strong> {questions}
                </div>
                <div style={{ marginTop: 8 }}>
                  <strong>Your answer:</strong> {response || "No answer entered"}
                </div>
              </div>
            ) : null}
            <div
              style={{
                marginTop: 18,
                padding: 16,
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-gray-cool-1)",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: "var(--font-size-2xs)" }}>
                {selectedFile.name}
              </div>
              <div
                style={{
                  marginTop: 4,
                  color: "var(--text-muted)",
                  fontSize: "var(--font-size-3xs)",
                }}
              >
                {formatBytes(selectedFile.size)}
              </div>
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                style={{ ...link, display: "inline-block", marginTop: 8 }}
              >
                Open selected PDF
              </a>
            </div>
            {reviewError ? (
              <div
                ref={reviewErrorRef}
                tabIndex={-1}
                role="alert"
                style={{
                  marginTop: 16,
                  padding: "12px 14px",
                  border: "1px solid var(--theme-error-light)",
                  borderLeft: "4px solid var(--theme-error)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--theme-error-lighter)",
                  color: "var(--theme-error-dark)",
                  fontSize: "var(--font-size-2xs)",
                }}
              >
                <Icon name="error" size={16} color="var(--theme-error-dark)" /> {reviewError}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
              <PendingActionButton
                type="button"
                style={primaryButton}
                disabled={pdfIsOutOfDate}
                pending={pending.isActionPending(principalId, "submit-eir")}
                locked={busy}
                onClick={() => void confirmSubmission()}
              >
                Submit for validation
              </PendingActionButton>
              <PendingActionStatus pending={pending.isRecordPending(principalId)}>
                Saving your submission. When many people are saving at once this can take up to a
                minute; you don't need to click again.
              </PendingActionStatus>
              <button
                type="button"
                style={disabledPendingStyle(outlineButton, busy)}
                onClick={() => replaceFileRef.current?.click()}
                disabled={busy}
              >
                Replace file
              </button>
              <input
                ref={replaceFileRef}
                aria-label="Replacement signed EIR PDF"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => chooseFile(event.target.files?.[0])}
                style={{ display: "none" }}
              />
              <button
                type="button"
                style={disabledPendingStyle(outlineButton, busy)}
                disabled={busy}
                onClick={() => {
                  // Leave review: the form opens for editing, and the PDF is chosen again after.
                  clearSelectedFile();
                  setEditRequested((count) => count + 1);
                }}
              >
                Edit form
              </button>
              <button
                type="button"
                style={disabledPendingStyle(linkButton, busy)}
                disabled={busy}
                onClick={() => {
                  clearSelectedFile();
                  setMessage("Upload canceled. Your saved form values are unchanged.");
                }}
              >
                Cancel
              </button>
            </div>
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
