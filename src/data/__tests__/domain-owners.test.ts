import { describe, expect, it } from "vitest";
import type { UserProfile } from "../types";
import {
  DOMAIN_OWNER_GROUPS,
  getDomainOwnerGroup,
  getDomainOwnerMembers,
  isDomainOwner,
  isRouted,
  routedDomainIds,
  unroutedReason,
} from "../domain-owners";

// A real seeded domain (see src/legacy/appData.js) and one that does not exist.
const SEEDED_DOMAIN = "individual-filing";
const UNMAPPED_DOMAIN = "totally-made-up-domain";

function user(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    principalId: "marcus-liu-1",
    name: "Marcus Liu",
    initials: "ML",
    title: "Domain Steward",
    tenant: "RAAS",
    email: "marcus.liu@example.gov",
    isOnboardingLead: false,
    isAdmin: false,
    ...overrides,
  };
}

describe("getDomainOwnerGroup", () => {
  it("returns the owner-group handle for a mapped domain (hit)", () => {
    expect(getDomainOwnerGroup(SEEDED_DOMAIN)).toBe("domain-owners-individual-filing");
  });

  it("returns undefined for an unmapped domain (miss)", () => {
    expect(getDomainOwnerGroup(UNMAPPED_DOMAIN)).toBeUndefined();
  });
});

describe("isDomainOwner", () => {
  it("is true when the user's email is a member of the group", () => {
    expect(isDomainOwner(user(), SEEDED_DOMAIN)).toBe(true);
  });

  it("matches membership case-insensitively", () => {
    expect(isDomainOwner(user({ email: "MARCUS.LIU@example.gov" }), SEEDED_DOMAIN)).toBe(true);
  });

  it("accepts a bare identifier string", () => {
    expect(isDomainOwner("individual-returns-council@example.gov", SEEDED_DOMAIN)).toBe(true);
  });

  it("is false when the user is not a member", () => {
    expect(
      isDomainOwner(user({ email: "stranger@example.gov", name: "Stranger" }), SEEDED_DOMAIN),
    ).toBe(false);
  });

  it("is false for an unmapped domain (an unrouted domain has no owners)", () => {
    expect(isDomainOwner(user(), UNMAPPED_DOMAIN)).toBe(false);
  });

  it("is false when the identity is empty", () => {
    expect(isDomainOwner("   ", SEEDED_DOMAIN)).toBe(false);
  });
});

describe("isRouted", () => {
  it("is true for a mapped domain", () => {
    expect(isRouted(SEEDED_DOMAIN)).toBe(true);
  });

  it("is false for an unmapped domain", () => {
    expect(isRouted(UNMAPPED_DOMAIN)).toBe(false);
  });
});

describe("unroutedReason", () => {
  it("is undefined for a routed domain", () => {
    expect(unroutedReason(SEEDED_DOMAIN)).toBeUndefined();
  });

  it("explains why an unmapped domain cannot be routed (fail loud, not silent)", () => {
    const reason = unroutedReason(UNMAPPED_DOMAIN);
    expect(reason).toBeDefined();
    expect(reason?.kind).toBe("no-owner-group");
    expect(reason?.domainId).toBe(UNMAPPED_DOMAIN);
    expect(reason?.detail).toContain(UNMAPPED_DOMAIN);
  });
});

describe("getDomainOwnerMembers", () => {
  it("returns members for a mapped domain", () => {
    expect(getDomainOwnerMembers(SEEDED_DOMAIN)).toContain("marcus.liu@example.gov");
  });

  it("returns an empty list for an unmapped domain", () => {
    expect(getDomainOwnerMembers(UNMAPPED_DOMAIN)).toEqual([]);
  });
});

describe("seeded coverage", () => {
  it("every seeded domain has an owner group with a valid handle and members", async () => {
    // Importing the legacy prototype module populates window.AppData as a side
    // effect (jsdom env); readAppDataSeed snapshots it. This ties the coverage
    // assertion to the real seed rather than a hand-copied id list.
    await import("../../legacy/appData");
    const { readAppDataSeed } = await import("../seed");
    const seededIds = readAppDataSeed().domains.map((domain) => domain.id);

    expect(seededIds.length).toBeGreaterThan(0);
    for (const id of seededIds) {
      expect(isRouted(id)).toBe(true);
      const group = DOMAIN_OWNER_GROUPS[id];
      expect(group).toBeDefined();
      expect(group?.ownerGroup).toBe(`domain-owners-${id}`);
      expect(group?.members.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("routedDomainIds matches the mapping table keys", () => {
    expect(new Set(routedDomainIds())).toEqual(new Set(Object.keys(DOMAIN_OWNER_GROUPS)));
  });
});
