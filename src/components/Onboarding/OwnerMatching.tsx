// EDP staff match an onboarding request's owners to Databricks principals, or
// request user onboarding for those who aren't users yet (#103, slice 103-B),
// and the match state every reader of the request sees beside each owner.
//
// The app can't look Databricks users up (ADR-0004, ADR-0006): staff find the
// principal ID themselves and type it in, so a staff match is always shown as
// entered by staff and not verified. Who may match is decided by the store
// from the signed-in session; the profile here only decides what to show.

import React from "react";

import {
  INITIATIVE_OWNER_ID,
  isPrincipalIdFormat,
  useMatchOnboardingOwner,
  useRequestOwnerOnboarding,
  useWriteIntent,
  type OnboardingOwnerMatch,
  type OnboardingRequest,
  type OwnerVerification,
} from "@/data";
import { useChrome } from "./chrome";
import { ActionFailedNotice, Mono, SaveStatus } from "./shared";
import { TONE, inp, lbl, muted, outlineBtn, pendingBtn, primaryBtn, type Tone } from "./styles";

/** What a match state says, in the words every screen uses for it. */
function markFor(
  match: OnboardingOwnerMatch | undefined,
  verification: OwnerVerification | undefined,
): { tone: Tone; icon: string; text: string } {
  if (match?.state === "matched") {
    return match.matchedBy?.kind === "staff"
      ? { tone: "info", icon: "person_search", text: "Matched by EDP staff, not verified" }
      : { tone: "success", icon: "verified", text: "Verified: signed-in account" };
  }
  if (match?.state === "onboarding-requested") {
    return { tone: "warning", icon: "schedule", text: "Not a Databricks user yet" };
  }
  if (!match && verification === "verified") {
    return { tone: "success", icon: "verified", text: "Verified: signed-in account" };
  }
  return { tone: "warning", icon: "help", text: "Not verified" };
}

/**
 * Whether the app knows which Databricks principal an owner is (#103): the
 * provider's own signed-in account (verified), matched by EDP staff (not
 * verified), waiting on onboarding, or nothing confirmed yet.
 */
export function OwnerMatchMark({
  match,
  verification,
}: {
  match?: OnboardingOwnerMatch | undefined;
  verification?: OwnerVerification | undefined;
}) {
  const { Icon } = useChrome();
  const mark = markFor(match, verification);
  const tone = TONE[mark.tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        marginLeft: 8,
        padding: "1px 8px",
        borderRadius: "var(--radius-pill)",
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.fg,
        fontSize: "var(--font-size-3xs)",
        fontWeight: 700,
        whiteSpace: "normal",
      }}
    >
      <Icon name={mark.icon} size={14} color={tone.fg} />
      {mark.text}
    </span>
  );
}

const day = (at: string) =>
  new Date(at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

/** The detail under a match: which principal, who entered it and when, or the pending entry. */
function MatchDetail({ owner }: { owner: OnboardingOwnerMatch }) {
  if (owner.state === "matched" && owner.matchedBy?.kind === "staff") {
    return (
      <div style={muted}>
        Databricks principal ID <Mono>{owner.principalId}</Mono>, entered by{" "}
        {owner.matchedBy.name ?? "EDP staff"}
        {owner.matchedBy.at ? (
          <>
            {" "}
            on <time dateTime={owner.matchedBy.at}>{day(owner.matchedBy.at)}</time>
          </>
        ) : null}
        . The app can&apos;t check it against a user directory.
      </div>
    );
  }
  if (owner.state === "matched") {
    return (
      <div style={muted}>
        The data provider&apos;s own signed-in account, principal ID{" "}
        <Mono>{owner.principalId}</Mono>.
      </div>
    );
  }
  if (owner.state === "onboarding-requested") {
    return (
      <div style={muted}>
        Onboarding is on the change list as <strong>{owner.onboardingEntryId}</strong>. Once EDP
        staff mark it applied, match them here.
      </div>
    );
  }
  return <div style={muted}>Not matched to a Databricks user yet.</div>;
}

function ownsText(owner: OnboardingOwnerMatch, request: OnboardingRequest): string {
  if (owner.ownerId === INITIATIVE_OWNER_ID) return "Initiative point of contact";
  const dataset = request.intake.datasets.find((item) => item.id === owner.datasetId);
  return `Owner of ${dataset?.name ?? "a dataset"}`;
}

/**
 * Every owner of the request with their match state, and, for each one who
 * isn't the provider's own account, a way to enter the principal staff found
 * or request user onboarding for them.
 */
export function OwnerMatchingPanel({ request }: { request: OnboardingRequest }) {
  const { Icon } = useChrome();
  const match = useMatchOnboardingOwner();
  const onboard = useRequestOwnerOnboarding();
  const intents = useWriteIntent();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [principalId, setPrincipalId] = React.useState("");
  const [formatError, setFormatError] = React.useState(false);
  const [outcome, setOutcome] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const saving = match.isPending || onboard.isPending;
  const busy = saving
    ? { disabled: true, "aria-disabled": true as const }
    : { disabled: false, "aria-disabled": undefined };
  const headingId = `${request.id}-owners`;
  const error = match.error ?? onboard.error;

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startMatch = (owner: OnboardingOwnerMatch) => {
    if (saving) return;
    match.reset();
    onboard.reset();
    setOutcome("");
    setFormatError(false);
    setPrincipalId(owner.principalId ?? "");
    setEditing(owner.ownerId);
  };

  const saveMatch = (owner: OnboardingOwnerMatch) => {
    if (!isPrincipalIdFormat(principalId)) {
      setFormatError(true);
      inputRef.current?.focus();
      return;
    }
    const input = { ownerId: owner.ownerId, principalId: principalId.trim() };
    match.mutate(
      {
        id: request.id,
        match: input,
        intent: intents.intentFor({ id: request.id, match: input }, request.version),
      },
      {
        onSuccess: () => {
          intents.settle();
          setEditing(null);
          setOutcome(`Matched ${owner.name} to Databricks principal ID ${input.principalId}.`);
        },
      },
    );
  };

  const requestOnboarding = (owner: OnboardingOwnerMatch) => {
    if (saving) return;
    match.reset();
    onboard.reset();
    setOutcome("");
    setEditing(null);
    onboard.mutate(
      {
        id: request.id,
        ownerId: owner.ownerId,
        intent: intents.intentFor({ id: request.id, onboard: owner.ownerId }, request.version),
      },
      {
        onSuccess: () => {
          intents.settle();
          setOutcome(`Listed onboarding for ${owner.name} on the change list.`);
        },
      },
    );
  };

  return (
    <section aria-labelledby={headingId} style={{ display: "grid", gap: 10 }}>
      <h3
        id={headingId}
        style={{
          margin: 0,
          fontSize: "var(--font-size-2xs)",
          fontWeight: 700,
          color: "var(--text-default)",
        }}
      >
        Owners and their Databricks users
      </h3>
      <p style={{ ...muted, margin: 0 }}>
        The app can&apos;t look Databricks users up. Find each owner in the account console and
        enter their principal ID, or, if they aren&apos;t a Databricks user yet, request user
        onboarding on the change list. A match you enter shows as not verified.
      </p>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-white, #fff)",
        }}
      >
        {request.ownerMatches.map((owner, i) => {
          const self = owner.matchedBy?.kind === "self";
          const inputId = `${request.id}-${owner.ownerId}-principal`;
          const hintId = `${inputId}-hint`;
          const errorId = `${inputId}-error`;
          return (
            <li
              key={owner.ownerId}
              aria-label={`${owner.name}, ${ownsText(owner, request)}`}
              style={{
                padding: "12px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--border-default)",
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ fontSize: "var(--font-size-2xs)", lineHeight: 1.5 }}>
                <strong>{owner.name}</strong> ({owner.email}) ·{" "}
                <span style={muted}>{ownsText(owner, request)}</span>
                <OwnerMatchMark match={owner} />
              </div>
              <MatchDetail owner={owner} />
              {self ? null : editing === owner.ownerId ? (
                <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
                  <div>
                    <label style={lbl} htmlFor={inputId}>
                      Databricks principal ID for {owner.name}
                    </label>
                    <div id={hintId} style={{ ...muted, marginBottom: 7 }}>
                      Digits only, as the account console shows it.
                    </div>
                    <input
                      ref={inputRef}
                      id={inputId}
                      inputMode="numeric"
                      autoComplete="off"
                      aria-describedby={formatError ? `${hintId} ${errorId}` : hintId}
                      aria-invalid={formatError || undefined}
                      readOnly={saving}
                      value={principalId}
                      onChange={(e) => {
                        setPrincipalId(e.target.value);
                        if (isPrincipalIdFormat(e.target.value)) setFormatError(false);
                      }}
                      style={
                        formatError ? { ...inp, border: "1.5px solid var(--theme-error)" } : inp
                      }
                    />
                    {formatError ? (
                      <div
                        id={errorId}
                        role="alert"
                        style={{
                          color: "var(--theme-error-dark)",
                          fontSize: "var(--font-size-3xs)",
                          marginTop: 5,
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                        }}
                      >
                        <Icon name="error" size={14} color="var(--theme-error-dark)" />
                        Enter the principal ID as digits only, up to 20 of them.
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={saving ? { ...primaryBtn, ...pendingBtn } : primaryBtn}
                      {...busy}
                      onClick={() => saveMatch(owner)}
                    >
                      {match.isPending ? "Saving…" : "Save match"}
                    </button>
                    <button
                      type="button"
                      style={outlineBtn}
                      {...busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={outlineBtn}
                    {...busy}
                    aria-label={`${owner.state === "matched" ? "Change the match for" : "Match"} ${owner.name}`}
                    onClick={() => startMatch(owner)}
                  >
                    {owner.state === "matched" ? "Change match" : "Match to a principal ID"}
                  </button>
                  {owner.state === "unmatched" ? (
                    <button
                      type="button"
                      style={outlineBtn}
                      {...busy}
                      aria-label={`Request user onboarding for ${owner.name}`}
                      onClick={() => requestOnboarding(owner)}
                    >
                      Request user onboarding
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {outcome && !saving ? <p style={{ ...muted, margin: 0 }}>{outcome}</p> : null}
      <SaveStatus message={saving ? `Saving the owner match on ${request.id}…` : outcome || null} />
      {error ? <ActionFailedNotice error={error} /> : null}
    </section>
  );
}
