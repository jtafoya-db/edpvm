/**
 * Public surface of the data-access seam.
 *
 * Components import from `@/data` and get the typed hooks + provider; they
 * never import a concrete adapter. See store.ts for the seam interfaces and
 * loadStore.ts for how the active backend is chosen.
 */
export { StoreProvider } from "./store-provider";
export { useStore } from "./store-context";
export {
  queryKeys,
  useCatalog,
  useUser,
  useRequests,
  useRequest,
  usePipeline,
  useRequestStatus,
  useStatuses,
  useStages,
  useMyAccess,
  useSubmitRequest,
  useEir,
  useEirInbox,
  useSaveEirDraft,
  useEvaluateEirDraft,
  useGenerateEirPdf,
  useStartEir,
  useSubmitEirFile,
  useRespondEir,
  useDecideEir,
  useEirForms,
  useEirDefinitionHistory,
  useEirDefinitionVersion,
  useCheckEirDefinition,
  usePublishEirDefinition,
  useActivateEirDefinition,
  usePrivacyAcknowledgment,
  useAcknowledgePrivacyNotice,
  type CatalogSnapshot,
} from "./queries";
export { useLegacyAppData, type LegacyAppData, type LegacyAppState } from "./legacy-bridge";
export { loadStore, activeBackend, resetStoreForTests, type DataBackend } from "./loadStore";
export { createMemoryStore } from "./adapters/memory";
export { createDeltaStore, type DeltaStoreConfig } from "./adapters/delta";
export type { CatalogStore, DataStore, RequestStore, StatusStore } from "./store";
export type * from "./types";
export type * from "./eir/types";
export * from "./eir/config";
export * from "./eir/form";
export * from "./eir/pdf";
export { withoutLegacyMarker } from "./eir/self-decision";
export {
  CHANGED_ANSWERS_REFUSAL,
  EIR_UNAVAILABLE_MESSAGE,
  formForNextSave,
} from "./eir/repository";
export { eirFormsFrom } from "./eir/definition/repository";
export { definitionLabel, eirFormName } from "./eir/definition/identity";
export { eirErrorStatus, isEirReadRefusal } from "./eir/errors";
export { canAuthorEirDefinitions, canReadEirDefinitions } from "./eir/definition/access";
export type { EirDefinitionCheck } from "./eir/definition/check";
export type { EirScenarioResult } from "./eir/definition/scenarios";
export type {
  EirDefinitionActivation,
  EirDefinitionHistory,
  EirDefinitionVersionSummary,
  EirFormsAnswer,
  PublishedEirDefinition,
} from "./eir/definition/repository";
export { ACTIVE_PRIVACY_NOTICE } from "./privacy/notice";
export type * from "./privacy/repository";
export * from "./lifecycle";
export * from "./canonical-request";
export * from "./sla";
export * from "./group-membership";
export * from "./onboarding";
