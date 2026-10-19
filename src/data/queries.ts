/**
 * TanStack Query hooks that sit in front of the {@link DataStore} seam.
 *
 * These are the app's client cache: every read goes through Query (so caching
 * and invalidation are real) and every read ultimately calls the seam, never a
 * concrete backend. Swapping the seam's adapter (in-memory → Delta/UC) changes
 * nothing here or in the components that use these hooks.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { project, type SaveSpec } from "./optimistic-save";
import { useStore } from "./store-context";
import type { EirResponseInput } from "./eir/repository";
import { isEirReadRefusal } from "./eir/errors";
import type {
  AccessBundle,
  AccessRequest,
  BusinessDomain,
  DataAsset,
  MyAccess,
  OnboardingPersona,
  PipelineEntry,
  RequestStatus,
  SourceSystem,
  Tenant,
  UserProfile,
} from "./types";
import type { EirDecision, EirFormValues, EirInboxItem, EirRecord } from "./eir/types";
import type { EirDefinitionCheck } from "./eir/definition/check";
import type {
  ActivateEirDefinitionInput,
  EirDefinitionHistory,
  EirFormsAnswer,
  PublishEirDefinitionInput,
  PublishedEirDefinition,
} from "./eir/definition/repository";
import { registerEirForm } from "./eir/form";
import type { PrivacyAcknowledgment } from "./privacy/repository";
import { afterPrivacyAcknowledgment, trackPrivacyAcknowledgment } from "./privacy/in-flight";
import { apiFailureKind } from "./api-response";
import type {
  GroupMembership,
  GroupMembershipHistoryCursor,
  GroupMembershipHistoryPage,
  SnapshotRun,
} from "./group-membership";

/** Canonical query keys. Prefixes let one invalidate a whole family at once. */
export const queryKeys = {
  catalog: ["catalog"] as const,
  user: () => ["catalog", "user"] as const,
  requests: ["requests"] as const,
  requestList: () => ["requests", "list"] as const,
  request: (id: string) => ["requests", "detail", id] as const,
  pipeline: () => ["requests", "pipeline"] as const,
  status: ["status"] as const,
  requestStatus: (id: string) => ["status", "detail", id] as const,
  statusAll: () => ["status", "all"] as const,
  stages: () => ["status", "stages"] as const,
  myAccess: () => ["status", "my-access"] as const,
  eir: (principalId: string) => ["eir", "person", principalId] as const,
  eirInbox: () => ["eir", "inbox"] as const,
  eirFormsAll: ["eir", "forms"] as const,
  eirForms: (versions: readonly string[]) => ["eir", "forms", ...versions] as const,
  eirDefinitions: ["eir-definitions"] as const,
  eirDefinitionHistory: () => ["eir-definitions", "history"] as const,
  eirDefinitionVersion: (versionNumber: number) =>
    ["eir-definitions", "version", versionNumber] as const,
  privacyAcknowledgment: () => ["privacy", "acknowledgment"] as const,
  groupMemberships: () => ["membership", "current"] as const,
  groupMembershipHistory: (cursor?: GroupMembershipHistoryCursor) =>
    ["membership", "history", cursor ?? null] as const,
  groupMembershipLatestRun: () => ["membership", "latest-run"] as const,
};

export function useGroupMemberships(): UseQueryResult<GroupMembership[]> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.groupMemberships(),
    queryFn: () => store.groupMemberships.listMemberships(),
  });
}

export function useGroupMembershipHistory(
  cursor?: GroupMembershipHistoryCursor,
): UseQueryResult<GroupMembershipHistoryPage> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.groupMembershipHistory(cursor),
    queryFn: () => store.groupMemberships.listHistory(cursor ? { cursor } : undefined),
  });
}

export function useGroupMembershipLatestRun(): UseQueryResult<SnapshotRun | null> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.groupMembershipLatestRun(),
    queryFn: () => store.groupMemberships.latestRun(),
  });
}

export function usePrivacyAcknowledgment(): UseQueryResult<PrivacyAcknowledgment | null> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.privacyAcknowledgment(),
    queryFn: () => store.privacyAcknowledgments.current(),
    retry: false,
  });
}

export function useAcknowledgePrivacyNotice() {
  const store = useStore();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      new Promise<PrivacyAcknowledgment>((resolve, reject) => {
        const displayedNotice = store.privacyAcknowledgments.notice;
        const confirmOrReject = async (error: unknown) => {
          if (
            apiFailureKind(error) !== "session-expired" &&
            (error as { code?: string }).code !== "privacy-notice-changed"
          ) {
            try {
              const current = await store.privacyAcknowledgments.current();
              if (
                current?.noticeVersion === displayedNotice.version &&
                current.contentHash === displayedNotice.contentHash
              ) {
                resolve(current);
                return;
              }
            } catch {
              // Preserve the write failure: it is the operation the person is recovering from.
            }
          }
          reject(error);
        };
        const timeout = globalThis.setTimeout(
          () => void confirmOrReject(new Error("Privacy acknowledgment timed out.")),
          20_000,
        );
        void store.privacyAcknowledgments
          .acknowledge({
            noticeVersion: displayedNotice.version,
            contentHash: displayedNotice.contentHash,
          })
          .then(
            (acknowledgment) => {
              globalThis.clearTimeout(timeout);
              resolve(acknowledgment);
            },
            (error) => {
              globalThis.clearTimeout(timeout);
              void confirmOrReject(error);
            },
          );
      }),
    retry: (failureCount, error) =>
      apiFailureKind(error) !== "session-expired" &&
      (error as { code?: string }).code !== "privacy-notice-changed" &&
      failureCount < 2,
    retryDelay: (attemptIndex) => 250 * 2 ** attemptIndex + Math.floor(Math.random() * 250),
    onSuccess: (acknowledgment) =>
      client.setQueryData(queryKeys.privacyAcknowledgment(), acknowledgment),
  });
  return {
    ...mutation,
    start: () => {
      const retryingAfterFailure = mutation.isError;
      const acknowledgment = mutation.mutateAsync();
      trackPrivacyAcknowledgment(store, acknowledgment);
      if (retryingAfterFailure) {
        void acknowledgment.then(() =>
          client.refetchQueries({ queryKey: ["eir"], type: "active" }),
        );
      }
      return acknowledgment;
    },
  };
}

export const EIR_READ_RETRY_ATTEMPTS = 2;
export const EIR_READ_RETRY_DELAY_MS = 800;

const eirReadRetryDelay = (attemptIndex: number) => EIR_READ_RETRY_DELAY_MS * (attemptIndex + 1);
const eirReadRetry = (failureCount: number, error: Error) =>
  !isEirReadRefusal(error) && failureCount < EIR_READ_RETRY_ATTEMPTS;

const runWithPrivacyAcknowledgmentRefresh = async <T>(
  client: ReturnType<typeof useQueryClient>,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "privacy-acknowledgment-required") {
      await client.invalidateQueries({ queryKey: queryKeys.privacyAcknowledgment() });
    }
    throw error;
  }
};

export function useEir(principalId: string): UseQueryResult<EirRecord> {
  const store = useStore();
  const client = useQueryClient();
  return useQuery<EirRecord, Error>({
    queryKey: queryKeys.eir(principalId),
    queryFn: () =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () => store.eir.get(principalId)),
      ),
    enabled: Boolean(principalId),
    retry: eirReadRetry,
    retryDelay: eirReadRetryDelay,
    refetchOnWindowFocus: false,
  });
}

export function useEirInbox(enabled: boolean): UseQueryResult<EirInboxItem[]> {
  const store = useStore();
  return useQuery<EirInboxItem[], Error>({
    queryKey: queryKeys.eirInbox(),
    queryFn: () => store.eir.listValidatorInbox(),
    enabled,
    retry: eirReadRetry,
    retryDelay: eirReadRetryDelay,
    refetchOnWindowFocus: false,
  });
}

/** Start the EIR: it gets its Record ID before the PDF is generated. */
export function useStartEir() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { principalId: string; personName: string }) =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () =>
          store.eir.start(input.principalId, input.personName),
        ),
      ),
    onSuccess: (record) => client.setQueryData(queryKeys.eir(record.principalId), record),
  });
}

export function useSaveEirDraft() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      principalId: string;
      values: EirFormValues;
      /** The draft version the screen read (`EirRecord.draftVersion`). */
      expectedDraftVersion?: number;
      /** The form version the screen showed (#201). */
      formVersion?: string;
    }) =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () =>
          store.eir.saveDraft(
            input.principalId,
            input.values,
            input.expectedDraftVersion,
            input.formVersion,
          ),
        ),
      ),
    onSuccess: (record) => client.setQueryData(queryKeys.eir(record.principalId), record),
  });
}

export function useEvaluateEirDraft() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (principalId: string) =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () => store.eir.evaluateDraft(principalId)),
      ),
    onSuccess: (evaluation, principalId) =>
      client.setQueryData<EirRecord>(queryKeys.eir(principalId), (record) =>
        record ? { ...record, evaluation } : record,
      ),
  });
}

export function useGenerateEirPdf() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (principalId: string) =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () => store.eir.generatePdf(principalId)),
      ),
  });
}

/** The record an EIR save locks: one person's EIR. */
export const eirRecord = (principalId: string) => `eir:${principalId}`;

/**
 * Save draft as an optimistic save (ADR-0009 phase 1): the form keeps what
 * the person typed and says Saving…; the EIR is replaced only by the server's
 * result. The repository reuses its key for the same answers and version, so
 * Try again can't save twice. Submit and renew stay synchronous (decision 2).
 */
export const saveEirDraftSave: SaveSpec<
  {
    principalId: string;
    values: EirFormValues;
    expectedDraftVersion?: number;
    /** The form version the screen showed (#201). */
    formVersion?: string;
  },
  EirRecord
> = {
  action: "save-draft",
  refusedTitle: "We could not save the draft",
  record: (i) => eirRecord(i.principalId),
  describe: () => "Save your EIR draft",
  describeSaved: () => "Draft saved. Your answers are kept if you leave or reload this page.",
  run: (store, i) =>
    afterPrivacyAcknowledgment(store, () =>
      store.eir.saveDraft(i.principalId, i.values, i.expectedDraftVersion, i.formVersion),
    ),
  projections: (i) => [
    project<EirRecord, typeof i, EirRecord>(
      queryKeys.eir(i.principalId),
      (record) => record,
      (_record, saved) => saved,
    ),
  ],
  invalidates: () => [],
};

export function useSubmitEirFile() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      principalId: string;
      personName: string;
      file: File;
      values: EirFormValues;
      response?: string;
      /** The EIR version the screen read (`EirRecord.version`). */
      expectedVersion?: number;
      /** The form version the screen showed (#201). */
      formVersion?: string;
    }) =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () => store.eir.submitWithFile(input)),
      ),
    onSuccess: (record) => {
      client.setQueryData(queryKeys.eir(record.principalId), record);
      void client.invalidateQueries({ queryKey: queryKeys.eirInbox() });
    },
  });
}

/** Send response: answer safeguards questions with the answers and PDF already signed. */
export function useRespondEir() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EirResponseInput) =>
      afterPrivacyAcknowledgment(store, () =>
        runWithPrivacyAcknowledgmentRefresh(client, () => store.eir.respond(input)),
      ),
    onSuccess: (record) => {
      client.setQueryData(queryKeys.eir(record.principalId), record);
      void client.invalidateQueries({ queryKey: queryKeys.eirInbox() });
    },
  });
}

export function useDecideEir() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      principalId: string;
      decision: EirDecision;
      actorScimId: string;
      actorName?: string;
      note?: string;
      /** The EIR version the validator read (`EirRecord.version`). */
      expectedVersion?: number;
    }) =>
      store.eir.decide(
        input.principalId,
        input.decision,
        input.actorScimId,
        input.note,
        input.actorName,
        input.expectedVersion,
      ),
    onSuccess: (record) => {
      client.setQueryData(queryKeys.eir(record.principalId), record);
      void client.invalidateQueries({ queryKey: queryKeys.eirInbox() });
    },
  });
}

export interface CatalogSnapshot {
  domains: BusinessDomain[];
  datasets: DataAsset[];
  bundles: AccessBundle[];
  systems: SourceSystem[];
  personas: OnboardingPersona[];
  tenants: Tenant[];
}

/** Read the whole catalog (domains, datasets, bundles, systems, personas, tenants). */
export function useCatalog(): UseQueryResult<CatalogSnapshot> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.catalog,
    queryFn: async (): Promise<CatalogSnapshot> => {
      const [domains, datasets, bundles, systems, personas, tenants] = await Promise.all([
        store.catalog.listDomains(),
        store.catalog.listDatasets(),
        store.catalog.listBundles(),
        store.catalog.listSystems(),
        store.catalog.listPersonas(),
        store.catalog.listTenants(),
      ]);
      return { domains, datasets, bundles, systems, personas, tenants };
    },
  });
}

/** Read the current user/session profile. */
export function useUser(): UseQueryResult<UserProfile> {
  const store = useStore();
  return useQuery({ queryKey: queryKeys.user(), queryFn: () => store.catalog.getUser() });
}

/** Read the tenant's access requests. */
export function useRequests(): UseQueryResult<AccessRequest[]> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.requestList(),
    queryFn: () => store.requests.listRequests(),
  });
}

/** Read one request by id. */
export function useRequest(id: string): UseQueryResult<AccessRequest | undefined> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.request(id),
    queryFn: () => store.requests.getRequest(id),
    enabled: id.length > 0,
  });
}

/** Read the enterprise onboarding/access pipeline (admin). */
export function usePipeline(): UseQueryResult<PipelineEntry[]> {
  const store = useStore();
  return useQuery({ queryKey: queryKeys.pipeline(), queryFn: () => store.requests.listPipeline() });
}

/** Read one request's status/timeline projection through the StatusStore. */
export function useRequestStatus(id: string): UseQueryResult<RequestStatus | undefined> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.requestStatus(id),
    queryFn: () => store.status.getRequestStatus(id),
    enabled: id.length > 0,
  });
}

/** Read the StatusStore projection for every request, keyed by id. */
export function useStatuses(): UseQueryResult<Record<string, RequestStatus>> {
  const store = useStore();
  return useQuery({
    queryKey: queryKeys.statusAll(),
    queryFn: () => store.status.listRequestStatuses(),
  });
}

/** Read the ordered stage labels a request moves through. */
export function useStages(): UseQueryResult<string[]> {
  const store = useStore();
  return useQuery({ queryKey: queryKeys.stages(), queryFn: () => store.status.listStages() });
}

/** Read the current user's active access. */
export function useMyAccess(): UseQueryResult<MyAccess> {
  const store = useStore();
  return useQuery({ queryKey: queryKeys.myAccess(), queryFn: () => store.status.getMyAccess() });
}

interface SubmitContext {
  previousList: AccessRequest[] | undefined;
  previousDetail: AccessRequest | undefined;
  hadDetail: boolean;
  previousStatusAll: Record<string, RequestStatus> | undefined;
  previousStatusDetail: RequestStatus | undefined;
  hadStatusDetail: boolean;
}

/** Derive the StatusStore projection shape from a request + known stages. */
function projectStatus(request: AccessRequest, stages: string[]): RequestStatus {
  return {
    requestId: request.id,
    status: request.status,
    overall: request.overall,
    stageIndex: request.stageIndex,
    stages,
    subRequests: request.subRequests,
  };
}

/**
 * Submit a new request. Optimistically prepends it to the cached list, seeds
 * the detail cache AND the status caches (so the status screen shows a single,
 * consistent representation immediately), then invalidates the request + status
 * families so the authoritative data is re-read through the seam. On error it
 * rolls every touched cache back so no phantom request is left behind.
 */
export function useSubmitRequest(): UseMutationResult<
  AccessRequest,
  Error,
  AccessRequest,
  SubmitContext
> {
  const store = useStore();
  const queryClient = useQueryClient();
  return useMutation<AccessRequest, Error, AccessRequest, SubmitContext>({
    mutationFn: (request) => store.requests.createRequest(request),
    onMutate: async (request) => {
      // Cancel in-flight fetches for every cache we touch so a landing refetch
      // can't overwrite the optimistic list/detail/status entries.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.requestList() }),
        queryClient.cancelQueries({ queryKey: queryKeys.statusAll() }),
        queryClient.cancelQueries({ queryKey: queryKeys.requestStatus(request.id) }),
      ]);

      // Request list + detail.
      const previousList = queryClient.getQueryData<AccessRequest[]>(queryKeys.requestList());
      const detailKey = queryKeys.request(request.id);
      const previousDetail = queryClient.getQueryData<AccessRequest>(detailKey);
      const hadDetail = previousDetail !== undefined;
      queryClient.setQueryData<AccessRequest[]>(queryKeys.requestList(), (list) => [
        request,
        ...(list ?? []),
      ]);
      queryClient.setQueryData<AccessRequest>(detailKey, request);

      // Status caches — seed the projection so the status screen never shows a
      // brief second representation. Only when stages are already known (they
      // are once the app has loaded), so the projection is complete.
      const statusDetailKey = queryKeys.requestStatus(request.id);
      const previousStatusAll = queryClient.getQueryData<Record<string, RequestStatus>>(
        queryKeys.statusAll(),
      );
      const previousStatusDetail = queryClient.getQueryData<RequestStatus>(statusDetailKey);
      const hadStatusDetail = previousStatusDetail !== undefined;
      const stages = queryClient.getQueryData<string[]>(queryKeys.stages());
      if (stages) {
        const projection = projectStatus(request, stages);
        queryClient.setQueryData<Record<string, RequestStatus>>(queryKeys.statusAll(), (map) => ({
          ...(map ?? {}),
          [request.id]: projection,
        }));
        queryClient.setQueryData<RequestStatus>(statusDetailKey, projection);
      }

      return {
        previousList,
        previousDetail,
        hadDetail,
        previousStatusAll,
        previousStatusDetail,
        hadStatusDetail,
      };
    },
    onError: (_error, request, context) => {
      if (context?.previousList) {
        queryClient.setQueryData(queryKeys.requestList(), context.previousList);
      }
      const detailKey = queryKeys.request(request.id);
      if (context?.hadDetail) {
        queryClient.setQueryData(detailKey, context.previousDetail);
      } else {
        queryClient.removeQueries({ queryKey: detailKey, exact: true });
      }
      if (context?.previousStatusAll !== undefined) {
        queryClient.setQueryData(queryKeys.statusAll(), context.previousStatusAll);
      } else {
        queryClient.removeQueries({ queryKey: queryKeys.statusAll(), exact: true });
      }
      const statusDetailKey = queryKeys.requestStatus(request.id);
      if (context?.hadStatusDetail) {
        queryClient.setQueryData(statusDetailKey, context.previousStatusDetail);
      } else {
        queryClient.removeQueries({ queryKey: statusDetailKey, exact: true });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.requests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

// ---- EIR definitions (#201) ---------------------------------------------------

/**
 * The active EIR form and the forms behind `versions` (#201). Each is
 * registered by version, so stored answers show with their own labels.
 * Refused (503) with no current form.
 */
export function useEirForms(
  versions: readonly string[],
  enabled = true,
): UseQueryResult<EirFormsAnswer> {
  const store = useStore();
  return useQuery<EirFormsAnswer, Error>({
    queryKey: queryKeys.eirForms(versions),
    queryFn: async () => {
      const answer = await store.eirForms.forms(versions);
      for (const form of [answer.active, ...Object.values(answer.forms)]) registerEirForm(form);
      return answer;
    },
    // No current form is the server's answer, not a glitch: shown at once, not retried.
    retry: (failureCount, error) =>
      (error as { code?: unknown }).code !== "eir-unavailable" && eirReadRetry(failureCount, error),
    retryDelay: eirReadRetryDelay,
    enabled,
  });
}

export function useEirDefinitionHistory(enabled = true): UseQueryResult<EirDefinitionHistory> {
  const store = useStore();
  return useQuery<EirDefinitionHistory, Error>({
    queryKey: queryKeys.eirDefinitionHistory(),
    queryFn: () => store.eirDefinitions.history(),
    enabled,
    retry: eirReadRetry,
    retryDelay: eirReadRetryDelay,
  });
}

export function useEirDefinitionVersion(
  versionNumber: number | undefined,
): UseQueryResult<PublishedEirDefinition> {
  const store = useStore();
  return useQuery<PublishedEirDefinition, Error>({
    queryKey: queryKeys.eirDefinitionVersion(versionNumber ?? 0),
    queryFn: () => store.eirDefinitions.get(versionNumber!),
    enabled: versionNumber !== undefined,
    retry: eirReadRetry,
    retryDelay: eirReadRetryDelay,
  });
}

/** Validate and preview a definition on the server. Publishes nothing. */
export function useCheckEirDefinition(): UseMutationResult<EirDefinitionCheck, Error, string> {
  const store = useStore();
  return useMutation({
    mutationFn: (sourceYaml: string) => store.eirDefinitions.check(sourceYaml),
  });
}

export function usePublishEirDefinition() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishEirDefinitionInput) => store.eirDefinitions.publish(input),
    // Not awaited: the confirmation is the server's reply, not the list's
    // refresh (about 1-2 s more on Delta, #210 UAT). Writes wait for the refresh.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.eirDefinitions });
    },
  });
}

export function useActivateEirDefinition() {
  const store = useStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ActivateEirDefinitionInput) => store.eirDefinitions.activate(input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.eirDefinitions });
      void client.invalidateQueries({ queryKey: queryKeys.eirFormsAll });
    },
  });
}
