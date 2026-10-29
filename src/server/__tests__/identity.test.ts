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
    email: "casey.rivera@example.gov",
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
    emails: [{ value: "casey.rivera@example.gov", primary: true }],
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
    expect(identity.email).toBe("casey.rivera@example.gov");
    expect(identity.displayName).toBe("Casey Rivera");
    expect(identity.isDevFallback).toBeUndefined();
  });

  it("falls back to forwarded header fields when SCIM omits them, and picks the primary email", async () => {
    // SCIM omits userName/displayName entirely (not present on the resource).
    const fetchMe = vi.fn().mockResolvedValue({
      id: "scim-9f3c",
      emails: [{ value: "old@example.gov" }, { value: "primary@example.gov", primary: true }],
      groups: [],
    } satisfies ScimMe);

    const identity = await resolveIdentity({
      headers: headersWithToken({ preferredUsername: "hdr.user", user: "Header Name" }),
      fetchMe,
      config: { mode: "production", devFallback: DEV_FALLBACK },
    });

    expect(identity.email).toBe("primary@example.gov");
    expect(identity.username).toBe("hdr.user");
    expect(identity.displayName).toBe("Header Name");
  });

  it("(b) derives isAdmin=true only when SCIM groups contain the configured admin group id", async () => {
    const fetchMe = vi.fn().mockResolvedValue(
      scimMe({
        groups: [
          { value: "grp-analysts", type: "direct" },
          { value: "grp-admin", display: "EDP Admins", type: "direct" },
        ],
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

describe("resolveIdentity — the display name when SCIM has no name (GovCloud)", () => {
  /** GovCloud: /Me succeeds but the IdP sync sent no name attributes. */
  const NAMELESS_ME: ScimMe = {
    id: "scim-gov-1",
    userName: "casey.rivera@example.gov",
    emails: [{ value: "casey.rivera@example.gov", primary: true }],
    groups: [],
  };
  /** X-Forwarded-User as GovCloud sends it: `<userId>@<workspaceId>`. */
  const NUMERIC_USER = "1234567890123456@7890123456789012";

  async function resolveWith(me: ScimMe, over: Partial<ForwardedIdentityHeaders> = {}) {
    return resolveIdentity({
      headers: headersWithToken({ user: NUMERIC_USER, ...over }),
      fetchMe: vi.fn().mockResolvedValue(me),
      config: { mode: "production", devFallback: DEV_FALLBACK },
    });
  }

  it("never shows the numeric X-Forwarded-User id; shows the email instead", async () => {
    const identity = await resolveWith(NAMELESS_ME);
    expect(identity.displayName).toBe("casey.rivera@example.gov");
    expect(identity.displayName).not.toContain("1234567890123456");
    expect(identity.nameSource).toBe("email");
    expect(identity.givenName).toBeUndefined();
    expect(identity.familyName).toBeUndefined();
  });

  it("treats blank or whitespace SCIM name fields as absent", async () => {
    const identity = await resolveWith({
      ...NAMELESS_ME,
      displayName: "   ",
      name: { givenName: " ", familyName: "" },
    });
    expect(identity.displayName).toBe("casey.rivera@example.gov");
    expect(identity.nameSource).toBe("email");
  });

  it("never uses a numeric-id-shaped SCIM displayName", async () => {
    const identity = await resolveWith({ ...NAMELESS_ME, displayName: NUMERIC_USER });
    expect(identity.displayName).toBe("casey.rivera@example.gov");
  });

  it("joins the SCIM name parts when there is no displayName", async () => {
    const identity = await resolveWith({
      ...NAMELESS_ME,
      name: { givenName: "Casey", familyName: "Rivera" },
    });
    expect(identity.displayName).toBe("Casey Rivera");
    expect(identity.nameSource).toBe("scim-parts");
  });

  it("uses a real (non-numeric) X-Forwarded-User before the email", async () => {
    const identity = await resolveWith(NAMELESS_ME, { user: "Casey Rivera" });
    expect(identity.displayName).toBe("Casey Rivera");
    expect(identity.nameSource).toBe("header");
  });

  it("falls back to the username when there is no email", async () => {
    const identity = await resolveWith(
      { id: "scim-gov-1", userName: "crivera", groups: [] },
      { email: null },
    );
    expect(identity.displayName).toBe("crivera");
    expect(identity.nameSource).toBe("username");
  });

  it("reports no name when every candidate is blank or the numeric id", async () => {
    const identity = await resolveWith(
      { id: "scim-gov-1", userName: NUMERIC_USER, groups: [] },
      { email: null, preferredUsername: null },
    );
    expect(identity.displayName).not.toContain("1234567890123456");
    expect(identity.displayName.trim()).not.toBe("");
    expect(identity.nameSource).toBe("none");
  });

  it("never accepts an email-shaped SCIM displayName as scim-display", async () => {
    const identity = await resolveWith({ ...NAMELESS_ME, displayName: "casey.rivera@example.gov" });
    expect(identity.displayName).toBe("casey.rivera@example.gov");
    expect(identity.nameSource).toBe("email");
  });

  it("skips a SCIM displayName that equals the userName or the email's local part", async () => {
    for (const displayName of ["Casey.Rivera@example.gov", "casey.rivera"]) {
      const identity = await resolveWith({ ...NAMELESS_ME, userName: "crivera", displayName });
      expect(identity.nameSource).toBe("email");
    }
    const identity = await resolveWith({
      ...NAMELESS_ME,
      userName: "crivera",
      displayName: "CRIVERA",
    });
    expect(identity.nameSource).toBe("email");
  });

  it("skips an X-Forwarded-User that is an email or the preferred username", async () => {
    for (const user of ["someone@example.gov", "casey.rivera"]) {
      const identity = await resolveWith(NAMELESS_ME, { user });
      expect(identity.nameSource).toBe("email");
    }
  });

  it("drops a malformed SCIM name part and keeps the other", async () => {
    const identity = await resolveWith({
      ...NAMELESS_ME,
      name: { givenName: "casey.rivera@example.gov", familyName: "Rivera" },
    });
    expect(identity.givenName).toBeUndefined();
    expect(identity.familyName).toBe("Rivera");
    expect(identity.displayName).toBe("Rivera");
    expect(identity.nameSource).toBe("scim-parts");

    const digits = await resolveWith({
      ...NAMELESS_ME,
      name: { givenName: "Casey", familyName: "12345" },
    });
    expect(digits.givenName).toBe("Casey");
    expect(digits.familyName).toBeUndefined();
  });

  it("keeps a real single-word displayName", async () => {
    const identity = await resolveWith({ ...NAMELESS_ME, displayName: "Cher" });
    expect(identity.displayName).toBe("Cher");
    expect(identity.nameSource).toBe("scim-display");
  });

  it("returns email and username exactly as SCIM and the headers send them", async () => {
    const padded = await resolveWith({
      ...NAMELESS_ME,
      userName: "  casey.rivera  ",
      emails: [{ value: " casey.rivera@example.gov ", primary: true }],
    });
    expect(padded.email).toBe(" casey.rivera@example.gov ");
    expect(padded.username).toBe("  casey.rivera  ");
    expect(padded.principalId).toBe("scim-gov-1");

    // A whitespace userName is not replaced by the forwarded username or the email.
    const blank = await resolveWith({ ...NAMELESS_ME, userName: "   " });
    expect(blank.username).toBe("   ");
    expect(blank.email).toBe("casey.rivera@example.gov");
  });

  it("classifies the name on trimmed copies of the email and username", async () => {
    const padded = await resolveWith(
      {
        id: "scim-gov-1",
        userName: "   ",
        displayName: " Casey.Rivera ",
        emails: [{ value: " casey.rivera@example.gov ", primary: true }],
        groups: [],
      },
      { preferredUsername: "  " },
    );
    expect(padded.nameSource).toBe("email");
    expect(padded.displayName).toBe("casey.rivera@example.gov");
  });

  it("never treats Unicode decimal digits as a name", async () => {
    for (const displayName of ["１２３４", "١٢٣٤", "١٢٣٤@٥٦٧٨"]) {
      const identity = await resolveWith({ ...NAMELESS_ME, displayName });
      expect(identity.nameSource).toBe("email");
    }
    const parts = await resolveWith({
      ...NAMELESS_ME,
      name: { givenName: "Casey", familyName: "１２３４" },
    });
    expect(parts.familyName).toBeUndefined();
    expect(parts.displayName).toBe("Casey");

    const header = await resolveWith(NAMELESS_ME, { user: "１２３４５６" });
    expect(header.nameSource).toBe("email");

    // Nor as the username fallback when there is no email.
    const username = await resolveWith(
      { id: "scim-gov-1", userName: "１２３４@５６７８", groups: [] },
      { email: null, preferredUsername: null },
    );
    expect(username.nameSource).toBe("none");
    expect(username.displayName).not.toContain("１２３４");
  });

  it("skips a digit-shaped email in any script, spaced or '@' form, and falls back to the username", async () => {
    for (const value of ["١٢٣٤ ٥٦٧٨", "１２３４ ５６７８@９０１２", "1234 5678"]) {
      const identity = await resolveWith(
        { ...NAMELESS_ME, userName: "crivera", emails: [{ value, primary: true }] },
        { email: null },
      );
      expect(identity.displayName).toBe("crivera");
      expect(identity.nameSource).toBe("username");
      // The email itself is still returned as SCIM sent it.
      expect(identity.email).toBe(value);
    }
  });

  it("uses a real email as the fallback name, sourced email", async () => {
    const identity = await resolveWith({ ...NAMELESS_ME, userName: "١٢٣٤ ٥٦٧٨" });
    expect(identity.displayName).toBe("casey.rivera@example.gov");
    expect(identity.nameSource).toBe("email");
  });

  it("never uses a spaced Unicode-digit username as the fallback name", async () => {
    for (const userName of ["١٢٣٤ ٥٦٧٨", "１２３４ ５６７８", "١٢٣٤ ٥٦٧٨@٩٠١٢ ٣٤٥٦"]) {
      const identity = await resolveWith(
        { id: "scim-gov-1", userName, groups: [] },
        { email: null, preferredUsername: null },
      );
      expect(identity.displayName).toBe("Signed-in user");
      expect(identity.nameSource).toBe("none");
      expect(identity.username).toBe(userName);
    }
  });

  it("keeps a SCIM displayName as the name, sourced scim-display (commercial)", async () => {
    const identity = await resolveWith(scimMe());
    expect(identity.displayName).toBe("Casey Rivera");
    expect(identity.nameSource).toBe("scim-display");
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
    expect(deriveIsAdmin([{ value: "grp-admin", type: "direct" }], undefined)).toBe(false);
  });

  it("matches on the stable group id, not the display name", () => {
    expect(
      deriveIsAdmin([{ value: "grp-x", display: "EDP Admins", type: "direct" }], "grp-admin"),
    ).toBe(false);
    expect(
      deriveIsAdmin([{ value: "grp-admin", display: "anything", type: "direct" }], "grp-admin"),
    ).toBe(true);
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

  it("gives a direct member of the EDP admin group every staff role", async () => {
    const identity = await resolveWith([{ value: ADMIN, type: "direct" }]);
    expect(identity).toMatchObject({
      isAdmin: true,
      isSafeguardsValidator: true,
      onboardingReviewerRoles: ["business-office", "ccb"],
    });
  });

  it("gives an indirect member of the EDP admin group no staff role", async () => {
    const identity = await resolveWith([{ value: ADMIN, type: "indirect" }]);
    expect(identity).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });

  it.each([
    ["missing", { value: ADMIN }],
    ["unexpected", { value: ADMIN, type: "dynamic" }],
  ])("gives a member with %s membership type no staff role", async (_label, group) => {
    const identity = await resolveWith([group]);
    expect(identity).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
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
    const identity = await resolveWith([{ value: ADMIN, type: "direct" }], null);
    expect(identity).toMatchObject({
      isAdmin: false,
      isSafeguardsValidator: false,
      onboardingReviewerRoles: [],
    });
  });
});
