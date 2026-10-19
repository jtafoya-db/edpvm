/**
 * The tables, rows and shared SQL of the `initiatives`, `teams` and
 * `change-list` areas (#123, `resources/store-teams.sql`), and the mapping
 * from rows to the domain types the screens already use.
 *
 * Commands plan from a {@link Snapshot}: one dataset's owners, members,
 * bindings and change-list entries, read before the block. The decisions are
 * the same pure rules the in-memory store uses (ownership.ts, the
 * reconcilers). The block then re-checks that none of what the snapshot read
 * has changed ({@link guardSnapshot}); if it has, the runner re-plans from a
 * fresh read, exactly as after a Delta conflict.
 */
import type {
  ChangeListEntry,
  AddMemberEntry,
  DatasetRoleAddedReason,
} from "../../../data/change-list/types";
import type {
  DatasetOwnerAddedReason,
  DatasetOwnerRemovedReason,
  DatasetRoleChangedReason,
  DatasetRoleRemovedReason,
  RemoveMemberEntry,
} from "../../../data/change-list/team-entries";
import type { OwnerBindings } from "../../../data/datasets/ownership";
import {
  INTAKE,
  type Dataset,
  type DatasetMember,
  type DatasetOwner,
  type DatasetRoleName,
  type PersonContact,
} from "../../../data/datasets/types";
import type { WireEntry, WireMember, WireOwner } from "../../../data/adapters/teams-wire";
import { GUARD_STATE } from "../errors.ts";
import type { ReadFn } from "../registry.ts";
import type { AtomicBlock, StoreNames } from "../sql-builder.ts";
import { ident } from "../sql-builder.ts";
import type { SqlValue } from "../sql-client.ts";
import {
  expectRow,
  timestamp,
  type ActionTableRef,
  type ColumnValue,
  type TableRef,
  type WriteContext,
} from "../write-helpers.ts";

export const INITIATIVES: TableRef = { schema: "initiatives", table: "initiatives" };
export const INITIATIVE_ACTIONS: ActionTableRef = {
  schema: "initiatives",
  table: "initiative_actions",
  recordIdColumn: "initiative_id",
};
export const DATASETS: TableRef = { schema: "initiatives", table: "datasets" };
export const DATASET_ACTIONS: ActionTableRef = {
  schema: "initiatives",
  table: "dataset_actions",
  recordIdColumn: "dataset_id",
};
export const OWNERS: TableRef = { schema: "teams", table: "dataset_owners" };
export const OWNER_ACTIONS: ActionTableRef = {
  schema: "teams",
  table: "dataset_owner_actions",
  recordIdColumn: "dataset_owner_id",
};
export const MEMBERS: TableRef = { schema: "teams", table: "dataset_members" };
export const MEMBER_ACTIONS: ActionTableRef = {
  schema: "teams",
  table: "dataset_member_actions",
  recordIdColumn: "dataset_member_id",
};
export const BINDINGS: TableRef = { schema: "teams", table: "email_bindings" };
export const BINDING_ACTIONS: ActionTableRef = {
  schema: "teams",
  table: "email_binding_actions",
  recordIdColumn: "email_binding_id",
};
export const ENTRIES: TableRef = { schema: "change_list", table: "change_list_entries" };
export const ENTRY_ACTIONS: ActionTableRef = {
  schema: "change_list",
  table: "change_list_entry_actions",
  recordIdColumn: "change_list_entry_id",
};
export const APPROVALS: TableRef = { schema: "change_list", table: "change_list_approvals" };
export const APPLICATIONS: TableRef = { schema: "change_list", table: "change_list_applications" };

/**
 * A guard state the runner retries (it's `isRetryableConflict`): the rows a
 * plan read have changed since, so re-read and re-plan, as after a Delta
 * conflict. Used where the server chose the version, not the client.
 */
export const REPLAN = GUARD_STATE.idempotencyRace;

const t = (names: StoreNames, ref: TableRef) => names.table(ref.schema, ref.table);

// ---- rows ------------------------------------------------------------------

export interface DatasetRow {
  id: string;
  initiative_id: string;
  name: string;
  domain_tag: string;
  dataset_tag: string;
  version: number;
  initiative_stage?: string | null;
}

export interface OwnerRow {
  id: string;
  dataset_id: string;
  source: string;
  person_display: string;
  person_email: string | null;
  person_principal_id: string | null;
  bound_at: string | null;
  version: number;
  created_at: string;
  created_by_principal_id: string;
  /** The owner's newest action, when it's an `access-refused`. */
  refused_at: string | null;
  refused_payload: string | null;
}

export interface MemberRow {
  id: string;
  dataset_id: string;
  role: DatasetRoleName;
  source: string;
  person_display: string;
  person_email: string | null;
  person_principal_id: string | null;
  version: number;
  created_at: string;
  created_by_principal_id: string;
  updated_at: string;
  updated_by_principal_id: string;
}

export interface EntryRow {
  id: string;
  display_number: number;
  kind: "add-member" | "remove-member";
  reason: string;
  dataset_id: string;
  group_name: string;
  role: DatasetRoleName;
  person_display: string;
  person_email: string | null;
  person_principal_id: string | null;
  /** JSON text (`to_json` of the array), so both the warehouse and the fake give the same shape. */
  grants: string | string[];
  version: number;
  created_at: string;
  created_by_principal_id: string;
  from_role?: string | null;
  to_role?: string | null;
  applied_at?: string | null;
  applied_by_principal_id?: string | null;
}

export interface BindingRow {
  id: string;
  email: string;
  principal_id: string;
  created_at: string;
}

export const OWNER_COLUMNS = (o: string) =>
  [
    "id",
    "dataset_id",
    "source",
    "person_display",
    "person_email",
    "person_principal_id",
    "bound_at",
    "version",
    "created_at",
    "created_by_principal_id",
  ]
    .map((c) => `${o}.${c}`)
    .join(", ");

export const MEMBER_COLUMNS = (m: string) =>
  [
    "id",
    "dataset_id",
    "role",
    "source",
    "person_display",
    "person_email",
    "person_principal_id",
    "version",
    "created_at",
    "created_by_principal_id",
    "updated_at",
    "updated_by_principal_id",
  ]
    .map((c) => `${m}.${c}`)
    .join(", ");

const ENTRY_FIELDS = [
  "id",
  "display_number",
  "kind",
  "reason",
  "dataset_id",
  "group_name",
  "role",
  "person_display",
  "person_email",
  "person_principal_id",
  "version",
  "created_at",
  "created_by_principal_id",
];

/** An entry's columns, its grants as JSON text, its role change, and its application. */
export function entrySelect(names: StoreNames, where: string): string {
  return (
    `SELECT ${ENTRY_FIELDS.map((c) => `e.${c}`).join(", ")}, to_json(e.grants) AS grants, ` +
    `ma.from_role, ma.to_role, ap.created_at AS applied_at, ap.created_by_principal_id AS applied_by_principal_id ` +
    `FROM ${t(names, ENTRIES)} e ` +
    `LEFT JOIN ${t(names, MEMBER_ACTIONS)} ma ON ma.action_id = e.caused_by_action_id AND ma.action = 'role-changed' ` +
    `LEFT JOIN ${t(names, APPLICATIONS)} ap ON ap.change_list_entry_id = e.id ` +
    `WHERE ${where} ORDER BY e.display_number`
  );
}

/** An owner's columns, with its newest action when that's a refusal (ADR-0006 decision 5). */
export function ownerSelect(names: StoreNames, where: string): string {
  return (
    `SELECT ${OWNER_COLUMNS("o")}, ra.occurred_at AS refused_at, ra.payload AS refused_payload ` +
    `FROM ${t(names, OWNERS)} o ` +
    `LEFT JOIN ${t(names, OWNER_ACTIONS)} ra ON ra.action_id = o.last_action_id AND ra.action = 'access-refused' ` +
    `WHERE ${where} ORDER BY o._metadata.row_id`
  );
}

/** One row as a JSON object, for a command's stored result row. */
export function rowJson(
  fields: string[],
  alias: string,
  extra: Record<string, string> = {},
): string {
  const pairs = [
    ...fields.map((f) => `'${f}', ${alias}.${ident(f)}`),
    ...Object.entries(extra).map(([k, v]) => `'${k}', ${v}`),
  ];
  return `named_struct(${pairs.join(", ")})`;
}

export const OWNER_FIELDS = OWNER_COLUMNS("x").replace(/x\./g, "").split(", ");
export const MEMBER_FIELDS = MEMBER_COLUMNS("x").replace(/x\./g, "").split(", ");

/** The JSON array of the dataset's owners as the block leaves them. */
export function ownersJson(names: StoreNames, datasetParam: string): string {
  return (
    `(SELECT to_json(collect_list(${rowJson(OWNER_FIELDS, "o", { refused_at: "ra.occurred_at", refused_payload: "ra.payload" })})) ` +
    `FROM ${t(names, OWNERS)} o ` +
    `LEFT JOIN ${t(names, OWNER_ACTIONS)} ra ON ra.action_id = o.last_action_id AND ra.action = 'access-refused' ` +
    `WHERE o.dataset_id = ${datasetParam})`
  );
}

/** The JSON array of the entries this command listed (their `last_action_id` is the lead action). */
export function listedEntriesJson(names: StoreNames, actionParam: string): string {
  return (
    `(SELECT to_json(collect_list(${rowJson(ENTRY_FIELDS, "e", { grants: "to_json(e.grants)" })})) ` +
    `FROM ${t(names, ENTRIES)} e WHERE e.last_action_id = ${actionParam} AND e.version = 1)`
  );
}

// ---- mapping ---------------------------------------------------------------

const iso = (value: string | null | undefined) =>
  value === null || value === undefined ? undefined : new Date(value).toISOString();

const parseJson = <T>(value: unknown): T =>
  (typeof value === "string" ? JSON.parse(value) : value) as T;

export function personOf(row: {
  person_display: string;
  person_email: string | null;
  person_principal_id: string | null;
}): PersonContact {
  const person: PersonContact = { name: row.person_display, email: row.person_email ?? "" };
  if (!row.person_email && row.person_principal_id) person.principalId = row.person_principal_id;
  return person;
}

export function toOwner(row: OwnerRow): WireOwner {
  const owner: DatasetOwner = { displayName: row.person_display };
  // A principal ID copied from a binding is a match, not the owner's own key (ADR-0006).
  const bound = row.bound_at !== null && row.bound_at !== undefined;
  if (row.person_principal_id && !bound) owner.principalId = row.person_principal_id;
  if (row.person_email) owner.email = row.person_email;
  if (row.source === "app") {
    owner.addedBy = row.created_by_principal_id;
    owner.addedAt = iso(row.created_at)!;
  }
  if (bound && row.person_principal_id) {
    owner.matchedPrincipalId = row.person_principal_id;
    owner.matchedAt = iso(row.bound_at)!;
  }
  if (row.refused_at && row.refused_payload) {
    const refused = parseJson<{ refusedPrincipalId: string }>(row.refused_payload);
    owner.mismatch = { principalId: refused.refusedPrincipalId, at: iso(row.refused_at)! };
  }
  return { ...owner, ref: { id: row.id, version: Number(row.version) } };
}

export function toMember(row: MemberRow): WireMember {
  const member: DatasetMember = {
    datasetId: row.dataset_id,
    person: personOf(row),
    role: row.role,
    addedBy: row.source === "app" ? row.created_by_principal_id : INTAKE,
    addedAt: iso(row.created_at)!,
  };
  // A member row changes only when its role does.
  if (Number(row.version) > 1) {
    member.roleChangedBy = row.updated_by_principal_id;
    member.roleChangedAt = iso(row.updated_at)!;
  }
  return { ...member, ref: { id: row.id, version: Number(row.version) } };
}

export const entryLabel = (displayNumber: number) => `CL-${String(displayNumber).padStart(4, "0")}`;

export function toEntry(row: EntryRow, change?: { from: string; to: string }): WireEntry {
  const by = row.created_by_principal_id;
  const at = iso(row.created_at)!;
  const datasetId = row.dataset_id;
  const from = (change?.from ?? row.from_role) as DatasetRoleName;
  const to = (change?.to ?? row.to_role) as DatasetRoleName;
  const reasons = {
    "dataset-role-added": {
      kind: "dataset-role-added",
      datasetId,
      role: row.role,
      addedBy: by,
      addedAt: at,
    } satisfies DatasetRoleAddedReason,
    "dataset-role-changed": {
      kind: "dataset-role-changed",
      datasetId,
      from,
      to,
      changedBy: by,
      changedAt: at,
    } satisfies DatasetRoleChangedReason,
    "dataset-owner-added": {
      kind: "dataset-owner-added",
      datasetId,
      addedBy: by,
      addedAt: at,
    } satisfies DatasetOwnerAddedReason,
    "dataset-role-removed": {
      kind: "dataset-role-removed",
      datasetId,
      role: row.role,
      removedBy: by,
      removedAt: at,
    } satisfies DatasetRoleRemovedReason,
    "dataset-owner-removed": {
      kind: "dataset-owner-removed",
      datasetId,
      removedBy: by,
      removedAt: at,
    } satisfies DatasetOwnerRemovedReason,
  } as const;
  const base = {
    id: entryLabel(Number(row.display_number)),
    target: { group: row.group_name, person: personOf(row), datasetId, role: row.role },
    grants: parseJson<string[]>(row.grants),
    createdBy: by,
    createdAt: at,
    applied: row.applied_at
      ? { by: row.applied_by_principal_id ?? "", at: iso(row.applied_at)! }
      : null,
  };
  const reason = reasons[row.reason as keyof typeof reasons];
  const entry: ChangeListEntry =
    row.kind === "add-member"
      ? ({ ...base, kind: "add-member", reason } as AddMemberEntry)
      : ({ ...base, kind: "remove-member", reason } as RemoveMemberEntry);
  return { ...entry, ref: { id: row.id, version: Number(row.version) } };
}

export function toDataset(row: DatasetRow, owners: OwnerRow[]) {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    name: row.name,
    domainTag: row.domain_tag,
    datasetTag: row.dataset_tag,
    owners: owners.map(toOwner),
    ref: { id: row.id, version: Number(row.version) },
  };
}

/** A domain object without its `ref`, for the pure rules. */
export function bare<T extends { ref: unknown }>(value: T): Omit<T, "ref"> {
  const { ref: _ref, ...rest } = value;
  return rest;
}

// ---- the snapshot a command plans from --------------------------------------

export interface Snapshot {
  dataset: DatasetRow;
  owners: OwnerRow[];
  members: MemberRow[];
  entries: EntryRow[];
  bindings: BindingRow[];
  /** The emails whose bindings were read. */
  emails: string[];
  /** The dataset as the pure rules see it; `ownerRows` maps each owner back to its row. */
  domain: Dataset;
  ownerRows: Map<DatasetOwner, OwnerRow>;
  bindingMap: OwnerBindings;
}

/** Read one dataset's team, its entries and the bindings of every email involved. */
export async function readSnapshot(
  ctx: { names: StoreNames; read: ReadFn },
  datasetId: string,
  emails: string[],
): Promise<Snapshot | undefined> {
  const { names, read } = ctx;
  const [datasetRows, owners, members, entries] = await Promise.all([
    read<DatasetRow>({
      statement: `SELECT d.id, d.initiative_id, d.name, d.domain_tag, d.dataset_tag, d.version, i.stage AS initiative_stage FROM ${t(names, DATASETS)} d LEFT JOIN ${t(names, INITIATIVES)} i ON i.id = d.initiative_id WHERE d.id = :id`,
      parameters: { id: datasetId },
    }),
    read<OwnerRow>({
      statement: ownerSelect(names, "o.dataset_id = :id"),
      parameters: { id: datasetId },
    }),
    read<MemberRow>({
      statement: `SELECT ${MEMBER_COLUMNS("m")} FROM ${t(names, MEMBERS)} m WHERE m.dataset_id = :id ORDER BY m._metadata.row_id`,
      parameters: { id: datasetId },
    }),
    read<EntryRow>({
      statement: entrySelect(names, "e.dataset_id = :id"),
      parameters: { id: datasetId },
    }),
  ]);
  const [dataset] = datasetRows;
  if (!dataset) return undefined;
  const wanted = [
    ...new Set([...emails, ...owners.map((o) => o.person_email)].filter((e): e is string => !!e)),
  ].sort();
  const bindings = wanted.length
    ? await read<BindingRow>({
        statement: `SELECT id, email, principal_id, created_at FROM ${t(names, BINDINGS)} WHERE email IN (${wanted.map((_, i) => `:e${i}`).join(", ")})`,
        parameters: Object.fromEntries(wanted.map((e, i) => [`e${i}`, e])),
      })
    : [];
  const bindingMap: OwnerBindings = new Map(
    bindings.map((b) => [b.email, { principalId: b.principal_id, at: iso(b.created_at)! }]),
  );
  const ownerRows = new Map<DatasetOwner, OwnerRow>();
  const domainOwners = owners.map((row) => {
    const owner = bare(toOwner(row));
    ownerRows.set(owner, row);
    return owner;
  });
  return {
    dataset,
    owners,
    members,
    entries,
    bindings,
    emails: wanted,
    domain: { ...bare(toDataset(dataset, [])), owners: domainOwners },
    ownerRows,
    bindingMap,
  };
}

/**
 * Inside the block: refuse to commit (and re-plan) if anything the snapshot
 * read has moved: the dataset's owners and members (by count and summed
 * version, which every change moves), its entries (add-only, so by count),
 * and the bindings of the emails it read.
 */
export function guardSnapshot(ctx: WriteContext, snapshot: Snapshot): void {
  const { block, names } = ctx;
  const d = block.bind(snapshot.dataset.id);
  const sum = (rows: { version: number }[]) => rows.reduce((n, r) => n + Number(r.version), 0);
  const checks = [
    `(SELECT count(*) FROM ${t(names, OWNERS)} WHERE dataset_id = ${d}) <> ${block.bind(snapshot.owners.length)}`,
    `(SELECT coalesce(sum(version), 0) FROM ${t(names, OWNERS)} WHERE dataset_id = ${d}) <> ${block.bind(sum(snapshot.owners))}`,
    `(SELECT count(*) FROM ${t(names, MEMBERS)} WHERE dataset_id = ${d}) <> ${block.bind(snapshot.members.length)}`,
    `(SELECT coalesce(sum(version), 0) FROM ${t(names, MEMBERS)} WHERE dataset_id = ${d}) <> ${block.bind(sum(snapshot.members))}`,
    `(SELECT count(*) FROM ${t(names, ENTRIES)} WHERE dataset_id = ${d}) <> ${block.bind(snapshot.entries.length)}`,
  ];
  if (snapshot.emails.length) {
    checks.push(
      `(SELECT count(*) FROM ${t(names, BINDINGS)} WHERE email IN (${snapshot.emails.map((e) => block.bind(e)).join(", ")})) <> ${block.bind(snapshot.bindings.length)}`,
    );
  }
  block.signal(checks.join(" OR "), REPLAN, "edp:teams-snapshot-moved");
}

/** The snapshot's entries as the pure reconcilers read them. */
export function entriesForRules(snapshot: Snapshot): ChangeListEntry[] {
  return snapshot.entries.map((row) => bare(toEntry(row)) as ChangeListEntry);
}

// ---- writes the foundation helpers don't cover ------------------------------

/**
 * Update a row the server chose (not one whose version the client sent):
 * if it moved since the plan read it, re-plan. Returns the new version.
 */
export function updateReadRow(
  ctx: WriteContext,
  table: TableRef,
  id: string,
  readVersion: number,
  set: Record<string, ColumnValue>,
): number {
  const { block } = ctx;
  const target = t(ctx.names, table);
  const idParam = block.bind(id);
  block.signal(
    `NOT EXISTS (SELECT 1 FROM ${target} WHERE id = ${idParam} AND version = ${block.bind(readVersion)})`,
    REPLAN,
    "edp:teams-row-moved",
  );
  const assignments = Object.entries({
    ...set,
    updated_at: timestamp(ctx.occurredAt),
    updated_by_principal_id: ctx.actor.principalId,
    last_action_id: ctx.actionId,
  }).map(([column, value]) => `${ident(column)} = ${columnSql(block, value)}`);
  block.add(
    `UPDATE ${target} SET ${[...assignments, "version = version + 1"].join(", ")} WHERE id = ${idParam}`,
  );
  expectRow(ctx, table, "id", id, `last_action_id = ${block.bind(ctx.actionId)}`);
  return readVersion + 1;
}

/**
 * Delete a current-state row at `version`. A version that has moved signals
 * `versionConflict` when the client sent it, or re-plans when the server read it.
 */
export function deleteRow(
  ctx: WriteContext,
  table: TableRef,
  id: string,
  version: number,
  state: string,
): void {
  const { block } = ctx;
  const target = t(ctx.names, table);
  const idParam = block.bind(id);
  block.signal(
    `NOT EXISTS (SELECT 1 FROM ${target} WHERE id = ${idParam} AND version = ${block.bind(version)})`,
    state,
    state === GUARD_STATE.versionConflict ? "edp:version-conflict" : "edp:teams-row-moved",
  );
  block.add(`DELETE FROM ${target} WHERE id = ${idParam}`);
}

/**
 * Insert several current-state rows in one statement, so they keep their
 * order (`_metadata.row_id` follows a multi-row `VALUES`, but not separate
 * statements in one block; checked on example-workspace).
 */
export function insertStateRows(
  ctx: WriteContext,
  table: TableRef,
  rows: { id: string; columns: Record<string, ColumnValue> }[],
): void {
  if (!rows.length) return;
  const full = rows.map(({ id, columns }) => ({
    id,
    ...columns,
    version: 1,
    created_at: timestamp(ctx.occurredAt),
    created_by_principal_id: ctx.actor.principalId,
    updated_at: timestamp(ctx.occurredAt),
    updated_by_principal_id: ctx.actor.principalId,
    last_action_id: ctx.actionId,
  }));
  const columns = Object.keys(full[0]!);
  const values = full.map(
    (row) =>
      `(${columns.map((c) => columnSql(ctx.block, (row as Record<string, ColumnValue>)[c]!)).join(", ")})`,
  );
  ctx.block.add(
    `INSERT INTO ${t(ctx.names, table)} (${columns.map(ident).join(", ")}) VALUES ${values.join(", ")}`,
  );
  for (const row of rows) {
    expectRow(ctx, table, "id", row.id, `last_action_id = ${ctx.block.bind(ctx.actionId)}`);
  }
}

function columnSql(block: AtomicBlock, value: ColumnValue): string {
  return value !== null && typeof value === "object" && "sql" in value
    ? value.sql
    : block.bind(value as SqlValue);
}
