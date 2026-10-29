// The team page's overview (#114): KPI cards that filter the team table, and
// the table itself, one row per person. The table edits nothing: its Edit
// access buttons open the panel where changes are confirmed.
import type { CSSProperties } from "react";

import { SavingTag } from "@/components/SaveStatus";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import {
  DATASET_ROLES,
  personContact,
  type Dataset,
  type DatasetRoleName,
} from "@/data/datasets/types";
import type { SaveView } from "@/data/optimistic-save";
import type { DatasetAccessChrome, ScreenCtx } from "./resolveChrome";
import { matchesFilter, type TeamFilter, type TeamPerson } from "./teamPeople";
import { smallBtn, TableScroll } from "./teamShared";
import * as s from "./styles";

/** The id of the table's scroll region: where focus goes when a row's button has gone. */
export const TEAM_TABLE_ID = "team-members-table";

/** What the filter status says it's showing; roles use their configured plural labels. */
function filterWords(filter: TeamFilter, roles: RoleDescriptions): string {
  if (filter === "everyone") return "everyone";
  if (filter === "pending") return "people with pending changes";
  return roles.roles[filter].pluralLabel.toLowerCase();
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * The KPI cards. Each filters the table; Members shows everyone. They look
 * like the house StatCard (src/legacy/access.jsx), as buttons so they work
 * from the keyboard. Pending changes shows only to those who can read the
 * change list (`pending` is `null` for anyone else).
 */
export function KpiCards({
  team,
  pending,
  filter,
  onFilter,
  roles,
  chrome,
}: {
  team: TeamPerson[];
  pending: number | null;
  filter: TeamFilter;
  onFilter: (filter: TeamFilter) => void;
  roles: RoleDescriptions;
  chrome: DatasetAccessChrome;
}) {
  const current = team.filter((p) => p.member);
  const count = (role: DatasetRoleName) =>
    current.filter((p) => matchesFilter(p, role, undefined)).length;
  const cards: { id: TeamFilter; n: number; label: string; icon: string; warn?: boolean }[] = [
    { id: "everyone", n: current.length, label: "Members", icon: "group" },
    ...DATASET_ROLES.map((role) => ({
      id: role,
      n: count(role),
      label: roles.roles[role].pluralLabel,
      icon: "group",
    })),
    ...(pending === null
      ? []
      : [
          {
            id: "pending" as const,
            n: pending,
            label: "Pending changes",
            icon: "schedule",
            warn: pending > 0,
          },
        ]),
  ];
  const { Icon } = chrome;
  return (
    <div role="group" aria-label="Filter the team" style={kpiGrid}>
      {cards.map((card) => {
        const active = filter === card.id;
        return (
          <button
            key={card.id}
            type="button"
            aria-pressed={active}
            aria-label={`${card.n} ${card.label}`}
            onClick={() => onFilter(card.id)}
            style={kpiCard(active)}
          >
            <span style={kpiIcon(card.warn)}>
              <Icon
                name={card.icon}
                size={24}
                color={card.warn ? "var(--theme-warning-darker)" : "var(--theme-primary)"}
              />
            </span>
            <span>
              <span style={kpiNumber}>{card.n}</span>
              <span style={kpiLabel}>{card.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** What the table is showing, and the way back to everyone. */
export function FilterStatus({
  filter,
  shown,
  total,
  onClear,
  roles,
}: {
  filter: TeamFilter;
  shown: number;
  total: number;
  onClear: () => void;
  roles: RoleDescriptions;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <p role="status" aria-label="Table filter" style={{ margin: 0 }}>
        Showing <strong>{filterWords(filter, roles)}</strong>:{" "}
        {filter === "everyone" ? people(total) : `${shown} of ${people(total)}`}
      </p>
      {filter === "everyone" ? null : (
        <button type="button" onClick={onClear} style={s.linkBtn}>
          Clear filter
        </button>
      )}
    </div>
  );
}

/** One row per person: who, their role badge(s), what it grants, status and Edit access. */
export function PeopleTable({
  ctx,
  chrome,
  dataset,
  roles,
  team,
  rowSave,
  canManage,
  showStatus,
  onEdit,
  emptyText = "No one here matches this filter.",
}: {
  ctx: ScreenCtx;
  chrome: DatasetAccessChrome;
  dataset: Dataset;
  roles: RoleDescriptions;
  team: TeamPerson[];
  rowSave: (person: TeamPerson) => SaveView | undefined;
  canManage: boolean;
  /** Only those who can read the change list see where each change stands. */
  showStatus: boolean;
  onEdit: (person: TeamPerson) => void;
  /** What an empty table says. */
  emptyText?: string;
}) {
  const { Panel, Pill, Icon } = chrome;
  const headers = [
    "Person",
    "Role",
    "Access levels",
    ...(showStatus ? ["Status"] : []),
    ...(canManage ? ["Actions"] : []),
  ];
  const toChangeList = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    ctx.go("change-list", { id: dataset.id });
  };

  return (
    <Panel pad={0} style={{ overflow: "hidden" }}>
      <TableScroll id={TEAM_TABLE_ID} label="Team members" minWidth={760}>
        <table style={s.table} aria-label="Members">
          <thead>
            <tr style={s.headRow}>
              {headers.map((h) => (
                <th key={h} style={s.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {team.length === 0 ? (
              <tr style={s.row}>
                <td style={{ ...s.td, color: "var(--text-muted)" }} colSpan={headers.length}>
                  {emptyText}
                </td>
              </tr>
            ) : null}
            {team.map((person) => {
              const save = rowSave(person);
              const removed = !person.member;
              const role = roles.roles[person.roles[0]!];
              return (
                <tr key={person.key} style={s.row}>
                  <td style={s.td}>
                    <div style={{ fontWeight: 700 }}>{person.person.name}</div>
                    <div style={s.muted}>{personContact(person.person)}</div>
                  </td>
                  <td style={s.td}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {person.roles.map((r) => (
                        <Pill
                          key={r}
                          bg={removed ? "var(--color-gray-5)" : "var(--color-blue-5v)"}
                          fg={removed ? "var(--text-muted)" : "var(--theme-primary-dark)"}
                        >
                          {roles.roles[r].label}
                        </Pill>
                      ))}
                      {person.isOwner ? (
                        <Pill bg="var(--theme-warning-lighter)" fg="var(--theme-warning-darker)">
                          Owner
                        </Pill>
                      ) : null}
                    </div>
                  </td>
                  <td style={{ ...s.td, ...s.muted, minWidth: 180, maxWidth: 320 }}>
                    {role.summary}
                  </td>
                  {showStatus ? (
                    <td style={s.td}>
                      {save ? (
                        <SavingTag save={save} />
                      ) : person.status.kind === "active" ? (
                        <Pill
                          icon="check_circle"
                          bg="var(--theme-success-lighter)"
                          fg="var(--theme-success-darker)"
                        >
                          Active
                        </Pill>
                      ) : (
                        <a
                          href={`#change-list/${encodeURIComponent(dataset.id)}`}
                          onClick={toChangeList}
                          aria-label={`${statusWords(person)}, ${person.status.entry.id}`}
                          style={{ textDecoration: "none" }}
                        >
                          <Pill
                            icon={person.status.kind === "snapshot-seen" ? "verified" : "schedule"}
                            bg={
                              person.status.kind === "snapshot-seen"
                                ? "var(--theme-success-lighter)"
                                : "var(--theme-warning-lighter)"
                            }
                            fg={
                              person.status.kind === "snapshot-seen"
                                ? "var(--theme-success-darker)"
                                : "var(--theme-warning-darker)"
                            }
                          >
                            {statusWords(person)} · {person.status.entry.id}
                          </Pill>
                        </a>
                      )}
                    </td>
                  ) : null}
                  {canManage ? (
                    <td style={s.td}>
                      {save ? (
                        <span style={s.muted}>Available once saved</span>
                      ) : removed ? (
                        <span style={s.muted}>
                          {person.status.kind === "snapshot-seen"
                            ? "Removal seen in snapshot"
                            : "Removal waiting on EDP staff"}
                        </span>
                      ) : person.isOwner && person.roles.includes("manager") ? (
                        <span style={s.muted}>Owner: holds {roles.roles.manager.label}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onEdit(person)}
                          aria-label={`Edit access for ${person.person.name}`}
                          style={{ ...s.outlineBtn, ...smallBtn }}
                        >
                          <Icon name="tune" size={14} color="var(--theme-primary)" />
                          Edit access
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}

function statusWords(person: TeamPerson) {
  if (person.status.kind === "snapshot-seen") return "Seen in snapshot";
  return person.status.kind === "pending-removal" ? "Pending removal" : "Pending add";
}

const kpiGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))",
  gap: 16,
};

/** The house StatCard's look (src/legacy/access.jsx), plus a selected state. */
function kpiCard(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 14,
    width: "100%",
    textAlign: "left",
    cursor: "pointer",
    padding: 24,
    font: "inherit",
    color: "var(--text-default)",
    background: active ? "var(--color-blue-5v)" : "var(--surface-default)",
    border: `1px solid ${active ? "var(--theme-primary)" : "var(--border-default)"}`,
    borderRadius: "var(--radius-lg)",
    boxShadow: active ? "inset 0 0 0 1px var(--theme-primary), var(--shadow-1)" : "var(--shadow-1)",
  };
}

function kpiIcon(warn?: boolean): CSSProperties {
  return {
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: "var(--radius-md)",
    background: warn ? "var(--theme-warning-lighter)" : "var(--color-blue-5v)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

const kpiNumber: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-xl)",
  fontWeight: 700,
  lineHeight: 1,
};

const kpiLabel: CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  marginTop: 3,
};
