/**
 * GovCloud identities whose IdP sent no name (#332), resolved by the real
 * `resolveIdentity` and `toSessionUser`, so a downstream test sees exactly the
 * session user a deployed app would. `X-Forwarded-User` is the numeric
 * `<userId>@<workspaceId>` in every case.
 */
import { resolveIdentity, type ForwardedIdentityHeaders, type ScimMe } from "../identity";
import type { SessionUser } from "../delta/registry.ts";
import { toSessionUser } from "../session";

export const NUMERIC_USER = "1234567890123456@7890123456789012";
export const GOV_EMAIL = "casey.rivera@example.gov";
export const NO_NAME_DISPLAY = "Signed-in user";

interface GovCloudCase {
  me: ScimMe;
  headers: ForwardedIdentityHeaders;
}

const PRINCIPAL_ID = "4830123456789012";

/** /Me with an email and no name attributes: the display name is the email. */
export const NO_NAME_WITH_EMAIL: GovCloudCase = {
  me: {
    id: PRINCIPAL_ID,
    userName: GOV_EMAIL,
    emails: [{ value: GOV_EMAIL, primary: true }],
    groups: [],
  },
  headers: {
    accessToken: "obo-token",
    email: GOV_EMAIL,
    preferredUsername: null,
    user: NUMERIC_USER,
  },
};

/** No email and a digit-only username: the display name is the placeholder. */
export const NO_NAME_NO_EMAIL: GovCloudCase = {
  me: { id: PRINCIPAL_ID, userName: "١٢٣٤ ٥٦٧٨", groups: [] },
  headers: { accessToken: "obo-token", email: null, preferredUsername: null, user: NUMERIC_USER },
};

/** A digit-shaped email (Unicode digits) and a real username: the display name is the username. */
export const DIGIT_EMAIL: GovCloudCase = {
  me: {
    id: PRINCIPAL_ID,
    userName: "crivera",
    emails: [{ value: "١٢٣٤ ٥٦٧٨", primary: true }],
    groups: [],
  },
  headers: { accessToken: "obo-token", email: null, preferredUsername: null, user: NUMERIC_USER },
};

/** [label, case, the display name every downstream label must show]. */
export const GOVCLOUD_CASES: ReadonlyArray<[string, GovCloudCase, string]> = [
  ["the email", NO_NAME_WITH_EMAIL, GOV_EMAIL],
  ["the placeholder (no email, digit username)", NO_NAME_NO_EMAIL, NO_NAME_DISPLAY],
];

/**
 * [label, case, the account label a requester or attestor is stored and shown
 * as]: a usable email, else the sanitized display name.
 */
export const ACCOUNT_LABEL_CASES: ReadonlyArray<[string, GovCloudCase, string]> = [
  ["a normal email", NO_NAME_WITH_EMAIL, GOV_EMAIL],
  ["a digit-shaped email", DIGIT_EMAIL, "crivera"],
  ["no email and a digit username", NO_NAME_NO_EMAIL, NO_NAME_DISPLAY],
];

/** The session user the app resolves for `c` in production mode. */
export async function govCloudSessionUser(c: GovCloudCase): Promise<SessionUser> {
  return toSessionUser(
    await resolveIdentity({
      headers: c.headers,
      fetchMe: async () => c.me,
      config: {
        mode: "production",
        devFallback: {
          principalId: "dev-local-user",
          username: "local-dev",
          email: "local-dev@edp.invalid",
          displayName: "Local Dev (unauthenticated)",
          isAdmin: false,
          isDevFallback: true,
        },
      },
    }),
  );
}

/** True when `value` contains any digit run from the GovCloud identifiers. */
export function leaksIdentifier(value: unknown): boolean {
  const text = String(value);
  return /1234567890123456|7890123456789012|١٢٣٤/.test(text);
}
