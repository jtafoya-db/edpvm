/**
 * Domain-owner routing (ADR-0002).
 *
 * A canonical request carries a `domainId` (see {@link CanonicalRequest} in
 * ./canonical-request), but the seeded {@link BusinessDomain} only records an
 * `owner` (a council *name*) and a `steward` (a person's display name) —
 * neither is a routable target. This module adds the missing seam: a
 * data-driven table mapping each seeded domain to an *owner group* (a routable
 * handle plus its members), so a request can be routed to the accountable
 * reviewers instead of a free-text label.
 *
 * This slice is PURELY ADDITIVE — it neither reads nor mutates the store, the
 * seed, or the {@link BusinessDomain} type. The mapping lives entirely here so
 * a later wiring slice can move it onto the domain record (the deferred
 * `BusinessDomain.ownerGroup` field) or swap in a directory-backed source with
 * no change to these callers.
 *
 * Fail-loud by design: a `domainId` with no mapped owner group is reported as
 * `unrouted` via {@link isRouted} / {@link unroutedReason} rather than silently
 * dropped, so an unmapped domain surfaces as a routing gap instead of a
 * request that quietly goes nowhere.
 */

import type { UserProfile } from "./types";

/** A routable owner group: a stable handle plus the identities that belong to it. */
export interface DomainOwnerGroup {
  /** Stable routing handle, of the form `domain-owners-<domainId>`. */
  ownerGroup: string;
  /**
   * Member identities. Seeded with the reviewers' work emails; membership is
   * matched case-insensitively against a user's email or display name so a
   * {@link UserProfile} or a bare identifier string both resolve.
   */
  members: string[];
}

/** Why a `domainId` could not be routed to an owner group. */
export type UnroutedReason =
  | { kind: "unknown-domain"; domainId: string; detail: string }
  | { kind: "no-owner-group"; domainId: string; detail: string };

function ownerGroupHandle(domainId: string): string {
  return `domain-owners-${domainId}`;
}

/**
 * Seeded routing table keyed by the real seeded {@link BusinessDomain} ids
 * (see src/legacy/appData.js). Each entry names the accountable owner group and
 * its members. Kept as a plain data object so it is trivially swappable for a
 * directory-backed source later.
 */
export const DOMAIN_OWNER_GROUPS: Readonly<Record<string, DomainOwnerGroup>> = {
  "individual-filing": {
    ownerGroup: ownerGroupHandle("individual-filing"),
    members: ["marcus.liu@example.test", "individual-returns-council@example.test"],
  },
  "business-filing": {
    ownerGroup: ownerGroupHandle("business-filing"),
    members: ["priya.nadar@example.test", "business-returns-council@example.test"],
  },
  "modernized-efile": {
    ownerGroup: ownerGroupHandle("modernized-efile"),
    members: ["erin.coyle@example.test", "submission-processing-council@example.test"],
  },
  "preparer-practitioner": {
    ownerGroup: ownerGroupHandle("preparer-practitioner"),
    members: ["janet.osei@example.test", "return-preparer-office@example.test"],
  },
  "enforcement-collections": {
    ownerGroup: ownerGroupHandle("enforcement-collections"),
    members: ["carlos.reyes@example.test", "collection-strategy-council@example.test"],
  },
  "compliance-exam": {
    ownerGroup: ownerGroupHandle("compliance-exam"),
    members: ["helen.park@example.test", "examination-data-council@example.test"],
  },
  "taxpayer-identity": {
    ownerGroup: ownerGroupHandle("taxpayer-identity"),
    members: ["sam.whitfield@example.test", "identity-assurance-council@example.test"],
  },
  "information-returns": {
    ownerGroup: ownerGroupHandle("information-returns"),
    members: ["lena.brooks@example.test", "information-reporting-council@example.test"],
  },
};

/** The full set of `domainId`s that have a seeded owner group. */
export function routedDomainIds(): string[] {
  return Object.keys(DOMAIN_OWNER_GROUPS);
}

/**
 * Resolve the owner-group handle for a domain, or `undefined` if the domain has
 * no mapped owner group (see {@link isRouted} / {@link unroutedReason} to
 * detect and explain that case).
 */
export function getDomainOwnerGroup(domainId: string): string | undefined {
  return DOMAIN_OWNER_GROUPS[domainId]?.ownerGroup;
}

/** The member identities of a domain's owner group (empty if unmapped). */
export function getDomainOwnerMembers(domainId: string): string[] {
  return DOMAIN_OWNER_GROUPS[domainId]?.members ?? [];
}

function memberKeys(user: UserProfile | string): string[] {
  if (typeof user === "string") return [user.trim().toLowerCase()];
  return [user.email, user.name]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.trim().toLowerCase());
}

/**
 * Whether `user` belongs to the owner group for `domainId`. Accepts a
 * {@link UserProfile} (matched on email or display name) or a bare identifier
 * string. Returns `false` for an unmapped domain — an unrouted domain has no
 * owners.
 */
export function isDomainOwner(user: UserProfile | string, domainId: string): boolean {
  const entry = DOMAIN_OWNER_GROUPS[domainId];
  if (!entry) return false;
  const candidates = new Set(memberKeys(user));
  if (candidates.size === 0) return false;
  return entry.members.some((member) => candidates.has(member.trim().toLowerCase()));
}

/** Whether `domainId` has a mapped owner group and can therefore be routed. */
export function isRouted(domainId: string): boolean {
  return Object.prototype.hasOwnProperty.call(DOMAIN_OWNER_GROUPS, domainId);
}

/**
 * Explain why `domainId` cannot be routed, or `undefined` when it can. The
 * `kind` distinguishes a domain that is not a known seeded domain from one that
 * is known but has no owner group configured; today the table is keyed by
 * domain id alone, so any unmapped id reports `no-owner-group`.
 */
export function unroutedReason(domainId: string): UnroutedReason | undefined {
  if (isRouted(domainId)) return undefined;
  return {
    kind: "no-owner-group",
    domainId,
    detail: `Domain '${domainId}' has no mapped owner group; requests for it cannot be routed and must be triaged manually.`,
  };
}
