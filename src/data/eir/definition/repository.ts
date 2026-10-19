/**
 * Published EIR definitions (#201): what a Safeguards author publishes from
 * the staff app's workspace, and which version is active.
 *
 * - **Publish** stores a new, immutable version: the YAML exactly as written,
 *   the normalized definition the #200 service made of it, its content
 *   identity (SHA-256 of the YAML), who published it, from which app, and
 *   when. Nothing edits or deletes a version. The server numbers it (1, 2,
 *   3…, #224): that number is the definition's identity (`identity.ts`),
 *   and the YAML never names one.
 * - **Activate** points new EIR drafts at a published version, as an
 *   append-only action. Reactivating an earlier version is the rollback:
 *   history is never rewritten.
 * - With no activation the fallback built-in definition (`bootstrap-2.eir.yaml`,
 *   #217) is active: the repository-managed recovery source, with the
 *   reserved identity `bootstrap-2` (version 0) that no publish can take.
 *
 * Both commands are version-checked against the register (`version`) and
 * idempotent by key, and are refused whole: a refused command leaves nothing
 * behind. The same rules run in memory and on Delta
 * (`src/server/delta/areas/eir-definitions.ts`), so this file's
 * {@link createMemoryEirDefinitionRepository} is the contract's reference.
 */
import { canAuthorEirDefinitions, canReadEirDefinitions } from "./access.ts";
import {
  checkEirDefinition,
  eirDefinitionBytes,
  MAX_EIR_DEFINITION_BYTES,
  sha256OfText,
  type EirDefinitionCheck,
} from "./check.ts";
import type { EirFormConfig } from "../config.ts";
import { BOOTSTRAP_EIR_FORMS, type EirForms } from "../repository.ts";
import { bootstrapEirDefinition, builtInById, withId } from "./built-in.ts";
import { FALLBACK_BUILT_IN_ID, publishedDefinitionId, publishedVersionNumber } from "./identity.ts";
import { loadDefinition } from "./load.ts";
import type { EirDefinition, EirDefinitionRefusalCode } from "./types.ts";

export type EirDefinitionActorApp = "tenant" | "staff" | "job" | "system";

export interface EirDefinitionActor {
  principalId: string;
  display: string;
  app: EirDefinitionActorApp;
}

export interface EirDefinitionVersionSummary {
  /** 1, 2, 3…: the order versions were published in, assigned by the server. Its identity. */
  versionNumber: number;
  /** SHA-256 of the published YAML. */
  contentSha256: string;
  publishedAt: string;
  publishedBy: EirDefinitionActor;
}

export interface PublishedEirDefinition extends EirDefinitionVersionSummary {
  sourceYaml: string;
  definition: EirDefinition;
}

export interface EirDefinitionActivation {
  versionNumber: number;
  /** The published version active before, or null for the bootstrap definition. */
  previousVersionNumber: number | null;
  /** True when the version had been active before: a rollback. */
  rollback: boolean;
  activatedAt: string;
  activatedBy: EirDefinitionActor;
}

/** Which definition is active: a built-in one by its reserved identity, or a published version. */
export type ActiveEirDefinitionRef =
  { source: "bootstrap"; id: string } | { source: "published"; versionNumber: number };

export interface EirDefinitionHistory {
  /** The register's version: send it back with the next publish or activate. */
  version: number;
  active: ActiveEirDefinitionRef;
  /** Newest first. */
  versions: EirDefinitionVersionSummary[];
  /** Newest first. */
  activations: EirDefinitionActivation[];
}

export interface EirDefinitionCommandResult {
  versionNumber: number;
  /** The register's version after the command. */
  version: number;
  /** Publish only: the SHA-256 of the YAML the server stored as that version. */
  contentSha256?: string;
}

export interface PublishEirDefinitionInput {
  sourceYaml: string;
  expectedVersion: number;
  /** One per intent: a resend with the same key returns the first answer. */
  idempotencyKey?: string;
}

export interface ActivateEirDefinitionInput {
  versionNumber: number;
  expectedVersion: number;
  idempotencyKey?: string;
}

export interface EirDefinitionRepository {
  history(): Promise<EirDefinitionHistory>;
  get(versionNumber: number): Promise<PublishedEirDefinition>;
  /** Validate and preview, on the server; publishes and activates nothing. */
  check(sourceYaml: string): Promise<EirDefinitionCheck>;
  publish(input: PublishEirDefinitionInput): Promise<EirDefinitionCommandResult>;
  activate(input: ActivateEirDefinitionInput): Promise<EirDefinitionCommandResult>;
}

/**
 * What the employee screen needs (`eir-definitions/forms`): the active
 * definition's form, and the forms behind the versions it asked about.
 */
export interface EirFormsAnswer {
  active: EirFormConfig;
  forms: Record<string, EirFormConfig>;
}

/** The employee's side of the EIR definitions (tenant app). */
export interface EirFormSource {
  /** Refused (503) when there's no current form, or a definition's can't be loaded. */
  forms(ids: readonly string[]): Promise<EirFormsAnswer>;
}

/**
 * The answer as {@link EirForms}, for {@link formForNextSave}. A version it
 * wasn't asked about is the bootstrap definition's, if it's that one's.
 */
export const eirFormsFrom = (answer: EirFormsAnswer): EirForms => ({
  active: () => answer.active,
  byVersion: (version) => answer.forms[version] ?? BOOTSTRAP_EIR_FORMS.byVersion(version),
});

/** {@link EirFormSource} over the in-memory definitions. */
export function memoryEirFormSource(forms: EirForms): EirFormSource {
  return {
    async forms(versions) {
      const active = forms.active();
      const known: Record<string, EirFormConfig> = {};
      for (const version of versions) {
        const form = forms.byVersion(version);
        if (form === null || !active) throw BOOTSTRAP_UNAVAILABLE;
        if (form) known[version] = form;
      }
      if (!active) throw BOOTSTRAP_UNAVAILABLE;
      return { active, forms: known };
    },
  };
}

/** {@link EirDefinitionRepository} for whoever is signed in, resolved on each call. */
export function eirDefinitionsForCurrentUser(
  repositories: MemoryEirDefinitionRepositories,
  currentUser: () => Promise<MemoryUser>,
): EirDefinitionRepository {
  const as = async () => repositories.as(await currentUser());
  return {
    history: async () => (await as()).history(),
    get: async (versionNumber) => (await as()).get(versionNumber),
    check: async (sourceYaml) => (await as()).check(sourceYaml),
    publish: async (input) => (await as()).publish(input),
    activate: async (input) => (await as()).activate(input),
  };
}

/**
 * The store's typed EIR definitions (#201), whole: what an evaluator needs to
 * check a draft against the definition it was pinned to when it began (its
 * persisted identity, #224), or a new one against the active definition.
 * `undefined` from `active()` means no current definition (unavailable);
 * from {@link byId}, that no definition has that identity; `null`, that one
 * does but it can't be loaded right now.
 */
export interface EirDefinitions {
  active(): EirDefinition | undefined;
  activeRef(): ActiveEirDefinitionRef | undefined;
  /** By identity (`identity.ts`): a published version's number, or a built-in's reserved name. */
  byId(id: string): EirDefinition | null | undefined;
}

/** Which definitions to resolve besides the active one, by identity. */
export interface EirDefinitionVersions {
  ids?: readonly (string | undefined)[];
}

/** {@link EirForms} from {@link EirDefinitions}: the forms are the definitions' forms. */
export const formsOf = (definitions: EirDefinitions): EirForms => ({
  active: () => definitions.active()?.form,
  byVersion: (id) => {
    const definition = definitions.byId(id);
    return definition === null ? null : definition?.form;
  },
});

/** A refusal, with the HTTP status the server answers it with. */
export class EirDefinitionError extends Error {
  readonly code: EirDefinitionRefusalCode;
  readonly status: 400 | 403 | 404 | 409 | 503;
  constructor(
    code: EirDefinitionRefusalCode,
    message: string,
    status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = "EirDefinitionError";
    this.code = code;
    this.status = status;
  }
}

export const STALE_DEFINITION_MESSAGE =
  "This changed since you opened it. Reload to see the latest.";

export const refuseUnlessAuthor = (user: { isSafeguardsValidator?: boolean }): void => {
  if (!canAuthorEirDefinitions(user)) {
    throw new EirDefinitionError(
      "forbidden",
      "Only Safeguards can publish or activate EIR definitions.",
      403,
    );
  }
};

export const refuseUnlessReader = (user: {
  isAdmin?: boolean;
  isSafeguardsValidator?: boolean;
}): void => {
  if (!canReadEirDefinitions(user)) {
    throw new EirDefinitionError(
      "forbidden",
      "Only EDP staff and Safeguards can see EIR definitions.",
      403,
    );
  }
};

/** Refused before anything else: a definition over the limit in UTF-8 bytes (both adapters). */
export function refuseOversizedDefinition(sourceYaml: string): void {
  if (eirDefinitionBytes(sourceYaml) > MAX_EIR_DEFINITION_BYTES) {
    throw new EirDefinitionError(
      "definition-too-large",
      `An EIR definition can be at most ${MAX_EIR_DEFINITION_BYTES / 1024} KB (UTF-8).`,
      400,
    );
  }
}

export { bootstrapEirDefinition, builtInById, withId } from "./built-in.ts";

/**
 * The publish rules both repositories run, on a fresh server-side check of
 * the YAML and the versions already published. Returns the checked
 * definition, or throws the refusal.
 *
 * The YAML names no version (the loader refuses one, #224): the caller
 * numbers it, inside the same write that stores it. Publishing the
 * bootstrap's own YAML is allowed, as a new number, so it can be activated.
 */
export async function checkPublishable(
  sourceYaml: string,
  published: readonly EirDefinitionVersionSummary[],
): Promise<Extract<EirDefinitionCheck, { ok: true }>> {
  const check = await checkEirDefinition(sourceYaml);
  if (!check.ok) {
    throw new EirDefinitionError(
      "definition-invalid",
      `This definition can't be published: ${check.diagnostics.length} problem${check.diagnostics.length === 1 ? "" : "s"} (validate it to see where).`,
      400,
    );
  }
  if (!check.publishable) {
    const failed = check.scenarios.filter((scenario) => !scenario.ok).map((s) => s.id);
    throw new EirDefinitionError(
      "scenarios-failed",
      `This definition can't be published: scenario ${failed.join(", ")} doesn't produce its declared outcome.`,
      400,
    );
  }
  const same = published.find((v) => v.contentSha256 === check.contentSha256);
  if (same) {
    throw new EirDefinitionError(
      "already-published",
      `This definition is already published as version ${same.versionNumber}.`,
      409,
    );
  }
  return check;
}

/**
 * A stored version, loaded again before it's used: its YAML must still load
 * and still be the content that was published. Anything else is unavailable,
 * never guessed (fail closed).
 */
export async function reloadPublished(stored: {
  versionNumber: number;
  sourceYaml: string;
  contentSha256: string;
}): Promise<EirDefinition | undefined> {
  if ((await sha256OfText(stored.sourceYaml)) !== stored.contentSha256) return undefined;
  const loaded = loadDefinition(stored.sourceYaml, publishedDefinitionId(stored.versionNumber));
  return loaded.ok ? loaded.definition : undefined;
}

/**
 * What activation checks, on both adapters: the stored YAML still matches
 * its hash, still loads, and every synthetic scenario still produces its
 * declared outcome under today's rules. Returns the definition, or throws
 * the refusal (nothing is written).
 */
export async function checkActivatable(
  versionNumber: number,
  stored: { sourceYaml: string; contentSha256: string },
): Promise<EirDefinition> {
  const unloadable = new EirDefinitionError(
    "definition-unloadable",
    `Version ${versionNumber} no longer loads, so it can't be activated.`,
    409,
  );
  if ((await sha256OfText(stored.sourceYaml)) !== stored.contentSha256) throw unloadable;
  const check = await checkEirDefinition(stored.sourceYaml);
  if (!check.ok) {
    throw new EirDefinitionError(
      unloadable.code,
      `${unloadable.message} ${check.diagnostics.map((d) => d.message).join(" ")}`,
      409,
    );
  }
  if (!check.publishable) {
    const failed = check.scenarios.filter((scenario) => !scenario.ok);
    throw new EirDefinitionError(
      "scenarios-failed",
      `Version ${versionNumber} can't be activated: ${failed
        .map((s) => `scenario ${s.id} now gives ${s.actual}, not ${s.expected}`)
        .join("; ")}. Publish a corrected version.`,
      409,
    );
  }
  return check.definition;
}

export function activeRef(
  activeVersion: Pick<EirDefinitionVersionSummary, "versionNumber"> | undefined,
): ActiveEirDefinitionRef | undefined {
  if (activeVersion) return { source: "published", versionNumber: activeVersion.versionNumber };
  return bootstrapEirDefinition() ? { source: "bootstrap", id: FALLBACK_BUILT_IN_ID } : undefined;
}

export const BOOTSTRAP_UNAVAILABLE = new EirDefinitionError(
  "eir-unavailable",
  "The EIR definition is temporarily unavailable.",
  503,
);

interface MemoryUser {
  principalId: string;
  displayName: string;
  isAdmin?: boolean;
  isSafeguardsValidator?: boolean;
}

export interface MemoryEirDefinitionRepositories {
  /** The repository as `user` sees it: one shared store for everyone. */
  as(user: MemoryUser): EirDefinitionRepository;
  /** The forms employee commands use, as published and activated here (memory EIR rules). */
  forms: EirForms;
  /** The typed definitions, as published and activated here. */
  definitions: EirDefinitions;
}

/** The in-memory repository: the contract's reference, and the memory store's default. */
export function createMemoryEirDefinitionRepository(
  options: {
    clock?: () => Date;
    /** Versions already published by an earlier app (tests): stored as given, not checked again. */
    initialVersions?: Pick<
      PublishedEirDefinition,
      "sourceYaml" | "contentSha256" | "publishedAt" | "publishedBy"
    >[];
  } = {},
): MemoryEirDefinitionRepositories {
  const clock = options.clock ?? (() => new Date());
  const versions: PublishedEirDefinition[] = (options.initialVersions ?? []).map((stored, i) => {
    const loaded = loadDefinition(stored.sourceYaml, publishedDefinitionId(i + 1));
    if (!loaded.ok) throw new Error(`Stored version ${i + 1} doesn't load.`);
    return { ...stored, versionNumber: i + 1, definition: loaded.definition };
  });
  const activations: EirDefinitionActivation[] = [];
  const replies = new Map<string, { intent: string; result: EirDefinitionCommandResult }>();
  let version = versions.length;
  let active: number | null = null;
  const clone = <T>(value: T): T => structuredClone(value);
  const summary = ({
    sourceYaml: _sourceYaml,
    definition: _definition,
    ...rest
  }: PublishedEirDefinition): EirDefinitionVersionSummary => rest;

  /** Run a command once per key; the same key with another intent is refused. */
  async function once(
    key: string | undefined,
    intent: string,
    run: () => Promise<EirDefinitionCommandResult>,
  ): Promise<EirDefinitionCommandResult> {
    const prior = key ? replies.get(key) : undefined;
    if (prior) {
      if (prior.intent !== intent) {
        throw new EirDefinitionError(
          "idempotency-key-reused",
          "This request key was already used for a different change.",
          409,
        );
      }
      return clone(prior.result);
    }
    const result = await run();
    if (key) replies.set(key, { intent, result: clone(result) });
    return result;
  }

  const checkVersion = (expected: number) => {
    if (expected !== version) {
      throw new EirDefinitionError("version-conflict", STALE_DEFINITION_MESSAGE, 409);
    }
  };

  const definitions: EirDefinitions = {
    active: () =>
      active === null
        ? bootstrapEirDefinition()
        : versions.find((v) => v.versionNumber === active)?.definition,
    activeRef: () => activeRef(versions.find((v) => v.versionNumber === active)),
    byId: (id) => {
      const number = publishedVersionNumber(id);
      return number === undefined
        ? builtInById(id)
        : versions.find((v) => v.versionNumber === number)?.definition;
    },
  };
  const forms = formsOf(definitions);

  return {
    forms,
    definitions,
    as(user) {
      const actor: EirDefinitionActor = {
        principalId: user.principalId,
        display: user.displayName,
        app: "staff",
      };
      return {
        async history() {
          refuseUnlessReader(user);
          const ref = activeRef(versions.find((v) => v.versionNumber === active));
          if (!ref) throw BOOTSTRAP_UNAVAILABLE;
          return clone({
            version,
            active: ref,
            versions: versions.map(summary).reverse(),
            activations: [...activations].reverse(),
          });
        },
        async get(versionNumber) {
          refuseUnlessReader(user);
          const found = versions.find((v) => v.versionNumber === versionNumber);
          if (!found) {
            throw new EirDefinitionError("not-found", `There's no version ${versionNumber}.`, 404);
          }
          return clone(found);
        },
        async check(sourceYaml) {
          refuseUnlessAuthor(user);
          refuseOversizedDefinition(sourceYaml);
          return checkEirDefinition(sourceYaml);
        },
        async publish(input) {
          refuseUnlessAuthor(user);
          refuseOversizedDefinition(input.sourceYaml);
          return once(
            input.idempotencyKey,
            JSON.stringify(["publish", user.principalId, input.sourceYaml, input.expectedVersion]),
            async () => {
              checkVersion(input.expectedVersion);
              const check = await checkPublishable(input.sourceYaml, versions);
              // Re-checked after the await: another publish may have landed meanwhile.
              checkVersion(input.expectedVersion);
              const versionNumber = versions.length + 1;
              versions.push({
                versionNumber,
                contentSha256: check.contentSha256,
                publishedAt: clock().toISOString(),
                publishedBy: { ...actor },
                sourceYaml: input.sourceYaml,
                definition: withId(check.definition, publishedDefinitionId(versionNumber)),
              });
              version += 1;
              return { versionNumber, version, contentSha256: check.contentSha256 };
            },
          );
        },
        async activate(input) {
          refuseUnlessAuthor(user);
          return once(
            input.idempotencyKey,
            JSON.stringify([
              "activate",
              user.principalId,
              input.versionNumber,
              input.expectedVersion,
            ]),
            async () => {
              checkVersion(input.expectedVersion);
              const target = versions.find((v) => v.versionNumber === input.versionNumber);
              if (!target) {
                throw new EirDefinitionError(
                  "not-found",
                  `There's no published version ${input.versionNumber}.`,
                  404,
                );
              }
              if (active === input.versionNumber) {
                throw new EirDefinitionError(
                  "already-active",
                  `Version ${input.versionNumber} is already active.`,
                  409,
                );
              }
              await checkActivatable(input.versionNumber, target);
              checkVersion(input.expectedVersion);
              activations.push({
                versionNumber: input.versionNumber,
                previousVersionNumber: active,
                rollback: activations.some((a) => a.versionNumber === input.versionNumber),
                activatedAt: clock().toISOString(),
                activatedBy: { ...actor },
              });
              active = input.versionNumber;
              version += 1;
              return { versionNumber: input.versionNumber, version };
            },
          );
        },
      };
    },
  };
}
