import {
  useDatasetSummaries,
  usePrefetchDatasetTeam,
  useRoleDescriptions,
} from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { DatasetWithMemberSummary, DatasetRoleName } from "@/data/datasets/types";
import { useUser } from "@/data/queries";
import type { UserProfile } from "@/data/types";
import { FeatureGate } from "@/features/FeatureGate";
import { useEffect, useRef } from "react";
import { QueryGate } from "./chrome";
import { resolveChrome, type DatasetAccessChrome, type ScreenProps } from "./resolveChrome";
import * as s from "./styles";
import { TableScroll } from "./teamShared";

const ROW_HOVER_INTENT_MS = 120;

/**
 * Every dataset the viewer can see, with its domain, dataset tag, owners,
 * member count (for its owners and EDP staff only, #257) and the viewer's own
 * role, linking to each team page. In the MVP every signed-in person can see
 * every dataset.
 */
export function DatasetsScreen({ ctx, chrome: injected }: ScreenProps) {
  const chrome = resolveChrome(injected);
  const { Page, Trail, Panel, Icon } = chrome;
  const datasets = useDatasetSummaries();
  const prefetchTeam = usePrefetchDatasetTeam();
  const roles = useRoleDescriptions();
  const user = useUser();

  return (
    <Page>
      <Trail items={[{ label: "Home", go: () => ctx.go("home") }, { label: "Datasets" }]} />
      <FeatureGate id="dataset-team">
        <div style={s.titleRow}>
          <div>
            <h1 style={s.h1}>Datasets</h1>
            <p style={s.subtitle}>
              Open a dataset to see its team. Only its owners and EDP staff decide who holds a role
              on it.
            </p>
          </div>
        </div>
        <QueryGate
          isPending={datasets.isPending || roles.isPending || user.isPending}
          error={datasets.error ?? roles.error ?? user.error}
          chrome={chrome}
        >
          <Panel pad={0} style={{ overflow: "hidden" }}>
            {/* Scrolls inside the panel when zoomed in, so every column stays reachable. */}
            <TableScroll label="Datasets table" minWidth={960}>
              <table style={s.table} aria-label="Datasets">
                <thead>
                  <tr style={s.headRow}>
                    {["Dataset", "Domain", "Dataset tag", "Owners", "Members", "Your role"].map(
                      (h) => (
                        <th key={h} style={s.th}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(datasets.data ?? []).map((dataset) => {
                    return (
                      <DatasetSummaryRow
                        key={dataset.id}
                        chrome={chrome}
                        dataset={dataset}
                        go={ctx.go}
                        prefetchTeam={prefetchTeam}
                        roles={roles.data}
                        user={user.data}
                      />
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </Panel>
        </QueryGate>
      </FeatureGate>
    </Page>
  );
}

function DatasetSummaryRow({
  chrome,
  dataset,
  go,
  prefetchTeam,
  roles,
  user,
}: {
  chrome: DatasetAccessChrome;
  dataset: DatasetWithMemberSummary;
  go: (name: string, params?: Record<string, string>) => void;
  prefetchTeam: (datasetId: string) => void;
  roles: RoleDescriptions | undefined;
  user: UserProfile | undefined;
}) {
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { Icon } = chrome;
  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const prefetch = () => prefetchTeam(dataset.id);
  useEffect(() => cancelHover, []);

  return (
    <tr
      style={s.row}
      onMouseEnter={() => {
        cancelHover();
        hoverTimer.current = setTimeout(prefetch, ROW_HOVER_INTENT_MS);
      }}
      onMouseLeave={cancelHover}
      onFocus={() => {
        cancelHover();
        prefetch();
      }}
    >
      <td style={s.td}>
        <a
          href={`#team/${encodeURIComponent(dataset.id)}`}
          onClick={(e) => {
            e.preventDefault();
            go("team", { id: dataset.id });
          }}
          style={s.linkBtn}
        >
          {dataset.name}
          <Icon name="chevron_right" size={16} />
        </a>
      </td>
      <td style={s.td}>
        <code style={s.mono}>{dataset.domainTag}</code>
      </td>
      <td style={s.td}>
        <code style={s.mono}>{dataset.datasetTag}</code>
      </td>
      <td style={s.td}>{dataset.owners.map((o) => o.displayName).join(", ")}</td>
      <td style={s.td}>
        {dataset.memberSummary.totalMembers === null ? (
          // #257: the store gives the count to the dataset's owners and EDP staff only.
          <span style={{ color: "var(--text-muted)" }}>Only owners and EDP staff can see this</span>
        ) : (
          dataset.memberSummary.totalMembers
        )}
      </td>
      <td style={s.td}>
        {user && roles ? (
          <YourRole
            chrome={chrome}
            dataset={dataset}
            viewerRoles={dataset.memberSummary.viewerRoles}
            roles={roles}
            user={user}
          />
        ) : null}
      </td>
    </tr>
  );
}

/**
 * The viewer's own standing on a dataset. Ownership is matched by SCIM id;
 * `viewerRoles` comes from the store, which matches the viewer's own member
 * rows by SCIM id or email (#257).
 */
function YourRole({
  chrome,
  dataset,
  viewerRoles,
  roles,
  user,
}: {
  chrome: DatasetAccessChrome;
  dataset: DatasetWithMemberSummary;
  viewerRoles: DatasetRoleName[];
  roles: RoleDescriptions;
  user: UserProfile;
}) {
  const { Pill } = chrome;
  const isOwner = dataset.owners.some((o) => o.principalId === user.principalId);
  if (!isOwner && viewerRoles.length === 0) {
    return <span style={{ color: "var(--text-muted)" }}>No role</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      {isOwner ? (
        <Pill bg="var(--color-blue-5v)" fg="var(--theme-primary)" bd="var(--color-blue-20v)">
          Owner
        </Pill>
      ) : null}
      {viewerRoles.map((role) => (
        <Pill key={role}>{roles.roles[role].label}</Pill>
      ))}
    </span>
  );
}
