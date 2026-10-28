import { AddPersonForm, type AddChoice, type AddDraft } from "./AddPersonForm";
import type { DatasetAccessChrome } from "./resolveChrome";
import { SidePanel } from "./SidePanel";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { Dataset, DatasetMember } from "@/data/datasets/types";

/** The shared add-person flow used by dataset owners and EDP staff. */
export function AddTeamMemberPanel({
  dataset,
  roles,
  members,
  choices,
  viewerId,
  draft,
  onDraft,
  onClose,
  note,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  members: DatasetMember[];
  choices: AddChoice[];
  viewerId: string;
  draft: AddDraft;
  onDraft: (draft: AddDraft | ((current: AddDraft) => AddDraft)) => void;
  onClose: () => void;
  note?: string | undefined;
  chrome: DatasetAccessChrome;
}) {
  const ownerOnly = choices.length === 1 && choices[0] === "owner";

  return (
    <SidePanel title="Add team member" onClose={onClose} chrome={chrome}>
      <AddPersonForm
        dataset={dataset}
        roles={roles}
        members={members}
        choices={choices}
        idPrefix={ownerOnly ? "owner" : "member"}
        note={note}
        viewerId={viewerId}
        draft={draft}
        onDraft={onDraft}
        onDone={onClose}
        chrome={chrome}
      />
    </SidePanel>
  );
}
