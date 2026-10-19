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
 * contain the configured EDP-admin group's STABLE id — never a seed flag, never
 * a browser-supplied value.
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
  /** Group memberships; `value` is the stable SCIM group id. */
  groups?: Array<{ value: string; display?: string }>;
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

/** The user is an admin iff a configured admin group id appears in their SCIM groups (by stable id). */
export function deriveIsAdmin(groups: ScimMe["groups"], adminGroupId: string | undefined): boolean {
  if (!adminGroupId) return false;
  return (groups ?? []).some((group) => group.value === adminGroupId);
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
    const groups = (config.devFallbackGroupIds ?? []).map((value) => ({ value }));
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
  const displayName = me.displayName ?? headers.user ?? username;

  return {
    principalId: me.id,
    username,
    email,
    displayName,
    ...(me.name?.givenName?.trim() ? { givenName: me.name.givenName.trim() } : {}),
    ...(me.name?.familyName?.trim() ? { familyName: me.name.familyName.trim() } : {}),
    ...deriveStaffRoles(me.groups, config.adminGroupId),
  };
}
