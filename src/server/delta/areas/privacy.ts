import { z } from "zod";

import { ACTIVE_PRIVACY_NOTICE } from "../../../data/privacy/notice";
import type { PrivacyAcknowledgment } from "../../../data/privacy/repository";
import { DomainError } from "../errors";
import { requireEdpStaff, type Registry, type ResultRowContext } from "../registry";
import type { ActionTableRef } from "../write-helpers";

export const PRIVACY_ACKNOWLEDGMENTS: ActionTableRef = {
  schema: "privacy",
  table: "acknowledgments",
  recordIdColumn: "acknowledgment_id",
};

interface Row {
  notice_version: string;
  content_hash: string;
  actor_principal_id: string;
  actor_display: string;
  actor_app: "tenant" | "staff";
  occurred_at: string;
}

const columns =
  "notice_version, content_hash, actor_principal_id, actor_display, actor_app, occurred_at";
const toAcknowledgment = (row: Row): PrivacyAcknowledgment => ({
  noticeVersion: row.notice_version,
  contentHash: row.content_hash,
  principalId: row.actor_principal_id,
  actorDisplay: row.actor_display,
  actorApp: row.actor_app,
  acknowledgedAt: row.occurred_at,
});
const activeWhere = (principal: string, version: string, hash: string) =>
  `actor_principal_id = ${principal} AND notice_version = ${version} AND content_hash = ${hash}`;
export function registerPrivacyArea(registry: Registry, notice = ACTIVE_PRIVACY_NOTICE): void {
  const resultRow = ({ block, user, occurredAt }: ResultRowContext) =>
    `SELECT ${block.bind(notice.version)} AS notice_version, ${block.bind(notice.contentHash)} AS content_hash, ${block.bind(user.principalId)} AS actor_principal_id, ${block.bind(user.displayName)} AS actor_display, ${block.bind("tenant")} AS actor_app, ${block.bind({ type: "TIMESTAMP", value: occurredAt.toISOString() })} AS occurred_at`;
  registry.command({
    area: "privacy",
    name: "acknowledge",
    app: "tenant",
    payload: z
      .object({
        noticeVersion: z.string().min(1),
        contentHash: z.string().min(1),
      })
      .strict(),
    leadActionTable: PRIVACY_ACKNOWLEDGMENTS,
    plan(ctx) {
      const table = ctx.names.table("privacy", "acknowledgments");
      ctx.block.guard(
        `${ctx.block.bind(ctx.payload.noticeVersion)} <> ${ctx.block.bind(notice.version)} OR ${ctx.block.bind(ctx.payload.contentHash)} <> ${ctx.block.bind(notice.contentHash)}`,
        new DomainError(
          "privacy-notice-changed",
          "The privacy notice changed. Reload to read the new notice.",
          409,
        ),
      );
      ctx.block.guard(
        `EXISTS (SELECT 1 FROM ${table} WHERE ${activeWhere(ctx.block.bind(ctx.user.principalId), ctx.block.bind(notice.version), ctx.block.bind(notice.contentHash))})`,
        new DomainError(
          "already-acknowledged",
          "This privacy notice is already acknowledged.",
          409,
        ),
      );
      return {
        recordId: ctx.actionId,
        recordVersion: 1,
        leadAction: {
          action: "acknowledged",
          columns: {
            notice_version: notice.version,
            content_hash: notice.contentHash,
          },
        },
      };
    },
    resultRow,
    result: (row) => toAcknowledgment(row as unknown as Row),
  });

  registry.read({
    area: "privacy",
    name: "current",
    app: "tenant",
    query: z.object({}).strict(),
    async run({ user, names, read }) {
      const rows = await read<Row>({
        statement: `SELECT ${columns} FROM ${names.table("privacy", "acknowledgments")} WHERE actor_principal_id = :principal AND notice_version = :version AND content_hash = :hash LIMIT 1`,
        parameters: {
          principal: user.principalId,
          version: notice.version,
          hash: notice.contentHash,
        },
      });
      return rows[0] ? toAcknowledgment(rows[0]) : null;
    },
  });

  registry.read({
    area: "privacy",
    name: "history",
    app: "tenant",
    query: z.object({}).strict(),
    async run({ user, names, read }) {
      const rows = await read<Row>({
        statement: `SELECT ${columns} FROM ${names.table("privacy", "acknowledgments")} WHERE actor_principal_id = :principal ORDER BY occurred_at DESC`,
        parameters: { principal: user.principalId },
      });
      return rows.map(toAcknowledgment);
    },
  });

  registry.read({
    area: "privacy",
    name: "audit",
    app: "staff",
    query: z.object({ principalId: z.string().min(1).optional() }).strict(),
    authorize: requireEdpStaff,
    async run({ query, names, read }) {
      const rows = await read<Row>({
        statement: `SELECT ${columns} FROM ${names.table("privacy", "acknowledgments")}${query.principalId ? " WHERE actor_principal_id = :principal" : ""} ORDER BY occurred_at DESC`,
        ...(query.principalId ? { parameters: { principal: query.principalId } } : {}),
      });
      return rows.map(toAcknowledgment);
    },
  });
}
