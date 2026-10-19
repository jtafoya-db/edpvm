import { newDisplayCode } from "../display-codes.ts";
import { computePeriodSlaStatus, computeStoredSlaStatus } from "../sla.ts";
import type { HolidayCalendar } from "../sla.ts";
import {
  EIR_FORM,
  EIR_FORM_UNAVAILABLE,
  EIR_REVIEW_SLA_BUSINESS_DAYS,
  EIR_VALIDITY_DAYS,
} from "./config.ts";
import { describeEirErrors, normalizeAnswersOn, validateAnswersOn } from "./form.ts";
import type { EirFormConfig } from "./config.ts";
import { OWN_EIR_REFUSAL, refuseForgedMarker } from "./self-decision.ts";
import type { EirDecision, EirFormValues, EirInboxItem, EirRecord } from "./types";
import type { EirEvaluation } from "./types";
import { ACTIVE_EIR_DEFINITION } from "./definition/active.ts";
import { builtInById } from "./definition/built-in.ts";
import type { EirDefinitions } from "./definition/repository.ts";
import type { EirDefinition } from "./definition/types.ts";
import { blockingGuidance, evaluateEirDraft, manualHandlingEvaluation } from "./evaluation.ts";
import { generateEirPdf } from "./pdf.ts";
import { definitionLabel } from "./definition/identity.ts";

export class EirDomainError extends Error {
  readonly status: 400 | 403 | 409 | 503;
  constructor(message: string, status: 400 | 403 | 409 | 503) {
    super(message);
    this.name = "EirDomainError";
    this.status = status;
  }
}

export type EirClock = () => Date;

/**
 * The refusal when the EIR definition can't be loaded (#200): nothing is
 * saved on guessed rules. Plain words for the person; the cause is logged
 * where it's read (`definition/bootstrap-source.ts`).
 */
export const EIR_UNAVAILABLE_MESSAGE =
  "The EIR form is temporarily unavailable. Nothing has been saved.";

/** A value the active EIR definition supplies, or the unavailable refusal. */
function fromDefinition<T>(value: T | undefined): T {
  if (value === undefined || EIR_FORM_UNAVAILABLE) {
    throw new EirDomainError(EIR_UNAVAILABLE_MESSAGE, 503);
  }
  return value;
}

/**
 * The forms employee commands use (#201), from the EIR definitions: the
 * active one, and the one a draft or submission began under. `undefined`
 * from {@link EirForms.active} means there's no current form (unavailable);
 * from {@link EirForms.byVersion}, that the version isn't a definition's
 * (an older form, whose answers open in the active form); `null`, that it
 * is one but can't be loaded right now (unavailable, never guessed).
 */
export interface EirForms {
  active(): EirFormConfig | undefined;
  byVersion(version: string): EirFormConfig | null | undefined;
}

/** The built-in definitions' forms, when nothing has been published. */
export const BOOTSTRAP_EIR_FORMS: EirForms = {
  active: () => (EIR_FORM_UNAVAILABLE ? undefined : EIR_FORM),
  byVersion: (id) => builtInById(id)?.form,
};

/**
 * The form an employee's next save or submission uses: the one their draft
 * began under, else the active definition's. A draft keeps its version when
 * another is activated; a new draft starts on the active one.
 */
export function formForNextSave(
  record: Pick<EirRecord, "draftFormVersion">,
  forms: EirForms,
): EirFormConfig {
  const own = record.draftFormVersion ? forms.byVersion(record.draftFormVersion) : undefined;
  if (own === null) throw new EirDomainError(EIR_UNAVAILABLE_MESSAGE, 503);
  return own ?? fromDefinition(forms.active());
}

/**
 * What EIR employee commands need of the store's typed definitions (#201,
 * `EirDefinitions`): the active one, and the one a draft was pinned to (its
 * persisted identity, #224), which is what that draft is evaluated against.
 */
export type EirDefinitionLookup = Pick<EirDefinitions, "active" | "byId">;

/**
 * The built-in definitions alone, when nothing has been published: the
 * fallback (`bootstrap-2`, #217) is active, and a draft pinned to another
 * built-in (`bootstrap`, or its old label 1.3) keeps that one's rules.
 */
export const BOOTSTRAP_EIR_DEFINITIONS: EirDefinitionLookup = {
  active: () => (ACTIVE_EIR_DEFINITION.ok ? ACTIVE_EIR_DEFINITION.definition : undefined),
  byId: (id) => builtInById(id),
};

/** {@link EirForms} from the definitions: a definition's form is the form. */
export const formsOfDefinitions = (definitions: EirDefinitionLookup): EirForms => ({
  active: () => definitions.active()?.form,
  byVersion: (id) => {
    const definition = definitions.byId(id);
    return definition === null ? null : definition?.form;
  },
});

/**
 * The definition a saved draft is evaluated against: the one it was pinned
 * to when it began, by identity, not whichever is active now (#201, #203,
 * #224). A draft with none is on the active definition. `definition` is
 * undefined when no definition has that identity, or it can't be loaded
 * right now: the caller records manual handling, never a guess.
 */
export function definitionForDraft(
  record: Pick<EirRecord, "draftFormVersion">,
  definitions: EirDefinitionLookup,
): { formVersion: string; definition: EirDefinition | undefined } {
  const formVersion =
    record.draftFormVersion ?? definitions.active()?.form.version ?? EIR_FORM.version;
  return { formVersion, definition: definitions.byId(formVersion) ?? undefined };
}

/** Refused when the screen showed another form than the one the save will use. */
export const FORM_CHANGED_REFUSAL =
  "The EIR form changed since you opened it. Reload to see the current form; your saved answers are kept.";

export interface EirFileSubmission {
  principalId: string;
  personName: string;
  file: File;
  values: EirFormValues;
  /** The form version the screen showed; refused if the server would use another. */
  formVersion?: string;
  response?: string;
  /** The EIR version the person saw (`EirRecord.version`); Delta refuses a stale one. */
  expectedVersion?: number;
}

export interface EirSubmissionFileStorage {
  write(path: string, bytes: Uint8Array, options: { overwrite: boolean }): Promise<void>;
}

/**
 * What the EIR screens use. The kind of submission (first, resubmission or
 * renewal) follows from the EIR's stage, never from the caller.
 */
export interface EirRepository {
  get(principalId: string): Promise<EirRecord>;
  /**
   * Start the person's EIR: it gets its Record ID (`EIR-7K3QFD`), which the
   * generated PDF carries. Refused once it has one.
   */
  start(principalId: string, personName: string): Promise<EirRecord>;
  listValidatorInbox(): Promise<EirInboxItem[]>;
  /** Unsigned work in progress; never changes a submitted record. */
  saveDraft(
    principalId: string,
    values: EirFormValues,
    expectedDraftVersion?: number,
    /** The form version the screen showed; refused if the server would use another. */
    formVersion?: string,
  ): Promise<EirRecord>;
  evaluateDraft(principalId: string): Promise<EirEvaluation>;
  generatePdf(principalId: string): Promise<Uint8Array>;
  submitWithFile(input: EirFileSubmission): Promise<EirRecord>;
  /**
   * Send response: answer safeguards questions on the EIR (or its renewal)
   * with the same answers and the PDF already signed for them, without a new
   * PDF. Refused unless `values` equal the sent-back submission's answers:
   * changed answers need a new signed PDF (`submitWithFile`, with the response).
   */
  respond(input: EirResponseInput): Promise<EirRecord>;
  decide(
    principalId: string,
    decision: EirDecision,
    actorScimId: string,
    note?: string,
    actorName?: string,
    expectedVersion?: number,
  ): Promise<EirRecord>;
}

export interface EirResponseInput {
  principalId: string;
  personName?: string;
  /** The answers on screen: they must be the signed submission's. */
  values: EirFormValues;
  response: string;
  /** The EIR version the screen read (`EirRecord.version`). */
  expectedVersion?: number;
}

export const CHANGED_ANSWERS_REFUSAL = "You changed your answers, so you need to sign a new PDF.";

/**
 * When an EIR (or its renewal) last went to a validator: its latest
 * submission, resubmission, renewal or response. The SLA counts from it.
 */
export function eirWaitingSince(record: EirRecord): string {
  const onRenewal = record.renewal?.stage === "submitted";
  const sent = [...record.actions]
    .reverse()
    .find((action) =>
      onRenewal
        ? action.subject === "renewal" && action.kind === "renewed"
        : action.subject !== "renewal" &&
          (action.kind === "submitted" || action.kind === "renewed"),
    );
  return (
    sent?.at ?? (onRenewal ? record.renewal!.submittedAt : record.submissions.at(-1)!.submittedAt)
  );
}

export interface MemoryEirRepository extends EirRepository {
  /** A first submission, starting again after a rejection or revocation, or a resubmission. */
  submit(
    principalId: string,
    personName: string,
    volumePath: string,
    values: EirFormValues,
    response?: string,
    metadata?: { sha256: string; sizeBytes: number },
  ): Promise<EirRecord>;
  /**
   * A renewal of a valid or expired EIR. On a rejected or revoked EIR it's a
   * plain submission (decision 2026-10-05): the person starts again.
   */
  renew(
    principalId: string,
    actorScimId: string,
    volumePath: string,
    response?: string,
    metadata?: { sha256: string; sizeBytes: number },
    actorName?: string,
    values?: EirFormValues,
  ): Promise<EirRecord>;
}

/** Who closes a renewal when the EIR it renews is revoked (docs/data-model.md, `eir_actions`). */
export const EIR_SYSTEM_ACTOR = {
  actorScimId: "system",
  actorName: "EDP Vending Machine",
} as const;

/** True when submitting now renews the EIR rather than submitting it. */
export function isRenewalStage(record: Pick<EirRecord, "stage">): boolean {
  return record.stage === "valid" || record.stage === "expired";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

const clone = <T>(value: T): T => structuredClone(value);

export function createMemoryEirRepository(
  options: {
    clock?: EirClock;
    validityDays?: number;
    reviewSlaBusinessDays?: number;
    dueSoonThresholdBusinessDays?: number;
    holidays?: HolidayCalendar;
    initialRecords?: EirRecord[];
    fileStorage?: EirSubmissionFileStorage;
    filePath?: (principalId: string) => string;
    /** Draws a new record's Record ID; a random display code (`EIR-7K3QFD`) by default. */
    newRecordId?: () => string;
    /**
     * A PR preview's test mode: a validator may decide their own EIR. Off by
     * default, as in production. Only the server passes it, from its own two
     * guards (`src/server/eir-test-mode.ts`); never from a session or profile.
     */
    selfDecisionTestMode?: boolean;
    /**
     * The typed EIR definitions (#201): what saves use (their forms) and what
     * a draft is evaluated against (the one its form version names). The
     * bootstrap definition's when unset.
     */
    definitions?: EirDefinitionLookup;
    evaluator?: typeof evaluateEirDraft;
    persistEvaluation?: (evaluation: EirEvaluation) => void;
  } = {},
): MemoryEirRepository {
  const clock = options.clock ?? (() => new Date());
  const validityDays = () => options.validityDays ?? fromDefinition(EIR_VALIDITY_DAYS);
  const reviewDays = () =>
    options.reviewSlaBusinessDays ?? fromDefinition(EIR_REVIEW_SLA_BUSINESS_DAYS);
  const definitions = options.definitions ?? BOOTSTRAP_EIR_DEFINITIONS;
  const forms = formsOfDefinitions(definitions);
  /** Employee commands need the current form: refused, never guessed, without it. */
  const requireForm = () => fromDefinition(forms.active());
  /** The form `prior`'s next save uses, refused if the screen showed another. */
  const formFor = (prior: EirRecord, shown?: string) => {
    const form = formForNextSave(prior, forms);
    if (shown !== undefined && shown !== form.version) {
      throw new EirDomainError(FORM_CHANGED_REFUSAL, 400);
    }
    return form;
  };
  const answerIds = (form: EirFormConfig) => [
    ...form.sections.flatMap((section) => section.fields.map((field) => field.id)),
    form.declaration.attestation.id,
  ];
  const dueSoonThreshold = options.dueSoonThresholdBusinessDays;
  const holidays = options.holidays ?? [];
  const records = new Map(
    (options.initialRecords ?? []).map((record) => [record.principalId, clone(record)]),
  );
  const evaluations = new Map<string, EirEvaluation>();
  const empty = (principalId: string): EirRecord => ({
    principalId,
    personName: "",
    stage: "not-started",
    submissions: [],
    actions: [],
  });
  const current = (principalId: string) => records.get(principalId) ?? empty(principalId);
  const newRecordId = options.newRecordId ?? (() => newDisplayCode("EIR"));
  /** A Record ID for a record that doesn't have one yet. */
  const recordIdFor = (record: EirRecord) => record.recordId ?? newRecordId();
  /**
   * Current-form answers as submitted: refused unless they're complete and
   * well-formed (compliance answers never refuse: the validator sees flags),
   * then stored trimmed, with the form version and when the form was started.
   */
  const signedAnswers = (prior: EirRecord, values: EirFormValues, at: string) => {
    const form = formFor(prior, shownFormVersion);
    const errors = validateAnswersOn(form, values);
    if (errors.length) throw new EirDomainError(describeEirErrors(errors), 400);
    return {
      formValues: normalizeAnswersOn(form, values),
      formVersion: form.version,
      formStartedAt: prior.draftValues && prior.draftStartedAt ? prior.draftStartedAt : at,
    };
  };
  const withExpiry = (record: EirRecord): EirRecord => {
    if (
      record.stage === "valid" &&
      record.expiresAt &&
      clock().getTime() >= Date.parse(record.expiresAt)
    ) {
      record.stage = "expired";
    }
    return record;
  };
  const withReviewSla = (record: EirRecord): EirRecord => {
    const currentRecord = withExpiry(record);
    if (currentRecord.stage !== "submitted" && currentRecord.renewal?.stage !== "submitted") {
      const { sla: _sla, ...withoutSla } = currentRecord;
      return withoutSla;
    }
    if (currentRecord.sla?.dueAt) {
      return {
        ...currentRecord,
        sla: computeStoredSlaStatus(
          "eir-validation",
          eirWaitingSince(currentRecord),
          clock(),
          currentRecord.sla.dueAt,
          undefined,
          { holidays },
        ),
      };
    }
    return {
      ...currentRecord,
      sla: computePeriodSlaStatus(
        "eir-validation",
        eirWaitingSince(currentRecord),
        clock(),
        reviewDays(),
        {
          ...(dueSoonThreshold !== undefined ? { dueSoonThreshold } : {}),
          holidays,
        },
      ),
    };
  };
  // submitWithFile works out the new record first, writes the PDF, and only
  // then saves the record, so a failed file write leaves no submission behind.
  let staged: EirRecord[] | null = null;
  /** The form version the screen showed, while `submitWithFile` stages a submission. */
  let shownFormVersion: string | undefined;
  const store = (record: EirRecord) => {
    const saved = withReviewSla(clone(record));
    if (staged) staged.push(clone(saved));
    else records.set(saved.principalId, clone(saved));
    return clone(saved);
  };

  const repository: MemoryEirRepository = {
    get: async (principalId) => {
      const record = clone(withReviewSla(clone(current(principalId))));
      const evaluation = evaluations.get(principalId);
      return evaluation && record.draftValues
        ? { ...record, evaluation: clone(evaluation) }
        : record;
    },
    listValidatorInbox: async () =>
      [...records.values()]
        .map((record) => withExpiry(clone(record)))
        .filter(
          (record) =>
            record.stage === "submitted" ||
            record.stage === "valid" ||
            record.renewal?.stage === "submitted",
        )
        .map((record) => {
          const submittedAt = eirWaitingSince(record);
          // Unsigned drafts are the person's own work in progress, not for review.
          const {
            draftValues: _draftValues,
            draftFormVersion: _draftFormVersion,
            draftStartedAt: _draftStartedAt,
            draftVersion: _draftVersion,
            ...reviewed
          } = clone(record);
          if (reviewed.sla?.dueAt) {
            return {
              ...reviewed,
              sla: computeStoredSlaStatus(
                "eir-validation",
                submittedAt,
                clock(),
                reviewed.sla.dueAt,
                undefined,
                { holidays },
              ),
            };
          }
          return {
            ...reviewed,
            sla: computePeriodSlaStatus("eir-validation", submittedAt, clock(), reviewDays(), {
              ...(dueSoonThreshold !== undefined ? { dueSoonThreshold } : {}),
              holidays,
            }),
          };
        }),
    start: async (principalId, personName) => {
      requireForm();
      const prior = clone(current(principalId));
      if (prior.recordId) throw new EirDomainError("This EIR has already been started.", 409);
      return store({
        ...prior,
        principalId,
        personName,
        recordId: recordIdFor(prior),
        actions: [
          ...prior.actions,
          {
            kind: "started",
            actorScimId: principalId,
            actorName: personName,
            at: clock().toISOString(),
          },
        ],
      });
    },
    saveDraft: async (principalId, values, _expectedDraftVersion, formVersion) => {
      const storedPrior = clone(current(principalId));
      const form = formFor(storedPrior, formVersion);
      const ids = answerIds(form);
      const unknown = Object.keys(values).find((key) => !ids.includes(key));
      if (unknown) {
        throw new EirDomainError(
          `${unknown} isn't on the EIR form for ${definitionLabel(form.version)}.`,
          400,
        );
      }
      const prior = withExpiry(clone(storedPrior));
      if (prior.stage === "submitted" || prior.renewal?.stage === "submitted") {
        throw new EirDomainError(
          "A draft can't be saved while the EIR waits for a safeguards validator.",
          409,
        );
      }
      const draftVersion = (storedPrior.draftVersion ?? 0) + 1;
      const draft = {
        draftValues: clone(values),
        draftFormVersion: form.version,
        draftVersion,
        // A draft starts on its first save since the last submission used one.
        draftStartedAt:
          storedPrior.draftValues && storedPrior.draftStartedAt
            ? storedPrior.draftStartedAt
            : clock().toISOString(),
      };
      store({ ...storedPrior, ...draft });
      return clone(withExpiry({ ...storedPrior, ...draft }));
    },
    evaluateDraft: async (principalId) => {
      const prior = clone(current(principalId));
      if (!prior.draftValues || !prior.draftStartedAt || !prior.draftVersion) {
        throw new EirDomainError("Save the EIR draft before evaluating it.", 409);
      }
      const effectiveAt = clock().toISOString();
      const { formVersion, definition } = definitionForDraft(prior, definitions);
      let evaluation: EirEvaluation;
      try {
        if (!definition) throw new Error("draft definition unavailable");
        evaluation = (options.evaluator ?? evaluateEirDraft)({
          definition,
          values: prior.draftValues,
          draftVersion: prior.draftVersion,
          draftStartedAt: prior.draftStartedAt,
          effectiveAt,
        });
      } catch {
        evaluation = manualHandlingEvaluation({
          draftVersion: prior.draftVersion,
          effectiveAt,
          formVersion,
          ...(definition ? { definitionVersion: definition.form.version } : {}),
        });
      }
      try {
        options.persistEvaluation?.(evaluation);
        evaluations.set(principalId, clone(evaluation));
      } catch {
        throw Object.assign(
          new EirDomainError(
            "Your draft was saved, but the pre-check couldn't be confirmed. Try again; retrying is safe.",
            503,
          ),
          { draftWasSaved: true },
        );
      }
      return clone(evaluation);
    },
    generatePdf: async (principalId) => {
      const prior = clone(current(principalId));
      const evaluation = evaluations.get(principalId);
      if (!prior.draftValues || !prior.draftVersion || !evaluation) {
        throw new EirDomainError("Evaluate the saved draft before generating its PDF.", 409);
      }
      if (evaluation.evaluatedDraftVersion !== prior.draftVersion) {
        throw new EirDomainError("The draft changed after evaluation. Evaluate it again.", 409);
      }
      if (evaluation.outcome === "blocking") {
        const guidance = blockingGuidance(evaluation.outcomes);
        throw new EirDomainError(`Correct the blocking EIR fields first. ${guidance}`, 409);
      }
      // The form the draft was evaluated on, never guessed (#201).
      const form = forms.byVersion(evaluation.formVersion);
      if (!form) throw new EirDomainError(EIR_UNAVAILABLE_MESSAGE, 503);
      return generateEirPdf(prior.draftValues, { recordId: prior.recordId ?? principalId, form });
    },
    submitWithFile: async (input: EirFileSubmission): Promise<EirRecord> => {
      requireForm();
      const currentDraft = clone(current(input.principalId));
      const evaluation = evaluations.get(input.principalId);
      if (
        !evaluation ||
        !currentDraft.draftVersion ||
        evaluation.evaluatedDraftVersion !== currentDraft.draftVersion
      ) {
        throw new EirDomainError("Evaluate the current saved draft before uploading its PDF.", 409);
      }
      if (evaluation.outcome === "blocking") {
        throw new EirDomainError(
          `Correct the blocking EIR fields before uploading its PDF. ${blockingGuidance(evaluation.outcomes)}`,
          409,
        );
      }
      const evaluatedIds = answerIds(formFor(currentDraft));
      if (
        !currentDraft.draftValues ||
        evaluatedIds.some(
          (field) => (currentDraft.draftValues?.[field] ?? "") !== (input.values[field] ?? ""),
        )
      ) {
        throw new EirDomainError("The uploaded PDF must use the evaluated draft answers.", 409);
      }
      const path =
        options.filePath?.(input.principalId) ??
        `/Volumes/local/memory/eir/${input.principalId}/${Date.now()}-${globalThis.crypto.randomUUID()}.pdf`;
      const bytes = new Uint8Array(await input.file.arrayBuffer());
      const metadata = { sha256: await sha256(bytes), sizeBytes: bytes.length };
      const renewing = isRenewalStage(withExpiry(clone(current(input.principalId))));
      // Work out the new record without saving it (submit and renew don't
      // await, so nothing else runs while it's staged), write the file, then save.
      staged = [];
      shownFormVersion = input.formVersion;
      const pending = renewing
        ? repository.renew(
            input.principalId,
            input.principalId,
            path,
            input.response,
            metadata,
            input.personName,
            input.values,
          )
        : repository.submit(
            input.principalId,
            input.personName,
            path,
            input.values,
            input.response,
            metadata,
          );
      const toSave = staged;
      staged = null;
      shownFormVersion = undefined;
      const record = await pending;
      await options.fileStorage?.write(path, bytes, { overwrite: false });
      for (const saved of toSave) records.set(saved.principalId, saved);
      return record;
    },
    submit: async (principalId, personName, volumePath, values, response, metadata) => {
      refuseForgedMarker(response, (message) => new EirDomainError(message, 400));
      if (!volumePath.toLowerCase().endsWith(".pdf"))
        throw new EirDomainError("Only PDF files are accepted.", 400);
      const at = clock().toISOString();
      const prior = current(principalId);
      if (prior.submissions.some((submission) => submission.volumePath === volumePath)) {
        throw new EirDomainError("This signed PDF has already been submitted.", 409);
      }
      // Starting again after a rejection or revocation is a submission, not a
      // renewal (decision 2026-10-05). A valid or expired EIR is renewed.
      if (!["not-started", "questions", "rejected", "revoked"].includes(prior.stage)) {
        throw new EirDomainError(
          "Only a new, returned, rejected or revoked EIR can be submitted. Renew a valid or expired EIR instead.",
          409,
        );
      }
      const answer = response?.trim();
      if (prior.stage === "questions" && !answer) {
        throw new EirDomainError("An answer is required after safeguards questions.", 400);
      }
      const signed = signedAnswers(prior, values, at);
      const {
        questions: _questions,
        expiresAt: _expiresAt,
        response: _response,
        draftValues: _draftValues,
        draftFormVersion: _draftFormVersion,
        draftStartedAt: _draftStartedAt,
        renewal: _renewal,
        ...base
      } = prior;
      return store({
        ...base,
        principalId,
        personName,
        // A first submission with no start before it starts the record too.
        recordId: recordIdFor(prior),
        stage: "submitted",
        ...clone(signed),
        formSubmittedAt: at,
        ...(answer ? { response: answer } : {}),
        submissions: [
          ...prior.submissions,
          {
            volumePath,
            submittedAt: at,
            ...(metadata ? { sha256: metadata.sha256, sizeBytes: metadata.sizeBytes } : {}),
            ...clone(signed),
            kind: prior.stage === "questions" ? "resubmission" : "first",
          },
        ],
        actions: [
          ...prior.actions,
          {
            kind: "submitted",
            actorScimId: principalId,
            actorName: personName,
            at,
            ...(answer ? { response: answer } : {}),
          },
        ],
      });
    },
    respond: async ({ principalId, personName, values, response }) => {
      requireForm();
      refuseForgedMarker(response, (message) => new EirDomainError(message, 400));
      const storedPrior = clone(current(principalId));
      const prior = withExpiry(clone(storedPrior));
      const onRenewal = prior.renewal?.stage === "questions";
      if (!onRenewal && prior.stage !== "questions") {
        throw new EirDomainError("There are no safeguards questions to respond to.", 409);
      }
      const answer = response?.trim();
      if (!answer) {
        throw new EirDomainError(
          onRenewal
            ? "An answer is required after renewal questions."
            : "An answer is required after safeguards questions.",
          400,
        );
      }
      const signed = onRenewal ? prior.renewal : prior;
      // It stands on the definition it was signed under, active or not (#201).
      const signedForm = signed?.formVersion ? forms.byVersion(signed.formVersion) : undefined;
      if (signedForm === null) throw new EirDomainError(EIR_UNAVAILABLE_MESSAGE, 503);
      if (!signed?.formValues || !signedForm) {
        const active = fromDefinition(forms.active());
        throw new EirDomainError(
          `This EIR was signed on another form: correct your answers on the current form (EIR definition ${definitionLabel(active.version)}) and sign a new PDF.`,
          409,
        );
      }
      // The answers on screen must be the ones the PDF was signed with.
      const ids = answerIds(signedForm);
      const onScreen = normalizeAnswersOn(signedForm, values);
      const asSigned = normalizeAnswersOn(signedForm, signed.formValues);
      const unknown = Object.keys(values).find((key) => !ids.includes(key));
      if (unknown) {
        throw new EirDomainError(
          `${unknown} isn't on the EIR form for ${definitionLabel(signedForm.version)}.`,
          400,
        );
      }
      if (ids.some((id) => onScreen[id] !== asSigned[id])) {
        throw new EirDomainError(CHANGED_ANSWERS_REFUSAL, 409);
      }
      const at = clock().toISOString();
      const action = {
        kind: onRenewal ? ("renewed" as const) : ("submitted" as const),
        actorScimId: principalId,
        ...(personName ? { actorName: personName } : {}),
        at,
        ...(onRenewal ? { subject: "renewal" as const } : {}),
        response: answer,
      };
      const {
        draftValues: _draftValues,
        draftFormVersion: _draftFormVersion,
        draftStartedAt: _draftStartedAt,
        ...withoutDraft
      } = storedPrior;
      if (onRenewal) {
        const { questions: _questions, ...renewal } = storedPrior.renewal!;
        return clone(
          withExpiry(
            store({
              ...withoutDraft,
              renewal: { ...renewal, stage: "submitted", response: answer },
              actions: [...storedPrior.actions, action],
            }),
          ),
        );
      }
      const { questions: _questions, ...base } = withoutDraft;
      return store({
        ...base,
        stage: "submitted",
        response: answer,
        actions: [...storedPrior.actions, action],
      });
    },
    decide: async (principalId, decision, actorScimId, note, actorName) => {
      const storedPrior = clone(current(principalId));
      const prior = withExpiry(clone(storedPrior));
      const detail = note?.trim();
      const pendingRenewal = prior.renewal?.stage === "submitted";
      const renewalClosedByRevocation =
        Boolean(prior.renewal) && prior.renewal?.stage !== "rejected";
      if (pendingRenewal && decision !== "revoked") {
        if (prior.stage !== "valid" && prior.stage !== "expired") {
          throw new EirDomainError("A renewal cannot be reviewed for this EIR stage.", 409);
        }
        if ((decision === "questions" || decision === "rejected") && !detail) {
          throw new EirDomainError("A validator note is required for this decision.", 400);
        }
        const at = clock().toISOString();
        if (decision === "valid") {
          // The renewal becomes the EIR, with its own answer (if it had one).
          const { renewal: _renewal, response: _response, ...base } = storedPrior;
          return store({
            ...base,
            stage: "valid",
            ...(prior.renewal?.formValues ? { formValues: clone(prior.renewal.formValues) } : {}),
            ...(prior.renewal?.formVersion ? { formVersion: prior.renewal.formVersion } : {}),
            ...(prior.renewal?.formStartedAt ? { formStartedAt: prior.renewal.formStartedAt } : {}),
            ...(prior.renewal ? { formSubmittedAt: prior.renewal.submittedAt } : {}),
            ...(prior.renewal?.response ? { response: prior.renewal.response } : {}),
            expiresAt: new Date(clock().getTime() + validityDays() * 86_400_000).toISOString(),
            actions: [
              ...prior.actions,
              {
                kind: "valid",
                actorScimId,
                ...(actorName ? { actorName } : {}),
                at,
                subject: "renewal",
              },
            ],
          });
        }
        const stored = store({
          ...storedPrior,
          renewal: {
            ...prior.renewal!,
            stage: decision,
            ...(decision === "questions" && detail ? { questions: detail } : {}),
            ...(decision === "rejected" && detail ? { note: detail } : {}),
          },
          actions: [
            ...prior.actions,
            {
              kind: decision,
              actorScimId,
              ...(actorName ? { actorName } : {}),
              at,
              subject: "renewal",
              ...(detail ? { note: detail } : {}),
            },
          ],
        });
        return clone(withExpiry(stored));
      }
      if (
        (decision === "valid" || decision === "questions" || decision === "rejected") &&
        prior.stage !== "submitted"
      )
        throw new EirDomainError("Only submitted EIRs can be reviewed.", 409);
      if (decision === "revoked" && prior.stage !== "valid")
        throw new EirDomainError("Only valid EIRs can be revoked.", 409);
      if ((decision === "questions" || decision === "rejected") && !detail) {
        throw new EirDomainError("A validator note is required for this decision.", 400);
      }
      const at = clock().toISOString();
      const { questions: _questions, expiresAt: _expiresAt, renewal: _renewal, ...base } = prior;
      const expiresAt =
        decision === "valid"
          ? new Date(clock().getTime() + validityDays() * 86_400_000).toISOString()
          : decision === "revoked"
            ? undefined
            : prior.expiresAt;
      return store({
        ...base,
        stage: decision,
        ...(decision === "questions" && detail
          ? { questions: detail }
          : prior.questions
            ? { questions: prior.questions }
            : {}),
        ...(expiresAt ? { expiresAt } : {}),
        actions: [
          ...prior.actions,
          ...(decision === "revoked" && renewalClosedByRevocation
            ? [
                {
                  kind: "renewal-closed" as const,
                  // The app closes it, as a consequence of the validator's revocation.
                  ...EIR_SYSTEM_ACTOR,
                  at,
                  subject: "renewal" as const,
                  note: "Closed because the current EIR was revoked.",
                },
              ]
            : []),
          {
            kind: decision,
            actorScimId,
            ...(actorName ? { actorName } : {}),
            at,
            ...(detail ? { note: detail } : {}),
          },
        ],
      });
    },
    renew: async (principalId, actorScimId, volumePath, response, metadata, actorName, values) => {
      refuseForgedMarker(response, (message) => new EirDomainError(message, 400));
      const storedPrior = clone(current(principalId));
      const prior = withExpiry(clone(storedPrior));
      const signed = values ?? prior.draftValues ?? prior.formValues;
      if (prior.stage === "rejected" || prior.stage === "revoked") {
        // Starting again is a submission, not a renewal (decision 2026-10-05).
        if (!signed) throw new EirDomainError("The EIR form must be completed first.", 409);
        return repository.submit(
          principalId,
          actorName ?? prior.personName,
          volumePath,
          signed,
          response,
          metadata,
        );
      }
      if (!signed) throw new EirDomainError("The EIR form must be completed before renewal.", 409);
      if (!isRenewalStage(prior)) {
        throw new EirDomainError("Only a valid or expired EIR can be renewed.", 409);
      }
      if (prior.submissions.some((submission) => submission.volumePath === volumePath)) {
        throw new EirDomainError("Renewal requires a newly uploaded signed PDF.", 409);
      }
      const at = clock().toISOString();
      if (prior.renewal?.stage === "submitted") {
        throw new EirDomainError("This EIR already has a pending renewal.", 409);
      }
      const answers = (check: () => void = () => undefined) => {
        check();
        return signedAnswers(prior, signed, at);
      };
      if (prior.stage === "valid" || prior.renewal?.stage === "questions") {
        const answer = response?.trim();
        const renewed = answers(() => {
          if (prior.renewal?.stage === "questions" && !answer) {
            throw new EirDomainError("An answer is required after renewal questions.", 400);
          }
        });
        const {
          draftValues: _draftValues,
          draftFormVersion: _draftFormVersion,
          draftStartedAt: _draftStartedAt,
          ...base
        } = storedPrior;
        const stored = store({
          ...base,
          renewal: {
            stage: "submitted",
            volumePath,
            submittedAt: at,
            ...clone(renewed),
            ...(answer ? { response: answer } : {}),
          },
          submissions: [
            ...prior.submissions,
            {
              volumePath,
              submittedAt: at,
              ...(metadata ? { sha256: metadata.sha256, sizeBytes: metadata.sizeBytes } : {}),
              ...clone(renewed),
              kind: "renewal",
            },
          ],
          actions: [
            ...prior.actions,
            {
              kind: "renewed",
              actorScimId,
              ...(actorName ? { actorName } : {}),
              at,
              subject: "renewal",
              ...(answer ? { response: answer } : {}),
            },
          ],
        });
        return clone(withExpiry(stored));
      }
      // An expired EIR with nothing running alongside: the renewal is now what
      // the EIR waits on, so it carries no earlier answer.
      const renewed = answers();
      const {
        expiresAt: _expiresAt,
        renewal: _renewal,
        draftValues: _draftValues,
        draftFormVersion: _draftFormVersion,
        draftStartedAt: _draftStartedAt,
        response: _response,
        ...base
      } = prior;
      return store({
        ...base,
        stage: "submitted",
        ...clone(renewed),
        formSubmittedAt: at,
        submissions: [
          ...prior.submissions,
          {
            volumePath,
            submittedAt: at,
            ...(metadata ? { sha256: metadata.sha256, sizeBytes: metadata.sizeBytes } : {}),
            ...clone(renewed),
            kind: "renewal",
          },
        ],
        actions: [
          ...prior.actions,
          { kind: "renewed", actorScimId, ...(actorName ? { actorName } : {}), at },
        ],
      });
    },
  };
  // Self-decisions (`self-decision.ts`): refused unless built with test mode,
  // and marked here, by the rules, with the structured flag when allowed. No
  // typed note or response can look like the marker. These checks wrap every
  // decision, the renewal ones included.
  const decideByRules = repository.decide;
  repository.decide = async (principalId, decision, actorScimId, note, actorName, expected) => {
    const own = principalId === actorScimId;
    if (own && !options.selfDecisionTestMode) throw new EirDomainError(OWN_EIR_REFUSAL, 403);
    refuseForgedMarker(note, (message) => new EirDomainError(message, 400));
    const before = current(principalId).actions.length;
    const decided = await decideByRules(
      principalId,
      decision,
      actorScimId,
      note,
      actorName,
      expected,
    );
    // A decision answers the validator: the person's draft stays theirs (stored, not returned).
    if (!own) {
      const {
        draftValues: _draftValues,
        draftFormVersion: _draftFormVersion,
        draftStartedAt: _draftStartedAt,
        draftVersion: _draftVersion,
        ...reviewed
      } = decided;
      return reviewed;
    }
    return store({
      ...decided,
      actions: decided.actions.map((action, index) =>
        index >= before && action.actorScimId === actorScimId
          ? // Marked by the flag alone; the note stays as the validator wrote it.
            { ...action, selfDecisionTestMode: true as const }
          : action,
      ),
    });
  };
  return repository;
}
