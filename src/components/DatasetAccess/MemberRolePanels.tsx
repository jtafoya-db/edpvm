// Editing and removing one of a member's dataset roles (#87), in the team
// page's Edit access panel (#114).
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import { changeMemberRoleSave, removeMemberSave } from "@/data/datasets/team-queries";
import { useSave } from "@/data/optimistic-save";
import {
  DATASET_ROLES,
  type Dataset,
  type DatasetMember,
  type DatasetRoleName,
} from "@/data/datasets/types";
import { GrantList } from "./chrome";
import { RoleCard } from "./DatasetTeamPage";
import type { DatasetAccessChrome } from "./resolveChrome";
import { handleRoleGroupKeyDown } from "./role-card-keyboard";
import { dangerBtn, columnHead, personLabel, ReviewStep, useFocusOnAttempt } from "./teamShared";
import * as s from "./styles";

/** Grants the old role gave that the new one doesn't, the reverse, and what stays. */
function grantDiff(before: string[], after: string[]) {
  return {
    lose: before.filter((g) => !after.includes(g)),
    gain: after.filter((g) => !before.includes(g)),
    keep: before.filter((g) => after.includes(g)),
  };
}

/** Lists for a confirmation: what someone loses, gains and keeps. */
function GrantColumns({
  lose,
  gain,
  keep,
  chrome,
}: {
  lose: string[];
  gain: string[];
  keep: string[];
  chrome: DatasetAccessChrome;
}) {
  const { Icon } = chrome;
  const column = (title: string, grants: string[], icon: string, color: string) => (
    <section aria-label={title}>
      <h3 style={columnHead}>{title}</h3>
      {grants.length === 0 ? (
        <span style={s.muted}>Nothing</span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {grants.map((grant) => (
            <li key={grant} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <Icon name={icon} size={16} color={color} />
              <span>{grant}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
        gap: 16,
      }}
    >
      {column("They lose", lose, "remove", "var(--theme-error-dark)")}
      {column("They gain", gain, "add", "var(--theme-success-dark)")}
      {column("They keep", keep, "check", "var(--text-muted)")}
    </div>
  );
}

/**
 * The Edit access panel's body: pick a new role and confirm what changes, or
 * remove the person after confirming what they lose. Nothing is saved until a
 * confirm button is pressed.
 */
export function EditAccess(props: {
  dataset: Dataset;
  roles: RoleDescriptions;
  member: DatasetMember;
  heldRoles: DatasetRoleName[];
  chrome: DatasetAccessChrome;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [returned, setReturned] = useState(false);
  return removing ? (
    <RemoveRolePanel
      {...props}
      onCancel={() => {
        setRemoving(false);
        setReturned(true);
      }}
    />
  ) : (
    <EditRolePanel {...props} focusRemove={returned} onRemove={() => setRemoving(true)} />
  );
}

/** Pick a new role for one of a member's roles, review what changes, then save. */
function EditRolePanel({
  dataset,
  roles,
  member,
  heldRoles,
  chrome,
  onDone,
  onCancel,
  onRemove,
  focusRemove,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  member: DatasetMember;
  /** Every role this person holds on the dataset, this one included. */
  heldRoles: DatasetRoleName[];
  chrome: DatasetAccessChrome;
  /** The save has started: it shows in Members at once, marked Saving…. */
  onDone: () => void;
  onCancel: () => void;
  onRemove: () => void;
  /** Back from the removal step: focus goes to its button again. */
  focusRemove: boolean;
}) {
  const { Icon } = chrome;
  const change = useSave(changeMemberRoleSave);
  const [newRole, setNewRole] = useState<DatasetRoleName>(member.role);
  const [reviewing, setReviewing] = useState(false);
  const [backFromReview, setBackFromReview] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const problemRef = useFocusOnAttempt<HTMLDivElement>(attempt);
  const removeRef = useRef<HTMLButtonElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRemove) removeRef.current?.focus();
  }, [focusRemove]);
  useEffect(() => {
    if (backFromReview && !reviewing) {
      cardsRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
  }, [backFromReview, reviewing]);
  const from = roles.roles[member.role];
  const to = roles.roles[newRole];

  const pick = (role: DatasetRoleName) => {
    setNewRole(role);
    setProblem(null);
  };
  const review = (event: FormEvent) => {
    event.preventDefault();
    if (newRole === member.role) {
      setProblem(`${from.label} is already their role here. Pick a different role to change it.`);
      setAttempt((n) => n + 1);
    } else if (heldRoles.includes(newRole)) {
      setProblem(
        `${member.person.name} already holds ${to.label}. Remove their ${from.label} role instead.`,
      );
      setAttempt((n) => n + 1);
    } else {
      setReviewing(true);
    }
  };
  const confirm = () => {
    const started = change(
      {
        datasetId: dataset.id,
        email: member.person.email,
        role: member.role,
        newRole,
        personName: member.person.name,
        roleLabel: from.label,
        newRoleLabel: to.label,
      },
      { idempotencyKey: globalThis.crypto.randomUUID() },
    );
    if (started) onDone();
  };

  if (reviewing) {
    return (
      <ReviewStep label="Confirm the role change">
        <div style={s.summaryBox}>
          <p style={{ margin: "0 0 14px", fontSize: "var(--font-size-sm)" }}>
            You're changing <strong>{personLabel(member)}</strong> from{" "}
            <strong>{from.label}</strong> to <strong>{to.label}</strong> on{" "}
            <strong>{dataset.name}</strong>. The change list will say to remove them from the{" "}
            {from.label} group and add them to the {to.label} group.
          </p>
          <GrantColumns {...grantDiff(from.grants, to.grants)} chrome={chrome} />
        </div>
        <div style={actions}>
          <button type="button" onClick={confirm} style={s.primaryBtn}>
            <Icon name="check" size={18} color="#fff" />
            Confirm role change
          </button>
          <button
            type="button"
            onClick={() => {
              setReviewing(false);
              setBackFromReview(true);
            }}
            style={s.outlineBtn}
          >
            <Icon name="arrow_back" size={16} color="var(--theme-primary)" />
            Pick another role
          </button>
        </div>
      </ReviewStep>
    );
  }
  return (
    <>
      <form onSubmit={review} aria-label="Edit role" noValidate>
        <p style={{ margin: "0 0 4px" }}>
          {personLabel(member)} holds <strong>{from.label}</strong>. Pick their new role. Each card
          lists the access it grants.
        </p>
        <div
          ref={cardsRef}
          role="radiogroup"
          aria-label="New dataset role"
          style={s.cardGrid}
          onKeyDown={handleRoleGroupKeyDown}
        >
          {DATASET_ROLES.map((r) => (
            <RoleCard
              key={r}
              role={r}
              roles={roles}
              selected={newRole === r}
              tabIndex={newRole === r ? 0 : -1}
              onSelect={() => pick(r)}
              chrome={chrome}
            />
          ))}
        </div>
        {problem ? (
          <div
            ref={problemRef}
            role="alert"
            tabIndex={-1}
            style={{ ...s.fieldError, marginTop: 10 }}
          >
            <Icon name="error" size={14} color="var(--theme-error-dark)" />
            {problem}
          </div>
        ) : null}
        <div style={{ ...actions, marginTop: 22 }}>
          <button type="submit" style={s.primaryBtn}>
            Review role change
            <Icon name="arrow_forward" size={18} color="#fff" />
          </button>
          <button type="button" onClick={onCancel} style={s.outlineBtn}>
            Cancel
          </button>
        </div>
      </form>
      <section aria-label="Remove from the team" style={removeSection}>
        <h3 style={columnHead}>Remove from the team</h3>
        <p style={{ margin: "0 0 12px" }}>
          They lose everything {from.label} grants on {dataset.name}. You'll confirm it first.
        </p>
        <button
          ref={removeRef}
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${member.person.name}'s ${from.label} role`}
          style={dangerBtn}
        >
          <Icon name="close" size={16} color="var(--theme-error-dark)" />
          Remove from the team
        </button>
      </section>
    </>
  );
}

/** Confirm removing one of a member's roles. */
function RemoveRolePanel({
  dataset,
  roles,
  member,
  chrome,
  onDone,
  onCancel,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  member: DatasetMember;
  chrome: DatasetAccessChrome;
  /** The save has started: the role leaves Members at once; Team changes says Saving…. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const { Icon } = chrome;
  const remove = useSave(removeMemberSave);
  const role = roles.roles[member.role];
  const confirm = () => {
    const started = remove(
      {
        datasetId: dataset.id,
        email: member.person.email,
        role: member.role,
        personName: member.person.name,
        roleLabel: role.label,
      },
      { idempotencyKey: globalThis.crypto.randomUUID() },
    );
    if (started) onDone();
  };
  return (
    <ReviewStep label="Confirm the removal">
      <div style={s.summaryBox}>
        <p style={{ margin: "0 0 10px", fontSize: "var(--font-size-sm)" }}>
          You're removing <strong>{personLabel(member)}</strong> from <strong>{role.label}</strong>{" "}
          on <strong>{dataset.name}</strong>. The change list will say to remove them from the{" "}
          {role.label} group. They lose:
        </p>
        <GrantList grants={role.grants} chrome={chrome} />
      </div>
      <div style={actions}>
        <button type="button" onClick={confirm} style={dangerBtn}>
          <Icon name="close" size={16} color="var(--theme-error-dark)" />
          Confirm removal
        </button>
        <button type="button" onClick={onCancel} style={s.outlineBtn}>
          Cancel
        </button>
      </div>
    </ReviewStep>
  );
}

const actions: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 };

const removeSection: CSSProperties = {
  marginTop: 28,
  paddingTop: 20,
  borderTop: "1px solid var(--border-default)",
};
