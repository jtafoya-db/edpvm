import { entryDatasetId, isPendingChange, type ChangeListEntry } from "@/data/change-list/types";
import {
  PendingActionButton,
  PendingActionStatus,
  keepIntentForUnknownOutcome,
  usePendingActionGroup,
} from "@/components/PendingAction";
import {
  useChangeList,
  useDatasets,
  useMarkChangeApplied,
  useRoleDescriptions,
} from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { Dataset } from "@/data/datasets/types";
import { useUser } from "@/data/queries";
import { FeatureGate } from "@/features/FeatureGate";
import { RefreshButton } from "../RefreshButton";
import { ActionErrorNotice, Notice, QueryGate, SessionStateNotice, Timestamp } from "./chrome";
import { EntryWhat, entryWhy } from "./entryText";
import { resolveChrome, type DatasetAccessChrome, type ScreenProps } from "./resolveChrome";
import * as s from "./styles";

/**
 * The change list: every change to make in Databricks, with what and why.
 * EDP staff read every entry; a dataset's owners read only that dataset's
 * (#123). Only EDP staff can mark an entry applied, and the store refuses
 * anyone else regardless of what this screen shows.
 */
export function ChangeListScreen({ ctx, params, chrome: injected }: ScreenProps) {
  const chrome = resolveChrome(injected);
  const { Page, Trail, Panel, Pill } = chrome;
  const entries = useChangeList();
  const datasets = useDatasets();
  const roles = useRoleDescriptions();
  const user = useUser();
  const markApplied = useMarkChangeApplied();
  const pendingActions = usePendingActionGroup();
  const isStaff = user.data?.isAdmin === true;
  // `#change-list/<dataset id>`, from a team page's Pending changes (#114): that dataset only.
  const datasetId = params?.id;
  const filteredTo = datasetId ? datasets.data?.find((d) => d.id === datasetId) : undefined;
  const shown = (entries.data ?? []).filter((e) => !datasetId || entryDatasetId(e) === datasetId);
  const pending = shown.filter(isPendingChange).length;

  return (
    <Page>
      <Trail items={[{ label: "Home", go: () => ctx.go("home") }, { label: "Change list" }]} />
      <FeatureGate id="change-list">
        <div style={{ ...s.titleRow, flexWrap: "wrap" }}>
          <div>
            <h1 style={s.h1}>Change list</h1>
            <p style={s.subtitle}>
              Entries start Requested. EDP staff apply them by hand and can record Marked applied. A
              fresh, complete membership snapshot can show Seen in snapshot. The app never changes
              Databricks.
            </p>
            {datasetId ? (
              <p style={{ ...s.subtitle, marginTop: 6 }}>
                Showing entries for <strong>{filteredTo?.name ?? datasetId}</strong>.{" "}
                <a
                  href="#change-list"
                  onClick={(e) => {
                    e.preventDefault();
                    ctx.go("change-list");
                  }}
                  style={s.linkBtn}
                >
                  Show every entry
                </a>
              </p>
            ) : null}
          </div>
          {entries.data ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <RefreshButton queries={[entries]} what="the change list" />
              <Pill
                size="md"
                icon="schedule"
                bg="var(--color-blue-5v)"
                fg="var(--theme-primary)"
                bd="var(--color-blue-20v)"
              >
                {pending} pending
              </Pill>
            </div>
          ) : null}
        </div>
        <div style={s.stack}>
          <SessionStateNotice chrome={chrome} />
          <QueryGate
            isPending={entries.isPending || datasets.isPending || roles.isPending || user.isPending}
            error={entries.error ?? datasets.error ?? roles.error ?? user.error}
            chrome={chrome}
          >
            {isStaff ? null : (
              <Notice kind="warning" chrome={chrome} title="Read only">
                Only EDP staff can mark entries applied.
              </Notice>
            )}
            {markApplied.error ? (
              <ActionErrorNotice
                error={markApplied.error}
                refusedTitle="That change was refused"
                chrome={chrome}
              />
            ) : null}
            {shown.length === 0 ? (
              <Panel pad={24}>
                <span style={{ color: "var(--text-muted)" }}>Nothing to change.</span>
              </Panel>
            ) : (
              <Panel pad={0} style={{ overflow: "hidden" }}>
                {/* At high zoom the table scrolls sideways in its own focusable
                    region (WCAG 1.4.10's data-table exception); the page reflows. */}
                <div
                  role="region"
                  aria-label="Change-list entries, scrolls sideways"
                  tabIndex={0}
                  style={{ overflowX: "auto" }}
                >
                  <table style={{ ...s.table, minWidth: 720 }} aria-label="Change-list entries">
                    <thead>
                      <tr style={s.headRow}>
                        {["Entry", "What to do", "Why", "Created", "State"].map((h) => (
                          <th key={h} style={s.th}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((entry) => (
                        <EntryRow
                          key={entry.id}
                          chrome={chrome}
                          entry={entry}
                          roles={roles.data}
                          dataset={datasets.data?.find((d) => d.id === entryDatasetId(entry))}
                          canMark={isStaff}
                          supersedingApplied={Boolean(
                            entry.supersededBy &&
                            entries.data?.find((candidate) => candidate.id === entry.supersededBy)
                              ?.applied,
                          )}
                          marking={pendingActions.isActionPending(entry.id, "mark-applied")}
                          locked={pendingActions.isRecordPending(entry.id)}
                          onMark={() =>
                            void (() => {
                              const intent = pendingActions.makeIntent(
                                entry.id,
                                "mark-applied",
                                JSON.stringify({ entryId: entry.id }),
                              );
                              return pendingActions
                                .run(
                                  {
                                    recordId: entry.id,
                                    actionId: "mark-applied",
                                    label: "Marking applied",
                                  },
                                  ({ idempotencyKey }) =>
                                    markApplied.mutateAsync({ entryId: entry.id, idempotencyKey }),
                                  { intent, keepIntentOnError: keepIntentForUnknownOutcome },
                                )
                                .catch(() => undefined);
                            })()
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </QueryGate>
        </div>
      </FeatureGate>
    </Page>
  );
}

function EntryRow({
  chrome,
  entry,
  roles,
  dataset,
  canMark,
  supersedingApplied,
  marking,
  locked,
  onMark,
}: {
  chrome: DatasetAccessChrome;
  entry: ChangeListEntry;
  roles: RoleDescriptions | undefined;
  dataset: Dataset | undefined;
  canMark: boolean;
  supersedingApplied: boolean;
  marking: boolean;
  locked: boolean;
  onMark: () => void;
}) {
  const { Pill, Icon } = chrome;
  return (
    <tr
      style={{
        ...s.row,
        ...(entry.supersededBy ? { background: "var(--color-gray-cool-2)" } : {}),
      }}
    >
      <td style={{ ...s.td, fontWeight: 700, whiteSpace: "nowrap" }}>{entry.id}</td>
      <td style={s.td}>
        <EntryWhat entry={entry} dataset={dataset} />
      </td>
      <td style={s.td}>{entryWhy(entry, dataset, roles)}</td>
      <td style={{ ...s.td, ...s.muted }}>
        <Timestamp iso={entry.createdAt} />
      </td>
      <td style={s.td}>
        <div style={{ display: "grid", gap: 8 }}>
          <div>
            <Pill
              icon={isPendingChange(entry) ? "schedule" : "info"}
              bg="var(--color-blue-5v)"
              fg="var(--theme-primary)"
            >
              Requested
            </Pill>
          </div>
          {entry.applied ? (
            <div>
              <Pill
                icon="check_circle"
                bg="var(--theme-success-lighter)"
                fg="var(--theme-success-darker)"
              >
                Marked applied
              </Pill>
              <div style={{ ...s.muted, marginTop: 4 }}>
                by <code style={s.mono}>{entry.applied.by}</code>,{" "}
                <Timestamp iso={entry.applied.at} />
              </div>
            </div>
          ) : null}
          {entry.verified ? (
            <div>
              <Pill
                icon="verified"
                bg="var(--theme-success-lighter)"
                fg="var(--theme-success-darker)"
              >
                Seen in snapshot
              </Pill>
              <div style={{ ...s.muted, marginTop: 4 }}>
                Seen in membership snapshot, <Timestamp iso={entry.verified.at} />
              </div>
            </div>
          ) : null}
          {entry.supersededBy ? (
            <div>
              <Pill icon="block" bg="var(--color-gray-cool-10)" fg="var(--color-gray-cool-70)">
                Superseded by {entry.supersededBy}
              </Pill>
              <div style={{ ...s.muted, marginTop: 4 }}>
                A later entry replaced this change. It is no longer pending and cannot be marked
                applied.
              </div>
            </div>
          ) : null}
          {entry.supersededBy && !entry.verified && !supersedingApplied && canMark ? (
            <PendingActionButton
              type="button"
              pending={false}
              disabled
              style={s.outlineBtn}
              aria-label={`Mark applied ${entry.id} unavailable: superseded by ${entry.supersededBy}`}
            >
              <Icon name="block" size={16} color="var(--color-gray-cool-70)" />
              Mark applied unavailable
            </PendingActionButton>
          ) : null}
          {!entry.applied && !entry.verified && !entry.supersededBy && canMark ? (
            <>
              <PendingActionButton
                type="button"
                onClick={onMark}
                pending={marking}
                locked={locked}
                style={s.outlineBtn}
                aria-label={
                  marking ? `Saving… Mark applied ${entry.id}` : `Mark applied ${entry.id}`
                }
                aria-busy={marking}
              >
                <Icon name="check" size={16} color="var(--theme-primary)" />
                Mark applied
              </PendingActionButton>
              <PendingActionStatus pending={marking} />
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
