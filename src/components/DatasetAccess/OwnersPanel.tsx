// The dataset's owners: listing, adding and removing them (#87).
import { useState } from "react";
import { SavingTag } from "@/components/SaveStatus";
import { ownerKey } from "@/data/datasets/ownership";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import { ownerRecord, removeOwnerSave } from "@/data/datasets/team-queries";
import { useSave, useSavesUnder } from "@/data/optimistic-save";
import {
  accountIdLabel,
  type Dataset,
  type DatasetMember,
  type DatasetOwner,
} from "@/data/datasets/types";
import { AddPersonForm, type AddDraft } from "./AddPersonForm";
import { GrantList, Notice, Timestamp } from "./chrome";
import { actorName } from "./entryText";
import type { DatasetAccessChrome } from "./resolveChrome";
import { dangerBtn, smallBtn, TableScroll } from "./teamShared";
import * as s from "./styles";

function ownerContact(owner: DatasetOwner) {
  return owner.email ?? (owner.principalId ? accountIdLabel(owner.principalId) : "—");
}

/**
 * The dataset's owners. Owners, and EDP staff, add and remove them. Each
 * change shows here at once; where it's mounted, a SaveNotices for
 * `owner:<dataset id>:` says Saving…, then Saved or why it was refused.
 */
export function OwnersPanel({
  dataset,
  roles,
  canManage,
  isStaff,
  members = [],
  viewerId = "",
  canAdd = true,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  /** Owners, or EDP staff. */
  canManage: boolean;
  isStaff: boolean;
  /** The dataset's members, so the add form can warn when someone already holds a role. */
  members?: DatasetMember[];
  viewerId?: string;
  /**
   * Show the add-owner form under the list. The team page turns it off: there,
   * owners are added from the Add team member panel (UAT round 2, PR #234).
   * EDP Admin's owner reassignment keeps it.
   */
  canAdd?: boolean;
  chrome: DatasetAccessChrome;
}) {
  const { Panel, SectionHead, Icon } = chrome;
  const remove = useSave(removeOwnerSave);
  const saves = useSavesUnder(`owner:${dataset.id}:`);
  const unresolved = (owner: DatasetOwner) =>
    [...saves]
      .reverse()
      .find(
        (save) =>
          (save.state === "saving" || save.state === "unconfirmed") &&
          save.record === ownerRecord(dataset.id, ownerKey(owner)),
      );
  const [removing, setRemoving] = useState<DatasetOwner | null>(null);
  const confirmRemove = (owner: DatasetOwner) => {
    const started = remove(
      {
        datasetId: dataset.id,
        owner: ownerKey(owner),
        ownerName: owner.displayName,
        managerLabel: roles.roles.manager.label,
      },
      { idempotencyKey: globalThis.crypto.randomUUID() },
    );
    if (started) setRemoving(null);
  };

  return (
    <div>
      <SectionHead eyebrow="Accountable for the dataset" title="Owners" />
      <div style={s.stack}>
        {isStaff && dataset.owners.length === 0 ? (
          <Notice kind="warning" chrome={chrome} title="This dataset has no owner">
            As EDP staff, you can reassign ownership:{" "}
            {canAdd ? "add an owner below." : "add one with Add team member."}
          </Notice>
        ) : null}
        <Panel pad={0} style={{ overflow: "hidden" }}>
          <TableScroll label="Owners table" minWidth={620}>
            <table style={s.table} aria-label="Owners">
              <thead>
                <tr style={s.headRow}>
                  {["Owner", "Contact", "Added", ...(canManage ? ["Actions"] : [])].map((h) => (
                    <th key={h} style={s.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataset.owners.length === 0 ? (
                  <tr style={s.row}>
                    <td style={{ ...s.td, color: "var(--text-muted)" }} colSpan={canManage ? 4 : 3}>
                      No owners.
                    </td>
                  </tr>
                ) : null}
                {dataset.owners.map((owner) => (
                  <tr key={ownerKey(owner)} style={s.row}>
                    <td style={{ ...s.td, fontWeight: 700 }}>{owner.displayName}</td>
                    <td style={s.td}>
                      <div>{ownerContact(owner)}</div>
                      {owner.email ? (
                        <div style={s.muted}>
                          {owner.matchedPrincipalId && owner.matchedAt ? (
                            <>
                              Bound to {accountIdLabel(owner.matchedPrincipalId)} on their first
                              owner action, <Timestamp iso={owner.matchedAt} />
                            </>
                          ) : (
                            "Not bound yet: recognised by email until their first owner action"
                          )}
                        </div>
                      ) : null}
                      {owner.mismatch ? (
                        <div style={{ ...s.fieldError, marginTop: 4 }}>
                          <Icon name="error" size={14} color="var(--theme-error-dark)" />
                          Refused an action with this email from another account (
                          {accountIdLabel(owner.mismatch.principalId)}),{" "}
                          <Timestamp iso={owner.mismatch.at} />
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...s.td, ...s.muted }}>
                      {owner.addedBy && owner.addedAt ? (
                        <>
                          by {actorName(dataset, owner.addedBy)}, <Timestamp iso={owner.addedAt} />
                        </>
                      ) : (
                        "Named at intake"
                      )}
                    </td>
                    {canManage ? (
                      <td style={s.td}>
                        {unresolved(owner) ? (
                          <SavingTag save={unresolved(owner)} />
                        ) : (
                          <button
                            type="button"
                            style={{ ...dangerBtn, ...smallBtn }}
                            aria-label={`Remove ${owner.displayName} as owner`}
                            onClick={() => setRemoving(owner)}
                          >
                            <Icon name="close" size={14} color="var(--theme-error-dark)" />
                            Remove
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Panel>
        {removing ? (
          <Panel pad={24}>
            <section aria-label="Confirm the owner removal">
              <div style={s.summaryBox}>
                <p style={{ margin: "0 0 12px", fontSize: "var(--font-size-sm)" }}>
                  You're removing <strong>{removing.displayName}</strong> as an owner of{" "}
                  <strong>{dataset.name}</strong>. Every owner holds the {roles.roles.manager.label}{" "}
                  role, so it goes with ownership. They lose:
                </p>
                <section aria-label="They lose">
                  <h3 style={{ ...s.lbl, margin: "0 0 6px" }}>Ownership</h3>
                  <p style={{ margin: "0 0 12px" }}>
                    They can no longer add, edit or remove members, or manage owners of{" "}
                    {dataset.name}.
                  </p>
                  <h3 style={{ ...s.lbl, margin: "0 0 6px" }}>
                    The {roles.roles.manager.label} role
                  </h3>
                  <GrantList grants={roles.roles.manager.grants} chrome={chrome} />
                  <p style={{ margin: "12px 0 0" }}>
                    The change list will say to remove them (
                    {removing.email ?? accountIdLabel(ownerKey(removing))}) from the{" "}
                    {roles.roles.manager.label} group. Any other role they hold here stays.
                  </p>
                </section>
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
                <button type="button" style={dangerBtn} onClick={() => confirmRemove(removing)}>
                  <Icon name="close" size={16} color="var(--theme-error-dark)" />
                  Confirm owner removal
                </button>
                <button type="button" onClick={() => setRemoving(null)} style={s.outlineBtn}>
                  Cancel
                </button>
              </div>
            </section>
          </Panel>
        ) : null}
        {canManage && canAdd ? (
          <AddOwnerForm
            dataset={dataset}
            roles={roles}
            members={members}
            viewerId={viewerId}
            chrome={chrome}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Owners section's add form: the team page's one add form (AddPersonForm)
 * with Owner its only choice, so there's one add-owner, not two.
 */
function AddOwnerForm({
  dataset,
  roles,
  members,
  viewerId,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  members: DatasetMember[];
  viewerId: string;
  chrome: DatasetAccessChrome;
}) {
  const { Panel, SectionHead } = chrome;
  const [draft, setDraft] = useState<AddDraft>({ name: "", email: "", choice: "owner" });
  return (
    <Panel pad={24}>
      <SectionHead eyebrow="Owner action" title="Add an owner" />
      <AddPersonForm
        dataset={dataset}
        roles={roles}
        members={members}
        choices={["owner"]}
        idPrefix="owner"
        viewerId={viewerId}
        draft={draft}
        onDraft={setDraft}
        chrome={chrome}
      />
    </Panel>
  );
}
