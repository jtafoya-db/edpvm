import { describe, expect, it, vi } from "vitest";

import {
  IdentityResolutionError,
  deriveIsAdmin,
  readForwardedHeaders,
  resolveIdentity,
  type ForwardedIdentityHeaders,
  type ResolvedIdentity,
  type ScimMe,
} from "../identity";

const DEV_FALLBACK: ResolvedIdentity = {
  principalId: "dev-local-user",
  username: "local-dev",
  email: "local-dev@edp.invalid",
  displayName: "Local Dev (unauthenticated)",
  isAdmin: false,
  isDevFallback: true,
};

/** Forwarded headers with a real OBO token; override fields per test. */
function headersWithToken(over: Partial<ForwardedIdentityHeaders> = {}): ForwardedIdentityHeaders {
  return {
    accessToken: "obo-token-abc",
    email: "casey.rivera@example.test",
    preferredUsername: "casey.rivera",
    user: "Casey Rivera",
    ...over,
  };
}

const NO_HEADERS: ForwardedIdentityHeaders = {
  accessToken: null,
  email: null,
  preferredUsername: null,
  user: null,
};

/** A SCIM /Me body; groups default to none. */
function scimMe(over: Partial<ScimMe> = {}): ScimMe {
  return {
    id: "scim-9f3c",
    userName: "casey.rivera",
    displayName: "Casey Rivera",
    emails: [{ value: "casey.rivera@example.test", primary: true }],
    groups: [],
    ...over,
  };
}

describe("resolveIdentity — real forwarded headers", () => {
  it("(a) resolves the principal from the mocked SCIM /Me using the OBO token", async () => {
    const fetchMe = vi.fn().mockResolvedValue(scimMe());

    const identity = await resolveIdentity({
      headers: headersWithToken(),
      fetchMe,
      config: { mode: "production", adminGroupId: "grp-admin", devFallback: DEV_FALLBACK },
    });

    // The token is passed to SCIM as the bearer credential, never decoded here.
    expect(fetchMe).toHaveBeenCalledWith("obo-token-abc");
    // The STABLE key is the SCIM id, not the email.
    expect(identity.principalId).toBe("scim-9f3c");
    expect(identity.username).toBe("casey.rivera");
    expect(identity.email).toBe("casey.rivera@example.test");
    expect(identity.displayName).toBe("Casey Rivera");
    expect(identity.isDevFallback).toBeUndefined();
  });

  it("falls back to forwarded header fields when SCIM omits them, and picks the primary email", async () => {
    // SCIM omits userName/displayName entirely (not present on the resource).
    const fetchMe = vi.fn().mockResolvedValue({
      id: "scim-9f3c",
      emails: [{ value: "old@example.test" }, { value: "primary@example.test", primary: true }],
      groups: [],
    } satisfies ScimMe);

    const identity = await resolveIdentity({
      headers: headersWithToken({ preferredUsername: "hdr.user", user: "Header Name" }),
      fetchMe,
      config: { mode: "production", devFallback: DEV_FALLBACK },
    });

    expect(identity.email).toBe("primary@example.test");
    expect(identity.username).toBe("hdr.user");
    expect(identity.displayName).toBe("Header Name");
  });

  it("(b) derives isAdmin=true only when SCIM groups contain the configured admin group id", async () => {
    const fetchMe = vi.fn().mockResolvedValue(
      scimMe({
        groups: [{ value: "grp-analysts" }, { value: "grp-admin", display: "EDP Admins" }],
      }),
    );

    const identity = await resolveIdentity({
      headers: headersWithToken(),
      fetchMe,
      config: { mode: "production", adminGroupId: "grp-admin", devFallback: DEV_FALLBACK },
    });

    expect(identity.isAdmin).toBe(true);
  });

  it("(b) derives isAdmin=false when the configured admin group id is absent from the user's groups", async () => {
    const fetchMe = vi.fn().mockResolvedValue(scimMe({ groups: [{ value: "grp-analysts" }] }));

    const identity = await resolveIdentity({
      headers: headersWithToken(),
      fetchMe,
      config: { mode: "production", adminGroupId: "grp-admin", devFallback: DEV_FALLBACK },
    });

    expect(identity.isAdmin).toBe(false);
  });

  it("throws when SCIM /Me returns no stable id", async () => {
    const fetchMe = vi.fn().mockResolvedValue({ userName: "x" } as ScimMe);

    await expect(
      resolveIdentity({
        headers: headersWithToken(),
        fetchMe,
        config: { mode: "production", devFallback: DEV_FALLBACK },
      }),
    ).rejects.toBeInstanceOf(IdentityResolutionError);
  });
});

describe("resolveIdentity — absent forwarded headers", () => {
  it("(c) returns the clearly-marked dev fallback (isAdmin false) in development, without calling SCIM", async () => {
    const fetchMe = vi.fn();

    const identity = await resolveIdentity({
      headers: NO_HEADERS,
      fetchMe,
      config: { mode: "development", adminGroupId: "grp-admin", devFallback: DEV_FALLBACK },
    });

    expect(fetchMe).not.toHaveBeenCalled();
    expect(identity.isDevFallback).toBe(true);
    expect(identity.isAdmin).toBe(false);
    expect(identity.principalId).toBe("dev-local-user");
  });

  it("derives the dev fallback's staff roles from its groups and the admin group, like anyone's (#226)", async () => {
    const devFallback = (adminGroupId?: string) =>
      resolveIdentity({
        headers: NO_HEADERS,
        fetchMe: vi.fn(),
        config: {
          mode: "development",
          ...(adminGroupId ? { adminGroupId } : {}),
          devFallback: { ...DEV_FALLBACK, onboardingReviewerRoles: ["business-office", "ccb"] },
          devFallbackGroupIds: ["grp-admin"],
        },
      });
    expect(await devFallback("grp-admin")).toMatchObject({
      isAdmin: true,
      isSafeguardsValidator: true,
      onboardingReviewerRoles: ["business-office", "ccb"],
    });
    expect(await devFallback()).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });

  it("refuses the dev fallback in production even when it names dev groups", async () => {
    await expect(
      resolveIdentity({
        headers: NO_HEADERS,
        fetchMe: vi.fn(),
        config: {
          mode: "production",
          adminGroupId: "grp-admin",
          devFallback: DEV_FALLBACK,
          devFallbackGroupIds: ["grp-admin"],
        },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("(d) throws a 401 in production rather than impersonating the seed user", async () => {
    const fetchMe = vi.fn();

    await expect(
      resolveIdentity({
        headers: NO_HEADERS,
        fetchMe,
        config: { mode: "production", devFallback: DEV_FALLBACK },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMe).not.toHaveBeenCalled();
  });
});

describe("deriveIsAdmin", () => {
  it("is false when no admin group is configured, even if the user has groups", () => {
    expect(deriveIsAdmin([{ value: "grp-admin" }], undefined)).toBe(false);
  });

  it("matches on the stable group id, not the display name", () => {
    expect(deriveIsAdmin([{ value: "grp-x", display: "EDP Admins" }], "grp-admin")).toBe(false);
    expect(deriveIsAdmin([{ value: "grp-admin", display: "anything" }], "grp-admin")).toBe(true);
  });
});

describe("readForwardedHeaders", () => {
  it("reads the four Databricks forwarded identity headers case-insensitively", () => {
    const headers = new Headers({
      "X-Forwarded-Access-Token": "tok",
      "X-Forwarded-Email": "a@b.gov",
      "X-Forwarded-Preferred-Username": "a.b",
      "X-Forwarded-User": "A B",
    });

    expect(readForwardedHeaders(headers)).toEqual({
      accessToken: "tok",
      email: "a@b.gov",
      preferredUsername: "a.b",
      user: "A B",
    });
  });

  it("yields null for headers the platform did not send", () => {
    expect(readForwardedHeaders(new Headers())).toEqual({
      accessToken: null,
      email: null,
      preferredUsername: null,
      user: null,
    });
  });
});

describe("resolveIdentity — one EDP admin group holds every staff role (#226)", () => {
  const ADMIN = "grp-admin";
  const resolveWith = (
    groups: NonNullable<ScimMe["groups"]>,
    adminGroupId: string | null = ADMIN,
  ) =>
    resolveIdentity({
      headers: headersWithToken(),
      fetchMe: vi.fn().mockResolvedValue(scimMe({ groups })),
      config: {
        mode: "production",
        ...(adminGroupId ? { adminGroupId } : {}),
        devFallback: DEV_FALLBACK,
      },
    });

  it("gives a member of the EDP admin group every staff role", async () => {
    const identity = await resolveWith([{ value: ADMIN }]);
    expect(identity).toMatchObject({
      isAdmin: true,
      isSafeguardsValidator: true,
      onboardingReviewerRoles: ["business-office", "ccb"],
    });
  });

  it("gives a non-member no staff role, whatever other groups they are in", async () => {
    const identity = await resolveWith([
      { value: "grp-validators" },
      { value: "grp-bo" },
      { value: "grp-ccb" },
      { value: "grp-other", display: ADMIN },
    ]);
    expect(identity).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });

  it("gives nobody a staff role when no admin group is configured", async () => {
    const identity = await resolveWith([{ value: ADMIN }], null);
    expect(identity).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });
});
