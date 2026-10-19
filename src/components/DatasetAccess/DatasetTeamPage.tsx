import { useState } from "react";

import { SaveNotices } from "@/components/SaveStatus";
import type { ChangeListEntry } from "@/data/change-list/types";
import {
  addMemberSave,
  useChangeList,
  useDataset,
  useDatasetMembers,
  useRoleDescriptions,
} from "@/data/datasets/queries";
import { canReadTeam, isDatasetOwner } from "@/data/datasets/ownership";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import { useTeamEvents } from "@/data/datasets/team-queries";
import {
  DATASET_ROLES,
  isValidEmail,
  normalizeEmail,
  type Dataset,
  type DatasetMember,
  type DatasetRoleName,
} from "@/data/datasets/types";
import { useUser } from "@/data/queries";
import type { UserProfile } from "@/data/types";
import { FeatureGate } from "@/features/FeatureGate";
import { AddPersonForm, type AddChoice, type AddDraft } from "./AddPersonForm";
import { Notice, QueryGate, SessionStateNotice } from "./chrome";
import {
  resolveChrome,
  type DatasetAccessChrome,
  type ScreenCtx,
  type ScreenProps,
} from "./resolveChrome";
import * as s from "./styles";
import { SidePanel } from "./SidePanel";
import {
  matchesFilter,
  teamPeople,
  useRowSaves,
  type TeamFilter,
  type TeamPerson,
} from "./teamPeople";
import { EditAccess, OwnersPanel, TeamHistory } from "./TeamManagement";
import { FilterStatus, KpiCards, PeopleTable, TEAM_TABLE_ID } from "./TeamOverview";

/**
 * A dataset's team page, overview first (#114): KPI cards that filter a
 * table with one row per person, then the owners and the team's history.
 * Owners add people as tester, developer, manager or owner, and edit or
 * remove them, in a panel, seeing exactly what each role grants before they confirm; each
 * change puts entries on the change list. Owners and EDP staff manage owners
 * (TeamManagement.tsx). Anyone else sees only their own row, with no counts
 * and no actions, because the store gives them nothing more (#257); it
 * refuses their writes regardless.
 */
export function DatasetTeamScreen({ ctx, params, chrome: injected }: ScreenProps) {
  const chrome = resolveChrome(injected);
  const { Page, Trail } = chrome;
  const datasetId = params?.id ?? "";
  const dataset = useDataset(datasetId);
  const members = useDatasetMembers(datasetId);
  const changeList = useChangeList();
  const roles = useRoleDescriptions();
  const user = useUser();

  return (
    <Page>
      <Trail
        items={[
          { label: "Home", go: () => ctx.go("home") },
          { label: "Datasets", go: () => ctx.go("datasets") },
          { label: dataset.data?.name ?? "Team" },
        ]}
      />
      <FeatureGate id="dataset-team">
        <QueryGate
          isPending={
            dataset.isPending ||
            members.isPending ||
            changeList.isPending ||
            roles.isPending ||
            user.isPending
          }
          error={dataset.error ?? members.error ?? changeList.error ?? roles.error ?? user.error}
          chrome={chrome}
        >
          {dataset.data === null ? (
            <Notice kind="warning" chrome={chrome} title="No such dataset">
              There's no dataset <code style={s.mono}>{datasetId}</code>.{" "}
              <a
                href="#datasets"
                onClick={(e) => {
                  e.preventDefault();
                  ctx.go("datasets");
                }}
                style={s.linkBtn}
              >
                See all datasets
              </a>
            </Notice>
          ) : dataset.data && user.data && roles.data ? (
            <Team
              ctx={ctx}
              chrome={chrome}
              dataset={dataset.data}
              roles={roles.data}
              isOwner={isDatasetOwner(dataset.data, user.data)}
              isStaff={user.data.isAdmin}
              viewer={user.data}
              members={members.data ?? []}
              entries={changeList.data ?? []}
            />
          ) : null}
        </QueryGate>
      </FeatureGate>
    </Page>
  );
}

function Team({
  ctx,
  chrome,
  dataset,
  roles,
  isOwner,
  isStaff,
  viewer,
  members,
  entries,
}: {
  ctx: ScreenCtx;
  chrome: DatasetAccessChrome;
  dataset: Dataset;
  roles: RoleDescriptions;
  isOwner: boolean;
  isStaff: boolean;
  viewer: UserProfile;
  members: DatasetMember[];
  entries: ChangeListEntry[];
}) {
  const { Icon, Pill, SectionHead } = chrome;
  const owners = dataset.owners.map((o) => o.displayName).join(", ");
  const events = useTeamEvents(dataset.id);
  const [panel, setPanel] = useState<{ kind: "add" } | { kind: "edit"; person: TeamPerson } | null>(
    null,
  );
  const close = () => setPanel(null);
  // The add form's details outlive its panel, so a refused add puts them back (#91).
  const [draft, setDraft] = useState<AddDraft>({ name: "", email: "", choice: "tester" });
  const [filter, setFilter] = useState<TeamFilter>("everyone");
  const rowSave = useRowSaves(dataset.id);
  // Only owners and EDP staff can read this dataset's change list (#123) and
  // its whole team (#257). Anyone else gets only their own rows from the store.
  const canSeeTeam = canReadTeam(dataset, viewer);
  const team = teamPeople(dataset, members, canSeeTeam ? entries : []);
  const shown = team.filter((p) => matchesFilter(p, filter, rowSave(p)));
  const pending = entries.filter((e) => e.target.datasetId === dataset.id && !e.applied).length;
  const changeListHref = `#change-list/${encodeURIComponent(dataset.id)}`;
  // What the server lets this viewer add: owners add members and owners; EDP
  // staff who don't own the dataset add owners only (UAT round 2, PR #234).
  const addChoices: AddChoice[] = [
    ...(isOwner ? DATASET_ROLES : []),
    ...(isOwner || isStaff ? (["owner"] as const) : []),
  ];
  const ownerOnly = !isOwner && addChoices.length > 0;

  return (
    <>
      <div style={{ ...s.titleRow, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ ...s.h1, overflowWrap: "anywhere" }}>{dataset.name}: team</h1>
          <p style={{ ...s.subtitle, lineHeight: 1.9 }}>
            Domain tag <code style={s.mono}>{dataset.domainTag}</code> · dataset tag{" "}
            <code style={s.mono}>{dataset.datasetTag}</code>
          </p>
          <div
            role="group"
            aria-label="Your role"
            style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}
          >
            <span style={s.muted}>Your role</span>
            <Pill bg="var(--color-blue-5v)" fg="var(--theme-primary-dark)">
              {viewerRole(dataset, members, viewer, isOwner, roles)}
            </Pill>
          </div>
        </div>
        {isOwner || canSeeTeam ? (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {addChoices.length > 0 ? (
              <button type="button" onClick={() => setPanel({ kind: "add" })} style={s.primaryBtn}>
                <Icon name="add" size={18} color="#fff" />
                Add team member
              </button>
            ) : null}
            <a
              href={changeListHref}
              onClick={(e) => {
                e.preventDefault();
                ctx.go("change-list", { id: dataset.id });
              }}
              style={{ ...s.outlineBtn, padding: "9px 18px", textDecoration: "none" }}
            >
              Pending changes ({pending})
            </a>
          </div>
        ) : null}
      </div>
      <div style={s.stack}>
        <SessionStateNotice chrome={chrome} />
        <SaveNotices
          prefixes={[`member:${dataset.id}:`, `owner:${dataset.id}:`]}
          label="Team changes"
        />
        {isOwner || isStaff ? null : (
          <Notice kind="warning" chrome={chrome} title="You can't add people to this dataset">
            Only its owners can: {owners}.
          </Notice>
        )}
        {canSeeTeam ? (
          <KpiCards
            team={team}
            pending={pending}
            filter={filter}
            onFilter={setFilter}
            chrome={chrome}
          />
        ) : null}
        {canSeeTeam ? (
          <p style={{ ...s.help, margin: "-10px 0 0" }}>
            Pending changes counts change-list entries waiting on EDP staff. A role change is two:
            remove from the old group, add to the new one.
          </p>
        ) : null}
        <div>
          <SectionHead eyebrow="Dataset roles" title="Team" />
          <div style={{ display: "grid", gap: 12 }}>
            {canSeeTeam ? (
              <FilterStatus
                filter={filter}
                shown={shown.length}
                total={team.length}
                onClear={() => setFilter("everyone")}
              />
            ) : (
              <p role="note" aria-label="Who can see this team" style={{ margin: 0 }}>
                Only this dataset's owners and EDP staff can see its full team, member counts and
                pending changes. You see only your own roles.
              </p>
            )}
            <PeopleTable
              ctx={ctx}
              chrome={chrome}
              dataset={dataset}
              roles={roles}
              team={shown}
              rowSave={rowSave}
              canManage={isOwner}
              showStatus={canSeeTeam}
              onEdit={(person) => setPanel({ kind: "edit", person })}
              {...(canSeeTeam ? {} : { emptyText: `You have no role on ${dataset.name}.` })}
            />
          </div>
        </div>
        <OwnersPanel
          dataset={dataset}
          roles={roles}
          canManage={isOwner || isStaff}
          isStaff={isStaff}
          canAdd={false}
          chrome={chrome}
        />
        <TeamHistory dataset={dataset} roles={roles} events={events.data ?? []} chrome={chrome} />
      </div>
      {panel?.kind === "add" ? (
        <SidePanel title="Add team member" onClose={close} chrome={chrome}>
          <AddPersonForm
            dataset={dataset}
            roles={roles}
            members={members}
            choices={addChoices}
            idPrefix={ownerOnly ? "owner" : "member"}
            note={
              ownerOnly
                ? "As EDP staff, you can add owners. Only the dataset's owners add members."
                : undefined
            }
            viewerId={viewer.principalId ?? ""}
            draft={draft}
            onDraft={setDraft}
            onDone={close}
            chrome={chrome}
          />
        </SidePanel>
      ) : panel?.kind === "edit" && panel.person.member ? (
        <SidePanel
          title={`Edit access: ${panel.person.person.name}`}
          onClose={close}
          returnFocusId={TEAM_TABLE_ID}
          chrome={chrome}
        >
          <EditAccess
            dataset={dataset}
            roles={roles}
            member={panel.person.member}
            heldRoles={panel.person.roles}
            chrome={chrome}
            onDone={close}
            onCancel={close}
          />
        </SidePanel>
      ) : null}
    </>
  );
}

/** The viewer's role here, as the header shows it: "Manager · Owner", "Tester" or "No role". */
function viewerRole(
  dataset: Dataset,
  members: DatasetMember[],
  viewer: UserProfile,
  isOwner: boolean,
  roles: RoleDescriptions,
): string {
  const email = normalizeEmail(viewer.email ?? "");
  const held = members
    .filter(
      (m) =>
        (email !== "" && m.person.email === email) ||
        (m.person.principalId !== undefined && m.person.principalId === viewer.principalId),
    )
    .map((m) => roles.roles[m.role].label);
  const words = [...new Set(held), ...(isOwner ? ["Owner"] : [])];
  if (viewer.isAdmin) words.push("EDP staff");
  return words.length ? words.join(" · ") : `No role on ${dataset.name}`;
}

// Field and RoleCard moved to AddPersonForm.tsx with the one add form; kept
// here for the screens that import them from the team page.
export { Field, RoleCard } from "./AddPersonForm";
