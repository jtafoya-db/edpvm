import { newDisplayCode } from "../display-codes";
/**
 * The onboarding repository on the DataStore seam (#86), and its in-memory
 * implementation.
 *
 * Calls take no actor: the adapter resolves the signed-in user from the
 * server-resolved session (`/api/session`) on every call, and authorizes
 * against that user's SCIM id and reviewer-group membership. A caller cannot
 * pass or override either. Every call, reads included, resolves the session
 * first, so a missing identity fails closed. (While this repository runs in
 * the browser, the enforcement is client-side; it moves server-side with a
 * future onboarding-persistence slice. Onboarding requests are in memory on
 * purpose: #72's Delta request tables don't fit them.)
 *
 * Every write goes through the pure lifecycle (./lifecycle.ts), so invalid
 * transitions are refused here whatever the caller. Reads attach the current
 * stage's SLA state, computed from the clock at read time. Reads return
 * clones; nothing persists across reloads (that future slice's job).
 */
import { findDatasetTagProblem, loadSchema, validateStep, type IntakeState } from "../../schema";
import {
  ONBOARDING_SEND_BACK_STAGE,
  REVIEWER_FOR_STAGE,
  REVIEWER_LABEL,
  STAGE_FOR_REVIEWER,
  isOnboardingTerminal,
  isReviewStage,
  nextOnboardingStage,
  onboardingSla,
  resubmissionStage,
} from "./lifecycle";
import {
  findDatasetOptionIdProblem,
  findResubmittedIdProblem,
  findSubmittedIdProblem,
  normalizeIntake,
  resubmissionChanges,
  resubmittedAnswers,
  submittedAnswers,
  resubmitNote,
  wholeIntakeProblem,
} from "./resubmission";
import {
  INITIATIVE_OWNER_ID,
  NO_MATCH,
  initiativeOwnerFor,
  normalizeInitiativeOwner,
  normalizeOwnerEmail,
  normalizePrincipalId,
  onboardingRequestProblem,
  ownerMatchStageOpen,
  ownerMatchesFor,
  ownerVerificationOf,
  resubmittedMatch,
  selfMatch,
  stateOnlyOwners,
  staffMatch,
  staffMatchProblem,
  withSessionOwners,
  type OwnerMatchProblem,
  type OwnerMatchRecord,
  type OwnerMatchSubject,
  type OwnerSession,
} from "./owners";
import { memoryOnboardUserEntries, type OnboardUserEntries } from "../change-list/onboard-user";
import type {
  OnboardingActor,
  OnboardingDecision,
  OnboardingIntake,
  OnboardingRequest,
  OnboardingRequestRecord,
  OnboardingResubmission,
  OnboardingResubmissionRecord,
  OnboardingReviewDecision,
  OnboardingReviewStage,
  OnboardingReviewerRole,
  OnboardingWriteIntent,
  OwnerMatchInput,
} from "./types";
import type { UserProfile } from "../types";
import {
  cloneEffectiveSlaConfig,
  DEFAULT_EFFECTIVE_SLA_CONFIG,
  type EffectiveSlaConfig,
} from "../sla-config";

export interface OnboardingStore {
  /** Validate the intake package and create a request for the signed-in user, forwarded to the business & ROI review. */
  submit(intake: OnboardingIntake, intent?: OnboardingWriteIntent): Promise<OnboardingRequest>;
  get(id: string): Promise<OnboardingRequest | undefined>;
  /** The signed-in user's own requests, newest first. */
  listMine(): Promise<OnboardingRequest[]>;
  /** Only the requests at the role's stage, oldest first. Refused unless the signed-in user is a direct member of the EDP admin group. */
  listInbox(role: OnboardingReviewerRole): Promise<OnboardingRequest[]>;
  /** Approve, send back or reject at the current review stage, as the signed-in reviewer. Send-backs need questions and rejections a reason. */
  decide(
    id: string,
    decision: OnboardingReviewDecision,
    intent?: OnboardingWriteIntent,
  ): Promise<OnboardingRequest>;
  /** The signed-in provider answers a send-back; the request returns to the review stage that sent it back. */
  resubmit(
    id: string,
    resubmission: OnboardingResubmission,
    intent?: OnboardingWriteIntent,
  ): Promise<OnboardingRequest>;
  /** The signed-in provider ends their own request. Terminal. */
  withdraw(
    id: string,
    input?: { note?: string | undefined },
    intent?: OnboardingWriteIntent,
  ): Promise<OnboardingRequest>;
  /**
   * EDP staff record the Databricks principal an owner is, as they entered
   * it: not verified, and no ADR-0006 email binding (#103, 103-B). Only at a
   * review stage; refused for anyone but EDP staff.
   */
  matchOwner(
    id: string,
    match: OwnerMatchInput,
    intent?: OnboardingWriteIntent,
  ): Promise<OnboardingRequest>;
  /**
   * EDP staff mark an owner not a Databricks user yet, listing one
   * onboard-user change-list entry for their email (or reusing the pending
   * one). Only at a review stage; refused for anyone but EDP staff.
   */
  requestOwnerOnboarding(
    id: string,
    owner: { ownerId: string },
    intent?: OnboardingWriteIntent,
  ): Promise<OnboardingRequest>;
}

/** The acting person as the onboarding store sees them, from the server-resolved profile. */
export function toOnboardingActor(user: UserProfile): OnboardingActor {
  return {
    principalId: user.principalId,
    name: user.name,
    reviewerRoles: [...(user.onboardingReviewerRoles ?? [])],
  };
}

export interface MemoryOnboardingStoreConfig {
  /** The signed-in user, from the server-resolved session. Read on every call. */
  currentUser: () => Promise<UserProfile>;
  now?: () => Date;
  slaConfig?: EffectiveSlaConfig;
  /**
   * The change list onboard-user entries go on (#103, 103-B). The memory
   * adapter passes the one EDP staff see; left out, the store keeps its own.
   */
  onboardUserEntries?: OnboardUserEntries;
}

const SYSTEM_ACTOR = { principalId: "system", name: "System" } as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** A refusal with a machine-readable code, as the Delta API's error codes. */
export class OnboardingRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OnboardingRefusal";
    this.code = code;
  }
}

function assertIntake(intake: OnboardingIntake): void {
  // Same refusal codes as the server (invalid-/duplicate-dataset-tag).
  const tagProblem = findDatasetTagProblem(intake.datasets);
  if (tagProblem) throw new OnboardingRefusal(tagProblem.code, tagProblem.message);
  const schema = loadSchema();
  refuseOn(findDatasetOptionIdProblem(intake, schema));
  const state: IntakeState = {
    dataName: intake.initiativeName,
    useCase: intake.businessCase,
    annualBenefit: intake.annualBenefit,
    levers: intake.levers,
    datasets: intake.datasets,
    isolation: intake.workspaceNeeds?.isolation,
    teamSize: intake.workspaceNeeds?.teamSize,
    initiativeOwner: intake.initiativeOwner,
  };
  const issues = [
    ...validateStep(schema, "source", state).filter(
      ({ field }) => field === "dataName" || field === "initiativeOwner",
    ),
    ...validateStep(schema, "business", state).filter(
      ({ field }) => field !== "outcome" && field !== "hoursSaved",
    ),
    ...validateStep(schema, "datasets", state),
    ...validateStep(schema, "workspace", state),
  ].map(({ message }) => message);
  if (issues.length > 0) {
    throw new Error(`Onboarding request is incomplete: ${issues.join(" ")}`);
  }
}

function refuseOn(problem: { code: string; message: string } | null): void {
  if (problem) throw new OnboardingRefusal(problem.code, problem.message);
}

/** The intake with an ID on every dataset and owner contact that hasn't one: the store's record IDs. */
function withRecordIds(intake: OnboardingIntake): OnboardingIntake {
  const id = () => globalThis.crypto.randomUUID();
  return {
    ...intake,
    datasets: intake.datasets.map((dataset) => ({
      ...dataset,
      id: dataset.id ?? id(),
      owners: dataset.owners.map((owner) => ({ ...owner, id: owner.id ?? id() })),
    })),
  };
}

/** Build the in-memory onboarding repository. `currentUser` and `now` are read on every call. */
export function createMemoryOnboardingStore(config: MemoryOnboardingStoreConfig): OnboardingStore {
  const now = config.now ?? (() => new Date());
  const slaConfig = cloneEffectiveSlaConfig(config.slaConfig ?? DEFAULT_EFFECTIVE_SLA_CONFIG);
  /**
   * The signed-in user, read once per call: who is acting, and who Myself is
   * (#103), from the same read, so one write can't act as one person and
   * store another as a verified owner.
   */
  const signedInAs = async (): Promise<{ actor: OnboardingActor; session: OwnerSession }> => {
    const user = await config.currentUser();
    return {
      actor: toOnboardingActor(user),
      session: { principalId: user.principalId, name: user.name, email: user.email },
    };
  };
  const signedIn = async (): Promise<OnboardingActor> => (await signedInAs()).actor;
  /** The intake as stored: its owner answer normalised and its Myself owners from the session. */
  const ownedIntake = (intake: OnboardingIntake, session: OwnerSession): OnboardingIntake => {
    const { initiativeOwner: _answer, ...rest } = intake;
    const owner = normalizeInitiativeOwner(intake.initiativeOwner);
    return withSessionOwners({ ...rest, ...(owner ? { initiativeOwner: owner } : {}) }, session);
  };
  const records: OnboardingRequestRecord[] = [];
  let ownEntry = 1;
  const onboardUsers =
    config.onboardUserEntries ??
    memoryOnboardUserEntries([], () => `CL-${String(ownEntry++).padStart(4, "0")}`);
  /** Each request's owner matches, by owner ID (`initiative` for the initiative owner). */
  const matches = new Map<string, Map<string, OwnerMatchRecord>>();
  /** The matches a request's owners start with: Myself from the session, nobody else. */
  const initialMatches = (
    intake: OnboardingIntake,
    owner: OnboardingRequestRecord["initiativeOwner"],
    session: OwnerSession,
  ): Map<string, OwnerMatchRecord> =>
    new Map([
      ...(owner?.kind === "self" ? [[INITIATIVE_OWNER_ID, selfMatch(session)] as const] : []),
      ...intake.datasets.flatMap((dataset) =>
        dataset.owners.flatMap((contact) =>
          contact.id && contact.self === true ? [[contact.id, selfMatch(session)] as const] : [],
        ),
      ),
    ]);
  /** Every owner of a record, as the match rules read them. */
  const subjectsOf = (record: OnboardingRequestRecord): OwnerMatchSubject[] => {
    const stored = matches.get(record.id) ?? new Map<string, OwnerMatchRecord>();
    return [
      ...(record.initiativeOwner
        ? [
            {
              ownerId: INITIATIVE_OWNER_ID,
              role: "initiative" as const,
              datasetId: null,
              name: record.initiativeOwner.name,
              email: record.initiativeOwner.email,
              match: stored.get(INITIATIVE_OWNER_ID) ?? NO_MATCH,
            },
          ]
        : []),
      ...record.intake.datasets.flatMap((dataset) =>
        dataset.owners.flatMap((contact) =>
          contact.id
            ? [
                {
                  ownerId: contact.id,
                  role: "dataset" as const,
                  datasetId: dataset.id ?? null,
                  name: contact.name,
                  email: contact.email,
                  match: stored.get(contact.id) ?? NO_MATCH,
                },
              ]
            : [],
        ),
      ),
    ];
  };
  /** A display code no request here has (ADR-0007 decision 2, amended 2026-10-10). */
  const newRequestId = (): string => {
    const id = newDisplayCode("ONB");
    return records.some((record) => record.id === id) ? newRequestId() : id;
  };

  const view = (record: OnboardingRequestRecord): OnboardingRequest => ({
    ...clone(record),
    ownerMatches: ownerMatchesFor(
      subjectsOf(record),
      onboardUsers
        .pending()
        .map((entry) => ({ entryId: entry.id, email: entry.target.person.email })),
    ),
    sla: onboardingSla(record.stage, record.stageEnteredAt, now(), slaConfig),
  });

  const notFound = (): Error => new Error("Onboarding request not found.");

  const findForProvider = (id: string, actor: OnboardingActor): OnboardingRequestRecord => {
    const record = records.find((candidate) => candidate.id === id);
    if (!record || record.providerId !== actor.principalId) throw notFound();
    return record;
  };

  const findForReviewer = (
    id: string,
    actor: OnboardingActor,
  ): OnboardingRequestRecord & { stage: OnboardingReviewStage } => {
    const record = records.find((candidate) => candidate.id === id);
    if (
      !record ||
      !isReviewStage(record.stage) ||
      !actor.reviewerRoles.includes(REVIEWER_FOR_STAGE[record.stage])
    ) {
      throw notFound();
    }
    return record as OnboardingRequestRecord & { stage: OnboardingReviewStage };
  };

  /** Apply one transition to a stored record and record who made it. */
  const move = (
    record: OnboardingRequestRecord,
    kind: OnboardingDecision["kind"],
    to: OnboardingRequestRecord["stage"],
    actor: Pick<OnboardingActor, "principalId" | "name">,
    note = "",
    resubmission?: OnboardingResubmissionRecord,
  ) => {
    const at = now().toISOString();
    record.decisions.push({
      kind,
      from: record.stage,
      to,
      actorId: actor.principalId,
      actorName: actor.name,
      at,
      note,
      ...(resubmission ? { resubmission } : {}),
    });
    record.stage = to;
    record.stageEnteredAt = at;
    record.version += 1;
  };

  const store: OnboardingStore = {
    submit: async (intake) => {
      const { actor: provider, session } = await signedInAs();
      refuseOn(findSubmittedIdProblem(intake));
      assertIntake(intake);
      const owned = withRecordIds(ownedIntake(clone(intake), session));
      const stored = { ...owned, answers: submittedAnswers(owned.answers) };
      const at = now().toISOString();
      const record: OnboardingRequestRecord = {
        id: newRequestId(),
        version: 1,
        title: intake.initiativeName.trim(),
        providerId: provider.principalId,
        providerName: provider.name,
        submittedAt: at,
        stage: "submitted",
        stageEnteredAt: at,
        intake: stored,
        openSendBack: null,
        initiativeOwner: initiativeOwnerFor(stored.initiativeOwner, session),
        ownerVerification: ownerVerificationOf(stored),
        ownerMatches: [],
        decisions: [
          {
            kind: "submit",
            from: null,
            to: "submitted",
            actorId: provider.principalId,
            actorName: provider.name,
            at,
            note: "",
          },
        ],
      };
      move(record, "forward", nextOnboardingStage("submitted", { type: "forward" }), SYSTEM_ACTOR);
      matches.set(record.id, initialMatches(record.intake, record.initiativeOwner, session));
      records.push(record);
      return view(record);
    },

    get: async (id) => {
      const actor = await signedIn();
      const record = records.find((candidate) => candidate.id === id);
      if (!record) return undefined;
      const authorizedReviewer =
        isReviewStage(record.stage) &&
        actor.reviewerRoles.includes(REVIEWER_FOR_STAGE[record.stage]);
      return record.providerId === actor.principalId || authorizedReviewer
        ? view(record)
        : undefined;
    },

    listMine: async () => {
      const provider = await signedIn();
      return records
        .filter((record) => record.providerId === provider.principalId)
        .reverse()
        .map(view);
    },

    listInbox: async (role) => {
      const reviewer = await signedIn();
      if (!reviewer.reviewerRoles.includes(role)) {
        throw new Error(`${reviewer.name} is not a direct member of the EDP admin group.`);
      }
      const stage = STAGE_FOR_REVIEWER[role];
      return records.filter((record) => record.stage === stage).map(view);
    },

    decide: async (id, decision) => {
      const reviewer = await signedIn();
      const record = findForReviewer(id, reviewer);
      const to = nextOnboardingStage(
        record.stage,
        decision.type === "send-back" ? { type: "send-back", to: decision.to } : decision,
      );
      const from = record.stage;

      const note = decision.note?.trim() ?? "";
      if (decision.type === "send-back" && note.length === 0) {
        throw new Error("A send-back needs questions for the data provider.");
      }
      if (decision.type === "reject" && note.length === 0) {
        throw new Error("A rejection needs a reason for the data provider.");
      }

      move(record, decision.type, to, reviewer, note);
      record.openSendBack =
        decision.type === "send-back"
          ? { from, questions: note, actorId: reviewer.principalId, at: record.stageEnteredAt }
          : null;
      return view(record);
    },

    resubmit: async (id, resubmission) => {
      const { actor: provider, session } = await signedInAs();
      const record = findForProvider(id, provider);
      if (isOnboardingTerminal(record.stage)) {
        throw new Error(
          `Invalid onboarding transition: terminal stage '${record.stage}' cannot transition`,
        );
      }
      if (record.stage !== ONBOARDING_SEND_BACK_STAGE || !record.openSendBack) {
        throw new Error(
          `Only a request sent back to the data provider can be resubmitted; ${record.id} is at '${record.stage}'.`,
        );
      }
      const answer = resubmission.answer.trim();
      if (!answer) throw new Error("A resubmission needs an answer for the reviewer.");
      // The whole intake as the provider edited it, re-validated here whatever
      // the browser checked (#222). Stored records keep their IDs; new ones get
      // one from the store; the browser can't name any other.
      const sent = resubmission.intake
        ? ownedIntake(normalizeIntake(resubmission.intake), session)
        : undefined;
      if (sent) refuseOn(findResubmittedIdProblem(record.intake, sent));
      // A retired answer (the steward) stays as the request stored it, whatever the browser sent.
      const mergedIntake = sent
        ? {
            ...withRecordIds(sent),
            answers: resubmittedAnswers(sent.answers, record.intake.answers),
          }
        : clone(record.intake);
      // An answer-only resubmission of a request made before #103 keeps having no owner.
      refuseOn(
        wholeIntakeProblem(mergedIntake, undefined, new Set(sent ? [] : ["initiativeOwner"])),
      );
      // A staff match stays while the provider leaves that owner's email as it was (103-B).
      const before = new Map(subjectsOf(record).map((subject) => [subject.ownerId, subject]));
      const typedOwner = sent
        ? initiativeOwnerFor(mergedIntake.initiativeOwner, session)
        : record.initiativeOwner;
      const ownerMatch = typedOwner
        ? resubmittedMatch(
            before.get(INITIATIVE_OWNER_ID),
            { email: typedOwner.email, self: typedOwner.kind === "self" },
            session,
          )
        : NO_MATCH;
      const owner =
        typedOwner && ownerMatch.source === "staff"
          ? { ...typedOwner, principalId: ownerMatch.principalId }
          : typedOwner;
      const nextMatches = new Map<string, OwnerMatchRecord>(
        owner ? [[INITIATIVE_OWNER_ID, ownerMatch]] : [],
      );
      for (const dataset of mergedIntake.datasets) {
        for (const contact of dataset.owners) {
          if (!contact.id) continue;
          nextMatches.set(
            contact.id,
            resubmittedMatch(
              before.get(contact.id),
              { email: contact.email, self: contact.self === true },
              session,
            ),
          );
        }
      }
      const note = resubmitNote(answer, record.intake, mergedIntake);
      // Back to the stage that sent it back, from the stored send-back (#221).
      const sentBackFrom = [...record.decisions].reverse().find(({ kind }) => kind === "send-back");
      const to = nextOnboardingStage(record.stage, {
        type: "resubmit",
        to: resubmissionStage(record.openSendBack.from, sentBackFrom?.from),
      });
      const changes = resubmissionChanges(record.intake, mergedIntake, undefined, {
        before: record.initiativeOwner,
        after: owner,
      });
      record.intake = mergedIntake;
      record.initiativeOwner = owner;
      matches.set(record.id, nextMatches);
      record.ownerVerification = ownerVerificationOf(mergedIntake);
      record.title = mergedIntake.initiativeName;
      move(record, "resubmit", to, provider, note, { answer, changes });
      record.openSendBack = null;
      return view(record);
    },

    withdraw: async (id, input = {}) => {
      const provider = await signedIn();
      const record = findForProvider(id, provider);
      const to = nextOnboardingStage(record.stage, { type: "withdraw" });
      move(record, "withdraw", to, provider, input.note?.trim() ?? "");
      record.openSendBack = null;
      return view(record);
    },

    matchOwner: async (id, match, intent) => {
      const { record, staff, subject } = await forOwnerMatch(id, match.ownerId, intent);
      const principalId = normalizePrincipalId(match.principalId);
      refuseOwnerMatch(staffMatchProblem(subject, principalId));
      const stored = staffMatch(principalId, staff, now().toISOString());
      matches.get(record.id)!.set(match.ownerId, stored);
      if (match.ownerId === INITIATIVE_OWNER_ID && record.initiativeOwner) {
        record.initiativeOwner = { ...record.initiativeOwner, principalId };
      }
      record.version += 1;
      return view(record);
    },

    requestOwnerOnboarding: async (id, { ownerId }, intent) => {
      const { record, staff, subject } = await forOwnerMatch(id, ownerId, intent);
      refuseOwnerMatch(onboardingRequestProblem(subject));
      onboardUsers.list({
        person: { name: subject!.name, email: normalizeOwnerEmail(subject!.email) },
        initiative: { onboardingRequestId: record.id, name: record.title },
        requestedBy: staff.principalId,
        requestedAt: now().toISOString(),
      });
      record.version += 1;
      return view(record);
    },
  };

  function refuseOwnerMatch(problem: OwnerMatchProblem | null): void {
    if (problem) throw new OnboardingRefusal(problem.code, problem.message);
  }

  /**
   * The request and owner a staff match names, as EDP staff only (103-B): the
   * signed-in user must be in the EDP admin group, the request at a review
   * stage, and the intent's version (when it has one) the request's own.
   */
  async function forOwnerMatch(
    id: string,
    ownerId: string,
    intent: OnboardingWriteIntent | undefined,
  ) {
    const user = await config.currentUser();
    if (!user.isAdmin) throw new OnboardingRefusal("forbidden", "Only EDP staff can do this.");
    const record = records.find((candidate) => candidate.id === id);
    if (!record || !ownerMatchStageOpen(record.stage)) {
      throw new OnboardingRefusal("not-found", "Onboarding request not found.");
    }
    if (intent?.version !== undefined && intent.version !== record.version) {
      throw new OnboardingRefusal(
        "version-conflict",
        `${record.id} has changed since you read it. Reload it and try again.`,
      );
    }
    const subject = subjectsOf(record).find((candidate) => candidate.ownerId === ownerId);
    return { record, staff: { principalId: user.principalId, name: user.name }, subject };
  }

  // A write under an intent key the store has already seen replays that write's
  // result rather than writing again, as the server's idempotency key does. A
  // refusal frees the key, so a retry of the same intent runs again.
  const replays = new Map<string, Promise<OnboardingRequest>>();
  const once = (
    intent: OnboardingWriteIntent | undefined,
    write: () => Promise<OnboardingRequest>,
  ): Promise<OnboardingRequest> => {
    if (!intent) return write();
    const prior = replays.get(intent.key);
    if (prior) return prior;
    const result = write();
    replays.set(intent.key, result);
    result.catch(() => replays.delete(intent.key));
    return result;
  };

  // The provider's reads and writes carry match state only; EDP staff's (the
  // inbox, decisions, matching) keep who matched whom (#103, 103-B).
  const forProvider = async (read: Promise<OnboardingRequest>) => stateOnlyOwners(await read);
  return {
    ...store,
    get: async (id) => {
      const found = await store.get(id);
      return found && stateOnlyOwners(found);
    },
    listMine: async () => (await store.listMine()).map(stateOnlyOwners),
    submit: (intake, intent) => forProvider(once(intent, () => store.submit(intake))),
    decide: (id, decision, intent) => once(intent, () => store.decide(id, decision)),
    resubmit: (id, resubmission, intent) =>
      forProvider(once(intent, () => store.resubmit(id, resubmission))),
    withdraw: (id, input, intent) => forProvider(once(intent, () => store.withdraw(id, input))),
    matchOwner: (id, match, intent) => once(intent, () => store.matchOwner(id, match, intent)),
    requestOwnerOnboarding: (id, owner, intent) =>
      once(intent, () => store.requestOwnerOnboarding(id, owner, intent)),
  };
}
