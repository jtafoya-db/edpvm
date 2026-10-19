/**
 * What an area registers with the Delta API: its commands and its reads.
 *
 * - A **command** (`POST /api/commands/<area>/<name>`) is one intent by one
 *   person. The runner wraps it in one atomic transaction with idempotency,
 *   a version check and retries; the handler only plans its rows.
 * - A **legacy write** (`POST /api/legacy-writes/<area>/<name>`, body
 *   `{ payload }` only) is #72's cart-request tables, which have no versions,
 *   no action table to hold an idempotency key, and aren't catalog-managed, so
 *   they can't be written in a transaction. Each statement commits on its own;
 *   the handler orders them so that re-running the write converges. Its
 *   envelope refuses `idempotencyKey` and `expectedVersion`: it doesn't
 *   provide those guarantees, so it doesn't accept them. #96 retires it.
 * - A **read** (`GET /api/reads/<area>/<name>`) is an allow-listed query.
 *   There is no way to send SQL: every statement is built here, on the server.
 *
 * Each registration names the app surface it belongs to (`tenant` or
 * `staff`). The router mounts only the surfaces its app serves, so splitting
 * into two apps (ADR-0008, proposed) is a deployment setting, not a rewrite.
 */
import type { z } from "zod";

import { DomainError } from "./errors.ts";
import type { AtomicBlock, StoreNames } from "./sql-builder.ts";
import type { SqlClient, SqlStatement } from "./sql-client.ts";
import type { ActionRow, ActionTableRef, ColumnValue, WriteContext } from "./write-helpers.ts";
import type { DeltaSnapshot } from "./snapshot-cache.ts";

export type AppSurface = "tenant" | "staff";

/** The signed-in person, as the server resolved them from the session. Never from the body. */
export interface SessionUser {
  principalId: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  onboardingReviewerRoles: string[];
  /** Holds the Safeguards validator role (EIR decisions; ADR-0008 staff app): the EDP admin group in the MVP. */
  isSafeguardsValidator?: boolean;
}

/** Run an allow-listed query, tagged with the current action or read ID. */
export type ReadFn = <T extends object>(statement: SqlStatement) => Promise<T[]>;

export interface CommandContext<P> extends WriteContext {
  payload: P;
  /** The version the client read; 0 for a new record. */
  expectedVersion: number;
  user: SessionUser;
  /** Read current state before planning (outside the block). Rules must still be guarded inside it. */
  read: ReadFn;
  /**
   * Record an ADR-0006 `access-refused` row for `datasetId` in its own commit,
   * before a protected command refuses an ownership mismatch. The command's
   * own block rolls back on refusal, so the audit row can't ride on it; this
   * runs the `record-ownership-refusal` command as a separate transaction, so
   * the refusal is recorded even when the client never called it first. A
   * no-op when the runner has no refusal command wired.
   */
  recordRefusal: (datasetId: string) => Promise<void>;
}

/** What a command's lead action records. The runner writes it, with the stored command. */
export interface CommandPlan {
  recordId: string;
  /** The record's version after this command: `expectedVersion + 1`. */
  recordVersion: number;
  leadAction: Pick<ActionRow, "action" | "change" | "note" | "payload"> & {
    /** The lead action table's own columns, such as `eir_submission_id`. */
    columns?: Record<string, ColumnValue>;
  };
}

/** What {@link CommandDefinition.resultRow} builds its query from. */
export interface ResultRowContext {
  recordId: string;
  recordVersion: number;
  actionId: string;
  occurredAt: Date;
  actor: WriteContext["actor"];
  user: SessionUser;
  leadAction: CommandPlan["leadAction"];
  names: StoreNames;
  block: AtomicBlock;
}

export interface CommandResultContext {
  names: StoreNames;
  read: ReadFn;
  recordId: string;
  recordVersion: number;
  user: SessionUser;
}

export interface CommandDefinition<P = unknown, R = unknown> {
  kind: "command";
  area: string;
  name: string;
  app: AppSurface;
  payload: z.ZodType<P>;
  /** Where the lead action goes; its `idempotency_key` is looked up here. */
  leadActionTable: ActionTableRef;
  /** Throw a {@link DomainError} (403) to refuse before anything is read. */
  authorize?: (user: SessionUser) => void;
  /** Add the command's statements and guards to `ctx.block`, using the write helpers. */
  plan: (ctx: CommandContext<P>) => CommandPlan | Promise<CommandPlan>;
  /**
   * A `SELECT` of the one row the response is built from, as this command's
   * block leaves it. The runner runs it inside the block and stores the row
   * (as JSON) on the lead action, so the first response and every replay of
   * the key are built from the same stored row, never from later state.
   */
  resultRow: (ctx: ResultRowContext) => string;
  /** Build the response from the stored row. Compatibility reads are only for old stored shapes. */
  result: (row: Record<string, unknown>, ctx: CommandResultContext) => R | Promise<R>;
}

export interface LegacyWriteContext<P> {
  payload: P;
  user: SessionUser;
  names: StoreNames;
  actionId: string;
  read: ReadFn;
  /**
   * Run one standalone statement. Delta commits it on its own (no
   * transaction), so it's retried on a Delta conflict, which means it didn't
   * commit. Returns `num_affected_rows`.
   */
  write: (statement: SqlStatement) => Promise<number | null>;
}

export interface LegacyWriteDefinition<P = unknown, R = unknown> {
  kind: "legacy";
  area: string;
  name: string;
  app: AppSurface;
  payload: z.ZodType<P>;
  authorize?: (user: SessionUser) => void;
  run: (ctx: LegacyWriteContext<P>) => Promise<R>;
}

export interface ReadContext<Q> {
  query: Q;
  user: SessionUser;
  names: StoreNames;
  read: ReadFn;
}

export interface SnapshotReadContext<Q> {
  query: Q;
  user: SessionUser;
  names: StoreNames;
  snapshot: DeltaSnapshot;
}

export interface ReadDefinition<Q = unknown, R = unknown> {
  area: string;
  name: string;
  app: AppSurface;
  /** Other snapshot areas this read uses. Freshness checks must cover all of them. */
  dependsOn?: string[];
  /** Validates the URL query string (as a plain object of strings). */
  query: z.ZodType<Q>;
  authorize?: (user: SessionUser) => void;
  run: (ctx: ReadContext<Q>) => Promise<R>;
  /** Serve this read from the per-instance full snapshot. SQL `run` stays the Delta fallback. */
  snapshot?: (ctx: SnapshotReadContext<Q>) => R | Promise<R>;
}

export type WriteDefinition = CommandDefinition<any, any> | LegacyWriteDefinition<any, any>;

export interface Registry {
  command<P, R>(definition: Omit<CommandDefinition<P, R>, "kind">): void;
  legacyWrite<P, R>(definition: Omit<LegacyWriteDefinition<P, R>, "kind">): void;
  read<Q, R>(definition: ReadDefinition<Q, R>): void;
  findWrite(area: string, name: string): WriteDefinition | undefined;
  findRead(area: string, name: string): ReadDefinition<any, any> | undefined;
  list(): { writes: WriteDefinition[]; reads: ReadDefinition<any, any>[] };
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function createRegistry(): Registry {
  const writes = new Map<string, WriteDefinition>();
  const reads = new Map<string, ReadDefinition<any, any>>();
  const key = (area: string, name: string) => `${area}/${name}`;
  const check = (
    definition: { area: string; name: string; app: AppSurface; authorize?: unknown },
    taken: Map<string, unknown>,
  ) => {
    const { area, name } = definition;
    if (!NAME.test(area) || !NAME.test(name)) throw new Error(`Invalid API name: ${area}/${name}`);
    if (taken.has(key(area, name))) throw new Error(`Already registered: ${area}/${name}`);
    // Fail closed: while one app serves both surfaces, the surface alone keeps
    // nobody out, so a staff endpoint must say who may use it.
    if (definition.app === "staff" && typeof definition.authorize !== "function") {
      throw new Error(
        `Staff endpoint ${area}/${name} must declare authorize (e.g. requireEdpStaff).`,
      );
    }
  };
  return {
    command(definition) {
      check(definition, writes);
      writes.set(key(definition.area, definition.name), { ...definition, kind: "command" });
    },
    legacyWrite(definition) {
      check(definition, writes);
      writes.set(key(definition.area, definition.name), { ...definition, kind: "legacy" });
    },
    read(definition) {
      check(definition, reads);
      reads.set(key(definition.area, definition.name), definition);
    },
    findWrite: (area, name) => writes.get(key(area, name)),
    findRead: (area, name) => reads.get(key(area, name)),
    list: () => ({ writes: [...writes.values()], reads: [...reads.values()] }),
  };
}

/** `authorize` for EDP staff only commands and reads. */
export function requireEdpStaff(user: SessionUser): void {
  if (!user.isAdmin) throw new DomainError("forbidden", "Only EDP staff can do this.", 403);
}
