import { describe, expect, it } from "vitest";

import type { UserProfile } from "@/data/types";
import { DEV_FALLBACK_PRINCIPAL_ID, isDevFallbackPrincipal, presentProfile } from "./presenter";

/** A real, Databricks-forwarded resolved identity (opaque SCIM id). */
function realUser(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    principalId: "4830123456789012",
    name: "Jordan Vega",
    initials: "JV",
    title: "EDP User",
    tenant: "IRS Enterprise Data Platform",
    email: "jordan.vega@example.test",
    isOnboardingLead: false,
    isAdmin: false,
    ...overrides,
  };
}

describe("presentProfile — resolved identity (the only real data)", () => {
  it("explains the identity and admin derivation without implementation acronyms", () => {
    const vm = presentProfile({ user: realUser({ isAdmin: true }) });
    expect(vm.identity.sourceDetail).not.toContain("SCIM");
    expect(vm.admin.derivation).not.toContain("SCIM");
  });

  it("maps the real forwarded identity straight through", () => {
    const vm = presentProfile({
      user: realUser({ name: "Jordan Vega", email: "jordan.vega@example.test" }),
    });

    expect(vm.identity.displayName).toBe("Jordan Vega");
    expect(vm.identity.email).toBe("jordan.vega@example.test");
    expect(vm.identity.principalId).toBe("4830123456789012");
    expect(vm.identity.isDevFallback).toBe(false);
    expect(vm.identity.source).toBe("databricks-forwarded");
    expect(vm.identity.sourceLabel).toMatch(/Databricks-forwarded/i);
  });
});

describe("presentProfile — admin derivation label", () => {
  it("labels an admin as derived from EDP-admin group membership", () => {
    const vm = presentProfile({ user: realUser({ isAdmin: true }) });

    expect(vm.admin.isAdmin).toBe(true);
    expect(vm.admin.roleLabel).toBe("Administrator");
    expect(vm.admin.derivation).toMatch(/EDP-admin group/i);
    expect(vm.admin.derivation).toMatch(/member/i);
  });

  it("labels a non-admin as not a member of the EDP-admin group", () => {
    const vm = presentProfile({ user: realUser({ isAdmin: false }) });

    expect(vm.admin.isAdmin).toBe(false);
    expect(vm.admin.roleLabel).toBe("Standard user");
    expect(vm.admin.derivation).toMatch(/not a member/i);
  });
});

describe("presentProfile — dev-fallback marker", () => {
  it("marks the server dev-fallback identity as not real", () => {
    const vm = presentProfile({
      user: realUser({
        principalId: DEV_FALLBACK_PRINCIPAL_ID,
        name: "Local Dev (unauthenticated)",
      }),
    });

    expect(vm.identity.isDevFallback).toBe(true);
    expect(vm.identity.source).toBe("local-dev-fallback");
    expect(vm.identity.sourceLabel).toMatch(/local dev/i);
    expect(vm.identity.sourceDetail).toMatch(/not a real Databricks-forwarded identity/i);
  });

  it("marks the local seed profile (seed- prefix) as not real", () => {
    const vm = presentProfile({ user: realUser({ principalId: "seed-dana-whitfield" }) });
    expect(vm.identity.isDevFallback).toBe(true);
    expect(vm.identity.source).toBe("local-dev-fallback");
  });

  it("does not mistake an opaque real SCIM id for a dev fallback", () => {
    expect(isDevFallbackPrincipal("4830123456789012")).toBe(false);
    expect(isDevFallbackPrincipal(DEV_FALLBACK_PRINCIPAL_ID)).toBe(true);
    expect(isDevFallbackPrincipal("seed-anything")).toBe(true);
  });
});

describe("presentProfile — expansion sections are honestly not connected", () => {
  it("renders all three sections in the 'not connected' state, never fabricated data", () => {
    const vm = presentProfile({ user: realUser() });

    expect(vm.sections.map((s) => s.id)).toEqual(["access", "waiver", "requests"]);
    expect(vm.sections.find((s) => s.id === "waiver")).toMatchObject({
      label: "EIR stage",
    });
    expect(vm.sections.find((s) => s.id === "waiver")?.description).toMatch(
      /Employee Identity Record \(EIR\) stage/,
    );
    expect(vm.sections.find((s) => s.id === "requests")?.description).toMatch(
      /service-level agreement \(SLA\) state/,
    );
    for (const section of vm.sections) {
      expect(section.status).toBe("not-connected");
      expect(section.statusLabel).toBe("Not yet connected");
      expect(section.wiredUpBy).toBeTruthy();
    }
  });

  it("keeps sections not-connected even if empty future inputs are passed", () => {
    const vm = presentProfile({
      user: realUser(),
      access: null,
      waiver: null,
      requests: null,
    });
    expect(vm.sections.every((s) => s.status === "not-connected")).toBe(true);
  });

  it("shows no group memberships when the session payload carries none", () => {
    const vm = presentProfile({ user: realUser() });
    expect(vm.hasGroups).toBe(false);
    expect(vm.groups).toEqual([]);
  });

  it("surfaces read-only group memberships when present", () => {
    const vm = presentProfile({
      user: realUser(),
      groups: [{ id: "g1", label: "edp-analysts" }],
    });
    expect(vm.hasGroups).toBe(true);
    expect(vm.groups).toEqual([{ id: "g1", label: "edp-analysts" }]);
  });
});
