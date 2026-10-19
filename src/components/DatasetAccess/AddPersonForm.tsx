// Adding a person to a dataset's team (#87, #114): one form for a dataset
// role (tester, developer, manager) or for an owner. The team page's Add team
// member panel offers every choice to owners; the Owners section offers Owner
// only. Choosing Owner is the Owners section's add, not a second one: the same
// save (addOwnerSave → store.datasetTeam.addOwner), validation and refusals,
// so the same change-list entries.
import { useEffect, useState, type FormEvent } from "react";

import { addMemberSave } from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import { addOwnerSave } from "@/data/datasets/team-queries";
import {
  isValidEmail,
  normalizeEmail,
  type Dataset,
  type DatasetMember,
  type DatasetRoleName,
} from "@/data/datasets/types";
import { useSave } from "@/data/optimistic-save";
import { GrantList, Notice } from "./chrome";
import type { DatasetAccessChrome } from "./resolveChrome";
import { handleRoleGroupKeyDown } from "./role-card-keyboard";
import { ErrorSummary, ReviewStep, type FieldError } from "./teamShared";
import * as s from "./styles";

/** What the form adds someone as: one of the dataset roles, or an owner. */
export type AddChoice = DatasetRoleName | "owner";

export interface AddDraft {
  name: string;
  email: string;
  choice: AddChoice;
}

/**
 * The add form. Its draft is the caller's, so it outlives a closed panel and
 * a refused save can put the details back. `onDone` runs once a save starts
 * (the panel closes); without it, focus goes back to the name field, ready
 * for the next person.
 */
export function AddPersonForm({
  dataset,
  roles,
  members,
  choices,
  idPrefix,
  viewerId,
  draft,
  onDraft,
  onDone,
  note,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  /** The dataset's members, to warn when a new owner already holds a role here. */
  members: DatasetMember[];
  /** What the viewer may add someone as, in order. Owner only: the Owners section's form. */
  choices: AddChoice[];
  /** Field ids: `${idPrefix}-name` and `${idPrefix}-email`. */
  idPrefix: string;
  viewerId: string;
  draft: AddDraft;
  onDraft: (draft: AddDraft | ((d: AddDraft) => AddDraft)) => void;
  onDone?: () => void;
  /** A line above the fields, e.g. why EDP staff see Owner only. */
  note?: string | undefined;
  chrome: DatasetAccessChrome;
}) {
  const { Icon } = chrome;
  const addMember = useSave(addMemberSave);
  const addOwner = useSave(addOwnerSave);
  const [reviewing, setReviewing] = useState(false);
  const [backFromReview, setBackFromReview] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const touched = attempt > 0;
  const ownerOnly = choices.length === 1 && choices[0] === "owner";
  const choice = choices.includes(draft.choice) ? draft.choice : choices[0]!;
  const asOwner = choice === "owner";
  const nameId = `${idPrefix}-name`;
  const emailId = `${idPrefix}-email`;
  useEffect(() => {
    if ((backFromReview && !reviewing) || confirmedCount) document.getElementById(nameId)?.focus();
  }, [backFromReview, reviewing, confirmedCount, nameId]);

  const nameError = draft.name.trim()
    ? null
    : ownerOnly
      ? "Enter the new owner's name."
      : "Enter the person's name.";
  const emailError = isValidEmail(normalizeEmail(draft.email))
    ? null
    : "Enter an email address in the format name@example.gov.";
  const errors: FieldError[] = [
    ...(nameError ? [{ id: nameId, message: nameError }] : []),
    ...(emailError ? [{ id: emailId, message: emailError }] : []),
  ];
  const set = (patch: Partial<AddDraft>) => onDraft((d) => ({ ...d, ...patch }));

  const review = (event: FormEvent) => {
    event.preventDefault();
    if (errors.length === 0) {
      setReviewing(true);
    } else {
      setAttempt((n) => n + 1);
    }
  };
  // The person shows at once, marked Saving…, and the form is free for the
  // next one. A refusal puts this person's details back.
  const confirm = () => {
    const confirmed = { ...draft, choice };
    const options = { idempotencyKey: globalThis.crypto.randomUUID() };
    const callbacks = { onRefused: () => onDraft(confirmed) };
    const started =
      confirmed.choice === "owner"
        ? addOwner(
            {
              datasetId: dataset.id,
              name: confirmed.name,
              email: confirmed.email,
              managerLabel: roles.roles.manager.label,
            },
            options,
            callbacks,
          )
        : addMember(
            {
              datasetId: dataset.id,
              name: confirmed.name,
              email: confirmed.email,
              role: confirmed.choice,
              roleLabel: roles.roles[confirmed.choice].label,
              addedBy: viewerId,
            },
            options,
            callbacks,
          );
    if (!started) return;
    setReviewing(false);
    setAttempt(0);
    onDraft({ name: "", email: "", choice: confirmed.choice });
    if (onDone) onDone();
    else setConfirmedCount((n) => n + 1);
  };

  if (reviewing) {
    return (
      <ReviewStep label={asOwner ? "Confirm the new owner" : "Confirm the add"}>
        {asOwner ? (
          <OwnerReview
            dataset={dataset}
            roles={roles}
            members={members}
            draft={draft}
            chrome={chrome}
          />
        ) : (
          <div style={s.summaryBox}>
            <p style={{ margin: "0 0 10px", fontSize: "var(--font-size-sm)" }}>
              You're adding <strong>{personOf(draft)}</strong> as{" "}
              <strong>{roles.roles[choice as DatasetRoleName].label}</strong> on{" "}
              <strong>{dataset.name}</strong>. They will get:
            </p>
            <GrantList grants={roles.roles[choice as DatasetRoleName].grants} chrome={chrome} />
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
          <button type="button" onClick={confirm} style={s.primaryBtn}>
            <Icon name="check" size={18} color="#fff" />
            {asOwner ? "Confirm new owner" : "Confirm add"}
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
            Change details
          </button>
        </div>
      </ReviewStep>
    );
  }

  return (
    <form onSubmit={review} aria-label={ownerOnly ? "Add an owner" : "Add a member"} noValidate>
      <ErrorSummary errors={touched ? errors : []} attempt={attempt} chrome={chrome} />
      {note ? <p style={{ margin: "0 0 16px" }}>{note}</p> : null}
      <div style={s.two}>
        <Field
          id={nameId}
          label={ownerOnly ? "Owner's name" : "Name"}
          value={draft.name}
          onChange={(name) => set({ name })}
          error={touched ? nameError : null}
          autoFocus={Boolean(onDone)}
          chrome={chrome}
        />
        <Field
          id={emailId}
          label={ownerOnly ? "Owner's email" : "Email"}
          type="email"
          value={draft.email}
          onChange={(email) => set({ email })}
          error={touched ? emailError : null}
          help={
            asOwner
              ? "They act as an owner once signed in with this email."
              : "Their work email. EDP staff use it to find the person in Databricks."
          }
          chrome={chrome}
        />
      </div>
      {ownerOnly ? null : (
        <fieldset style={{ border: "none", padding: 0, margin: "22px 0 0" }}>
          <legend style={s.lbl}>
            Dataset role <span style={{ color: "var(--theme-secondary)" }}>*</span>
          </legend>
          <div
            role="radiogroup"
            aria-label="Dataset role"
            style={choices.length === 4 ? twoByTwo : s.cardGrid}
            onKeyDown={handleRoleGroupKeyDown}
          >
            {choices.map((c) =>
              c === "owner" ? (
                <ChoiceCard
                  key={c}
                  label="Owner"
                  points={[
                    `Holds the ${roles.roles.manager.label} role`,
                    "Adds, edits and removes members",
                    "Adds and removes owners",
                  ]}
                  selected={choice === c}
                  tabIndex={choice === c ? 0 : -1}
                  onSelect={() => set({ choice: c })}
                  chrome={chrome}
                />
              ) : (
                <RoleCard
                  key={c}
                  role={c}
                  roles={roles}
                  selected={choice === c}
                  tabIndex={choice === c ? 0 : -1}
                  onSelect={() => set({ choice: c })}
                  chrome={chrome}
                />
              ),
            )}
          </div>
          <div style={s.help}>{roles.consumerNote}</div>
        </fieldset>
      )}
      <div style={{ marginTop: 22 }}>
        <button type="submit" style={s.primaryBtn}>
          {asOwner ? "Review new owner" : "Review add"}
          <Icon name="arrow_forward" size={18} color="#fff" />
        </button>
      </div>
    </form>
  );
}

/**
 * Four cards (three roles and Owner) as a balanced 2×2 at desktop width, one
 * column when the window is narrow or zoomed (UAT round 2, PR #234). Four
 * across in the 640px panel left each card about 130px wide.
 */
const twoByTwo = {
  ...s.cardGrid,
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
};

const personOf = (draft: AddDraft) => `${draft.name.trim()} (${normalizeEmail(draft.email)})`;

/**
 * What making someone an owner does, in plain words (ADR-0005, ADR-0007
 * decision 11): they act alone, they hold the manager role, and a person
 * holds one role, so an existing member is refused until their role goes.
 */
function OwnerReview({
  dataset,
  roles,
  members,
  draft,
  chrome,
}: {
  dataset: Dataset;
  roles: RoleDescriptions;
  members: DatasetMember[];
  draft: AddDraft;
  chrome: DatasetAccessChrome;
}) {
  const manager = roles.roles.manager;
  const email = normalizeEmail(draft.email);
  const held = members.find((m) => m.person.email === email && m.role !== "manager");
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {held ? (
        <Notice kind="warning" chrome={chrome} title="This will be refused">
          {held.person.name} already holds {roles.roles[held.role].label} on {dataset.name}, so this
          will be refused. Remove their {roles.roles[held.role].label} role first, then make them an
          owner.
        </Notice>
      ) : null}
      <div style={s.summaryBox}>
        <p style={{ margin: "0 0 10px", fontSize: "var(--font-size-sm)" }}>
          You're making <strong>{personOf(draft)}</strong> an owner of{" "}
          <strong>{dataset.name}</strong>. They can act alone once signed in with that email; their
          first owner action binds the email to their account for good.
        </p>
        <p style={{ margin: "0 0 10px", fontSize: "var(--font-size-sm)" }}>
          Every owner holds the {manager.label} role, and the change list will say to add them to
          the {manager.label} group. A person holds one role on a dataset, so someone who already
          holds another role here must have it removed first. They'll get:
        </p>
        <GrantList grants={manager.grants} chrome={chrome} />
      </div>
    </div>
  );
}

export function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  error,
  help,
  autoFocus,
  chrome,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  help?: string;
  /** Takes focus when its SidePanel opens. */
  autoFocus?: boolean;
  chrome: DatasetAccessChrome;
}) {
  const { Icon } = chrome;
  return (
    <div>
      <label htmlFor={id} style={s.lbl}>
        {label}{" "}
        <span aria-hidden="true" style={{ color: "var(--theme-secondary)" }}>
          *
        </span>
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        aria-required="true"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
        data-autofocus={autoFocus ? "" : undefined}
        style={{ ...s.inp, ...(error ? { borderColor: "var(--theme-error)" } : null) }}
      />
      {error ? (
        <div id={`${id}-error`} style={s.fieldError}>
          <Icon name="error" size={14} color="var(--theme-error-dark)" />
          {error}
        </div>
      ) : help ? (
        <div id={`${id}-help`} style={s.help}>
          {help}
        </div>
      ) : null}
    </div>
  );
}

/** What a role card shows: a role's label and what it grants, from configuration. */
export function RoleCard({
  role,
  roles,
  selected,
  tabIndex,
  onSelect,
  chrome,
}: {
  role: DatasetRoleName;
  roles: RoleDescriptions;
  selected: boolean;
  tabIndex?: number;
  onSelect: () => void;
  chrome: DatasetAccessChrome;
}) {
  const description = roles.roles[role];
  return (
    <ChoiceCard
      label={description.label}
      points={description.grants}
      selected={selected}
      tabIndex={tabIndex}
      onSelect={onSelect}
      chrome={chrome}
    />
  );
}

/** A selectable card in a radio group: a label and a short list. */
function ChoiceCard({
  label,
  points,
  selected,
  tabIndex,
  onSelect,
  chrome,
}: {
  label: string;
  points: string[];
  selected: boolean;
  tabIndex?: number | undefined;
  onSelect: () => void;
  chrome: DatasetAccessChrome;
}) {
  const { Icon } = chrome;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={tabIndex}
      onClick={onSelect}
      style={s.roleCard(selected)}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon
          name={selected ? "check_circle" : "group"}
          size={19}
          color={selected ? "var(--theme-primary)" : "var(--color-gray-cool-50)"}
        />
        <span style={{ fontSize: "var(--font-size-2xs)", fontWeight: 700 }}>{label}</span>
      </span>
      <ul style={s.cardGrants}>
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </button>
  );
}
