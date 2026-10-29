/**
 * TanStack Query hooks in front of the onboarding repository (#86). Reads go
 * through the seam; every write invalidates the whole `onboarding` family so
 * inboxes, the provider's list and the detail all re-read the stored state.
 * Each write carries the screen's intent key (see `intent.ts`), resolves on its
 * own result and re-reads in the background.
 *
 * The provider's saves (submit, resubmit, withdraw) are optimistic saves
 * (src/data/optimistic-save.ts, ADR-0009 phase 1, #195). Reviewer decisions are
 * staff approvals, which ADR-0009 keeps synchronous: {@link useDecideOnboardingRequest}.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import type { IntakeState } from "../../schema/types";
import { project, type SaveSpec } from "../optimistic-save";
import type { DataStore } from "../store";
import { useStore } from "../store-context";
import { STAGE_FOR_REVIEWER, isReviewStage, resubmissionStage } from "./lifecycle";
import type {
  OnboardingIntake,
  OnboardingRequest,
  OnboardingResubmission,
  OnboardingReviewDecision,
  OnboardingReviewStage,
  OnboardingReviewerRole,
  OnboardingWriteIntent,
  OwnerMatchInput,
} from "./types";

export const onboardingKeys = {
  all: ["onboarding"] as const,
  mine: () => ["onboarding", "mine"] as const,
  inbox: (role: OnboardingReviewerRole) => ["onboarding", "inbox", role] as const,
  detail: (id: string) => ["onboarding", "detail", id] as const,
};

/**
 * The newest version of each request this cache has seen, from a command's
 * result or a read. A read that answers with an older version (a re-read that
 * started before a write committed, say) never replaces a newer one.
 */
const newest = new WeakMap<DataStore, Map<string, OnboardingRequest>>();

function seen(store: DataStore): Map<string, OnboardingRequest> {
  let known = newest.get(store);
  if (!known) newest.set(store, (known = new Map()));
  return known;
}

/** Record `request` if it's newer than what's known, and return the newer of the two. */
function newer(store: DataStore, request: OnboardingRequest): OnboardingRequest {
  const known = seen(store);
  const current = known.get(request.id);
  if (current && current.version > request.version) return current;
  known.set(request.id, request);
  return request;
}

/**
 * A list read, each request swapped for the newest version known; `belongs`
 * then drops one that's no longer on this list (an inbox keeps only its own
 * stage), so a stale re-read can't bring back a request a write moved on.
 */
function reconcileList(
  store: DataStore,
  list: OnboardingRequest[],
  belongs: (request: OnboardingRequest) => boolean = () => true,
): OnboardingRequest[] {
  return list.map((request) => newer(store, request)).filter(belongs);
}

/** The signed-in user's own requests. The store resolves who that is. */
export function useMyOnboardingRequests(): UseQueryResult<OnboardingRequest[]> {
  const store = useStore();
  return useQuery({
    queryKey: onboardingKeys.mine(),
    queryFn: async () => reconcileList(store, await store.onboarding.listMine()),
  });
}

/**
 * The role's inbox. `enabled` only avoids a request the UI already knows will be
 * refused; the store itself refuses non-members.
 */
export function useOnboardingInbox(
  role: OnboardingReviewerRole,
  enabled = true,
): UseQueryResult<OnboardingRequest[]> {
  const store = useStore();
  return useQuery({
    queryKey: onboardingKeys.inbox(role),
    queryFn: async () =>
      reconcileList(
        store,
        await store.onboarding.listInbox(role),
        (request) => request.stage === STAGE_FOR_REVIEWER[role],
      ),
    enabled,
  });
}

export function useOnboardingRequest(id: string): UseQueryResult<OnboardingRequest | undefined> {
  const store = useStore();
  return useQuery({
    queryKey: onboardingKeys.detail(id),
    // Not found is the server's answer (it may have left the caller's scope);
    // only a returned request is compared with the newest known version.
    queryFn: async () => {
      const request = await store.onboarding.get(id);
      return request ? newer(store, request) : undefined;
    },
    enabled: id.length > 0,
  });
}

/** A save on the onboarding store, as a screen drives it. */
export interface OnboardingWrite<TInput> {
  /** Start the save. While one is in flight, a second call is the same save, not another. */
  mutate: (input: TInput, options?: OnboardingWriteOptions) => void;
  mutateAsync: (input: TInput, options?: OnboardingWriteOptions) => Promise<OnboardingRequest>;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

export interface OnboardingWriteOptions {
  onSuccess?: (result: OnboardingRequest) => void;
}

/**
 * Put a write's returned request into every onboarding read that holds it, so
 * the screen shows the stored result at once: the detail, the provider's list
 * (a new request goes first, as the read orders them) and each inbox, which
 * keeps it only while it's at that inbox's stage. Reads not in the cache stay
 * out of it.
 */
function applyResult(
  queryClient: QueryClient,
  store: DataStore,
  result: OnboardingRequest,
  created: boolean,
) {
  const request = newer(store, result);
  queryClient.setQueryData(onboardingKeys.detail(request.id), request);
  const replace = (list: OnboardingRequest[]) =>
    list.map((item) => (item.id === request.id ? request : item));
  const holds = (list: OnboardingRequest[]) => list.some((item) => item.id === request.id);
  queryClient.setQueryData<OnboardingRequest[]>(onboardingKeys.mine(), (list) =>
    !list ? list : holds(list) ? replace(list) : created ? [request, ...list] : list,
  );
  for (const role of ["business-office", "ccb"] as const) {
    queryClient.setQueryData<OnboardingRequest[]>(onboardingKeys.inbox(role), (list) => {
      if (!list) return list;
      if (request.stage !== STAGE_FOR_REVIEWER[role]) {
        return list.filter((item) => item.id !== request.id);
      }
      return holds(list) ? replace(list) : [...list, request];
    });
  }
}

/**
 * Wrap a store write so it resolves on the command's own result: the result
 * goes into the cached reads straight away, and every onboarding read is
 * re-read in the background, not awaited, so the person isn't kept waiting on
 * refetches (a list re-read on Delta is a warehouse round trip). Only one save
 * runs at a time per hook: a double click that lands before the button
 * re-renders as disabled joins the save already running.
 */
function useOnboardingWrite<TInput>(
  write: (input: TInput) => Promise<OnboardingRequest>,
  options: { created?: boolean } = {},
): OnboardingWrite<TInput> {
  const queryClient = useQueryClient();
  const store = useStore();
  const inFlight = useRef<Promise<OnboardingRequest> | null>(null);
  const mutation = useMutation<OnboardingRequest, Error, TInput>({
    mutationFn: write,
    onSuccess: (request) => applyResult(queryClient, store, request, options.created ?? false),
    onSettled: () => {
      // In the background: the write has already resolved.
      void queryClient.invalidateQueries({ queryKey: onboardingKeys.all });
    },
  });
  const { mutateAsync: run, reset } = mutation;
  const mutateAsync = useCallback(
    (input: TInput, options?: OnboardingWriteOptions) => {
      if (inFlight.current) return inFlight.current;
      const saving = (
        options?.onSuccess ? run(input, { onSuccess: options.onSuccess }) : run(input)
      ).finally(() => {
        inFlight.current = null;
      });
      inFlight.current = saving;
      return saving;
    },
    [run],
  );
  const mutate = useCallback(
    (input: TInput, options?: OnboardingWriteOptions) => {
      // The error is on `error`; nothing more to do with the rejection here.
      mutateAsync(input, options).catch(() => undefined);
    },
    [mutateAsync],
  );
  return {
    mutate,
    mutateAsync,
    isPending: mutation.isPending || inFlight.current !== null,
    error: mutation.error,
    reset,
  };
}

export function useDecideOnboardingRequest() {
  const store = useStore();
  return useOnboardingWrite(
    (input: { id: string; decision: OnboardingReviewDecision; intent?: OnboardingWriteIntent }) =>
      store.onboarding.decide(input.id, input.decision, input.intent),
  );
}

/** EDP staff match an owner to the principal they entered (#103, 103-B). */
export function useMatchOnboardingOwner() {
  const store = useStore();
  return useOnboardingWrite(
    (input: { id: string; match: OwnerMatchInput; intent?: OnboardingWriteIntent }) =>
      store.onboarding.matchOwner(input.id, input.match, input.intent),
  );
}

/** The change list's query key (datasets/queries.ts), re-read when onboarding lists an entry. */
const CHANGE_LIST_KEY = ["change-list"] as const;

/** EDP staff mark an owner not a Databricks user yet, listing an onboard-user entry (#103, 103-B). */
export function useRequestOwnerOnboarding() {
  const store = useStore();
  const queryClient = useQueryClient();
  return useOnboardingWrite(
    async (input: { id: string; ownerId: string; intent?: OnboardingWriteIntent }) => {
      const result = await store.onboarding.requestOwnerOnboarding(
        input.id,
        { ownerId: input.ownerId },
        input.intent,
      );
      void queryClient.invalidateQueries({ queryKey: CHANGE_LIST_KEY });
      return result;
    },
  );
}

// --- The provider's optimistic saves (#195) ----------------------------------

/** The record a provider's save on one request locks: a resubmission or a withdrawal. */
export const onboardingRecord = (id: string) => `onboarding:${id}:`;

/** Every new request's save is under this; each submitted intake is its own record. */
export const NEW_ONBOARDING_RECORD = "onboarding:new:";

/** The id a new request shows under until the server gives it its own. */
const PLACEHOLDER = "saving:";

/** True for the stand-in a new request's save shows until the server answers. */
export const isSavingOnboardingRequest = (request: Pick<OnboardingRequest, "id">) =>
  request.id.startsWith(PLACEHOLDER);

/** The stand-in's id for the submit with this idempotency key. */
export const savingOnboardingId = (intentKey: string) => `${PLACEHOLDER}${intentKey}`;

/** The intake's own record of what the person typed, put back in the form if refused. */
export interface SubmitOnboardingInput {
  intake: OnboardingIntake;
  values: IntakeState;
  /** The key of the press of Submit this is: the save's idempotency key and record. */
  intentKey: string;
}

/** A store write's result, remembered so an older re-read can't replace it (#196). */
const remembered = async (store: DataStore, write: Promise<OnboardingRequest>) =>
  newer(store, await write);

const replaceIn = (list: OnboardingRequest[], request: OnboardingRequest) =>
  list.map((item) => (item.id === request.id ? request : item));

/** A request's change as the provider expects it, on My requests and its detail. */
function onRequest<TInput extends { id: string }>(
  change: (request: OnboardingRequest, input: TInput) => OnboardingRequest,
) {
  return (input: TInput) => [
    project<OnboardingRequest[], TInput, OnboardingRequest>(
      onboardingKeys.mine(),
      (list) => list.map((r) => (r.id === input.id ? change(r, input) : r)),
      (list, result) => replaceIn(list, result),
    ),
    project<OnboardingRequest | undefined, TInput, OnboardingRequest>(
      onboardingKeys.detail(input.id),
      (request) => (request ? change(request, input) : request),
      (request, result) => (request ? result : request),
    ),
  ];
}

/**
 * Submit an intake. It shows first in My onboarding requests at once, marked
 * Saving…, under a stand-in id; the server gives it its id and stage. The
 * server resolves who the provider is and checks every rule (dataset tags
 * included); a refusal puts the typed intake back in the form.
 */
export const submitOnboardingSave: SaveSpec<SubmitOnboardingInput, OnboardingRequest> = {
  action: "submit-onboarding",
  refusedTitle: "That onboarding request was refused",
  // Each confirmed intake is one intent, so a double click is the same record.
  record: (i) => `${NEW_ONBOARDING_RECORD}${i.intentKey}`,
  describe: (i) => `Submit ${i.intake.initiativeName.trim()} for business & ROI review`,
  describeSaved: (r) =>
    `Submitted ${r.id}: ${r.title} is with the EDP business office for business & ROI review.`,
  run: (store, i) =>
    remembered(store, store.onboarding.submit(i.intake, { key: i.idempotencyKey })),
  projections: (i) => {
    const placeholder = savingOnboardingId(i.intentKey);
    const now = new Date().toISOString();
    return [
      project<OnboardingRequest[], SubmitOnboardingInput, OnboardingRequest>(
        onboardingKeys.mine(),
        (list) => [
          {
            id: placeholder,
            version: 0,
            title: i.intake.initiativeName.trim(),
            providerId: "",
            providerName: "",
            submittedAt: now,
            stage: "submitted",
            stageEnteredAt: now,
            intake: i.intake,
            openSendBack: null,
            // Who the owners are is the server's to say, from its session (#103).
            initiativeOwner: null,
            ownerVerification: {},
            ownerMatches: [],
            decisions: [],
            sla: null,
          },
          ...list.filter((r) => r.id !== placeholder),
        ],
        (list, r) => [r, ...list.filter((x) => x.id !== placeholder && x.id !== r.id)],
      ),
    ];
  },
  invalidates: () => [onboardingKeys.all],
};

export interface ResubmitOnboardingInput {
  id: string;
  /** The version the provider answered against: the server's expected version. */
  version: number;
  resubmission: OnboardingResubmission;
  /** What the provider had in the wizard, to put back if the server refuses it. */
  values?: IntakeState;
}

/** Who a resubmission is back with, in the saved message. */
const BACK_WITH: Readonly<Record<OnboardingReviewStage, string>> = {
  "business-roi-review": "the business office",
  ccb: "the CCB",
};

/**
 * Answer a send-back. It shows back at the stage that sent it back at once,
 * marked Saving…; the server decides the stage from its own record (#221).
 */
export const resubmitOnboardingSave: SaveSpec<ResubmitOnboardingInput, OnboardingRequest> = {
  action: "resubmit-onboarding",
  refusedTitle: "That resubmission was refused",
  record: (i) => onboardingRecord(i.id),
  describe: (i) => `Answer the questions on ${i.id} and resubmit it`,
  describeSaved: (r) =>
    isReviewStage(r.stage)
      ? `Resubmitted ${r.id}: it's back with ${BACK_WITH[r.stage]}.`
      : `Resubmitted ${r.id}.`,
  run: (store, i) =>
    remembered(
      store,
      store.onboarding.resubmit(i.id, i.resubmission, {
        key: i.idempotencyKey,
        version: i.version,
      }),
    ),
  projections: onRequest((request, input) => ({
    ...request,
    stage: resubmissionStage(request.openSendBack?.from),
    openSendBack: null,
    ...(input.resubmission.intake
      ? { title: input.resubmission.intake.initiativeName, intake: input.resubmission.intake }
      : {}),
    sla: null,
  })),
  invalidates: () => [onboardingKeys.all],
};

export interface WithdrawOnboardingInput {
  id: string;
  version: number;
  note?: string;
}

/** Withdraw a request. It shows as Withdrawn at once, marked Saving…. */
export const withdrawOnboardingSave: SaveSpec<WithdrawOnboardingInput, OnboardingRequest> = {
  action: "withdraw-onboarding",
  refusedTitle: "That withdrawal was refused",
  record: (i) => onboardingRecord(i.id),
  describe: (i) => `Withdraw ${i.id}`,
  describeSaved: (r) => `Withdrew ${r.id}. It's closed and no longer under review.`,
  run: (store, i) =>
    remembered(
      store,
      store.onboarding.withdraw(
        i.id,
        { ...(i.note ? { note: i.note } : {}) },
        { key: i.idempotencyKey, version: i.version },
      ),
    ),
  projections: onRequest((request) => ({ ...request, stage: "withdrawn", sla: null })),
  invalidates: () => [onboardingKeys.all],
};
