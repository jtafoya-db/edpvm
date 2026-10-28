/**
 * Server-side identity resolution — the pure core (ADR-0004, decisions 1–2).
 *
 * This module is the NAMED TEST SEAM for real Databricks App identity. It has
 * one job and no I/O of its own: given the identity headers a Databricks App
 * forwards, an INJECTED SCIM `/Me` fetch, and admin-group config, it resolves
 * the authenticated principal. Keeping the SCIM call injected (not performed
 * here) is what lets the resolver be unit-tested with a mock — no live network.
 *
 * The stable key is the SCIM `id` (NOT the token, which is never decoded, and
 * NOT the email). `isAdmin` is derived from whether the user's SCIM `groups`
 * contain the configured EDP-admin group's STABLE id as a direct membership —
 * never a nested group, seed flag, or browser-supplied value.
 *
 * In the MVP one group, the EDP admin group, holds every staff role (#226,
 * ADR-0008's 2026-10-18 amendment): EDP staff, Safeguards validator, EDP
 * business office and CCB. The role flags stay separate on the identity, so
 * splitting a role out later changes {@link deriveStaffRoles}, not its callers.
 *
 * The concrete SCIM call, env/config reading and the `/api/session` HTTP shape
 * live in `session.ts`; the request-header parsing adapter is `readForwardedHeaders`.
 */

import type { OnboardingReviewerRole } from "../data/onboarding/types";
import { isDigitIdentifier, isPersonName, type PersonIdentifiers } from "../data/person-name";
import type { NameSource } from "../data/types";

/**
 * The identity headers a Databricks App forwards to the app server. Present
 * ONLY inside a real Databricks App (local dev must simulate them). `null` when
 * the platform did not send the header — matching `Headers.get`.
 */
export interface ForwardedIdentityHeaders {
  /** `X-Forwarded-Access-Token` — the user's OBO token (user-authorization enabled). */
  accessToken: string | null;
  /** `X-Forwarded-Email`. */
  email: string | null;
  /** `X-Forwarded-Preferred-Username`. */
  preferredUsername: string | null;
  /** `X-Forwarded-User`. */
  user: string | null;
}

/** The subset of a SCIM v2 user resource (`/Me`) this slice consumes. */
export interface ScimMe {
  /** Stable SCIM principal id — the durable identity key. */
  id: string;
  userName?: string;
  displayName?: string;
  /** SCIM name parts, when the workspace has them (the EIR form pre-fills them). */
  name?: { givenName?: string; familyName?: string };
  emails?: Array<{ value: string; primary?: boolean }>;
  /** Group memberships; `value` is the stable id and `type` is direct or indirect. */
  groups?: Array<{ value: string; display?: string; type?: string }>;
}

/** Calls the workspace SCIM Current-User endpoint with the OBO token. Injected so tests can mock it. */
export type FetchMe = (accessToken: string) => Promise<ScimMe>;

/** Deployment posture. In `production`, absent forwarded identity is an error — never impersonate the seed. */
export type IdentityMode = "development" | "production";

/** Config the resolver needs, sourced by the caller from env (see `session.ts`). */
export interface IdentityResolverConfig {
  mode: IdentityMode;
  /**
   * Stable SCIM id of the EDP admin group; membership in it gives every staff
   * role (#226). Undefined ⇒ nobody holds a staff role.
   */
  adminGroupId?: string;
  /** Clearly-marked dev identity, returned ONLY when headers are absent AND mode is `development`. */
  devFallback: ResolvedIdentity;
  /**
   * Group ids the dev fallback counts as a member of. Its staff roles are
   * derived from them like anyone's, so it holds none without the admin group.
   */
  devFallbackGroupIds?: string[];
}

/** The sanitized, server-derived identity. Contains NO token. */
export interface ResolvedIdentity {
  /** Stable account SCIM principal id. */
  principalId: string;
  username: string;
  email: string;
  displayName: string;
  /** SCIM `name.givenName` / `name.familyName`, when /Me has them. */
  givenName?: string;
  familyName?: string;
  /** Where `displayName` came from, so operators can tell a missing SCIM name from a bug. */
  nameSource?: NameSource;
  isAdmin: boolean;
  isSafeguardsValidator?: boolean;
  /** Onboarding reviewer roles held (#86): both for an EDP admin group member (#226). */
  onboardingReviewerRoles?: OnboardingReviewerRole[];
  /** True when this is the local dev fallback rather than a real forwarded identity. */
  isDevFallback?: boolean;
}

/** Raised when identity cannot be resolved. `status` drives the `/api/session` HTTP code. */
export class IdentityResolutionError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "IdentityResolutionError";
    this.status = status;
  }
}

/** Parse the four forwarded identity headers off a request's `Headers` (case-insensitive). */
export function readForwardedHeaders(headers: Headers): ForwardedIdentityHeaders {
  return {
    accessToken: headers.get("x-forwarded-access-token"),
    email: headers.get("x-forwarded-email"),
    preferredUsername: headers.get("x-forwarded-preferred-username"),
    user: headers.get("x-forwarded-user"),
  };
}

/** The user is an admin iff SCIM reports direct membership in the configured group. */
export function deriveIsAdmin(groups: ScimMe["groups"], adminGroupId: string | undefined): boolean {
  if (!adminGroupId) return false;
  return (groups ?? []).some((group) => group.value === adminGroupId && group.type === "direct");
}

/** The staff roles on a resolved identity. */
export type StaffRoles = Pick<
  ResolvedIdentity,
  "isAdmin" | "isSafeguardsValidator" | "onboardingReviewerRoles"
>;

/**
 * The staff roles a user holds: all of them for a member of the EDP admin
 * group, none otherwise (#226). One group backs every role in the MVP; a
 * later split gives a role its own group here.
 */
export function deriveStaffRoles(
  groups: ScimMe["groups"],
  adminGroupId: string | undefined,
): Required<StaffRoles> {
  const member = deriveIsAdmin(groups, adminGroupId);
  return {
    isAdmin: member,
    isSafeguardsValidator: member,
    onboardingReviewerRoles: member ? ["business-office", "ccb"] : [],
  };
}

/**
 * Whether a `/Me` answer carries a usable stable principal id: a non-blank
 * string. The resolver refuses anything else, and the `/Me` cache keeps only
 * answers that pass.
 */
export function hasStablePrincipalId(me: unknown): me is ScimMe {
  const id = (me as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.trim() !== "";
}

/** Raised for a `/Me` answer without a stable principal id. */
export function missingPrincipalIdError(): IdentityResolutionError {
  return new IdentityResolutionError("SCIM /Me returned no stable principal id.", 502);
}

/** The primary email from a SCIM user (falls back to the first listed), or undefined. */
function primaryEmail(me: ScimMe): string | undefined {
  const emails = me.emails ?? [];
  return emails.find((entry) => entry.primary)?.value ?? emails[0]?.value;
}

/** Shown when no candidate is usable as a name. */
const NO_NAME_DISPLAY = "Signed-in user";

/** The trimmed value, or undefined when it's absent or blank. */
function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The trimmed value, when it's a person's name and not an identifier (`person-name.ts`). */
function personName(
  value: string | null | undefined,
  identifiers: PersonIdentifiers,
): string | undefined {
  return isPersonName(value, identifiers) ? value.trim() : undefined;
}

/** A non-blank value that isn't a digit-shaped id (`person-name.ts`), such as `<userId>@<workspaceId>`. */
function usable(value: string | null | undefined): string | undefined {
  const trimmed = nonBlank(value);
  return trimmed && !isDigitIdentifier(trimmed) ? trimmed : undefined;
}

/**
 * The display name and where it came from: SCIM `displayName`, then SCIM's
 * name parts, then `X-Forwarded-User`, then the email, then the username.
 * The first three must be a person's name, not an identifier, so a GovCloud
 * user whose IdP sent no name sees their email, not `<userId>@<workspaceId>`.
 */
function resolveDisplayName(
  me: ScimMe,
  headers: ForwardedIdentityHeaders,
  identifiers: PersonIdentifiers,
  parts: { givenName: string | undefined; familyName: string | undefined },
  email: string,
  username: string,
): { displayName: string; nameSource: NameSource } {
  const scimDisplay = personName(me.displayName, identifiers);
  if (scimDisplay) return { displayName: scimDisplay, nameSource: "scim-display" };
  const joined = [parts.givenName, parts.familyName].filter(Boolean).join(" ");
  if (joined) return { displayName: joined, nameSource: "scim-parts" };
  const header = personName(headers.user, identifiers);
  if (header) return { displayName: header, nameSource: "header" };
  const mail = usable(email);
  if (mail) return { displayName: mail, nameSource: "email" };
  const user = usable(username);
  if (user) return { displayName: user, nameSource: "username" };
  return { displayName: NO_NAME_DISPLAY, nameSource: "none" };
}

/**
 * Resolve the authenticated principal from forwarded headers.
 *
 * - Token present ⇒ call the injected SCIM `/Me`, key off `id`, derive the
 *   staff roles from EDP admin group membership. The token is used only as a bearer credential; it is
 *   never decoded or returned.
 * - Token absent + `development` ⇒ the clearly-marked dev fallback, with staff
 *   roles only if its configured dev groups include the admin group.
 * - Token absent + `production` ⇒ throw (401). We do NOT silently impersonate a
 *   seed user in a deployed app.
 */
export async function resolveIdentity(input: {
  headers: ForwardedIdentityHeaders;
  fetchMe: FetchMe;
  config: IdentityResolverConfig;
}): Promise<ResolvedIdentity> {
  const { headers, fetchMe, config } = input;

  const token = headers.accessToken?.trim();
  if (!token) {
    if (config.mode === "production") {
      throw new IdentityResolutionError(
        "No Databricks App forwarded identity (X-Forwarded-Access-Token) in a deployed app. " +
          "Enable user-authorization on the app; refusing to impersonate the seed user.",
        401,
      );
    }
    const groups = (config.devFallbackGroupIds ?? []).map(
      (value) => ({ value, type: "direct" }) as const,
    );
    return {
      ...config.devFallback,
      ...deriveStaffRoles(groups, config.adminGroupId),
      isDevFallback: true,
    };
  }

  const me = await fetchMe(token);
  if (!hasStablePrincipalId(me)) throw missingPrincipalIdError();

  const email = primaryEmail(me) ?? headers.email ?? "";
  const username = me.userName ?? headers.preferredUsername ?? email;
  // Trimmed copies, only to tell a name from an identifier; email and username
  // above are returned exactly as SCIM and the headers send them.
  const nameEmail = nonBlank(primaryEmail(me)) ?? nonBlank(headers.email) ?? "";
  const nameUsername = nonBlank(me.userName) ?? nonBlank(headers.preferredUsername) ?? nameEmail;
  const identifiers = { email: nameEmail, usernames: [me.userName, headers.preferredUsername] };
  // A name part that is only an identifier is dropped, not forwarded.
  const givenName = personName(me.name?.givenName, identifiers);
  const familyName = personName(me.name?.familyName, identifiers);

  return {
    principalId: me.id,
    username,
    email,
    ...resolveDisplayName(
      me,
      headers,
      identifiers,
      { givenName, familyName },
      nameEmail,
      nameUsername,
    ),
    ...(givenName ? { givenName } : {}),
    ...(familyName ? { familyName } : {}),
    ...deriveStaffRoles(me.groups, config.adminGroupId),
  };
}
