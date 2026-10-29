// Owner reassignment on the EDP Admin page (#159): every dataset with its
// owners, and the dataset team page's own owners panel (#87) for the one EDP
// staff pick. Nothing is reimplemented: the panel, and the store behind it,
// keep the email binding (ADR-0006), the last-owner refusal, the Maintainer-role
// coupling and the change-list entries exactly as on the team page.
import { useState } from "react";

import { SaveNotices } from "@/components/SaveStatus";
import { QueryGate, SessionStateNotice } from "@/components/DatasetAccess/chrome";
import { AddTeamMemberPanel } from "@/components/DatasetAccess/AddTeamMemberPanel";
import type { AddDraft } from "@/components/DatasetAccess/AddPersonForm";
import { OwnersPanel } from "@/components/DatasetAccess/TeamManagement";
import { resolveChrome, type DatasetAccessChrome } from "@/components/DatasetAccess/resolveChrome";
import * as s from "@/components/DatasetAccess/styles";
import { TableScroll } from "@/components/DatasetAccess/teamShared";
import { useDatasetMembers, useDatasets, useRoleDescriptions } from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { Dataset } from "@/data/datasets/types";
import { FeatureGate } from "@/features/FeatureGate";

export function OwnerReassignmentSection({
  chrome: injected,
}: {
  chrome?: Partial<DatasetAccessChrome>;
}) {
  const chrome = resolveChrome(injected);
  const { Panel } = chrome;
  const datasets = useDatasets();
  const roles = useRoleDescriptions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Read from the list so the panel shows each write as soon as it lands.
  const selected = datasets.data?.find((d) => d.id === selectedId);

  return (
    <>
      <h1 style={s.h1}>Owner reassignment</h1>
      <p style={{ ...s.subtitle, marginBottom: 20 }}>
        Add or remove a dataset&apos;s owners, for example when an owner leaves. Each change goes on
        the change list.
      </p>
      <FeatureGate id="dataset-team">
        <QueryGate
          isPending={datasets.isPending || roles.isPending}
          error={datasets.error ?? roles.error}
          chrome={chrome}
        >
          <div style={s.stack}>
            <SessionStateNotice chrome={chrome} />
            <SaveNotices prefixes={["owner:"]} label="Owner changes" />
            <Panel pad={0} style={{ overflow: "hidden" }}>
              <TableScroll label="Datasets and owners table" minWidth={720}>
                <table style={s.table} aria-label="Datasets and their owners">
                  <thead>
                    <tr style={s.headRow}>
                      {["Dataset", "Domain", "Owners", "Actions"].map((h) => (
                        <th key={h} style={s.th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(datasets.data ?? []).map((dataset) => (
                      <tr key={dataset.id} style={s.row}>
                        <td style={{ ...s.td, fontWeight: 700 }}>{dataset.name}</td>
                        <td style={s.td}>
                          <code style={s.mono}>{dataset.domainTag}</code>
                        </td>
                        <td style={s.td}>
                          {dataset.owners.length > 0 ? (
                            dataset.owners.map((o) => o.displayName).join(", ")
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>No owner</span>
                          )}
                        </td>
                        <td style={s.td}>
                          <button
                            type="button"
                            style={s.outlineBtn}
                            aria-label={`Manage owners of ${dataset.name}`}
                            aria-pressed={dataset.id === selectedId}
                            onClick={() => setSelectedId(dataset.id)}
                          >
                            Manage owners
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </Panel>
            {selected && roles.data ? (
              <SelectedOwners
                key={selected.id}
                dataset={selected}
                roles={roles.data}
                chrome={chrome}
              />
            ) : null}
          </div>
        </QueryGate>
      </FeatureGate>
    </>
  );
}

function SelectedOwners({
  dataset,
  roles,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  chrome: DatasetAccessChrome;
}) {
  const members = useDatasetMembers(dataset.id);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AddDraft>({ name: "", email: "", choice: "owner" });

  return (
    <section aria-label={`Owners of ${dataset.name}`}>
      <div style={{ ...s.titleRow, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ ...s.h1, fontSize: "var(--font-size-lg)" }}>{dataset.name}</h2>
        <button type="button" onClick={() => setAdding(true)} style={s.primaryBtn}>
          <chrome.Icon name="add" size={18} color="#fff" />
          Add team member
        </button>
      </div>
      <OwnersPanel dataset={dataset} roles={roles} canManage isStaff chrome={chrome} />
      {adding ? (
        <AddTeamMemberPanel
          dataset={dataset}
          roles={roles}
          members={members.data ?? []}
          choices={["owner"]}
          note="As EDP staff, you can add owners. Only the dataset's owners add members."
          viewerId=""
          draft={draft}
          onDraft={setDraft}
          onClose={() => setAdding(false)}
          chrome={chrome}
        />
      ) : null}
    </section>
  );
}
