/**
 * The two EIR definition repositories the publication contract runs against,
 * built the way the app builds them:
 *
 * - **memory**: {@link createMemoryEirDefinitionRepository}.
 * - **delta**: the browser's {@link createDeltaEirDefinitionRepository},
 *   talking to the real Delta API handler, transaction runner and
 *   `eir-definitions` area over the SQLite fake warehouse built from the
 *   real DDL, and to the real check endpoint. Who's signed in comes from the
 *   session, as in the app.
 */
import { createHash } from "node:crypto";

import { readBootstrapEirSource } from "../../../data/eir/definition/bootstrap-source.ts";
import { createDeltaEirDefinitionRepository } from "../../../data/eir/definition/delta-repository.ts";
import type { EirDefinitionCheck } from "../../../data/eir/definition/check.ts";
import {
  createMemoryEirDefinitionRepository,
  type EirDefinitionRepository,
  type EirDefinitions,
  type EirDefinitionVersions,
} from "../../../data/eir/definition/repository.ts";
import type { DeltaApiTransport } from "../../../data/adapters/delta";
import { handleEirDefinitionCheckRequest } from "../../eir-definition-check.ts";
import { handleDeltaApiRequest, type DeltaApiDeps } from "../api.ts";
import {
  EIR_DEFINITION_REGISTER_ID,
  registerEirDefinitionsArea,
  resolveEirDefinitions,
} from "../areas/eir-definitions.ts";
import { createRegistry, type AppSurface, type SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";
import { createTransactionRunner, type AttemptInfo } from "../transaction.ts";
import {
  createClock,
  deltaImplementation,
  memoryImplementation,
  type Clock,
  type EirImplementation,
} from "./eir-harness.ts";
import { createSqliteWarehouse } from "./eir-sqlite-warehouse.ts";

/** The fallback built-in definition's YAML (`bootstrap-2`, #217: every rule blocks). */
export const BOOTSTRAP_YAML = readBootstrapEirSource()!;
/** The bootstrap definition's YAML (`bootstrap`, mixed dispositions): the base of the synthetic published definitions. */
export const BOOTSTRAP_1_YAML = readBootstrapEirSource("bootstrap")!;

const person = (principalId: string, displayName: string, roles: Partial<SessionUser> = {}) =>
  ({
    principalId,
    displayName,
    email: `${displayName.split(" ")[0]!.toLowerCase()}@example.gov`,
    isAdmin: false,
    onboardingReviewerRoles: [],
    isSafeguardsValidator: false,
    ...roles,
  }) satisfies SessionUser;

/** The configured Safeguards role (the safeguards-validator group). */
export const SAFEGUARDS = person("4001", "Sara Safeguards", { isSafeguardsValidator: true });
export const SAFEGUARDS_TWO = person("4002", "Sam Second", { isSafeguardsValidator: true });
/** EDP staff who aren't Safeguards. */
export const EDP_STAFF = person("3001", "Edna Staff", { isAdmin: true });
/** Anyone else: an employee using the tenant app. */
export const EMPLOYEE = person("1001", "Test Person");

/**
 * A synthetic next definition: the bootstrap definition (`bootstrap`, not the
 * fallback `bootstrap-2`) with one changed section title, so its content is its
 * own. It keeps the bootstrap's warning and manual-review rules (#217: a
 * published definition can have any mix of dispositions). It names no
 * version: the server numbers it.
 */
export function nextDefinitionYaml(n: number): string {
  return BOOTSTRAP_1_YAML.replace(
    "      title: User details\n",
    `      title: User details (v${n})\n`,
  );
}

/**
 * A synthetic definition with the bootstrap definition's questions (`bootstrap`), word for word, and
 * other rules: each rule `flagged` (`mbi-investigation-complete`,
 * `irm-acknowledged`) flags a `warning` rather than `manual-review`.
 */
export function sameQuestionsYaml(...flagged: string[]): string {
  return flagged.reduce((yaml, rule) => {
    const at = yaml.indexOf(`  - id: ${rule}\n`);
    const end = yaml.indexOf("disposition: manual-review", at);
    if (at < 0 || end < 0) throw new Error(`No manual-review rule ${rule}.`);
    return `${yaml.slice(0, end)}disposition: warning${yaml.slice(end + "disposition: manual-review".length)}`;
  }, BOOTSTRAP_1_YAML);
}

export interface DefinitionImplementation {
  name: "memory" | "delta";
  clock: Clock;
  as(user: SessionUser): EirDefinitionRepository;
}

/**
 * Versions already in the store, as an earlier app published them: the
 * YAML and its hash only. They needn't pass today's checks (that's the point).
 */
export interface StoredVersionsOption {
  storedVersions?: string[];
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function memoryDefinitions(
  clock = createClock(),
  options: StoredVersionsOption = {},
): DefinitionImplementation {
  const repositories = createMemoryEirDefinitionRepository({
    clock: () => clock.now,
    initialVersions: (options.storedVersions ?? []).map((sourceYaml) => ({
      sourceYaml,
      contentSha256: sha256Hex(sourceYaml),
      publishedAt: clock.now.toISOString(),
      publishedBy: { principalId: "4001", display: "Sara Safeguards", app: "staff" as const },
    })),
  });
  return { name: "memory", clock, as: (user) => repositories.as(user) };
}

export interface DeltaDefinitionImplementation extends DefinitionImplementation {
  name: "delta";
  warehouse: ReturnType<typeof createSqliteWarehouse>;
  deps: DeltaApiDeps;
  attempts: AttemptInfo[];
  /** Send one API request as `user`, on an app serving `serves`. */
  request(user: SessionUser, request: Request, serves?: AppSurface[]): Promise<Response>;
}

export function definitionImplementation(
  clock = createClock(),
  options: StoredVersionsOption & {
    register?: (registry: ReturnType<typeof createRegistry>) => void;
  } = {},
): DeltaDefinitionImplementation {
  const warehouse = createSqliteWarehouse({
    now: () => clock.now,
    files: ["store-admin.sql", "store-eir.sql", "store-eir-definitions.sql"],
  });
  const names = createStoreNames("edp_vending", "");
  insertStoredVersions(warehouse, options.storedVersions ?? [], clock.now);
  const registry = createRegistry();
  registerEirDefinitionsArea(registry);
  options.register?.(registry);
  const attempts: AttemptInfo[] = [];
  const runner = createTransactionRunner({
    client: warehouse.client,
    names,
    now: () => clock.now,
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
  const request = (user: SessionUser, req: Request, serves: AppSurface[] = deps.serves) =>
    new URL(req.url).pathname === "/api/eir-definitions/check"
      ? handleEirDefinitionCheckRequest(req, { resolveUser: async () => user, serves })
      : handleDeltaApiRequest(req, { ...deps, serves, resolveUser: async () => user });

  const send = async <T>(user: SessionUser, req: Request): Promise<T> => {
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
  const transportFor = (user: SessionUser): DeltaApiTransport => ({
    read: (area, name, query) =>
      send(
        user,
        new Request(
          `https://app/api/reads/${area}/${name}${query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`,
        ),
      ),
    command: (area, name, body) =>
      send(
        user,
        new Request(`https://app/api/commands/${area}/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    legacyWrite: () => Promise.reject(new Error("No legacy writes here.")),
  });
  const impl: DeltaDefinitionImplementation = {
    name: "delta",
    clock,
    warehouse,
    deps,
    attempts,
    request,
    as: (user) =>
      createDeltaEirDefinitionRepository({
        transport: transportFor(user),
        check: (sourceYaml) =>
          send<EirDefinitionCheck>(
            user,
            new Request("https://app/api/eir-definitions/check", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sourceYaml }),
            }),
          ),
      }),
  };
  return impl;
}

/** An employee's EIR and the definitions it's drafted on, sharing one store. */
export interface EirWithDefinitions {
  name: "memory" | "delta";
  clock: Clock;
  eir: EirImplementation;
  definitions: (user: SessionUser) => EirDefinitionRepository;
  /** The store's typed definitions: the active one, and those `wanted` names. */
  resolve: (wanted: EirDefinitionVersions) => Promise<EirDefinitions>;
}

export function memoryEirWithDefinitions(clock = createClock()): EirWithDefinitions {
  const definitions = createMemoryEirDefinitionRepository({ clock: () => clock.now });
  return {
    name: "memory",
    clock,
    eir: memoryImplementation(clock, { definitions: definitions.definitions }),
    definitions: (user) => definitions.as(user),
    resolve: async () => definitions.definitions,
  };
}

export function deltaEirWithDefinitions(clock = createClock()): EirWithDefinitions & {
  eir: ReturnType<typeof deltaImplementation>;
} {
  const eir = deltaImplementation(clock);
  registerEirDefinitionsArea(eir.deps.registry);
  const send = async <T>(user: SessionUser, req: Request): Promise<T> => {
    const response = await eir.request(user, req);
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
    name: "delta",
    clock,
    eir,
    resolve: (wanted) =>
      resolveEirDefinitions(
        { names: eir.deps.names, read: eir.deps.runner.reader({ readId: "test-resolve" }) },
        wanted,
      ),
    definitions: (user) =>
      createDeltaEirDefinitionRepository({
        transport: {
          read: (area, name, query) =>
            send(
              user,
              new Request(
                `https://app/api/reads/${area}/${name}${query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`,
              ),
            ),
          command: (area, name, body) =>
            send(
              user,
              new Request(`https://app/api/commands/${area}/${name}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            ),
          legacyWrite: () => Promise.reject(new Error("No legacy writes here.")),
        },
        // The real check endpoint, as the staff app serves it.
        check: (sourceYaml) =>
          handleEirDefinitionCheckRequest(
            new Request("https://app/api/eir-definitions/check", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sourceYaml }),
            }),
            { resolveUser: async () => user, serves: ["tenant", "staff"] },
          ).then(async (response) => {
            const body = (await response.json()) as EirDefinitionCheck & {
              error?: { message: string };
            };
            if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
            return body;
          }),
      }),
  };
}

/** {@link StoredVersionsOption} on Delta: rows as an earlier app wrote them. */
export function insertStoredVersions(
  warehouse: ReturnType<typeof createSqliteWarehouse>,
  versions: string[],
  at: Date,
): void {
  if (!versions.length) return;
  const when = at.toISOString();
  versions.forEach((sourceYaml, i) => {
    const n = i + 1;
    warehouse.query(
      `INSERT INTO "eir__eir_definition_versions" (id, version_number, definition_version, form_version, source_yaml, normalized_definition, content_sha256, published_action_id, published_at, published_by_principal_id, published_by_display, published_by_app, created_at) VALUES (:id, :n, :dv, :fv, :yaml, '{}', :sha, 'earlier-app', :at, '4001', 'Sara Safeguards', 'staff', :at)`,
      {
        id: `5a0c9b1e-0000-4000-8000-${String(n).padStart(12, "0")}`,
        n,
        // The version number as text, as publish writes it (#224).
        dv: String(n),
        fv: String(n),
        yaml: sourceYaml,
        sha: sha256Hex(sourceYaml),
        at: when,
      },
    );
  });
  warehouse.query(
    `INSERT INTO "eir__eir_definition_register" (id, active_version_number, latest_version_number, version, created_at, created_by_principal_id, updated_at, updated_by_principal_id, last_action_id) VALUES (:id, NULL, :n, :n, :at, '4001', :at, '4001', 'earlier-app')`,
    { id: EIR_DEFINITION_REGISTER_ID, n: versions.length, at: when },
  );
}
