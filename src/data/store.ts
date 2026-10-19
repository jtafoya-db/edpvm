/**
 * The data-access seam.
 *
 * The app reads and writes its domain state ONLY through these typed
 * repository interfaces — never directly against a concrete backend. This is
 * the same "seam" pattern as `loadSchema()` (build-plan-p1.md §2/OQ-7):
 * callers depend on the interface, and switching from the P1 in-memory adapter
 * to a Delta/UC-backed adapter is a one-adapter change, not a rewrite.
 *
 * All methods are async so a network/Delta-backed implementation is a drop-in.
 */
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
  WaiverAttestation,
} from "./types";
import type { EirRepository } from "./eir/repository";
import type { EirDefinitionRepository, EirFormSource } from "./eir/definition/repository";
import type { PrivacyAcknowledgmentRepository } from "./privacy/repository";
import type { ChangeListStore } from "./change-list/store";
import type { DatasetRoleStore, DatasetStore } from "./datasets/store";
import type { OnboardingStore } from "./onboarding/store";
import type { AccessRequestStore } from "./access-requests/store";
import type { DatasetTeamStore } from "./datasets/team-store";
import type { GroupMembershipReader } from "./group-membership";

/** Reference/catalog reads: domains, datasets, bundles, systems, personas, tenants, user. */
export interface CatalogStore {
  listSystems(): Promise<SourceSystem[]>;
  getSystem(id: string): Promise<SourceSystem | undefined>;
  listDomains(): Promise<BusinessDomain[]>;
  getDomain(id: string): Promise<BusinessDomain | undefined>;
  listBundles(): Promise<AccessBundle[]>;
  getBundle(id: string): Promise<AccessBundle | undefined>;
  listDatasets(): Promise<DataAsset[]>;
  getDataset(id: string): Promise<DataAsset | undefined>;
  listPersonas(): Promise<OnboardingPersona[]>;
  listTenants(): Promise<Tenant[]>;
  /** The current user/session profile. */
  getUser(): Promise<UserProfile>;
}

/** Request reads + writes: the access requests a tenant submits, plus the admin pipeline. */
export interface RequestStore {
  listRequests(): Promise<AccessRequest[]>;
  getRequest(id: string): Promise<AccessRequest | undefined>;
  /** Persist a newly submitted request and return the stored record. */
  createRequest(request: AccessRequest): Promise<AccessRequest>;
  transitionRequest(
    id: string,
    update: Pick<AccessRequest, "status" | "overall" | "stageIndex" | "subRequests">,
  ): Promise<AccessRequest>;
  appendWaiverAttestation(attestation: WaiverAttestation): Promise<WaiverAttestation>;
  listPipeline(): Promise<PipelineEntry[]>;
}

/** Status reads: the approval/provisioning timeline and the current user's access. */
export interface StatusStore {
  /** The ordered stage labels a request moves through. */
  listStages(): Promise<string[]>;
  /** Read every request's status/timeline projection, keyed by request id. */
  listRequestStatuses(): Promise<Record<string, RequestStatus>>;
  /** A read projection of one request's status/timeline, or undefined if unknown. */
  getRequestStatus(id: string): Promise<RequestStatus | undefined>;
  getMyAccess(): Promise<MyAccess>;
}

export type { OnboardingStore } from "./onboarding/store";

/** The full seam handed to the app. One object, one field per repository. */
export interface DataStore {
  groupMemberships: GroupMembershipReader;
  catalog: CatalogStore;
  requests: RequestStore;
  status: StatusStore;
  eir: EirRepository;
  /** Published EIR definitions and their activation (#201): the Safeguards workspace. */
  eirDefinitions: EirDefinitionRepository;
  /** Which EIR form the signed-in person's next save uses (#201). */
  eirForms: EirFormSource;
  privacyAcknowledgments: PrivacyAcknowledgmentRepository;
  /** Initiatives, datasets and their owners (ADR-0005). */
  datasets: DatasetStore;
  /** Dataset roles and direct adds by dataset owners (ADR-0005). */
  datasetRoles: DatasetRoleStore;
  /** Editing and removing roles, and managing owners (#87). */
  datasetTeam: DatasetTeamStore;
  /** The change list EDP staff apply by hand (ADR-0005). */
  changeList: ChangeListStore;
  /** Onboarding requests on the new lifecycle (#86), alongside the old seven-stage requests. */
  onboarding: OnboardingStore;
  /** Access requests to dataset owners (ADR-0005). */
  accessRequests: AccessRequestStore;
}
