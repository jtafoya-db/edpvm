// The owner picker (#103): Myself or Someone else, used for the initiative
// owner (the `initiative-owner` field type) and for every dataset owner, so
// both read and behave the same. Myself shows the signed-in person and sends
// nothing typed: the server fills the owner from its own session, which is
// why it counts as verified. Someone else takes a name and an email, and says
// plainly that the app hasn't confirmed who that person is. Validation lives
// in the schema (initiativeOwnerIssues, datasetIssues); the form passes the
// issues, and each shows once its input is touched or after a failed attempt.

import React from "react";
import type { IntakeInitiativeOwner, StepIssue } from "../../schema";
import type { IconComponent } from "./SchemaForm";
import { FieldError } from "./field-helpers";

/** The signed-in person, from the server-resolved session; shown for Myself, never sent. */
export interface SignedInPerson {
  name: string;
  email: string;
}

const lbl: React.CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  marginBottom: 7,
};

const hint: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  lineHeight: 1.5,
};

function inp(invalid: boolean): React.CSSProperties {
  return {
    width: "100%",
    border: `1.5px solid ${invalid ? "var(--theme-error)" : "var(--border-strong)"}`,
    borderRadius: "var(--radius-md)",
    padding: "11px 13px",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--font-size-2xs)",
    background: "var(--surface-default)",
    boxSizing: "border-box",
  };
}

function choiceStyle(selected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "12px 14px",
    minHeight: 44,
    boxSizing: "border-box",
    border: `1.5px solid ${selected ? "var(--theme-primary)" : "var(--border-strong)"}`,
    borderRadius: "var(--radius-md)",
    background: selected ? "var(--color-blue-5v)" : "var(--surface-default)",
    cursor: "pointer",
  };
}

/** A short status line under an owner: verified (green) or not verified (amber). */
export function OwnerStatus({
  verified,
  Icon,
  children,
}: {
  verified: boolean;
  Icon: IconComponent;
  children: React.ReactNode;
}) {
  const fg = verified ? "var(--theme-success-darker)" : "var(--theme-warning-darker)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        marginTop: 8,
        fontSize: "var(--font-size-3xs)",
        lineHeight: 1.45,
        color: "var(--color-gray-cool-70)",
      }}
    >
      <Icon name={verified ? "verified" : "help"} size={16} color={fg} />
      <span>{children}</span>
    </div>
  );
}

export type OwnerKind = "self" | "someone-else";

/** An owner as the picker shows it: the choice (none yet on a new row) and Someone else's details. */
export interface OwnerChoice {
  kind: OwnerKind | undefined;
  name: string;
  email: string;
}

/**
 * One owner, chosen as Myself or Someone else. Controlled: the caller holds
 * the choice. The picker keeps what was typed for Someone else, so switching
 * to Myself and back brings it back; it starts blank unless the owner was
 * already Someone else. A stored Myself carries the signed-in person's name
 * and email, which never reappear as a typed, unverified Someone else.
 */
export function OwnerPicker({
  id,
  legend,
  groupLabel,
  help,
  value,
  onChange,
  onBlur,
  signedIn,
  issues,
  showAll,
  Icon,
  action,
}: {
  /** DOM id of the group: the Myself choice is `${id}-kind`, the inputs `${id}-name` and `${id}-email`. */
  id: string;
  legend: React.ReactNode;
  /** The group's accessible name when the visible legend needs context (e.g. "Dataset 1 owner 2"). */
  groupLabel?: string | undefined;
  help?: string | undefined;
  value: OwnerChoice;
  /** Myself always comes with a blank name and email: the server fills them from the session. */
  onChange: (next: OwnerChoice) => void;
  onBlur?: (() => void) | undefined;
  signedIn?: SignedInPerson | undefined;
  /** Every current issue, keyed `kind`, `name` or `email`. */
  issues: ReadonlyArray<{ key?: string | undefined; message: string }>;
  /** Show every issue, not only touched ones (after a failed attempt to continue). */
  showAll: boolean;
  Icon: IconComponent;
  /** Shown at the end of the group (a dataset owner's Remove button). */
  action?: React.ReactNode;
}) {
  const { kind, name, email } = value;
  const typed = React.useRef(kind === "someone-else" ? { name, email } : { name: "", email: "" });
  const choose = (next: OwnerKind) =>
    onChange(
      next === "self" ? { kind: next, name: "", email: "" } : { kind: next, ...typed.current },
    );
  const type = (patch: Partial<Pick<OwnerChoice, "name" | "email">>) => {
    typed.current = { ...typed.current, ...patch };
    onChange({ kind: "someone-else", ...typed.current });
  };
  // Touched per input, so choosing Someone else doesn't flag the empty name and email at once.
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => {
    setTouched((current) => new Set(current).add(key));
    onBlur?.();
  };
  const issueOf = (key: string) =>
    showAll || touched.has(key) ? issues.find((issue) => issue.key === key) : undefined;
  const kindIssue = issueOf("kind");
  const nameIssue = issueOf("name");
  const emailIssue = issueOf("email");

  return (
    <fieldset
      id={id}
      tabIndex={-1}
      aria-label={groupLabel}
      aria-describedby={
        [help ? `${id}-help` : "", kindIssue ? `${id}-kind-error` : ""].filter(Boolean).join(" ") ||
        undefined
      }
      style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}
    >
      <legend style={{ ...lbl, padding: 0 }}>
        {legend}{" "}
        <span aria-hidden="true" style={{ color: "var(--theme-secondary)" }}>
          *
        </span>
      </legend>
      {help ? (
        <div id={`${id}-help`} style={{ ...hint, margin: "-2px 0 10px" }}>
          {help}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 10 }}>
        <label style={choiceStyle(kind === "self")}>
          <input
            id={`${id}-kind`}
            type="radio"
            name={`${id}-kind`}
            checked={kind === "self"}
            onChange={() => choose("self")}
            onBlur={() => touch("kind")}
            aria-invalid={Boolean(kindIssue) || undefined}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong style={{ fontSize: "var(--font-size-2xs)" }}>Myself</strong>
            <span style={{ ...hint, display: "block" }}>
              {signedIn ? `${signedIn.name} (${signedIn.email})` : "You, as you're signed in"}
            </span>
          </span>
        </label>
        <label style={choiceStyle(kind === "someone-else")}>
          <input
            type="radio"
            name={`${id}-kind`}
            checked={kind === "someone-else"}
            onChange={() => choose("someone-else")}
            onBlur={() => touch("kind")}
            aria-invalid={Boolean(kindIssue) || undefined}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong style={{ fontSize: "var(--font-size-2xs)" }}>Someone else</strong>
            <span style={{ ...hint, display: "block" }}>Enter their name and email</span>
          </span>
        </label>
      </div>
      {kindIssue ? (
        <FieldError id={`${id}-kind-error`} Icon={Icon}>
          {kindIssue.message}
        </FieldError>
      ) : null}

      {/* Not on a refused choice (a second Myself on one dataset): it isn't an owner yet. */}
      {kind === "self" && !kindIssue ? (
        <OwnerStatus verified Icon={Icon}>
          Verified: it&apos;s the account you&apos;re signed in with.
        </OwnerStatus>
      ) : null}

      {kind === "someone-else" ? (
        <div
          style={{
            display: "grid",
            // min(…, 100%): a nested owner row on a phone is narrower than 220px.
            gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
            gap: 12,
            marginTop: 12,
          }}
        >
          <div>
            <label style={lbl} htmlFor={`${id}-name`}>
              Owner&apos;s name
            </label>
            <input
              id={`${id}-name`}
              aria-required
              aria-invalid={Boolean(nameIssue) || undefined}
              aria-describedby={nameIssue ? `${id}-name-error` : undefined}
              value={name}
              onChange={(e) => type({ name: e.target.value })}
              onBlur={() => touch("name")}
              placeholder="Full name"
              style={inp(Boolean(nameIssue))}
            />
            {nameIssue ? (
              <FieldError id={`${id}-name-error`} Icon={Icon}>
                {nameIssue.message}
              </FieldError>
            ) : null}
          </div>
          <div>
            <label style={lbl} htmlFor={`${id}-email`}>
              Owner&apos;s email
            </label>
            <input
              id={`${id}-email`}
              type="email"
              aria-required
              aria-invalid={Boolean(emailIssue) || undefined}
              aria-describedby={emailIssue ? `${id}-email-error` : undefined}
              value={email}
              onChange={(e) => type({ email: e.target.value })}
              onBlur={() => touch("email")}
              placeholder="name@example.test"
              style={inp(Boolean(emailIssue))}
            />
            {emailIssue ? (
              <FieldError id={`${id}-email-error`} Icon={Icon}>
                {emailIssue.message}
              </FieldError>
            ) : null}
          </div>
        </div>
      ) : null}
      {kind === "someone-else" ? (
        <OwnerStatus verified={false} Icon={Icon}>
          Not verified: the app only checks that the email looks right. It can&apos;t confirm who
          this person is yet.
        </OwnerStatus>
      ) : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </fieldset>
  );
}

/** The `initiative-owner` field: the owner picker over an {@link IntakeInitiativeOwner} answer. */
export function InitiativeOwnerField({
  id,
  label,
  help,
  value,
  onChange,
  onBlur,
  signedIn,
  issues,
  showAll,
  Icon,
}: {
  /** DOM id of the field: the Myself choice is `${id}-kind`, the inputs `${id}-name` and `${id}-email`. */
  id: string;
  label: string;
  help?: string | undefined;
  value: unknown;
  onChange: (next: IntakeInitiativeOwner) => void;
  onBlur: () => void;
  signedIn?: SignedInPerson | undefined;
  /** Every current issue with the field; each shows once its input is touched, or with `showAll`. */
  issues: readonly StepIssue[];
  showAll: boolean;
  Icon: IconComponent;
}) {
  const owner = (value ?? null) as Partial<IntakeInitiativeOwner> | null;
  const other =
    owner?.kind === "someone-else" ? (owner as { name?: string; email?: string }) : null;
  return (
    <OwnerPicker
      id={id}
      legend={label}
      help={help}
      value={{ kind: owner?.kind, name: other?.name ?? "", email: other?.email ?? "" }}
      onChange={(next) =>
        onChange(
          next.kind === "self"
            ? { kind: "self" }
            : { kind: "someone-else", name: next.name, email: next.email },
        )
      }
      onBlur={onBlur}
      signedIn={signedIn}
      issues={issues}
      showAll={showAll}
      Icon={Icon}
    />
  );
}
