import type { ChangeListEntry } from "@/data/change-list/types";
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
  const shown = (entries.data ?? []).filter((e) => !datasetId || e.target.datasetId === datasetId);
  const pending = shown.filter((e) => !e.applied).length;

  return (
    <Page>
      <Trail items={[{ label: "Home", go: () => ctx.go("home") }, { label: "Change list" }]} />
      <FeatureGate id="change-list">
        <div style={s.titleRow}>
          <div>
            <h1 style={s.h1}>Change list</h1>
            <p style={s.subtitle}>
              The app doesn't change Databricks. EDP staff apply each entry by hand, then mark it
              applied.
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
                <table style={s.table} aria-label="Change-list entries">
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
                        dataset={datasets.data?.find((d) => d.id === entry.target.datasetId)}
                        canMark={isStaff}
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
  marking,
  locked,
  onMark,
}: {
  chrome: DatasetAccessChrome;
  entry: ChangeListEntry;
  roles: RoleDescriptions | undefined;
  dataset: Dataset | undefined;
  canMark: boolean;
  marking: boolean;
  locked: boolean;
  onMark: () => void;
}) {
  const { Pill, Icon } = chrome;
  return (
    <tr style={s.row}>
      <td style={{ ...s.td, fontWeight: 700, whiteSpace: "nowrap" }}>{entry.id}</td>
      <td style={s.td}>
        <EntryWhat entry={entry} dataset={dataset} />
      </td>
      <td style={s.td}>{entryWhy(entry, dataset, roles)}</td>
      <td style={{ ...s.td, ...s.muted }}>
        <Timestamp iso={entry.createdAt} />
      </td>
      <td style={s.td}>
        {entry.applied ? (
          <div>
            <Pill
              icon="check_circle"
              bg="var(--theme-success-lighter)"
              fg="var(--theme-success-darker)"
            >
              Applied
            </Pill>
            <div style={{ ...s.muted, marginTop: 4 }}>
              by <code style={s.mono}>{entry.applied.by}</code>,{" "}
              <Timestamp iso={entry.applied.at} />
            </div>
          </div>
        ) : canMark ? (
          <>
            <PendingActionButton
              type="button"
              onClick={onMark}
              pending={marking}
              locked={locked}
              style={s.outlineBtn}
              aria-label={marking ? `Saving… Mark applied ${entry.id}` : `Mark applied ${entry.id}`}
              aria-busy={marking}
            >
              <Icon name="check" size={16} color="var(--theme-primary)" />
              Mark applied
            </PendingActionButton>
            <PendingActionStatus pending={marking} />
          </>
        ) : (
          <Pill icon="schedule" bg="var(--theme-warning-lighter)" fg="var(--theme-warning-darker)">
            Pending
          </Pill>
        )}
      </td>
    </tr>
  );
}
