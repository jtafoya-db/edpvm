/**
 * The `eir-definitions` area (#201): published EIR definitions on Delta
 * (`resources/store-eir-definitions.sql`). Staff app only (ADR-0008).
 *
 * - `eir-definitions/publish` (Safeguards): store a new immutable version of
 *   an EIR definition. The YAML is checked again here with the #200
 *   definition service and its scenarios; nothing the browser says about it
 *   is trusted.
 * - `eir-definitions/activate` (Safeguards): make a published version the
 *   one new EIR drafts use. Reactivating an earlier version is the rollback.
 * - Reads: `eir-definitions/history` and `eir-definitions/version` (EDP
 *   staff and Safeguards); `eir-definitions/forms` (tenant: the active form
 *   and the forms behind an employee's stored versions).
 *
 * Both commands check the register's version, so of two racing commands one
 * commits and the other is refused as stale; the runner replays a resent
 * key. A refused command's block rolls back whole: no version without its
 * action, no activation of a version that isn't there.
 *
 * Publish numbers the version itself (#224): the register's latest number
 * plus one, in the same block that stores it. Delta has no unique
 * constraint, so the block's guard is what keeps a number unique: it
 * refuses the write when any row already has that number, whoever wrote
 * it, and the register's version check refuses a publish that read an
 * older register. The table's CHECK keeps every number at 1 or more, so
 * none is ever a built-in definition's (`identity.ts`).
 *
 * Which definition is active, for the EIR area and the employee screen, is
 * {@link resolveEirDefinitions}.
 */
import { z } from "zod";

import {
  activeRef,
  bootstrapEirDefinition,
  builtInById,
  checkActivatable,
  checkPublishable,
  EirDefinitionError,
  refuseOversizedDefinition,
  refuseUnlessAuthor,
  refuseUnlessReader,
  reloadPublished,
  formsOf,
  withId,
  type EirDefinitionActivation,
  type EirDefinitions,
  type EirDefinitionVersions,
  type EirDefinitionActorApp,
  type EirDefinitionCommandResult,
  type EirDefinitionHistory,
  type EirDefinitionVersionSummary,
  type EirFormsAnswer,
  type PublishedEirDefinition,
} from "../../../data/eir/definition/repository.ts";
import { DomainError, VersionConflictError } from "../errors.ts";
import { canonicalJson } from "../ids.ts";
import type { EirFormConfig } from "../../../data/eir/config.ts";
import {
  publishedDefinitionId,
  FALLBACK_BUILT_IN_ID,
  publishedVersionNumber,
} from "../../../data/eir/definition/identity.ts";
import type { EirDefinition } from "../../../data/eir/definition/types.ts";
import type { EirForms } from "../../../data/eir/repository.ts";
import type { ReadFn, Registry, ResultRowContext, SessionUser } from "../registry.ts";
import type { StoreNames } from "../sql-builder.ts";
import {
  followOn,
  insertCurrentState,
  insertRow,
  timestamp,
  updateCurrentState,
  type ActionTableRef,
  type TableRef,
} from "../write-helpers.ts";

export const EIR_DEFINITION_REGISTER: TableRef = {
  schema: "eir",
  table: "eir_definition_register",
};
export const EIR_DEFINITION_VERSIONS: TableRef = {
  schema: "eir",
  table: "eir_definition_versions",
};
export const EIR_DEFINITION_ACTIONS: ActionTableRef = {
  schema: "eir",
  table: "eir_definition_actions",
  recordIdColumn: "eir_definition_register_id",
};

/** The register's one row. */
export const EIR_DEFINITION_REGISTER_ID = "0d7e5c1a-3b9f-5a40-9201-2f6e4d8c1a01";

const asDomainError = (error: unknown): unknown =>
  error instanceof EirDefinitionError
    ? error.code === "version-conflict"
      ? new VersionConflictError()
      : new DomainError(error.code, error.message, error.status)
    : error;

/** Run a shared rule; its refusal becomes the API's. */
function rule<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw asDomainError(error);
  }
}

async function ruleAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asDomainError(error);
  }
}

const requireAuthor = (user: SessionUser) => rule(() => refuseUnlessAuthor(user));
const requireReader = (user: SessionUser) => rule(() => refuseUnlessReader(user));

// ---- Reading the rows -------------------------------------------------------

interface RegisterRow {
  active_version_number: number | null;
  latest_version_number: number;
  version: number;
}

interface VersionRow {
  version_number: number;
  content_sha256: string;
  published_at: string;
  published_by_principal_id: string;
  published_by_display: string;
  published_by_app: string;
}

interface ActivationRow {
  definition_version_number: number;
  from_active_version: string | null;
  occurred_at: string;
  actor_principal_id: string;
  actor_display: string;
  actor_app: string;
  payload: string | null;
}

const VERSION_COLUMNS =
  "version_number, content_sha256, published_at, published_by_principal_id, published_by_display, published_by_app";

const iso = (value: string) => new Date(value).toISOString();

function toSummary(row: VersionRow): EirDefinitionVersionSummary {
  return {
    versionNumber: Number(row.version_number),
    contentSha256: row.content_sha256,
    publishedAt: iso(row.published_at),
    publishedBy: {
      principalId: row.published_by_principal_id,
      display: row.published_by_display,
      app: row.published_by_app as EirDefinitionActorApp,
    },
  };
}

function toActivation(row: ActivationRow): EirDefinitionActivation {
  const from = row.from_active_version;
  const payload = row.payload ? (JSON.parse(row.payload) as { rollback?: boolean }) : {};
  return {
    versionNumber: Number(row.definition_version_number),
    // A built-in's name (`bootstrap`, `bootstrap-2`) or a number: only a number was published.
    previousVersionNumber: (from ? publishedVersionNumber(from) : undefined) ?? null,
    rollback: payload.rollback === true,
    activatedAt: iso(row.occurred_at),
    activatedBy: {
      principalId: row.actor_principal_id,
      display: row.actor_display,
      app: row.actor_app as EirDefinitionActorApp,
    },
  };
}

interface DefinitionState {
  register?: RegisterRow;
  versions: EirDefinitionVersionSummary[];
}

/**
 * The register and every version's summary. The two reads go to the warehouse
 * together: neither depends on the other, and each is a round trip of about
 * half a second on Databricks (#210 UAT). A command's block checks the
 * register's version again, so reading them apart was never a guarantee.
 */
async function readState(ctx: { names: StoreNames; read: ReadFn }): Promise<DefinitionState> {
  const [[register], versions] = await Promise.all([
    ctx.read<RegisterRow>({
      statement: `SELECT active_version_number, latest_version_number, version FROM ${ctx.names.table(EIR_DEFINITION_REGISTER.schema, EIR_DEFINITION_REGISTER.table)} WHERE id = :id`,
      parameters: { id: EIR_DEFINITION_REGISTER_ID },
    }),
    ctx.read<VersionRow>({
      statement: `SELECT ${VERSION_COLUMNS} FROM ${ctx.names.table(EIR_DEFINITION_VERSIONS.schema, EIR_DEFINITION_VERSIONS.table)} ORDER BY version_number DESC`,
    }),
  ]);
  return { ...(register ? { register } : {}), versions: versions.map(toSummary) };
}

const activeNumber = (state: DefinitionState): number | null =>
  state.register?.active_version_number == null
    ? null
    : Number(state.register.active_version_number);

/** Reads of the history before it's returned as it is: a write lands every few seconds at most. */
const HISTORY_READS = 3;

/**
 * Whether the register, the versions and the activation list come from the
 * same commit: the active version is the latest activation's (none: none),
 * and the latest version is listed. They're separate statements sent
 * together, so each can see a different commit (#210 review N1).
 */
const agrees = (state: DefinitionState, activations: ActivationRow[]): boolean =>
  activeNumber(state) ===
    (activations[0] ? Number(activations[0].definition_version_number) : null) &&
  (!state.register ||
    state.versions[0]?.versionNumber === Number(state.register.latest_version_number));

async function readHistory(ctx: {
  names: StoreNames;
  read: ReadFn;
}): Promise<EirDefinitionHistory> {
  let state: DefinitionState;
  let activations: ActivationRow[];
  let reads = 0;
  // Read again while the parts disagree. One that never agrees (a register
  // set by hand, say) is shown as read, as it was before the reads went together.
  do {
    [state, activations] = await Promise.all([
      readState(ctx),
      ctx.read<ActivationRow>({
        statement: `SELECT definition_version_number, from_active_version, occurred_at, actor_principal_id, actor_display, actor_app, payload FROM ${ctx.names.table(EIR_DEFINITION_ACTIONS.schema, EIR_DEFINITION_ACTIONS.table)} WHERE action = 'activated' ORDER BY record_version DESC`,
      }),
    ]);
    reads += 1;
  } while (!agrees(state, activations) && reads < HISTORY_READS);
  const active = activeNumber(state);
  const ref = activeRef(state.versions.find((v) => v.versionNumber === active));
  if (!ref)
    throw new DomainError("eir-unavailable", "The EIR definition is temporarily unavailable.", 503);
  return {
    version: Number(state.register?.version ?? 0),
    active: ref,
    versions: state.versions,
    activations: activations.map(toActivation),
  };
}

async function readPublished(
  ctx: { names: StoreNames; read: ReadFn },
  versionNumber: number,
): Promise<(EirDefinitionVersionSummary & { sourceYaml: string }) | undefined> {
  const [row] = await ctx.read<VersionRow & { source_yaml: string }>({
    statement: `SELECT ${VERSION_COLUMNS}, source_yaml FROM ${ctx.names.table(EIR_DEFINITION_VERSIONS.schema, EIR_DEFINITION_VERSIONS.table)} WHERE version_number = :n`,
    parameters: { n: versionNumber },
  });
  return row ? { ...toSummary(row), sourceYaml: row.source_yaml } : undefined;
}

// ---- Which definition is active -----------------------------------------------

/** Published definitions as loaded again, by content: a version never changes. */
const reloaded = new Map<string, Promise<EirDefinition | undefined>>();

function reloadCached(row: {
  version_number: number;
  source_yaml: string;
  content_sha256: string;
}) {
  const key = `${row.version_number}:${row.content_sha256}`;
  let loaded = reloaded.get(key);
  if (!loaded) {
    loaded = reloadPublished({
      versionNumber: row.version_number,
      sourceYaml: row.source_yaml,
      contentSha256: row.content_sha256,
    });
    reloaded.set(key, loaded);
  }
  return loaded;
}

/**
 * The store's typed EIR definitions (#201): the active one, and the ones
 * `wanted` names by identity (a draft's, a submission's, #224).
 *
 * - **active**: the activated published version; with no activation, the
 *   bootstrap definition (the recovery source). A published version that no
 *   longer loads, or no longer matches its content hash, leaves no active
 *   definition: commands refuse as unavailable rather than fall back.
 * - **byId**: the published version with that number, or the built-in
 *   definition with that reserved name.
 *
 * One statement; versions are append-only, so a definition read here never
 * changes afterwards.
 */
export async function resolveEirDefinitions(
  ctx: { names: StoreNames; read: ReadFn },
  wanted: EirDefinitionVersions = {},
): Promise<EirDefinitions> {
  const register = ctx.names.table(EIR_DEFINITION_REGISTER.schema, EIR_DEFINITION_REGISTER.table);
  const table = ctx.names.table(EIR_DEFINITION_VERSIONS.schema, EIR_DEFINITION_VERSIONS.table);
  const numbers = [
    ...new Set(
      (wanted.ids ?? [])
        .map((id) => (id ? publishedVersionNumber(id) : undefined))
        .filter((n): n is number => n !== undefined),
    ),
  ].slice(0, 10);
  const parameters: Record<string, string | number> = { id: EIR_DEFINITION_REGISTER_ID };
  numbers.forEach((n, i) => (parameters[`n${i}`] = n));
  const named = numbers.length
    ? ` OR version_number IN (${numbers.map((_, i) => `:n${i}`).join(", ")})`
    : "";
  // The register's active version, and the versions it and `wanted` name.
  const rows = await ctx.read<{
    part: "register" | "version";
    version_number: number | null;
    source_yaml: string | null;
    content_sha256: string | null;
  }>({
    statement: `SELECT 'register' AS part, active_version_number AS version_number, CAST(NULL AS STRING) AS source_yaml, CAST(NULL AS STRING) AS content_sha256 FROM ${register} WHERE id = :id UNION ALL SELECT 'version' AS part, version_number, source_yaml, content_sha256 FROM ${table} WHERE version_number = (SELECT active_version_number FROM ${register} WHERE id = :id)${named}`,
    parameters,
  });
  const registered = rows.find((row) => row.part === "register");
  const active = registered?.version_number == null ? null : Number(registered.version_number);
  const loaded = await Promise.all(
    rows
      .filter((row) => row.part === "version")
      .map(async (row) => ({
        versionNumber: Number(row.version_number),
        definition: await reloadCached({
          version_number: Number(row.version_number),
          source_yaml: row.source_yaml!,
          content_sha256: row.content_sha256!,
        }),
      })),
  );
  const activeRow = loaded.find((row) => row.versionNumber === active);
  return {
    active: () => (active === null ? bootstrapEirDefinition() : activeRow?.definition),
    activeRef: () =>
      active === null
        ? activeRef(undefined)
        : activeRow
          ? { source: "published", versionNumber: activeRow.versionNumber }
          : undefined,
    byId: (id) => {
      const number = publishedVersionNumber(id);
      if (number === undefined) return builtInById(id);
      const published = loaded.find((row) => row.versionNumber === number);
      return published ? (published.definition ?? null) : undefined;
    },
  };
}

/**
 * The forms an employee command or screen uses (#201): the forms of
 * {@link resolveEirDefinitions}' definitions, by identity.
 */
export async function resolveEirForms(
  ctx: { names: StoreNames; read: ReadFn },
  ids: readonly (string | undefined)[] = [],
): Promise<EirForms> {
  return formsOf(await resolveEirDefinitions(ctx, { ids }));
}

// ---- The commands -------------------------------------------------------------

const commandResultRow =
  (
    column: "latest_version_number" | "active_version_number",
  ): ((ctx: ResultRowContext) => string) =>
  ({ names, block }) =>
    `SELECT ${column} AS version_number, version FROM ${names.table(EIR_DEFINITION_REGISTER.schema, EIR_DEFINITION_REGISTER.table)} WHERE id = ${block.bind(EIR_DEFINITION_REGISTER_ID)}`;

/** Publish's reply also names the content hash the block stored (from the plan, which hashed it). */
const publishResultRow = (ctx: ResultRowContext): string => {
  const { contentSha256 } = ctx.leadAction.payload as { contentSha256: string };
  return `SELECT latest_version_number AS version_number, version, ${ctx.block.bind(contentSha256)} AS content_sha256 FROM ${ctx.names.table(EIR_DEFINITION_REGISTER.schema, EIR_DEFINITION_REGISTER.table)} WHERE id = ${ctx.block.bind(EIR_DEFINITION_REGISTER_ID)}`;
};

const commandResult = (row: Record<string, unknown>): EirDefinitionCommandResult => ({
  versionNumber: Number(row["version_number"]),
  version: Number(row["version"]),
  // A publish replayed from before #210's UAT fix stored no hash.
  ...(typeof row["content_sha256"] === "string" ? { contentSha256: row["content_sha256"] } : {}),
});

function checkVersion(state: DefinitionState, expected: number): void {
  const actual = Number(state.register?.version ?? 0);
  if (actual !== expected) throw new VersionConflictError(`read ${actual}, expected ${expected}`);
}

export function registerEirDefinitionsArea(registry: Registry): void {
  registry.command({
    area: "eir-definitions",
    name: "publish",
    app: "staff",
    // The size limit is UTF-8 bytes, checked in the plan with the memory adapter's rule.
    payload: z.object({ sourceYaml: z.string().min(1) }).strict(),
    leadActionTable: EIR_DEFINITION_ACTIONS,
    authorize: requireAuthor,
    async plan(ctx) {
      rule(() => refuseOversizedDefinition(ctx.payload.sourceYaml));
      const state = await readState(ctx);
      checkVersion(state, ctx.expectedVersion);
      const check = await ruleAsync(() => checkPublishable(ctx.payload.sourceYaml, state.versions));
      const versionNumber = Number(state.register?.latest_version_number ?? 0) + 1;
      const versions = ctx.names.table(
        EIR_DEFINITION_VERSIONS.schema,
        EIR_DEFINITION_VERSIONS.table,
      );
      const register = ctx.names.table(
        EIR_DEFINITION_REGISTER.schema,
        EIR_DEFINITION_REGISTER.table,
      );
      // Inside the block, the number's uniqueness (#224): no row has it, nor this content.
      ctx.block.guard(
        `EXISTS (SELECT 1 FROM ${versions} WHERE version_number = ${ctx.block.bind(versionNumber)} OR content_sha256 = ${ctx.block.bind(check.contentSha256)})`,
        new VersionConflictError("a version was published meanwhile"),
      );
      const id = publishedDefinitionId(versionNumber);
      let recordVersion: number;
      if (state.register) {
        recordVersion = updateCurrentState(
          ctx,
          EIR_DEFINITION_REGISTER,
          EIR_DEFINITION_REGISTER_ID,
          ctx.expectedVersion,
          { latest_version_number: versionNumber },
        );
      } else {
        ctx.block.guard(
          `EXISTS (SELECT 1 FROM ${register} WHERE id = ${ctx.block.bind(EIR_DEFINITION_REGISTER_ID)})`,
          new VersionConflictError("the register was created meanwhile"),
        );
        insertCurrentState(ctx, EIR_DEFINITION_REGISTER, EIR_DEFINITION_REGISTER_ID, {
          active_version_number: null,
          latest_version_number: versionNumber,
        });
        recordVersion = 1;
      }
      insertRow(ctx, EIR_DEFINITION_VERSIONS, {
        id: await followOn(ctx, 0),
        version_number: versionNumber,
        // Columns from before #224, when the YAML named its versions: now its identity.
        definition_version: id,
        form_version: id,
        source_yaml: ctx.payload.sourceYaml,
        normalized_definition: canonicalJson(withId(check.definition, id)),
        content_sha256: check.contentSha256,
        published_action_id: ctx.actionId,
        published_at: timestamp(ctx.occurredAt),
        published_by_principal_id: ctx.actor.principalId,
        published_by_display: ctx.actor.display,
        published_by_app: ctx.actor.app,
        created_at: timestamp(ctx.occurredAt),
      });
      const active = activeNumber(state);
      const activeLabel = active === null ? FALLBACK_BUILT_IN_ID : String(active);
      return {
        recordId: EIR_DEFINITION_REGISTER_ID,
        recordVersion,
        leadAction: {
          action: "published",
          change: { active_version: [activeLabel, activeLabel] },
          payload: { contentSha256: check.contentSha256 },
          columns: { definition_version_number: versionNumber },
        },
      };
    },
    resultRow: publishResultRow,
    result: commandResult,
  });

  registry.command({
    area: "eir-definitions",
    name: "activate",
    app: "staff",
    payload: z.object({ versionNumber: z.number().int().min(1) }).strict(),
    leadActionTable: EIR_DEFINITION_ACTIONS,
    authorize: requireAuthor,
    async plan(ctx) {
      const { versionNumber } = ctx.payload;
      const actions = ctx.names.table(EIR_DEFINITION_ACTIONS.schema, EIR_DEFINITION_ACTIONS.table);
      // Every read at once (#210 UAT): none depends on another, and the block
      // re-checks the register's version and that the target exists.
      const [state, target, [{ n: before } = { n: 0 }]] = await Promise.all([
        readState(ctx),
        readPublished(ctx, versionNumber),
        ctx.read<{ n: number }>({
          statement: `SELECT count(*) AS n FROM ${actions} WHERE action = 'activated' AND definition_version_number = :n`,
          parameters: { n: versionNumber },
        }),
      ]);
      checkVersion(state, ctx.expectedVersion);
      if (!state.register || !target) {
        throw new DomainError("not-found", `There's no published version ${versionNumber}.`, 404);
      }
      const active = activeNumber(state);
      if (active === versionNumber) {
        throw new DomainError("already-active", `Version ${versionNumber} is already active.`, 409);
      }
      // Hash, load and every scenario again, under today's rules.
      await ruleAsync(() => checkActivatable(versionNumber, target));
      const versions = ctx.names.table(
        EIR_DEFINITION_VERSIONS.schema,
        EIR_DEFINITION_VERSIONS.table,
      );
      ctx.block.guard(
        `NOT EXISTS (SELECT 1 FROM ${versions} WHERE version_number = ${ctx.block.bind(versionNumber)})`,
        new DomainError("not-found", `There's no published version ${versionNumber}.`, 404),
      );
      // Inside the block: the rollback flag below is only true to the history
      // if no activation of this version landed after it was counted. The
      // count is a separate read, possibly of another commit (#210 review B1).
      ctx.block.guard(
        `(SELECT count(*) FROM ${actions} WHERE action = 'activated' AND definition_version_number = ${ctx.block.bind(versionNumber)}) <> ${ctx.block.bind(Number(before))}`,
        new VersionConflictError("an activation of this version landed meanwhile"),
      );
      const recordVersion = updateCurrentState(
        ctx,
        EIR_DEFINITION_REGISTER,
        EIR_DEFINITION_REGISTER_ID,
        ctx.expectedVersion,
        { active_version_number: versionNumber },
      );
      return {
        recordId: EIR_DEFINITION_REGISTER_ID,
        recordVersion,
        leadAction: {
          action: "activated",
          change: {
            active_version: [
              active === null ? FALLBACK_BUILT_IN_ID : String(active),
              String(versionNumber),
            ],
          },
          payload: { rollback: Number(before) > 0 },
          columns: { definition_version_number: versionNumber },
        },
      };
    },
    resultRow: commandResultRow("active_version_number"),
    result: commandResult,
  });

  registry.read({
    area: "eir-definitions",
    name: "history",
    app: "staff",
    query: z.object({}).strict(),
    authorize: requireReader,
    run: ({ names, read }) => readHistory({ names, read }),
  });

  registry.read({
    area: "eir-definitions",
    name: "version",
    app: "staff",
    query: z.object({ versionNumber: z.coerce.number().int().min(1) }).strict(),
    authorize: requireReader,
    async run({ query, names, read }): Promise<PublishedEirDefinition> {
      const stored = await readPublished({ names, read }, query.versionNumber);
      if (!stored) {
        throw new DomainError("not-found", `There's no version ${query.versionNumber}.`, 404);
      }
      const definition = await reloadPublished(stored);
      if (!definition) {
        throw new DomainError(
          "definition-unloadable",
          `Version ${query.versionNumber} no longer loads.`,
          503,
        );
      }
      return { ...stored, definition };
    },
  });

  // ---- The employee's side (tenant app) ---------------------------------------

  // The active form and the forms behind stored versions (a draft's, a
  // submission's), for the employee screen. It applies `formForNextSave`
  // to the record it read; the commands apply it again.
  registry.read({
    area: "eir-definitions",
    name: "forms",
    app: "tenant",
    query: z
      .object({
        versions: z
          .string()
          .max(200)
          .regex(/^[A-Za-z0-9.,-]*$/)
          .optional(),
      })
      .strict(),
    async run({ query, names, read }): Promise<EirFormsAnswer> {
      // Identities (#224): published numbers, built-in names, legacy form versions.
      const versions = (query.versions ?? "").split(",").filter(Boolean).slice(0, 10);
      const forms = await resolveEirForms({ names, read }, versions);
      const active = forms.active();
      const known: Record<string, EirFormConfig> = {};
      for (const version of versions) {
        const form = forms.byVersion(version);
        if (form === null) throw unavailableForm();
        if (form) known[version] = form;
      }
      if (!active) throw unavailableForm();
      return { active, forms: known };
    },
  });
}

const unavailableForm = () =>
  new DomainError("eir-unavailable", "The EIR form is temporarily unavailable.", 503);
