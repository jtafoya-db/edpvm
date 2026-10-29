/**
 * The `admin` area: write checks, the trivial command that proves the Delta
 * write path end to end (#76), and the audit trail read.
 *
 * It's also the worked example for area tickets: one current-state table and
 * its action table (`resources/store-admin.sql`), a create command, a
 * version-checked update command, and reads. A write check has no display
 * number (ADR-0007 decision 2, amended 2026-10-10): it's an internal test,
 * never quoted to anyone; see `onboarding.ts` for a record with a display code.
 *
 * EDP staff only. Nothing in the product depends on write checks.
 */
import { z } from "zod";

import { DomainError } from "../errors.ts";
import type { ReadFn, Registry, ResultRowContext } from "../registry.ts";
import { requireEdpStaff } from "../registry.ts";
import type { DeltaSnapshot } from "../snapshot-cache.ts";
import type { StoreNames } from "../sql-builder.ts";
import {
  NO_DISPLAY_NUMBER,
  followOn,
  insertCurrentState,
  updateCurrentState,
  type ActionTableRef,
  type TableRef,
} from "../write-helpers.ts";

export const WRITE_CHECKS: TableRef = { schema: "admin", table: "write_checks" };
export const WRITE_CHECK_ACTIONS: ActionTableRef = {
  schema: "admin",
  table: "write_check_actions",
  recordIdColumn: "write_check_id",
};

export interface WriteCheck {
  id: string;
  name: string;
  stage: "recorded" | "confirmed";
  version: number;
  createdAt: string;
  createdByPrincipalId: string;
  updatedAt: string;
  lastActionId: string;
}

interface WriteCheckRow {
  id: string;
  label: string;
  stage: "recorded" | "confirmed";
  version: number;
  created_at: string;
  created_by_principal_id: string;
  updated_at: string;
  last_action_id: string;
}

/** The columns a write check is built from, for reads and for a command's stored result. */
const WRITE_CHECK_COLUMNS =
  "id, label, stage, version, created_at, created_by_principal_id, updated_at, last_action_id";

function toWriteCheck(row: WriteCheckRow): WriteCheck {
  return {
    id: row.id,
    name: row.label,
    stage: row.stage,
    version: Number(row.version),
    createdAt: row.created_at,
    createdByPrincipalId: row.created_by_principal_id,
    updatedAt: row.updated_at,
    lastActionId: row.last_action_id,
  };
}

async function readWriteCheck(ctx: { names: StoreNames; read: ReadFn }, id: string) {
  const rows = await ctx.read<WriteCheckRow>({
    statement: `SELECT ${WRITE_CHECK_COLUMNS} FROM ${ctx.names.table(WRITE_CHECKS.schema, WRITE_CHECKS.table)} WHERE id = :id`,
    parameters: { id },
  });
  return rows[0] ? toWriteCheck(rows[0]) : undefined;
}

function snapshotWriteChecks(snapshot: DeltaSnapshot, id?: string): WriteCheck[] {
  return snapshot
    .table<WriteCheckRow>("admin", "write_checks")
    .filter((row) => (id ? row.id === id : true))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, id ? undefined : 50)
    .map(toWriteCheck);
}

/** Both commands answer with the write check as their block left it. */
const resultRow = ({ recordId, names, block }: ResultRowContext) =>
  `SELECT ${WRITE_CHECK_COLUMNS} FROM ${names.table(WRITE_CHECKS.schema, WRITE_CHECKS.table)} WHERE id = ${block.bind(recordId)}`;
const result = (row: Record<string, unknown>) => toWriteCheck(row as unknown as WriteCheckRow);

export function registerAdminArea(registry: Registry): void {
  registry.command({
    area: "admin",
    name: "record-write-check",
    app: "staff",
    payload: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    leadActionTable: WRITE_CHECK_ACTIONS,
    authorize: requireEdpStaff,
    async plan(ctx) {
      if (ctx.expectedVersion !== 0) {
        throw new DomainError("bad-version", "A new write check starts from version 0.", 400);
      }
      // The new record's ID derives from the lead action's, so a retry names the same row.
      const id = await followOn(ctx, 0);
      insertCurrentState(ctx, WRITE_CHECKS, id, {
        display_number: NO_DISPLAY_NUMBER,
        label: ctx.payload.name,
        stage: "recorded",
      });
      return {
        recordId: id,
        recordVersion: 1,
        leadAction: { action: "recorded", change: { stage: [null, "recorded"] } },
      };
    },
    resultRow,
    result,
  });

  registry.command({
    area: "admin",
    name: "confirm-write-check",
    app: "staff",
    payload: z.object({ writeCheckId: z.guid(), note: z.string().max(500).optional() }).strict(),
    leadActionTable: WRITE_CHECK_ACTIONS,
    authorize: requireEdpStaff,
    async plan(ctx) {
      const table = ctx.names.table(WRITE_CHECKS.schema, WRITE_CHECKS.table);
      ctx.block.guard(
        `NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ${ctx.block.bind(ctx.payload.writeCheckId)})`,
        new DomainError("not-found", "The write check wasn't found.", 404),
      );
      ctx.block.guard(
        `EXISTS (SELECT 1 FROM ${table} WHERE id = ${ctx.block.bind(ctx.payload.writeCheckId)} AND stage = 'confirmed' AND version = ${ctx.block.bind(ctx.expectedVersion)})`,
        new DomainError("already-confirmed", "This write check is already confirmed.", 409),
      );
      const recordVersion = updateCurrentState(
        ctx,
        WRITE_CHECKS,
        ctx.payload.writeCheckId,
        ctx.expectedVersion,
        { stage: "confirmed" },
      );
      return {
        recordId: ctx.payload.writeCheckId,
        recordVersion,
        leadAction: {
          action: "confirmed",
          change: { stage: ["recorded", "confirmed"] },
          note: ctx.payload.note ?? null,
        },
      };
    },
    resultRow,
    result,
  });

  registry.read({
    area: "admin",
    name: "write-checks",
    app: "staff",
    query: z.object({ id: z.guid().optional() }).strict(),
    authorize: requireEdpStaff,
    snapshot({ query, snapshot }) {
      const rows = snapshotWriteChecks(snapshot, query.id);
      if (query.id) {
        const check = rows[0];
        if (!check) throw new DomainError("not-found", "The write check wasn't found.", 404);
        return check;
      }
      return rows;
    },
    async run({ query, names, read }) {
      if (query.id) {
        const check = await readWriteCheck({ names, read }, query.id);
        if (!check) throw new DomainError("not-found", "The write check wasn't found.", 404);
        return check;
      }
      const rows = await read<WriteCheckRow>({
        statement: `SELECT ${WRITE_CHECK_COLUMNS} FROM ${names.table(WRITE_CHECKS.schema, WRITE_CHECKS.table)} ORDER BY created_at DESC LIMIT 50`,
      });
      return rows.map(toWriteCheck);
    },
  });

  // A record's history from audit.actions, in order. Every area's actions
  // show up here once its branch is in the view.
  registry.read({
    area: "audit",
    name: "record-history",
    app: "staff",
    query: z.object({ recordId: z.guid() }).strict(),
    authorize: requireEdpStaff,
    snapshot: ({ query, snapshot }) =>
      snapshot
        .table("audit", "actions")
        .filter((row) => row["record_id"] === query.recordId)
        .sort(
          (a, b) =>
            Number(a["record_version"] ?? 0) - Number(b["record_version"] ?? 0) ||
            String(a["occurred_at"]).localeCompare(String(b["occurred_at"])),
        ),
    run: ({ query, names, read }) =>
      read({
        statement: `SELECT area, record_type, record_id, action_id, action, changed, from_value, to_value, record_version, actor_principal_id, actor_display, actor_app, occurred_at, idempotency_key, caused_by_action_id, note, self_decision_test_mode FROM ${names.table("audit", "actions")} WHERE record_id = :id ORDER BY record_version, occurred_at`,
        parameters: { id: query.recordId },
      }),
  });
}
