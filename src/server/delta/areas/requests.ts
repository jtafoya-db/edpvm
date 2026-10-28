/**
 * #72's cart-style access requests (`requests.access_requests`,
 * `request_items`, `request_steps`, `waiver_attestations`), moved behind the
 * server. The browser used to post these statements itself.
 *
 * These tables predate ADR-0007: no versions, no action table to keep an
 * idempotency key in, and not catalog-managed, so a transaction can't write
 * them (`BEGIN ATOMIC` is refused with
 * TRANSACTION_NOT_SUPPORTED.WRITE_NON_CATALOG_MANAGED_TABLE; checked on
 * example-workspace). So they're legacy writes, not commands:
 *
 * - each statement commits on its own (Delta makes one statement atomic), and
 *   is retried only on a Delta conflict, which means it didn't commit;
 * - the statements are ordered, and written as MERGEs and insert-if-missing,
 *   so re-running a write that failed part-way converges instead of
 *   duplicating rows;
 * - nothing checks a version: the last transition wins;
 * - the endpoint (`/api/legacy-writes/…`) refuses `idempotencyKey` and
 *   `expectedVersion`, since it can't honour them.
 *
 * The requester and attestor come from the session, never the body. #96
 * retires the tables and this file.
 */
import { z } from "zod";

import {
  attestationToRow,
  requestToRows,
  rowToAttestation,
  rowsToRequest,
  type AccessRequestRow,
  type RequestItemRow,
  type RequestStepRow,
} from "../../../data/legacy-request-rows.ts";
import { isDigitIdentifier } from "../../../data/person-name";
import type { AccessRequest, RequestStatus, WaiverAttestation } from "../../../data/types";
import { DomainError } from "../errors.ts";
import type { ReadFn, Registry, SessionUser } from "../registry.ts";
import { requireEdpStaff } from "../registry.ts";
import type { DeltaSnapshot, SnapshotRow } from "../snapshot-cache.ts";
import type { StoreNames } from "../sql-builder.ts";
import { ParameterBag, ident } from "../sql-builder.ts";
import type { SqlStatement, SqlValue } from "../sql-client.ts";

/** A timestamp the browser sent, as ISO 8601; refused if it isn't a date. */
const timestampString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a date")
  .transform((value) => new Date(value).toISOString());

const subRequest = z
  .object({
    system: z.string(),
    status: z.enum(["done", "active", "pending", "blocked"]),
    detail: z.string(),
    ticket: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const requestItem = z
  .object({
    kind: z.string(),
    ref: z.string().optional(),
    id: z.string().optional(),
    bundle: z.string().optional(),
    label: z.string().optional(),
    sub: z.string().optional(),
  })
  .strict();

/** A new request. The requester is the session's, so it isn't in the payload. */
const newRequest = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string(),
    submittedAt: timestampString,
    status: z.string(),
    overall: z.string(),
    purpose: z.string(),
    items: z.array(requestItem),
    subRequests: z.array(subRequest),
    stageIndex: z.number().int(),
  })
  .strict();

const transition = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    overall: z.string(),
    stageIndex: z.number().int(),
    subRequests: z.array(subRequest),
  })
  .strict();

/** An attestation. The attestor is the session's, so it isn't in the payload. */
const attestation = z
  .object({
    id: z.string().min(1).max(64),
    requestId: z.string().min(1),
    checklistItemId: z.string().min(1),
    attested: z.boolean(),
    attestedAt: timestampString,
    note: z.string().optional(),
    source: z.string(),
    createdAt: timestampString,
  })
  .strict();

type Column = readonly [name: string, type: string];

const REQUEST_COLUMNS: Column[] = [
  ["id", "STRING"],
  ["title", "STRING"],
  ["submitted_at", "TIMESTAMP"],
  ["status", "STRING"],
  ["overall", "STRING"],
  ["purpose", "STRING"],
  ["stage_index", "INT"],
  ["requester_principal_id", "STRING"],
  ["requester_username", "STRING"],
];
const ITEM_COLUMNS: Column[] = [
  ["request_id", "STRING"],
  ["item_order", "INT"],
  ["kind", "STRING"],
  ["ref", "STRING"],
  ["dataset_id", "STRING"],
  ["bundle_id", "STRING"],
  ["label", "STRING"],
  ["sub", "STRING"],
];
const STEP_COLUMNS: Column[] = [
  ["request_id", "STRING"],
  ["step_order", "INT"],
  ["system", "STRING"],
  ["status", "STRING"],
  ["detail", "STRING"],
  ["ticket", "STRING"],
  ["error", "STRING"],
];
const ATTESTATION_COLUMNS: Column[] = [
  ["id", "STRING"],
  ["request_id", "STRING"],
  ["checklist_item_id", "STRING"],
  ["attestor_principal_id", "STRING"],
  ["attestor_username", "STRING"],
  ["attested", "BOOLEAN"],
  ["attested_at", "TIMESTAMP"],
  ["note", "STRING"],
  ["source", "STRING"],
  ["created_at", "TIMESTAMP"],
  ["superseded_at", "TIMESTAMP"],
];

/** `CAST(:p0 AS STRING), CAST(:p1 AS INT), …`: one row's values, bound and typed. */
function values(bag: ParameterBag, columns: Column[], row: object): string {
  const record = row as Record<string, SqlValue | undefined>;
  return columns
    .map(([name, type]) => `CAST(${bag.bind(record[name] ?? null)} AS ${type})`)
    .join(", ");
}

const columnList = (columns: Column[]) => columns.map(([name]) => ident(name)).join(", ");

/**
 * The display-only requester/attestor label stored beside the principal id
 * (`requester_username`, `attestor_username`; docs/delta-schema.md): the email,
 * unless it's blank or a digit-shaped id, else the sanitized display name
 * (`src/server/identity.ts`: a username or "Signed-in user"). Nothing matches
 * or authorises on it; ownership and "mine" key on the principal id.
 */
function accountLabel(user: SessionUser): string {
  const email = user.email?.trim();
  return email && !isDigitIdentifier(email) ? user.email : user.displayName;
}

/** Insert `row` unless a row with its `id` is already there. Reports 1 or 0 affected rows. */
function insertIfMissing(table: string, columns: Column[], row: { id: string }): SqlStatement {
  const bag = new ParameterBag();
  const select = values(bag, columns, row);
  return {
    statement: `INSERT INTO ${table} (${columnList(columns)}) SELECT ${select} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ${bag.bind(row.id)})`,
    parameters: bag.values,
  };
}

/**
 * Make one request's rows in `table` exactly `rows`, matched on the request
 * and the row's position. One MERGE: it commits whole or not at all, and
 * running it again changes nothing.
 */
function replaceRows(
  table: string,
  columns: Column[],
  position: string,
  requestId: string,
  rows: object[],
): SqlStatement {
  const bag = new ParameterBag();
  const id = bag.bind(requestId);
  if (!rows.length) {
    return { statement: `DELETE FROM ${table} WHERE request_id = ${id}`, parameters: bag.values };
  }
  const source = rows.map((row) => `(${values(bag, columns, row)})`).join(", ");
  return {
    statement: `MERGE INTO ${table} AS t USING (SELECT * FROM VALUES ${source} AS v(${columnList(columns)})) AS s ON t.request_id = s.request_id AND t.${ident(position)} = s.${ident(position)} WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT * WHEN NOT MATCHED BY SOURCE AND t.request_id = ${id} THEN DELETE`,
    parameters: bag.values,
  };
}

async function exists(read: ReadFn, table: string, id: string): Promise<boolean> {
  const rows = await read({
    statement: `SELECT 1 AS found FROM ${table} WHERE id = :id LIMIT 1`,
    parameters: { id },
  });
  return rows.length > 0;
}

/** Load requests (all, or one) with their items and steps; non-staff see only their own. */
async function load(
  names: StoreNames,
  read: ReadFn,
  user: SessionUser,
  id?: string,
): Promise<AccessRequest[]> {
  const conditions: string[] = [];
  const parameters: Record<string, SqlValue> = {};
  if (id) {
    conditions.push("id = :id");
    parameters["id"] = id;
  }
  if (!user.isAdmin) {
    conditions.push("requester_principal_id = :me");
    parameters["me"] = user.principalId;
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const requestRows = await read<AccessRequestRow>({
    statement: `SELECT id, title, CAST(submitted_at AS STRING) AS submitted_at, status, overall, purpose, stage_index, requester_principal_id, requester_username FROM ${names.table("requests", "access_requests")}${where} ORDER BY submitted_at DESC`,
    parameters,
  });
  if (!requestRows.length) return [];
  const idParameters = Object.fromEntries(requestRows.map((row, index) => [`id${index}`, row.id]));
  const placeholders = requestRows.map((_, index) => `:id${index}`).join(",");
  const [items, steps] = await Promise.all([
    read<RequestItemRow>({
      statement: `SELECT * FROM ${names.table("requests", "request_items")} WHERE request_id IN (${placeholders})`,
      parameters: idParameters,
    }),
    read<RequestStepRow>({
      statement: `SELECT * FROM ${names.table("requests", "request_steps")} WHERE request_id IN (${placeholders})`,
      parameters: idParameters,
    }),
  ]);
  return requestRows.map((row) =>
    rowsToRequest(
      row,
      items.filter((item) => item.request_id === row.id),
      steps.filter((step) => step.request_id === row.id),
    ),
  );
}

async function loadOne(names: StoreNames, read: ReadFn, user: SessionUser, id: string) {
  const request = (await load(names, read, user, id))[0];
  if (!request) throw new DomainError("not-found", `Request ${id} was not found.`, 404);
  return request;
}

function requestRowsFromSnapshot(snapshot: DeltaSnapshot, user: SessionUser, id?: string) {
  return snapshot
    .table<AccessRequestRow>("requests", "access_requests")
    .filter((row) => (id ? row.id === id : true))
    .filter((row) => user.isAdmin || row.requester_principal_id === user.principalId)
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
}

function loadFromSnapshot(
  snapshot: DeltaSnapshot,
  user: SessionUser,
  id?: string,
): AccessRequest[] {
  const requestRows = requestRowsFromSnapshot(snapshot, user, id);
  const items = snapshot.table<RequestItemRow>("requests", "request_items");
  const steps = snapshot.table<RequestStepRow>("requests", "request_steps");
  return requestRows.map((row) =>
    rowsToRequest(
      { ...row, submitted_at: String(row.submitted_at) },
      items.filter((item) => item.request_id === row.id),
      steps.filter((step) => step.request_id === row.id),
    ),
  );
}

type RequestChildRow = Partial<RequestItemRow & RequestStepRow> & {
  row_type: "item" | "step";
  request_id: string;
  row_order: number;
};

interface RequestsStatuses {
  requests: AccessRequest[];
  statuses: Record<string, RequestStatus>;
}

async function loadForStatuses(
  names: StoreNames,
  read: ReadFn,
  user: SessionUser,
): Promise<RequestsStatuses> {
  const parameters: Record<string, SqlValue> = {};
  const where = user.isAdmin ? "" : " WHERE requester_principal_id = :me";
  if (!user.isAdmin) parameters["me"] = user.principalId;
  const requestRows = await read<AccessRequestRow>({
    statement: `SELECT id, title, CAST(submitted_at AS STRING) AS submitted_at, status, overall, purpose, stage_index, requester_principal_id, requester_username FROM ${names.table("requests", "access_requests")}${where} ORDER BY submitted_at DESC`,
    parameters,
  });
  if (!requestRows.length) return { requests: [], statuses: {} };
  const idParameters = Object.fromEntries(requestRows.map((row, index) => [`id${index}`, row.id]));
  const placeholders = requestRows.map((_, index) => `:id${index}`).join(",");
  const childScope = user.isAdmin
    ? ""
    : ` AND request_id IN (SELECT id FROM ${names.table("requests", "access_requests")} WHERE requester_principal_id = :me)`;
  const children = await read<RequestChildRow>({
    statement: `SELECT 'item' AS row_type, request_id, item_order AS row_order, kind, ref, dataset_id, bundle_id, label, sub, NULL AS system, NULL AS status, NULL AS detail, NULL AS ticket, NULL AS error FROM ${names.table("requests", "request_items")} WHERE request_id IN (${placeholders})${childScope} UNION ALL SELECT 'step' AS row_type, request_id, step_order AS row_order, NULL AS kind, NULL AS ref, NULL AS dataset_id, NULL AS bundle_id, NULL AS label, NULL AS sub, system, status, detail, ticket, error FROM ${names.table("requests", "request_steps")} WHERE request_id IN (${placeholders})${childScope}`,
    parameters: { ...idParameters, ...parameters },
  });
  const itemRows = children
    .filter((row) => row.row_type === "item")
    .map((row) => ({ ...row, item_order: row.row_order }) as RequestItemRow);
  const stepRows = children
    .filter((row) => row.row_type === "step")
    .map((row) => ({ ...row, step_order: row.row_order }) as RequestStepRow);
  const requests = requestRows.map((row) =>
    rowsToRequest(
      row,
      itemRows.filter((item) => item.request_id === row.id),
      stepRows.filter((step) => step.request_id === row.id),
    ),
  );
  return {
    requests,
    statuses: Object.fromEntries(
      requests.map((request) => [
        request.id,
        {
          requestId: request.id,
          status: request.status,
          overall: request.overall,
          stageIndex: request.stageIndex,
          stages: [],
          subRequests: request.subRequests,
        },
      ]),
    ),
  };
}

export function registerRequestsArea(registry: Registry): void {
  registry.read({
    area: "requests",
    name: "access-requests",
    app: "tenant",
    query: z.object({ id: z.string().min(1).optional() }).strict(),
    snapshot({ snapshot, query, user }) {
      const requests = loadFromSnapshot(snapshot, user, query.id);
      return query.id ? (requests[0] ?? null) : requests;
    },
    async run({ query, names, read, user }) {
      if (query.id) return (await load(names, read, user, query.id))[0] ?? null;
      return load(names, read, user);
    },
  });

  registry.read<unknown, RequestsStatuses>({
    area: "requests",
    name: "statuses",
    app: "tenant",
    query: z.object({}).strict(),
    snapshot({ snapshot, user }) {
      const requests = loadFromSnapshot(snapshot, user);
      return {
        requests,
        statuses: Object.fromEntries(
          requests.map((request) => [
            request.id,
            {
              requestId: request.id,
              status: request.status,
              overall: request.overall,
              stageIndex: request.stageIndex,
              stages: [],
              subRequests: request.subRequests,
            },
          ]),
        ),
      };
    },
    run: ({ names, read, user }) => loadForStatuses(names, read, user),
  });

  registry.legacyWrite<z.infer<typeof newRequest>, AccessRequest>({
    area: "requests",
    name: "create-request",
    app: "tenant",
    payload: newRequest,
    async run({ payload, user, names, read, write }) {
      const rows = requestToRows({
        ...payload,
        requesterPrincipalId: user.principalId,
        requesterUsername: accountLabel(user),
      } as AccessRequest);
      const requests = names.table("requests", "access_requests");
      const alreadyExists = new DomainError(
        "already-exists",
        `Request ${payload.id} already exists.`,
        409,
      );
      if (await exists(read, requests, payload.id)) throw alreadyExists;
      // Items and steps first, the request row last: until it commits the
      // request isn't listed, and re-running this replaces the rows a failed
      // attempt left instead of adding to them.
      await write(
        replaceRows(
          names.table("requests", "request_items"),
          ITEM_COLUMNS,
          "item_order",
          payload.id,
          rows.items,
        ),
      );
      await write(
        replaceRows(
          names.table("requests", "request_steps"),
          STEP_COLUMNS,
          "step_order",
          payload.id,
          rows.steps,
        ),
      );
      if ((await write(insertIfMissing(requests, REQUEST_COLUMNS, rows.request))) === 0) {
        throw alreadyExists;
      }
      return loadOne(names, read, user, payload.id);
    },
  });

  registry.legacyWrite<z.infer<typeof transition>, AccessRequest>({
    area: "requests",
    name: "transition-request",
    app: "staff",
    payload: transition,
    authorize: requireEdpStaff,
    async run({ payload, user, names, read, write }) {
      const requests = names.table("requests", "access_requests");
      const notFound = new DomainError("not-found", `Request ${payload.id} was not found.`, 404);
      if (!(await exists(read, requests, payload.id))) throw notFound;
      // Steps, then the status. Last writer wins: these tables have no
      // version to check (the accepted exception in docs/delta-backend.md).
      await write(
        replaceRows(
          names.table("requests", "request_steps"),
          STEP_COLUMNS,
          "step_order",
          payload.id,
          payload.subRequests.map((step, step_order) => ({
            request_id: payload.id,
            step_order,
            system: step.system,
            status: step.status,
            detail: step.detail,
            ticket: step.ticket ?? null,
            error: step.error ?? null,
          })),
        ),
      );
      const bag = new ParameterBag();
      const updated = await write({
        statement: `UPDATE ${requests} SET status = ${bag.bind(payload.status)}, overall = ${bag.bind(payload.overall)}, stage_index = CAST(${bag.bind(payload.stageIndex)} AS INT) WHERE id = ${bag.bind(payload.id)}`,
        parameters: bag.values,
      });
      if (updated === 0) throw notFound;
      return loadOne(names, read, user, payload.id);
    },
  });

  registry.legacyWrite<z.infer<typeof attestation>, WaiverAttestation>({
    area: "requests",
    name: "append-waiver-attestation",
    app: "tenant",
    payload: attestation,
    async run({ payload, user, names, read, write }) {
      const row = attestationToRow({
        ...payload,
        attestorPrincipalId: user.principalId,
        attestorUsername: accountLabel(user),
      } as WaiverAttestation);
      const table = names.table("requests", "waiver_attestations");
      if (!(await exists(read, names.table("requests", "access_requests"), row.request_id))) {
        throw new DomainError("not-found", `Request ${row.request_id} was not found.`, 404);
      }
      // Supersede this person's earlier answer first, then add the new one,
      // so re-running after a failure between the two converges.
      const bag = new ParameterBag();
      await write({
        statement: `UPDATE ${table} SET superseded_at = CAST(${bag.bind(row.created_at)} AS TIMESTAMP) WHERE request_id = ${bag.bind(row.request_id)} AND checklist_item_id = ${bag.bind(row.checklist_item_id)} AND attestor_principal_id = ${bag.bind(row.attestor_principal_id)} AND superseded_at IS NULL AND id <> ${bag.bind(row.id)}`,
        parameters: bag.values,
      });
      if ((await write(insertIfMissing(table, ATTESTATION_COLUMNS, row))) === 0) {
        throw new DomainError("already-exists", `Attestation ${row.id} was already recorded.`, 409);
      }
      return rowToAttestation(row);
    },
  });
}
