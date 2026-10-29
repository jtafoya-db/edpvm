/**
 * The two EIR repositories the contract tests run against, built the same
 * way the app builds them:
 *
 * - **memory**: {@link createMemoryEirRepository}, the in-browser store.
 * - **delta**: the browser's {@link createDeltaEirRepository}, talking to the
 *   real Delta API handler, transaction runner and `eir` area, over the
 *   SQLite fake warehouse built from `resources/store-eir.sql`. Who's signed
 *   in comes from the session, as in the app; the PDF upload lands in a fake
 *   volume the area reads back to hash.
 *
 * Both share one clock and one sequence of volume paths, so the same steps
 * give comparable records.
 */
import { EIR_VALUES } from "../../../data/__tests__/eir-fixtures.ts";
import { readBootstrapEirSource } from "../../../data/eir/definition/bootstrap-source.ts";
import { loadDefinition } from "../../../data/eir/definition/load.ts";
import type { EirDefinition } from "../../../data/eir/definition/types.ts";
import { DISPLAY_CODE_ALPHABET, newDisplayCode } from "../../../data/display-codes.ts";
import { createDeltaEirRepository } from "../../../data/eir/delta-repository";
import {
  createMemoryEirRepository,
  type EirDefinitionLookup,
  type EirRepository,
  type EirUploadWrite,
} from "../../../data/eir/repository";
import type { EirEvaluation } from "../../../data/eir/types.ts";
import type { EirApprovalConfig } from "../../../data/eir/approval-mode.ts";
import type { evaluateEirDraft } from "../../../data/eir/evaluation.ts";
import type { EffectiveSlaConfig } from "../../../data/sla-config.ts";
import type { DeltaApiTransport } from "../../../data/adapters/delta";
import { eirVolumePath, type EirVolumeConfig } from "../../eir-storage";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import { registerEirArea } from "../areas/eir.ts";
import { createRegistry, type SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner, type AttemptInfo } from "../transaction.ts";
import { createSqliteWarehouse } from "./eir-sqlite-warehouse.ts";

export const VOLUME: EirVolumeConfig = { catalog: "edp", schema: "docs", volume: "eir" };

const person = (principalId: string, displayName: string, validator = false): SessionUser => ({
  principalId,
  displayName,
  email: `${displayName.split(" ")[0]!.toLowerCase()}@example.gov`,
  isAdmin: false,
  onboardingReviewerRoles: [],
  isSafeguardsValidator: validator,
});

export const APPLICANT = person("1001", "Test Person");
export const OTHER_PERSON = person("1002", "Sample Applicant");
export const VAL = person("2001", "Val Idator", true);
export const VIC = person("2002", "Vic Second", true);
/** EDP staff, but not a safeguards validator. */
export const STAFF: SessionUser = { ...person("3001", "Sam Staff"), isAdmin: true };

export const VALUES = EIR_VALUES;

/** The bootstrap definition (`bootstrap`, form 1.3's rules), typed: its rules mix blocking, warning and manual-review. */
export function bootstrap1(): EirDefinition {
  const loaded = loadDefinition(readBootstrapEirSource("bootstrap")!, "bootstrap");
  if (!loaded.ok) throw new Error("The bootstrap definition must load.");
  return loaded.definition;
}

/**
 * A store whose active definition is the bootstrap definition (`bootstrap`):
 * its warning and manual-review rules, now that the fallback built-in
 * (`bootstrap-2`, #217) blocks on every rule. Drafts pin to `bootstrap` (#224).
 */
export const ON_BOOTSTRAP_1: { definitions: EirDefinitionLookup; shownFormVersion: string } = {
  definitions: {
    active: bootstrap1,
    byId: (id) => (id === "bootstrap" ? bootstrap1() : undefined),
  },
  shownFormVersion: "bootstrap",
};

/**
 * The repository as a screen showing form `shown` uses it: a save or upload
 * that names no form version names that one, as the screen always does.
 */
function showingForm(repository: EirRepository, shown: string | undefined): EirRepository {
  if (!shown) return repository;
  return {
    ...repository,
    saveDraft: (principalId, values, expectedDraftVersion, formVersion) =>
      repository.saveDraft(principalId, values, expectedDraftVersion, formVersion ?? shown),
    submitWithFile: (input) =>
      repository.submitWithFile({ ...input, formVersion: input.formVersion ?? shown }),
    preparePdf: (input) =>
      repository.preparePdf({ ...input, formVersion: input.formVersion ?? shown }),
  };
}

export const pdf = (text = "signed") =>
  new File([`%PDF-1.7 ${text}`], "signed.pdf", { type: "application/pdf" });

export interface Clock {
  now: Date;
  advance(ms: number): void;
}

export function createClock(start = "2026-10-01T12:00:00.000Z"): Clock {
  const clock = {
    now: new Date(start),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  return clock;
}

/**
 * Record IDs in order (`EIR-00000A`, `EIR-00000B`…): the same sequence in
 * both implementations, so their records compare equal. Real ones are random
 * (`src/data/display-codes.ts`).
 */
export function recordIdSequence() {
  let n = 9;
  return () => {
    let value = ++n;
    let code = "";
    for (let i = 0; i < 6; i++, value = Math.floor(value / 32)) {
      code = DISPLAY_CODE_ALPHABET[value % 32] + code;
    }
    return `EIR-${code}`;
  };
}

/** The n-th signed PDF's path for a person: the same in both implementations. */
function pathSequence() {
  let n = 0;
  return (principalId: string) => {
    n += 1;
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    return eirVolumePath(VOLUME, principalId, `${1790000000000 + n}-${id}`);
  };
}

export interface EirImplementation {
  name: "memory" | "delta";
  clock: Clock;
  /** The repository as `user` sees it (memory has one shared store for everyone). */
  as(user: SessionUser): EirRepository;
}

export function memoryImplementation(
  clock = createClock(),
  options: {
    selfDecisionTestMode?: boolean;
    /** The store's EIR definitions (#201): what saves use and drafts are evaluated against. */
    definitions?: EirDefinitionLookup;
    /** The form version saves and uploads name when a test gives none (the screen's). */
    shownFormVersion?: string;
    evaluator?: typeof evaluateEirDraft;
    persistEvaluation?: (evaluation: EirEvaluation) => void;
    /** The deploy-time approval settings (#204); manual-validator when unset. */
    approval?: EirApprovalConfig;
    /** Refuse the signed PDF's write to the volume while it returns true. */
    failFileWrite?: () => boolean;
    /** Fail an upload at one of its writes (`EirUploadWrite`). */
    writeFailpoint?: (write: EirUploadWrite) => void;
  } = {},
): EirImplementation {
  const nextPath = pathSequence();
  const repository = createMemoryEirRepository({
    clock: () => clock.now,
    newRecordId: recordIdSequence(),
    filePath: (principalId) => nextPath(principalId),
    ...(options.selfDecisionTestMode ? { selfDecisionTestMode: true } : {}),
    ...(options.definitions ? { definitions: options.definitions } : {}),
    ...(options.evaluator ? { evaluator: options.evaluator } : {}),
    ...(options.persistEvaluation ? { persistEvaluation: options.persistEvaluation } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.writeFailpoint ? { writeFailpoint: options.writeFailpoint } : {}),
    ...(options.failFileWrite
      ? {
          fileStorage: {
            write: async () => {
              if (options.failFileWrite!()) throw new Error("synthetic volume write failure");
            },
          },
        }
      : {}),
  });
  const shown = showingForm(repository, options.shownFormVersion);
  return { name: "memory", clock, as: () => shown };
}

export interface DeltaImplementation extends EirImplementation {
  name: "delta";
  warehouse: ReturnType<typeof createSqliteWarehouse>;
  files: Map<string, Uint8Array>;
  deps: DeltaApiDeps;
  attempts: AttemptInfo[];
  /** Send one API request as `user`, as the browser would. */
  request(user: SessionUser, request: Request): Promise<Response>;
  /** A newly loaded browser client over the same server/store. */
  fresh(user: SessionUser): EirRepository;
}

export function deltaImplementation(
  clock = createClock(),
  options: {
    selfDecisionTestMode?: boolean;
    schemaPrefix?: string;
    slaConfig?: EffectiveSlaConfig;
    /** Stands in for the store's EIR definitions (#201); the real resolver when unset. */
    definitions?: EirDefinitionLookup;
    /** The form version saves and uploads name when a test gives none (the screen's). */
    shownFormVersion?: string;
    evaluator?: typeof evaluateEirDraft;
    /** Refuse every insert into `eir_evaluations` (or only while it returns true). */
    failEvaluationPersistence?: boolean | (() => boolean);
    /** The deploy-time approval settings (#204); manual-validator when unset. */
    approval?: EirApprovalConfig;
    /** Refuse the signed PDF's upload to the volume while it returns true. */
    failUpload?: () => boolean;
    /** Fail a block right after one of its writes (`createSqliteWarehouse`'s `failWrite`). */
    failWrite?: (statement: string, values: Record<string, unknown>) => boolean;
  } = {},
): DeltaImplementation {
  const nextPath = pathSequence();
  const warehouse = createSqliteWarehouse({
    now: () => clock.now,
    ...(options.schemaPrefix ? { schemaPrefix: options.schemaPrefix } : {}),
    ...(options.failWrite ? { failWrite: options.failWrite } : {}),
  });
  const files = new Map<string, Uint8Array>();
  if (options.failEvaluationPersistence) {
    const execute = warehouse.client.execute.bind(warehouse.client);
    const failing = options.failEvaluationPersistence;
    warehouse.client.execute = (statement, tag) => {
      if (
        (failing === true || (typeof failing === "function" && failing())) &&
        /INSERT INTO [^\s]*eir_evaluations\b/.test(statement.statement)
      ) {
        throw new Error("synthetic evaluation persistence failure");
      }
      return execute(statement, tag);
    };
  }
  const names = createStoreNames("edp_vending", options.schemaPrefix ?? "");
  const registry = createRegistry();
  registerEirArea(registry, {
    now: () => clock.now,
    volume: () => VOLUME,
    readFile: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Unity Catalog volume read failed (404).`);
      return bytes;
    },
    maxUploadBytes: () => 10 * 1024 * 1024,
    ...(options.slaConfig ? { slaConfig: () => options.slaConfig! } : {}),
    ...(options.definitions ? { definitions: async () => options.definitions! } : {}),
    ...(options.evaluator ? { evaluator: options.evaluator } : {}),
    ...(options.approval ? { approval: () => options.approval! } : {}),
    // The app's own check (env flag + store prefix) unless a test sets the result.
    ...(options.selfDecisionTestMode !== undefined
      ? { selfDecisionTestMode: () => options.selfDecisionTestMode! }
      : {}),
  });
  const attempts: AttemptInfo[] = [];
  const nextRecordId = recordIdSequence();
  const runner = createTransactionRunner({
    client: warehouse.client,
    names,
    now: () => clock.now,
    newDisplayCode: (prefix) => (prefix === "EIR" ? nextRecordId() : newDisplayCode(prefix)),
    sleep: async () => undefined,
    random: () => 0,
    onAttempt: (info) => attempts.push(info),
  });
  const deps: DeltaApiDeps = {
    registry,
    runner,
    names,
    serves: ["tenant", "staff"],
    resolveUser: async () => {
      throw new Error("Use request(user, …)");
    },
    requirePrivacyAcknowledgment: async () => undefined,
  };
  const request = (user: SessionUser, req: Request) =>
    handleDeltaApiRequest(req, { ...deps, resolveUser: async () => user });

  const transportFor = (user: SessionUser): DeltaApiTransport => {
    const send = async <T>(req: Request): Promise<T> => {
      // Through `impl.request`, so a test can stand in for the network.
      const response = await impl.request(user, req);
      const body = (await response.json()) as T & { error?: { code: string; message: string } };
      if (!response.ok) {
        throw Object.assign(new Error(body.error?.message ?? `HTTP ${response.status}`), {
          status: response.status,
          code: body.error?.code,
        });
      }
      return body;
    };
    return {
      read: (area, name, query) =>
        send(
          new Request(
            `https://app/api/reads/${area}/${name}${query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`,
          ),
        ),
      command: (area, name, body) =>
        send(
          new Request(`https://app/api/commands/${area}/${name}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      legacyWrite: () => Promise.reject(new Error("The EIR area has no legacy writes.")),
    };
  };
  const repositories = new Map<string, EirRepository>();
  const repositoryFor = (user: SessionUser) =>
    showingForm(
      createDeltaEirRepository({
        transport: transportFor(user),
        upload: async (file) => {
          if (options.failUpload?.()) throw new Error("synthetic volume upload failure");
          let volumePath = nextPath(user.principalId);
          // Migration fixtures already use the deterministic path sequence. Skip any
          // persisted or newly written path so a test upload still models a fresh PDF.
          while (
            files.has(volumePath) ||
            warehouse.query(
              `SELECT count(*) AS n FROM eir__eir_submissions WHERE volume_path = '${volumePath}'`,
            )[0]?.["n"]
          ) {
            volumePath = nextPath(user.principalId);
          }
          files.set(volumePath, new Uint8Array(await file.arrayBuffer()));
          return { volumePath };
        },
      }),
      options.shownFormVersion,
    );
  const impl: DeltaImplementation = {
    name: "delta",
    clock,
    warehouse,
    files,
    deps,
    attempts,
    request,
    fresh: repositoryFor,
    as(user) {
      let repository = repositories.get(user.principalId);
      if (!repository) {
        repository = repositoryFor(user);
        repositories.set(user.principalId, repository);
      }
      return repository;
    },
  };
  return impl;
}

/** A record or inbox without the Delta-only version fields, for comparing the two. */
export function comparable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(comparable) as T;
  if (value && typeof value === "object") {
    const { version: _v, draftVersion: _d, ...rest } = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(rest).map(([key, child]) => [key, comparable(child)]),
    ) as T;
  }
  return value;
}
