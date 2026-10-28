// What a change-list entry asks EDP staff to do, and why, for every entry
// kind: add-member (#97), the team-management kinds (#87) and onboard-user
// (#103).
import type { ChangeListEntry } from "@/data/change-list/types";
import { ownerPrincipalId } from "@/data/datasets/ownership";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import { personContact, type Dataset, type DatasetRoleName } from "@/data/datasets/types";
import * as s from "./styles";

/** A SCIM id as a name where it's one of the dataset's owners, else the id itself. */
export function actorName(dataset: Dataset | undefined, principalId: string): string {
  return (
    dataset?.owners.find((o) => ownerPrincipalId(o) === principalId)?.displayName ?? principalId
  );
}

function roleLabel(roles: RoleDescriptions | undefined, role: DatasetRoleName): string {
  return roles?.roles[role].label ?? role;
}

/** The "What to do" cell. */
export function EntryWhat({
  entry,
  dataset,
}: {
  entry: ChangeListEntry;
  dataset: Dataset | undefined;
}) {
  const person = (
    <>
      <strong>{entry.target.person.name}</strong> ({personContact(entry.target.person)})
    </>
  );
  if (entry.kind === "onboard-user") {
    return (
      <>
        <div>Onboard {person} as a Databricks user</div>
        <div style={{ ...s.muted, marginTop: 6 }}>
          <strong style={{ color: "var(--text-default)" }}>For:</strong> initiative{" "}
          {entry.target.initiative.name} ({entry.target.initiative.onboardingRequestId}). Done by
          hand only.
        </div>
      </>
    );
  }
  const removing = entry.kind === "remove-member";
  return (
    <>
      <div>
        {removing ? "Remove" : "Add"} {person} {removing ? "from" : "to"} group{" "}
        <code style={s.mono}>{entry.target.group}</code>
      </div>
      <div style={{ ...s.muted, marginTop: 6 }}>
        <strong style={{ color: "var(--text-default)" }}>
          {removing ? "Revokes:" : "Grants:"}
        </strong>{" "}
        {entry.grants.join("; ")}
      </div>
    </>
  );
}

/** The "Why" cell. */
export function entryWhy(
  entry: ChangeListEntry,
  dataset: Dataset | undefined,
  roles: RoleDescriptions | undefined,
): string {
  if (entry.kind === "onboard-user") {
    return `EDP staff (${entry.reason.requestedBy}) marked them not a Databricks user yet; they're named as an owner on ${entry.reason.onboardingRequestId}`;
  }
  const on = dataset?.name ?? entry.reason.datasetId;
  const reason = entry.reason;
  switch (reason.kind) {
    case "dataset-role-added":
      return `${actorName(dataset, reason.addedBy)} added them as ${roleLabel(roles, reason.role)} on ${on}`;
    case "dataset-role-changed":
      return `${actorName(dataset, reason.changedBy)} changed their role on ${on} from ${roleLabel(roles, reason.from)} to ${roleLabel(roles, reason.to)}`;
    case "dataset-role-removed":
      return `${actorName(dataset, reason.removedBy)} removed their ${roleLabel(roles, reason.role)} role on ${on}`;
    case "dataset-owner-added":
      if (reason.replacedRole) {
        return `${actorName(dataset, reason.addedBy)} made them an owner of ${on}; this replaces their ${roleLabel(roles, reason.replacedRole)} role with ${roleLabel(roles, "manager")}`;
      }
      return `${actorName(dataset, reason.addedBy)} made them an owner of ${on}; every owner holds the ${roleLabel(roles, "manager")} role`;
    case "dataset-owner-removed":
      return `${actorName(dataset, reason.removedBy)} removed them as an owner of ${on}; the ${roleLabel(roles, "manager")} role goes with ownership`;
  }
}
