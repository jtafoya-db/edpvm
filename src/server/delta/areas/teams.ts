/**
 * The `initiatives`, `teams` and `change-list` areas on Delta (#123, build
 * ticket 1 of the ADR-0007 migration): everything the dataset-team and
 * change-list screens do (#97, #110, #120), as commands and allow-listed
 * reads over `resources/store-teams.sql`.
 *
 * Each command reads a snapshot of the dataset's team, decides with the same
 * pure rules as the in-memory store (ownership.ts for ADR-0006, the change
 * list reconcilers), and writes in one block that re-checks, inside the
 * transaction, that the snapshot still holds and the rule still passes.
 *
 * ADR-0006 binding and refusal are their own commands (`bind-email`,
 * `record-ownership-refusal`), because a refused block rolls back and could
 * never keep its own `access-refused` row. The browser adapter asks
 * `teams/ownership` before each protected action, as the memory store's
 * claimOwnership does, and runs whichever the server says applies; every
 * protected command refuses on its own if the claim wasn't made.
 *
 * Who may read what:
 * - initiatives and datasets with their owners: the shared catalogue;
 * - a dataset's members, member counts and team history: its owners and EDP
 *   staff (#257, decision of 2026-10-18 on #115); anyone else only their own
 *   member rows and history, and no counts;
 * - `teams/ownership`: the caller's own standing;
 * - the change list: EDP staff see all of it, anyone else only entries for
 *   datasets they own.
 */
import { z } from "zod";

import { reconcileMembership, type DesiredMembership } from "../../../data/change-list/reconciler";
import { reconcileRemovals } from "../../../data/change-list/removals";
import type { TeamEvent } from "../../../data/datasets/team-store";
import {
  datasetGroupName,
  validateGroupNaming,
  DEFAULT_GROUP_NAMING,
  type GroupNamingConfig,
} from "../../../data/datasets/group-naming";
import {
  canReadTeam,
  evaluateClaim,
  findSameOwner,
  isDatasetOwner,
  isViewersRow,
  ownerHasEmail,
  ownerIsPerson,
  ownerKey,
  ownerMismatchMessage,
  ownerPerson,
  ownerPrincipalId,
} from "../../../data/datasets/ownership";
import { evaluateMemberAdd, roleTakenMessage } from "../../../data/datasets/membership";
import {
  DEFAULT_ROLE_DESCRIPTIONS,
  validateRoleDescriptions,
  type RoleDescriptions,
} from "../../../data/datasets/role-descriptions";
import {
  DATASET_ROLES,
  isValidEmail,
  normalizeEmail,
  type DatasetMember,
  type DatasetOwner,
  type DatasetRoleName,
  type DatasetWithMemberSummary,
  type PersonContact,
} from "../../../data/datasets/types";
import type {
  MemberChangeWire,
  MemberRemovedWire,
  OwnerChangeWire,
  OwnershipStatus,
  WireEntry,
} from "../../../data/adapters/teams-wire";
import { DomainError, GUARD_STATE } from "../errors.ts";
import type { CommandContext, Registry, ResultRowContext, SessionUser } from "../registry.ts";
import type { DeltaSnapshot } from "../snapshot-cache.ts";
import type { AtomicBlock, StoreNames } from "../sql-builder.ts";
import {
  allocateDisplayNumber,
  expectRow,
  followOn,
  insertAction,
  insertCurrentState,
  insertRow,
  stringArray,
  timestamp,
  updateCurrentState,
  type WriteContext,
} from "../write-helpers.ts";
import {
  APPLICATIONS,
  BINDING_ACTIONS,
  BINDINGS,
  DATASETS,
  ENTRIES,
  ENTRY_ACTIONS,
  INITIATIVES,
  MEMBER_ACTIONS,
  MEMBER_FIELDS,
  MEMBERS,
  OWNER_ACTIONS,
  OWNERS,
  REPLAN,
  bare,
  deleteRow,
  entriesForRules,
  entryLabel,
  entrySelect,
  guardSnapshot,
  listedEntriesJson,
  MEMBER_COLUMNS,
  ownerSelect,
  ownersJson,
  readSnapshot,
  rowJson,
  toDataset,
  toEntry,
  toMember,
  toOwner,
  updateReadRow,
  type DatasetRow,
  type EntryRow,
  type MemberRow,
  type OwnerRow,
  type Snapshot,
} from "./teams-model.ts";

export interface TeamsAreaOptions {
  groupNaming?: GroupNamingConfig;
  roleDescriptions?: RoleDescriptions;
}

const datasetId = z.string().trim().min(1).max(200);
const text = z.string().max(500);

const tableName = (names: StoreNames, ref: { schema: string; table: string }) =>
  names.table(ref.schema, ref.table);

/** Plan details a command's result row needs, keyed by that attempt's block. */
const planned = new WeakMap<AtomicBlock, Record<string, string | null>>();

function sessionEmail(user: SessionUser): string {
  return user.email ? normalizeEmail(user.email) : "";
}

/**
 * Whether the session may read each dataset's whole team (#257), from the
 * datasets' owner rows. A read never binds, as for the change list.
 */
function teamReadable(owners: OwnerRow[], user: SessionUser): (datasetId: string) => boolean {
  if (user.isAdmin) return () => true;
  const byDataset = new Map<string, DatasetOwner[]>();
  for (const row of owners) {
    byDataset.set(row.dataset_id, [...(byDataset.get(row.dataset_id) ?? []), bare(toOwner(row))]);
  }
  return (id) => canReadTeam({ owners: byDataset.get(id) ?? [] }, user);
}

/** A member row is the session's own, by SCIM id or email. */
function isOwnMemberRow(row: MemberRow, user: SessionUser): boolean {
  return isViewersRow({ email: row.person_email, principalId: row.person_principal_id }, user);
}

/**
 * The team events the session may read (#257): all of them if it may read the
 * team, else only those about the session. Oldest first; the entries' CL
 * numbers break a tie in commit order.
 */
function visibleEvents(events: TeamEvent[], readable: boolean, user: SessionUser): TeamEvent[] {
  const first = (e: TeamEvent) => e.entryIds[0] ?? "CL-￿";
  return events
    .filter((e) => readable || isViewersRow(e.person, user))
    .sort((a, b) =>
      a.at !== b.at
        ? a.at < b.at
          ? -1
          : 1
        : first(a) < first(b)
          ? -1
          : first(a) > first(b)
            ? 1
            : 0,
    );
}

function snapshotOwnerRows(snapshot: DeltaSnapshot): OwnerRow[] {
  const actions = snapshot.table<Record<string, unknown>>("teams", "dataset_owner_actions");
  return snapshot.table<Record<string, unknown>>("teams", "dataset_owners").map((row) => {
    const refusal = actions.find(
      (action) =>
        action["action_id"] === row["last_action_id"] && action["action"] === "access-refused",
    );
    return {
      ...(row as unknown as OwnerRow),
      refused_at: (refusal?.["occurred_at"] as string | null | undefined) ?? null,
      refused_payload: (refusal?.["payload"] as string | null | undefined) ?? null,
    };
  });
}

function snapshotEntryRows(snapshot: DeltaSnapshot): EntryRow[] {
  const memberActions = snapshot.table<Record<string, unknown>>("teams", "dataset_member_actions");
  const applications = snapshot.table<Record<string, unknown>>(
    "change_list",
    "change_list_applications",
  );
  return snapshot
    .table<Record<string, unknown>>("change_list", "change_list_entries")
    .map((row) => {
      const memberAction = memberActions.find(
        (action) =>
          action["action_id"] === row["caused_by_action_id"] && action["action"] === "role-changed",
      );
      const applied = applications.find((app) => app["change_list_entry_id"] === row["id"]);
      const grants = row["grants"];
      return {
        ...(row as unknown as EntryRow),
        grants:
          typeof grants === "string"
            ? grants
            : Array.isArray(grants)
              ? JSON.stringify(grants)
              : JSON.stringify([]),
        from_role: (memberAction?.["from_role"] as string | null | undefined) ?? null,
        to_role: (memberAction?.["to_role"] as string | null | undefined) ?? null,
        applied_at: (applied?.["created_at"] as string | null | undefined) ?? null,
        applied_by_principal_id:
          (applied?.["created_by_principal_id"] as string | null | undefined) ?? null,
      };
    });
}

function snapshotBindingMap(snapshot: DeltaSnapshot) {
  return new Map(
    snapshot
      .table<{ email: string; principal_id: string; created_at: string }>("teams", "email_bindings")
      .map((row) => [
        row.email,
        { principalId: row.principal_id, at: new Date(row.created_at).toISOString() },
      ]),
  );
}

function invalidEmail(raw: string): DomainError {
  return new DomainError(
    "invalid",
    `Enter an email address in the format name@example.gov (got ${JSON.stringify(raw.trim())}).`,
  );
}

function requireRole(role: string): asserts role is DatasetRoleName {
  if (!(DATASET_ROLES as readonly string[]).includes(role)) {
    throw new DomainError(
      "invalid",
      `Unknown dataset role ${JSON.stringify(role)}; expected ${DATASET_ROLES.join(", ")}.`,
    );
  }
}

async function snapshotOf(ctx: CommandContext<{ datasetId: string }>, emails: string[] = []) {
  const snapshot = await readSnapshot(ctx, ctx.payload.datasetId, [
    sessionEmail(ctx.user),
    ...emails,
  ]);
  if (!snapshot) {
    throw new DomainError("not-found", `No dataset ${ctx.payload.datasetId}.`, 404);
  }
  return snapshot;
}

/**
 * The ADR-0006 check every protected command makes. Returns whether the
 * session acts as an owner (false: as EDP staff, where `staffMay`).
 *
 * On a mismatch it records an `access-refused` row in its own commit before
 * refusing (as the memory store's claimOwnership flags the owner record), so a
 * refused attempt is audited even when the client skipped the separate
 * `record-ownership-refusal` call.
 */
async function requireOwner(
  ctx: CommandContext<unknown>,
  snapshot: Snapshot,
  refusal: string,
  staffMay = false,
): Promise<boolean> {
  const claim = evaluateClaim(snapshot.domain, ctx.user, snapshot.bindingMap);
  if (claim.kind === "mismatch") {
    await ctx.recordRefusal(snapshot.dataset.id);
    throw new DomainError("owner-mismatch", ownerMismatchMessage(snapshot.domain, ctx.user), 403);
  }
  if (claim.kind === "owner") {
    if (claim.bindEmail) {
      throw new DomainError(
        "claim-required",
        "Your email has to be bound to your account before you act as an owner. Reload and try again.",
        409,
      );
    }
    // Inside the block too: the session still owns the dataset by account ID.
    ctx.block.guard(
      `NOT EXISTS (SELECT 1 FROM ${tableName(ctx.names, OWNERS)} WHERE dataset_id = ${ctx.block.bind(snapshot.dataset.id)} AND person_principal_id = ${ctx.block.bind(ctx.user.principalId)})`,
      new DomainError("not-owner", refusal, 403),
    );
    return true;
  }
  if (staffMay && ctx.user.isAdmin) return false;
  throw new DomainError("not-owner", refusal, 403);
}

function requireActive(ctx: WriteContext, snapshot: Snapshot, message: string) {
  if (snapshot.dataset.initiative_stage !== "active") {
    throw new DomainError("not-active", message);
  }
  ctx.block.guard(
    `NOT EXISTS (SELECT 1 FROM ${tableName(ctx.names, INITIATIVES)} WHERE id = ${ctx.block.bind(snapshot.dataset.initiative_id)} AND stage = 'active')`,
    new DomainError("not-active", message),
  );
}

/** Follow-on IDs in order: each call takes the next position. */
function positions(ctx: WriteContext) {
  let next = 0;
  return () => followOn(ctx, next++);
}

function memberPayload(snapshot: Snapshot, person: PersonContact) {
  return { datasetId: snapshot.dataset.id, person };
}

function domainMember(row: MemberRow): DatasetMember {
  return bare(toMember(row));
}

interface EntryPlan {
  kind: "add-member" | "remove-member";
  target:
    | DesiredMembership
    | { group: string; person: PersonContact; datasetId: string; role: DatasetRoleName };
  grants: string[];
  reason: string;
  causedBy: string;
}

/** List change-list entries: a `CL-` number, the entry, and its `listed` action, per entry. */
async function listEntries(ctx: WriteContext, next: () => Promise<string>, entries: EntryPlan[]) {
  for (const entry of entries) {
    const id = await next();
    const displayNumber = allocateDisplayNumber(ctx, "CL");
    const person = entry.target.person;
    insertCurrentState(
      ctx,
      ENTRIES,
      id,
      {
        kind: entry.kind,
        reason: entry.reason,
        caused_by_action_id: entry.causedBy,
        dataset_id: entry.target.datasetId,
        group_name: entry.target.group,
        role: entry.target.role,
        person_display: person.name,
        person_email: person.email || null,
        person_principal_id: person.principalId ?? null,
        grants: stringArray(ctx.block, entry.grants),
      },
      { displayNumber },
    );
    insertAction(ctx, ENTRY_ACTIONS, {
      actionId: await next(),
      recordId: id,
      action: "listed",
      recordVersion: 1,
      change: { stage: [null, "pending"] },
      causedByActionId: entry.causedBy,
    });
  }
}

/** The result row of a member command: the member, the entries it listed, and any role change. */
function memberResultRow({ recordId, names, block }: ResultRowContext): string {
  const info = planned.get(block) ?? {};
  const member =
    info["removed"] !== undefined
      ? block.bind(info["removed"] ?? null)
      : `(SELECT to_json(${rowJson(MEMBER_FIELDS, "m")}) FROM ${tableName(names, MEMBERS)} m WHERE m.id = ${block.bind(recordId)})`;
  return (
    `SELECT ${member} AS member, ${listedEntriesJson(names, block.bind(info["actionId"] ?? null))} AS entries, ` +
    `${block.bind(info["from"] ?? null)} AS from_role, ${block.bind(info["to"] ?? null)} AS to_role`
  );
}

function parse<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function entriesOf(row: Record<string, unknown>): WireEntry[] {
  const from = row["from_role"] as string | null | undefined;
  const to = row["to_role"] as string | null | undefined;
  const change = from && to ? { from, to } : undefined;
  return parse<EntryRow[]>(row["entries"] ?? "[]")
    .map((entry) => toEntry(entry, entry.reason === "dataset-role-changed" ? change : undefined))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function ownerResultRow({ names, block }: ResultRowContext): string {
  const info = planned.get(block) ?? {};
  const d = block.bind(info["datasetId"] ?? null);
  return (
    `SELECT (SELECT to_json(${rowJson(["id", "initiative_id", "name", "domain_tag", "dataset_tag", "version"], "d")}) FROM ${tableName(names, DATASETS)} d WHERE d.id = ${d}) AS dataset, ` +
    `${ownersJson(names, d)} AS owners, ${block.bind(info["order"] ?? "[]")} AS owner_order, ` +
    `${listedEntriesJson(names, block.bind(info["actionId"] ?? null))} AS entries`
  );
}

function ownerResult(row: Record<string, unknown>): OwnerChangeWire {
  const order = parse<string[]>(row["owner_order"]);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const owners = parse<OwnerRow[]>(row["owners"] ?? "[]").sort((a, b) => rank(a.id) - rank(b.id));
  return {
    dataset: toDataset(parse<DatasetRow>(row["dataset"]), owners),
    entries: entriesOf(row),
  };
}

export function registerTeamsArea(registry: Registry, options: TeamsAreaOptions = {}): void {
  const naming = validateGroupNaming(structuredClone(options.groupNaming ?? DEFAULT_GROUP_NAMING));
  const roles = validateRoleDescriptions(
    structuredClone(options.roleDescriptions ?? DEFAULT_ROLE_DESCRIPTIONS),
  );

  // ---- dataset roles -------------------------------------------------------

  registry.command({
    area: "teams",
    name: "add-member",
    app: "tenant",
    payload: z.object({ datasetId, name: text, email: text, role: text }).strict(),
    leadActionTable: MEMBER_ACTIONS,
    async plan(ctx) {
      const name = ctx.payload.name.trim();
      if (!name) throw new DomainError("invalid", "Enter the name of the person to add.");
      const email = normalizeEmail(ctx.payload.email);
      if (!isValidEmail(email)) throw invalidEmail(ctx.payload.email);
      const role = ctx.payload.role;
      requireRole(role);
      if (ctx.expectedVersion !== 0) {
        throw new DomainError("bad-version", "A new member starts from version 0.", 400);
      }
      const snapshot = await snapshotOf(ctx, [email]);
      guardSnapshot(ctx, snapshot);
      await requireOwner(
        ctx,
        snapshot,
        `Only an owner of ${snapshot.dataset.name} can add people to it.`,
      );
      requireActive(
        ctx,
        snapshot,
        `${snapshot.dataset.name} can't take members until its initiative is active.`,
      );
      // One role per person per dataset (ADR-0007 decision 11): a repeat of the
      // role they hold records nothing; a different role is refused, since a
      // switch goes through change-member-role, not a second add.
      const held = snapshot.members.filter((m) => (m.person_email ?? "") === email);
      const decision = evaluateMemberAdd(
        held.map((m) => m.role),
        role,
      );
      if (decision.kind === "repeat") {
        // A repeat records nothing; the adapter answers it with the existing role.
        throw new DomainError("already-holds-role", `${email} already holds this role.`, 409);
      }
      if (decision.kind === "role-taken") {
        throw new DomainError(
          "duplicate",
          roleTakenMessage(name, roles.roles[decision.held].label, snapshot.dataset.name),
          409,
        );
      }

      const next = positions(ctx);
      const id = await next();
      insertCurrentState(ctx, MEMBERS, id, {
        dataset_id: snapshot.dataset.id,
        role,
        source: "app",
        person_display: name,
        person_email: email,
        person_principal_id: null,
      });
      // In the block: a concurrent add of the same person loses here (one row
      // per dataset, person), so two owners adding different roles converge to
      // one member rather than two.
      ctx.block.guard(
        `(SELECT count(*) FROM ${tableName(ctx.names, MEMBERS)} WHERE dataset_id = ${ctx.block.bind(snapshot.dataset.id)} AND person_email = ${ctx.block.bind(email)}) <> 1`,
        new DomainError(
          "duplicate",
          roleTakenMessage(name, roles.roles[role].label, snapshot.dataset.name),
          409,
        ),
      );
      const member: DatasetMember = {
        datasetId: snapshot.dataset.id,
        person: { name, email },
        role,
        addedBy: ctx.user.principalId,
        addedAt: ctx.occurredAt.toISOString(),
      };
      const desired = reconcileMembership({
        datasets: [snapshot.domain],
        members: [member],
        naming,
        roles,
        actual: [],
        changeList: entriesForRules(snapshot),
      });
      await listEntries(
        ctx,
        next,
        desired.map((target) => ({
          kind: "add-member",
          target,
          grants: target.grants,
          reason: "dataset-role-added",
          causedBy: ctx.actionId,
        })),
      );
      planned.set(ctx.block, { actionId: ctx.actionId });
      return {
        recordId: id,
        recordVersion: 1,
        leadAction: {
          action: "added",
          change: { role: [null, role] },
          payload: memberPayload(snapshot, member.person),
        },
      };
    },
    resultRow: memberResultRow,
    result: (row): MemberChangeWire => ({
      member: toMember(parse<MemberRow>(row["member"])),
      entries: entriesOf(row),
    }),
  });

  /** Find one of a person's roles, as the memory store does. */
  function findMember(snapshot: Snapshot, email: string, role: DatasetRoleName): MemberRow {
    const row = snapshot.members.find((m) => (m.person_email ?? "") === email && m.role === role);
    if (!row) {
      throw new DomainError(
        "not-found",
        `${email} doesn't hold ${roles.roles[role].label} on ${snapshot.dataset.name}.`,
        404,
      );
    }
    return row;
  }

  /** ADR-0005: every dataset owner holds the manager role, so it can't be taken away. */
  function guardOwnerManager(snapshot: Snapshot, row: MemberRow) {
    const person = domainMember(row).person;
    if (row.role === "manager" && snapshot.domain.owners.some((o) => ownerIsPerson(o, person))) {
      throw new DomainError(
        "owner-holds-manager",
        `${row.person_display} is an owner of ${snapshot.dataset.name}, and every owner holds the manager role. ` +
          "Remove them as an owner first.",
        409,
      );
    }
  }

  function removalPlans(
    snapshot: Snapshot,
    members: DatasetMember[],
    reason: string,
    causedBy: string,
  ): EntryPlan[] {
    return reconcileRemovals({
      datasetId: snapshot.dataset.id,
      datasets: [snapshot.domain],
      members,
      naming,
      changeList: entriesForRules(snapshot),
    }).map((target) => ({
      kind: "remove-member",
      target,
      grants: [...roles.roles[target.role].grants],
      reason,
      causedBy,
    }));
  }

  registry.command({
    area: "teams",
    name: "change-member-role",
    app: "tenant",
    payload: z.object({ datasetId, email: text, role: text, newRole: text }).strict(),
    leadActionTable: MEMBER_ACTIONS,
    async plan(ctx) {
      const snapshot = await snapshotOf(ctx);
      guardSnapshot(ctx, snapshot);
      await requireOwner(
        ctx,
        snapshot,
        `Only an owner of ${snapshot.dataset.name} can change members' roles.`,
      );
      const { role, newRole } = ctx.payload;
      requireRole(role);
      requireRole(newRole);
      requireActive(
        ctx,
        snapshot,
        `${snapshot.dataset.name} can't change roles until its initiative is active.`,
      );
      const row = findMember(snapshot, normalizeEmail(ctx.payload.email), role);
      if (newRole === role) {
        throw new DomainError("unchanged", "That's already their role.", 409);
      }
      guardOwnerManager(snapshot, row);
      if (snapshot.members.some((m) => m.person_email === row.person_email && m.role === newRole)) {
        throw new DomainError(
          "duplicate",
          `${row.person_display} already holds ${roles.roles[newRole].label} on ${snapshot.dataset.name}. ` +
            `Remove their ${roles.roles[role].label} role instead.`,
          409,
        );
      }

      const recordVersion = updateCurrentState(ctx, MEMBERS, row.id, ctx.expectedVersion, {
        role: newRole,
      });
      const changed: DatasetMember = { ...domainMember(row), role: newRole };
      const after = snapshot.members.map((m) => (m.id === row.id ? changed : domainMember(m)));
      const removals = removalPlans(snapshot, after, "dataset-role-changed", ctx.actionId);
      const adds = reconcileMembership({
        datasets: [snapshot.domain],
        members: [changed],
        naming,
        roles,
        actual: [],
        changeList: entriesForRules(snapshot),
      }).map((target): EntryPlan => ({
        kind: "add-member",
        target,
        grants: target.grants,
        reason: "dataset-role-changed",
        causedBy: ctx.actionId,
      }));
      await listEntries(ctx, positions(ctx), [...removals, ...adds]);
      planned.set(ctx.block, { actionId: ctx.actionId, from: role, to: newRole });
      return {
        recordId: row.id,
        recordVersion,
        leadAction: {
          action: "role-changed",
          change: { role: [role, newRole] },
          payload: memberPayload(snapshot, changed.person),
        },
      };
    },
    resultRow: memberResultRow,
    result: (row): MemberChangeWire => ({
      member: toMember(parse<MemberRow>(row["member"])),
      entries: entriesOf(row),
    }),
  });

  registry.command({
    area: "teams",
    name: "remove-member",
    app: "tenant",
    payload: z.object({ datasetId, email: text, role: text }).strict(),
    leadActionTable: MEMBER_ACTIONS,
    async plan(ctx) {
      const snapshot = await snapshotOf(ctx);
      guardSnapshot(ctx, snapshot);
      await requireOwner(
        ctx,
        snapshot,
        `Only an owner of ${snapshot.dataset.name} can remove members.`,
      );
      const role = ctx.payload.role;
      requireRole(role);
      const row = findMember(snapshot, normalizeEmail(ctx.payload.email), role);
      guardOwnerManager(snapshot, row);

      deleteRow(ctx, MEMBERS, row.id, ctx.expectedVersion, GUARD_STATE.versionConflict);
      const after = snapshot.members.filter((m) => m.id !== row.id).map(domainMember);
      await listEntries(
        ctx,
        positions(ctx),
        removalPlans(snapshot, after, "dataset-role-removed", ctx.actionId),
      );
      planned.set(ctx.block, { actionId: ctx.actionId, removed: JSON.stringify(row) });
      return {
        recordId: row.id,
        recordVersion: ctx.expectedVersion + 1,
        leadAction: {
          action: "removed",
          change: { role: [role, null] },
          payload: memberPayload(snapshot, domainMember(row).person),
        },
      };
    },
    resultRow: memberResultRow,
    result: (row): MemberRemovedWire => ({
      removed: toMember(parse<MemberRow>(row["member"])),
      entries: entriesOf(row),
    }),
  });

  // ---- owners --------------------------------------------------------------

  registry.command({
    area: "teams",
    name: "add-owner",
    app: "tenant",
    payload: z.object({ datasetId, name: text, email: text }).strict(),
    leadActionTable: OWNER_ACTIONS,
    async plan(ctx) {
      if (ctx.expectedVersion !== 0) {
        throw new DomainError("bad-version", "A new owner starts from version 0.", 400);
      }
      const email = normalizeEmail(ctx.payload.email);
      const snapshot = await snapshotOf(ctx, isValidEmail(email) ? [email] : []);
      guardSnapshot(ctx, snapshot);
      const dataset = snapshot.domain;
      await requireOwner(
        ctx,
        snapshot,
        `Only an owner of ${dataset.name}, or EDP staff, can add owners.`,
        true,
      );
      const name = ctx.payload.name.trim();
      if (!name) throw new DomainError("invalid", "Enter the new owner's name.");
      if (!isValidEmail(email)) throw invalidEmail(ctx.payload.email);
      // One person, one owner record (ADR-0006 decision 6).
      const same = findSameOwner(dataset, { email }, snapshot.bindingMap);
      if (same) {
        throw new DomainError(
          "duplicate",
          same.email === email
            ? `${email} is already an owner of ${dataset.name}.`
            : `${email} is already an owner of ${dataset.name}, as ${same.displayName}.`,
          409,
        );
      }
      // One role per person per dataset (ADR-0007 decision 11): the owner's
      // manager role can't be a second role for someone who already holds one.
      const otherRole = snapshot.members.find(
        (m) => (m.person_email ?? "") === email && m.role !== "manager",
      );
      if (otherRole) {
        throw new DomainError(
          "duplicate",
          roleTakenMessage(name, roles.roles[otherRole.role].label, dataset.name),
          409,
        );
      }

      const next = positions(ctx);
      const id = await next();
      // A re-added email keeps its binding: only the account it's bound to can act.
      const binding = snapshot.bindings.find((b) => b.email === email);
      insertCurrentState(ctx, OWNERS, id, {
        dataset_id: dataset.id,
        source: "app",
        person_display: name,
        person_email: email,
        person_principal_id: binding?.principal_id ?? null,
        bound_at: binding ? timestamp(new Date(binding.created_at)) : null,
      });
      // ADR-0005: every owner holds the manager role on their dataset.
      const existing = snapshot.members.find(
        (m) => m.person_email === email && m.role === "manager",
      );
      let manager: DatasetMember;
      let causedBy = ctx.actionId;
      if (existing) {
        manager = domainMember(existing);
      } else {
        const memberId = await next();
        manager = {
          datasetId: dataset.id,
          person: { name, email },
          role: "manager",
          addedBy: ctx.user.principalId,
          addedAt: ctx.occurredAt.toISOString(),
        };
        insertCurrentState(ctx, MEMBERS, memberId, {
          dataset_id: dataset.id,
          role: "manager",
          source: "app",
          person_display: name,
          person_email: email,
          person_principal_id: null,
        });
        causedBy = await next();
        insertAction(ctx, MEMBER_ACTIONS, {
          actionId: causedBy,
          recordId: memberId,
          action: "added",
          recordVersion: 1,
          change: { role: [null, "manager"] },
          payload: memberPayload(snapshot, manager.person),
        });
      }
      const desired = reconcileMembership({
        datasets: [dataset],
        members: [manager],
        naming,
        roles,
        actual: [],
        changeList: entriesForRules(snapshot),
      });
      await listEntries(
        ctx,
        next,
        desired.map((target) => ({
          kind: "add-member",
          target,
          grants: target.grants,
          reason: "dataset-owner-added",
          causedBy,
        })),
      );
      planned.set(ctx.block, {
        actionId: ctx.actionId,
        datasetId: dataset.id,
        order: JSON.stringify(snapshot.owners.map((o) => o.id)),
      });
      return {
        recordId: id,
        recordVersion: 1,
        leadAction: {
          action: "added",
          payload: { datasetId: dataset.id, person: { name, email } },
        },
      };
    },
    resultRow: ownerResultRow,
    result: ownerResult,
  });

  registry.command({
    area: "teams",
    name: "remove-owner",
    app: "tenant",
    payload: z.object({ datasetId, owner: text }).strict(),
    leadActionTable: OWNER_ACTIONS,
    async plan(ctx) {
      const snapshot = await snapshotOf(ctx);
      guardSnapshot(ctx, snapshot);
      const dataset = snapshot.domain;
      const bindings = snapshot.bindingMap;
      await requireOwner(
        ctx,
        snapshot,
        `Only an owner of ${dataset.name}, or EDP staff, can remove owners.`,
        true,
      );
      const wanted = ctx.payload.owner.trim();
      const owner = dataset.owners.find(
        (o) => ownerKey(o) === wanted || ownerHasEmail(o, normalizeEmail(wanted)),
      );
      if (!owner) {
        throw new DomainError("not-found", `${wanted} isn't an owner of ${dataset.name}.`, 404);
      }
      // Remove the person, not just one record (ADR-0006 decision 6).
      const person = ownerPerson(owner, bindings);
      const records = dataset.owners.filter((o) => ownerPerson(o, bindings) === person);
      const people = new Set(dataset.owners.map((o) => ownerPerson(o, bindings)));
      if (people.size === 1) {
        throw new DomainError(
          "last-owner",
          `${owner.displayName} is the last owner of ${dataset.name}, and a dataset can't be left without one. ` +
            "Add another owner first.",
          409,
        );
      }
      if (records.some((o) => !o.email && !ownerPrincipalId(o, bindings))) {
        throw new DomainError(
          "invalid",
          `${owner.displayName} has no email or SCIM id on record, so EDP staff couldn't act on ` +
            "removing them from the manager group. Ask EDP staff to fix the owner record first.",
        );
      }

      const next = positions(ctx);
      const named = snapshot.ownerRows.get(owner)!;
      const entries: EntryPlan[] = [];
      const removedMembers = new Set<string>();
      for (const record of records) {
        const row = snapshot.ownerRows.get(record)!;
        const isNamed = row.id === named.id;
        deleteRow(
          ctx,
          OWNERS,
          row.id,
          isNamed ? ctx.expectedVersion : Number(row.version),
          isNamed ? GUARD_STATE.versionConflict : REPLAN,
        );
        const payload = {
          datasetId: dataset.id,
          person: { name: record.displayName, email: record.email ?? null },
        };
        if (!isNamed) {
          insertAction(ctx, OWNER_ACTIONS, {
            actionId: await next(),
            recordId: row.id,
            action: "removed",
            recordVersion: Number(row.version) + 1,
            payload,
          });
        }
        // The manager role goes with ownership (ADR-0005), and its entry is
        // always listed: the membership may predate the app (standup).
        const fallback: PersonContact = { name: record.displayName, email: record.email ?? "" };
        if (!record.email) fallback.principalId = ownerPrincipalId(record, bindings)!;
        const managerRow = snapshot.members.find(
          (m) =>
            !removedMembers.has(m.id) &&
            m.role === "manager" &&
            ownerIsPerson(record, domainMember(m).person),
        );
        let causedBy = ctx.actionId;
        if (managerRow) {
          removedMembers.add(managerRow.id);
          deleteRow(ctx, MEMBERS, managerRow.id, Number(managerRow.version), REPLAN);
          causedBy = await next();
          insertAction(ctx, MEMBER_ACTIONS, {
            actionId: causedBy,
            recordId: managerRow.id,
            action: "removed",
            recordVersion: Number(managerRow.version) + 1,
            change: { role: ["manager", null] },
            payload: memberPayload(snapshot, domainMember(managerRow).person),
          });
        }
        entries.push({
          kind: "remove-member",
          target: {
            group: datasetGroupName(naming, dataset, "manager"),
            person: managerRow ? domainMember(managerRow).person : fallback,
            datasetId: dataset.id,
            role: "manager",
          },
          grants: [...roles.roles.manager.grants],
          reason: "dataset-owner-removed",
          causedBy,
        });
      }
      await listEntries(ctx, next, entries);
      planned.set(ctx.block, {
        actionId: ctx.actionId,
        datasetId: dataset.id,
        order: JSON.stringify(snapshot.owners.map((o) => o.id)),
      });
      return {
        recordId: named.id,
        recordVersion: ctx.expectedVersion + 1,
        leadAction: {
          action: "removed",
          payload: {
            datasetId: dataset.id,
            person: { name: owner.displayName, email: owner.email ?? null },
          },
        },
      };
    },
    resultRow: ownerResultRow,
    result: ownerResult,
  });

  // ---- ADR-0006: binding an owner's email, and recording a refusal ---------

  registry.command({
    area: "teams",
    name: "bind-email",
    app: "tenant",
    payload: z.object({ datasetId }).strict(),
    leadActionTable: BINDING_ACTIONS,
    async plan(ctx) {
      const snapshot = await snapshotOf(ctx);
      const claim = evaluateClaim(snapshot.domain, ctx.user, snapshot.bindingMap);
      if (claim.kind !== "owner" || !claim.bindEmail) {
        throw new DomainError("nothing-to-bind", "There's no email to bind here.", 409);
      }
      guardSnapshot(ctx, snapshot);
      const email = claim.bindEmail;
      const next = positions(ctx);
      const id = await next();
      insertRow(ctx, BINDINGS, {
        id,
        email,
        principal_id: ctx.user.principalId,
        created_at: timestamp(ctx.occurredAt),
        created_by_principal_id: ctx.user.principalId,
      });
      expectRow(ctx, BINDINGS, "id", id);
      // The binding belongs to the email on every dataset: copy it onto each owner record with it.
      const records = await ctx.read<OwnerRow>({
        statement: `SELECT id, dataset_id, version, person_display, person_email FROM ${tableName(ctx.names, OWNERS)} WHERE person_email = :email AND person_principal_id IS NULL`,
        parameters: { email },
      });
      for (const row of records) {
        const version = updateReadRow(ctx, OWNERS, row.id, Number(row.version), {
          person_principal_id: ctx.user.principalId,
          bound_at: timestamp(ctx.occurredAt),
        });
        insertAction(ctx, OWNER_ACTIONS, {
          actionId: await next(),
          recordId: row.id,
          action: "bound",
          recordVersion: version,
          payload: { datasetId: row.dataset_id, person: { name: row.person_display, email } },
        });
      }
      return {
        recordId: id,
        recordVersion: 1,
        leadAction: { action: "bound", payload: { datasetId: snapshot.dataset.id } },
      };
    },
    resultRow: ({ recordId, names, block }) =>
      `SELECT id, email, principal_id FROM ${tableName(names, BINDINGS)} WHERE id = ${block.bind(recordId)}`,
    result: (row) => ({ email: row["email"] as string }),
  });

  registry.command({
    area: "teams",
    name: "record-ownership-refusal",
    app: "tenant",
    payload: z.object({ datasetId }).strict(),
    leadActionTable: OWNER_ACTIONS,
    async plan(ctx) {
      const snapshot = await snapshotOf(ctx);
      const claim = evaluateClaim(snapshot.domain, ctx.user, snapshot.bindingMap);
      if (claim.kind !== "mismatch" || !claim.flagged) {
        throw new DomainError("nothing-to-record", "There's no refusal to record here.", 409);
      }
      guardSnapshot(ctx, snapshot);
      const row = snapshot.ownerRows.get(claim.flagged)!;
      // Like every action, a refusal moves the record's version (ADR-0006 decision 5).
      const recordVersion = updateReadRow(ctx, OWNERS, row.id, Number(row.version), {});
      return {
        recordId: row.id,
        recordVersion,
        leadAction: {
          action: "access-refused",
          payload: {
            datasetId: snapshot.dataset.id,
            refusedPrincipalId: ctx.user.principalId,
            email: sessionEmail(ctx.user),
          },
        },
      };
    },
    resultRow: ({ recordId, names, block }) =>
      `SELECT id, version FROM ${tableName(names, OWNERS)} WHERE id = ${block.bind(recordId)}`,
    result: () => ({ refused: true }),
  });

  // ---- the change list -----------------------------------------------------

  registry.command({
    area: "change-list",
    name: "mark-applied",
    app: "staff",
    payload: z.object({ entryId: z.string().uuid() }).strict(),
    leadActionTable: ENTRY_ACTIONS,
    authorize: (user) => {
      if (!user.isAdmin) {
        throw new DomainError("not-edp-staff", "Only EDP staff can mark changes applied.", 403);
      }
    },
    async plan(ctx) {
      const [entry] = await ctx.read<EntryRow>({
        statement: entrySelect(ctx.names, "e.id = :id"),
        parameters: { id: ctx.payload.entryId },
      });
      if (!entry) {
        throw new DomainError("not-found", `No change-list entry ${ctx.payload.entryId}.`, 404);
      }
      const label = entryLabel(Number(entry.display_number));
      if (entry.applied_at) {
        throw new DomainError(
          "already-applied",
          `${label} was already marked applied by ${entry.applied_by_principal_id} at ${new Date(entry.applied_at).toISOString()}.`,
          409,
        );
      }
      const applications = tableName(ctx.names, APPLICATIONS);
      ctx.block.guard(
        `EXISTS (SELECT 1 FROM ${applications} WHERE change_list_entry_id = ${ctx.block.bind(entry.id)})`,
        new DomainError("already-applied", `${label} was already marked applied.`, 409),
      );
      // MVP: EDP staff apply by hand and record it (ADR-0008 decision 4).
      const id = await followOn(ctx, 0);
      insertRow(ctx, APPLICATIONS, {
        id,
        change_list_entry_id: entry.id,
        method: "by-hand",
        run_id: null,
        outcome: null,
        created_at: timestamp(ctx.occurredAt),
        created_by_principal_id: ctx.user.principalId,
        caused_by_action_id: ctx.actionId,
      });
      expectRow(ctx, APPLICATIONS, "id", id);
      const recordVersion = updateCurrentState(ctx, ENTRIES, entry.id, ctx.expectedVersion, {});
      return {
        recordId: entry.id,
        recordVersion,
        leadAction: { action: "applied", change: { stage: ["pending", "applied"] } },
      };
    },
    resultRow: ({ recordId, names, block }) => entrySelect(names, `e.id = ${block.bind(recordId)}`),
    result: (row) => toEntry(row as unknown as EntryRow),
  });

  // ---- reads ---------------------------------------------------------------

  registry.read({
    area: "initiatives",
    name: "initiatives",
    app: "tenant",
    query: z.object({}).strict(),
    snapshot: ({ snapshot }) =>
      snapshot.table<Record<string, unknown>>("initiatives", "initiatives").map((row) => ({
        id: row["id"],
        name: row["name"],
        tenant: row["tenant"],
        stage: row["stage"],
      })),
    run: ({ names, read }) =>
      read({
        statement: `SELECT id, name, tenant, stage FROM ${tableName(names, INITIATIVES)} i ORDER BY i._metadata.row_id`,
      }),
  });

  registry.read({
    area: "initiatives",
    name: "datasets",
    app: "tenant",
    dependsOn: ["teams"],
    query: z.object({ id: datasetId.optional() }).strict(),
    snapshot({ snapshot, query }) {
      const datasets = snapshot
        .table<DatasetRow>("initiatives", "datasets")
        .filter((row) => (query.id ? row.id === query.id : true));
      const owners = snapshotOwnerRows(snapshot);
      return datasets.map((d) =>
        toDataset(
          d,
          owners.filter((o) => o.dataset_id === d.id),
        ),
      );
    },
    async run({ query, names, read }) {
      const where = query.id ? "d.id = :id" : "TRUE";
      const parameters = query.id ? { id: query.id } : {};
      const [datasets, owners] = await Promise.all([
        read<DatasetRow>({
          statement: `SELECT d.id, d.initiative_id, d.name, d.domain_tag, d.dataset_tag, d.version FROM ${tableName(names, DATASETS)} d WHERE ${where} ORDER BY d._metadata.row_id`,
          parameters,
        }),
        read<OwnerRow>({
          statement: ownerSelect(names, query.id ? "o.dataset_id = :id" : "TRUE"),
          parameters,
        }),
      ]);
      return datasets.map((d) =>
        toDataset(
          d,
          owners.filter((o) => o.dataset_id === d.id),
        ),
      );
    },
  });

  registry.read({
    area: "initiatives",
    name: "dataset-member-summaries",
    app: "tenant",
    dependsOn: ["teams"],
    query: z.object({}).strict(),
    snapshot({ snapshot, user }): DatasetWithMemberSummary[] {
      const datasets = snapshot.table<DatasetRow>("initiatives", "datasets");
      const owners = snapshotOwnerRows(snapshot);
      const members = snapshot.table<MemberRow>("teams", "dataset_members");
      const readable = teamReadable(owners, user);
      return datasets.map((d) => {
        const datasetMembers = members.filter((m) => m.dataset_id === d.id);
        const roleCounts = Object.fromEntries(DATASET_ROLES.map((role) => [role, 0])) as Record<
          DatasetRoleName,
          number
        >;
        const seen = new Set<string>();
        const viewerRoles: DatasetRoleName[] = [];
        for (const member of datasetMembers) {
          roleCounts[member.role] += 1;
          seen.add(
            member.person_email && member.person_email !== ""
              ? member.person_email
              : `scim:${member.person_principal_id ?? member.person_display}`,
          );
          if (isOwnMemberRow(member, user)) viewerRoles.push(member.role);
        }
        return {
          ...toDataset(
            d,
            owners.filter((o) => o.dataset_id === d.id),
          ),
          memberSummary: readable(d.id)
            ? { totalMembers: seen.size, roleCounts, viewerRoles }
            : { totalMembers: null, roleCounts: null, viewerRoles },
        };
      });
    },
    async run({ user, names, read }): Promise<DatasetWithMemberSummary[]> {
      const [datasets, owners, roleCountRows, totalRows, viewerRows] = await Promise.all([
        read<DatasetRow>({
          statement: `SELECT d.id, d.initiative_id, d.name, d.domain_tag, d.dataset_tag, d.version FROM ${tableName(names, DATASETS)} d ORDER BY d._metadata.row_id`,
        }),
        read<OwnerRow>({
          statement: ownerSelect(names, "TRUE"),
        }),
        read<{
          dataset_id: string;
          role: DatasetRoleName;
          member_count: number;
        }>({
          statement: `SELECT m.dataset_id, m.role, count(*) AS member_count FROM ${tableName(names, MEMBERS)} m GROUP BY m.dataset_id, m.role`,
        }),
        read<{ dataset_id: string; total_members: number }>({
          statement:
            `SELECT m.dataset_id, count(DISTINCT CASE WHEN m.person_email IS NOT NULL AND m.person_email <> '' THEN m.person_email ` +
            `ELSE 'scim:' || coalesce(m.person_principal_id, m.person_display) END) AS total_members ` +
            `FROM ${tableName(names, MEMBERS)} m GROUP BY m.dataset_id`,
        }),
        read<{ dataset_id: string; role: DatasetRoleName }>({
          // The viewer's own rows, as isOwnMemberRow: by SCIM id or by email.
          statement:
            `SELECT m.dataset_id, m.role FROM ${tableName(names, MEMBERS)} m ` +
            `WHERE (:viewerId <> '' AND m.person_principal_id = :viewerId) ` +
            `OR (:viewerEmail <> '' AND m.person_email = :viewerEmail) ORDER BY m._metadata.row_id`,
          parameters: { viewerId: user.principalId ?? "", viewerEmail: sessionEmail(user) },
        }),
      ]);
      const roleCountsByDataset = new Map<string, Record<DatasetRoleName, number>>();
      for (const row of roleCountRows) {
        const counts =
          roleCountsByDataset.get(row.dataset_id) ??
          (Object.fromEntries(DATASET_ROLES.map((role) => [role, 0])) as Record<
            DatasetRoleName,
            number
          >);
        counts[row.role] = Number(row.member_count);
        roleCountsByDataset.set(row.dataset_id, counts);
      }
      const totalByDataset = new Map(
        totalRows.map((row) => [row.dataset_id, Number(row.total_members)]),
      );
      const readable = teamReadable(owners, user);
      const viewerRolesByDataset = new Map<string, DatasetRoleName[]>();
      for (const row of viewerRows) {
        viewerRolesByDataset.set(row.dataset_id, [
          ...(viewerRolesByDataset.get(row.dataset_id) ?? []),
          row.role,
        ]);
      }
      return datasets.map((d) => {
        const roleCounts =
          roleCountsByDataset.get(d.id) ??
          (Object.fromEntries(DATASET_ROLES.map((role) => [role, 0])) as Record<
            DatasetRoleName,
            number
          >);
        return {
          ...toDataset(
            d,
            owners.filter((o) => o.dataset_id === d.id),
          ),
          memberSummary: readable(d.id)
            ? {
                totalMembers: totalByDataset.get(d.id) ?? 0,
                roleCounts,
                viewerRoles: viewerRolesByDataset.get(d.id) ?? [],
              }
            : {
                totalMembers: null,
                roleCounts: null,
                viewerRoles: viewerRolesByDataset.get(d.id) ?? [],
              },
        };
      });
    },
  });

  registry.read({
    area: "teams",
    name: "members",
    app: "tenant",
    query: z.object({ datasetId }).strict(),
    snapshot({ snapshot, query, user }) {
      const readable = teamReadable(snapshotOwnerRows(snapshot), user)(query.datasetId);
      return snapshot
        .table<MemberRow>("teams", "dataset_members")
        .filter(
          (row) => row.dataset_id === query.datasetId && (readable || isOwnMemberRow(row, user)),
        )
        .map(toMember);
    },
    async run({ query, user, names, read }) {
      const parameters = { id: query.datasetId };
      const [owners, members] = await Promise.all([
        user.isAdmin
          ? []
          : read<OwnerRow>({ statement: ownerSelect(names, "o.dataset_id = :id"), parameters }),
        read<MemberRow>({
          statement: `SELECT ${MEMBER_COLUMNS("m")} FROM ${tableName(names, MEMBERS)} m WHERE m.dataset_id = :id ORDER BY m._metadata.row_id`,
          parameters,
        }),
      ]);
      const readable = teamReadable(owners, user)(query.datasetId);
      return members.filter((row) => readable || isOwnMemberRow(row, user)).map(toMember);
    },
  });

  registry.read({
    area: "teams",
    name: "events",
    app: "tenant",
    dependsOn: ["change-list"],
    query: z.object({ datasetId }).strict(),
    snapshot({ snapshot, query, user }): TeamEvent[] {
      const readable = teamReadable(snapshotOwnerRows(snapshot), user)(query.datasetId);
      const ownerActions = snapshot
        .table<Record<string, unknown>>("teams", "dataset_owner_actions")
        .filter(
          (a) =>
            (a["action"] === "added" || a["action"] === "removed") &&
            a["caused_by_action_id"] === null &&
            parse<{ datasetId?: string }>(a["payload"]).datasetId === query.datasetId,
        );
      const memberActions = snapshot
        .table<Record<string, unknown>>("teams", "dataset_member_actions")
        .filter(
          (a) =>
            (a["action"] === "role-changed" || a["action"] === "removed") &&
            a["caused_by_action_id"] === null &&
            parse<{ datasetId?: string }>(a["payload"]).datasetId === query.datasetId,
        );
      const entries = snapshot
        .table<Record<string, unknown>>("change_list", "change_list_entries")
        .filter((entry) => entry["dataset_id"] === query.datasetId);
      const entryActions = snapshot.table<Record<string, unknown>>(
        "change_list",
        "change_list_entry_actions",
      );
      const entryIds = (key: string) =>
        entries
          .filter((entry) =>
            entryActions.some(
              (action) =>
                action["change_list_entry_id"] === entry["id"] &&
                action["action"] === "listed" &&
                action["idempotency_key"] === key,
            ),
          )
          .map((entry) => entryLabel(Number(entry["display_number"])))
          .sort();
      const events: TeamEvent[] = [
        ...ownerActions.map((a): TeamEvent => {
          const payload = parse<{ person: { name: string; email: string | null } }>(a["payload"]);
          return {
            datasetId: query.datasetId,
            kind: a["action"] === "added" ? "owner-added" : "owner-removed",
            person: payload.person,
            by: String(a["actor_principal_id"]),
            at: new Date(String(a["occurred_at"])).toISOString(),
            entryIds: entryIds(String(a["idempotency_key"])),
          };
        }),
        ...memberActions.map((a): TeamEvent => {
          const { person } = parse<{ person: PersonContact }>(a["payload"]);
          const common = {
            datasetId: query.datasetId,
            person,
            by: String(a["actor_principal_id"]),
            at: new Date(String(a["occurred_at"])).toISOString(),
            entryIds: entryIds(String(a["idempotency_key"])),
          };
          return a["action"] === "role-changed"
            ? {
                ...common,
                kind: "role-changed",
                from: a["from_role"] as DatasetRoleName,
                to: a["to_role"] as DatasetRoleName,
              }
            : { ...common, kind: "member-removed", role: a["from_role"] as DatasetRoleName };
        }),
      ];
      return visibleEvents(events, readable, user);
    },
    async run({ query, user, names, read }): Promise<TeamEvent[]> {
      const parameters = { id: query.datasetId };
      const readable = teamReadable(
        user.isAdmin
          ? []
          : await read<OwnerRow>({
              statement: ownerSelect(names, "o.dataset_id = :id"),
              parameters,
            }),
        user,
      )(query.datasetId);
      const leads = `caused_by_action_id IS NULL AND get_json_object(payload, '$.datasetId') = :id`;
      const owners = await read<{
        action: string;
        actor_principal_id: string;
        occurred_at: string;
        idempotency_key: string;
        payload: string;
      }>({
        statement: `SELECT a.action, a.actor_principal_id, a.occurred_at, a.idempotency_key, a.payload FROM ${tableName(names, OWNER_ACTIONS)} a WHERE a.action IN ('added', 'removed') AND ${leads} ORDER BY a._metadata.row_id`,
        parameters,
      });
      const members = await read<{
        action: string;
        from_role: DatasetRoleName | null;
        to_role: DatasetRoleName | null;
        actor_principal_id: string;
        occurred_at: string;
        idempotency_key: string;
        payload: string;
      }>({
        statement: `SELECT a.action, a.from_role, a.to_role, a.actor_principal_id, a.occurred_at, a.idempotency_key, a.payload FROM ${tableName(names, MEMBER_ACTIONS)} a WHERE a.action IN ('role-changed', 'removed') AND ${leads} ORDER BY a._metadata.row_id`,
        parameters,
      });
      const listed = await read<{ display_number: number; idempotency_key: string }>({
        statement: `SELECT e.display_number, a.idempotency_key FROM ${tableName(names, ENTRIES)} e JOIN ${tableName(names, ENTRY_ACTIONS)} a ON a.change_list_entry_id = e.id AND a.action = 'listed' WHERE e.dataset_id = :id ORDER BY e.display_number`,
        parameters,
      });
      const entryIds = (key: string) =>
        listed
          .filter((l) => l.idempotency_key === key)
          .map((l) => entryLabel(Number(l.display_number)));
      const events: TeamEvent[] = [
        ...owners.map((a): TeamEvent => {
          const payload = parse<{ person: { name: string; email: string | null } }>(a.payload);
          return {
            datasetId: query.datasetId,
            kind: a.action === "added" ? "owner-added" : "owner-removed",
            person: payload.person,
            by: a.actor_principal_id,
            at: new Date(a.occurred_at).toISOString(),
            entryIds: entryIds(a.idempotency_key),
          };
        }),
        ...members.map((a): TeamEvent => {
          const { person } = parse<{ person: PersonContact }>(a.payload);
          const common = {
            datasetId: query.datasetId,
            person,
            by: a.actor_principal_id,
            at: new Date(a.occurred_at).toISOString(),
            entryIds: entryIds(a.idempotency_key),
          };
          return a.action === "role-changed"
            ? { ...common, kind: "role-changed", from: a.from_role!, to: a.to_role! }
            : { ...common, kind: "member-removed", role: a.from_role! };
        }),
      ];
      return visibleEvents(events, readable, user);
    },
  });

  registry.read({
    area: "teams",
    name: "ownership",
    app: "tenant",
    dependsOn: ["initiatives"],
    query: z.object({ datasetId }).strict(),
    snapshot({ snapshot, query, user }): { status: OwnershipStatus; message?: string } {
      const dataset = snapshot
        .table<DatasetRow>("initiatives", "datasets")
        .find((row) => row.id === query.datasetId);
      if (!dataset) throw new DomainError("not-found", `No dataset ${query.datasetId}.`, 404);
      const owners = snapshotOwnerRows(snapshot).filter(
        (row) => row.dataset_id === query.datasetId,
      );
      const domain = toDataset(dataset, owners);
      const claim = evaluateClaim(domain, user, snapshotBindingMap(snapshot));
      const status: OwnershipStatus =
        claim.kind === "owner" ? (claim.bindEmail ? "bind" : "owner") : claim.kind;
      return status === "mismatch"
        ? { status, message: ownerMismatchMessage(domain, user) }
        : { status };
    },
    async run({
      query,
      user,
      names,
      read,
    }): Promise<{ status: OwnershipStatus; message?: string }> {
      const snapshot = await readSnapshot({ names, read }, query.datasetId, [sessionEmail(user)]);
      if (!snapshot) throw new DomainError("not-found", `No dataset ${query.datasetId}.`, 404);
      const claim = evaluateClaim(snapshot.domain, user, snapshot.bindingMap);
      const status: OwnershipStatus =
        claim.kind === "owner" ? (claim.bindEmail ? "bind" : "owner") : claim.kind;
      return status === "mismatch"
        ? { status, message: ownerMismatchMessage(snapshot.domain, user) }
        : { status };
    },
  });

  registry.read({
    area: "change-list",
    name: "entries",
    app: "tenant",
    dependsOn: ["teams"],
    query: z.object({}).strict(),
    snapshot({ snapshot, user }) {
      const entries = snapshotEntryRows(snapshot);
      if (user.isAdmin) return entries.map((row) => toEntry(row));
      const owners = snapshotOwnerRows(snapshot);
      const byDataset = new Map<string, DatasetOwner[]>();
      for (const row of owners) {
        byDataset.set(row.dataset_id, [
          ...(byDataset.get(row.dataset_id) ?? []),
          bare(toOwner(row)),
        ]);
      }
      const owned = new Set(
        [...byDataset.entries()]
          .filter(([, list]) => isDatasetOwner({ owners: list }, user))
          .map(([id]) => id),
      );
      return entries.filter((entry) => owned.has(entry.dataset_id)).map((row) => toEntry(row));
    },
    async run({ user, names, read }) {
      if (user.isAdmin)
        return (await read<EntryRow>({ statement: entrySelect(names, "TRUE") })).map((row) =>
          toEntry(row),
        );
      // Anyone else: only entries for datasets they own, by the owner records (no binding on a read).
      const owners = await read<OwnerRow>({ statement: ownerSelect(names, "TRUE") });
      const byDataset = new Map<string, DatasetOwner[]>();
      for (const row of owners) {
        byDataset.set(row.dataset_id, [
          ...(byDataset.get(row.dataset_id) ?? []),
          bare(toOwner(row)),
        ]);
      }
      const owned = [...byDataset.entries()]
        .filter(([, list]) => isDatasetOwner({ owners: list }, user))
        .map(([id]) => id);
      if (!owned.length) return [];
      return (
        await read<EntryRow>({
          statement: entrySelect(
            names,
            `e.dataset_id IN (${owned.map((_, i) => `:d${i}`).join(", ")})`,
          ),
          parameters: Object.fromEntries(owned.map((id, i) => [`d${i}`, id])),
        })
      ).map((row) => toEntry(row));
    },
  });
}
