/** Fixtures for the dataset-team and change-list contract tests. */
import { INTAKE, type DatasetMember, type DatasetSeed } from "../datasets/types";
import type { GroupNamingConfig } from "../datasets/group-naming";
import type { RoleDescriptions } from "../datasets/role-descriptions";
import type { UserProfile } from "../types";

function person(principalId: string, name: string, isAdmin = false): UserProfile {
  return {
    principalId,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    title: "EDP User",
    tenant: "RAAS",
    email: `${principalId}@example.gov`,
    isOnboardingLead: false,
    isAdmin,
  };
}

/** The seeded dataset's owner. */
export const OWNER = person("scim-owner-1", "Olive Owner");
/** Someone with no role on the dataset. */
export const STRANGER = person("scim-stranger-1", "Sam Stranger");
/** EDP staff (EDP-admin group member, so `isAdmin` is true). */
export const STAFF = person("scim-staff-1", "Stella Staff", true);

export const DATASET_ID = "ds-refund-anomalies";

export function makeDatasetSeed(): DatasetSeed {
  return {
    initiatives: [
      { id: "INI-001", name: "Refund Fraud Analytics", tenant: "RAAS", stage: "active" },
      { id: "INI-002", name: "Payroll Modernization", tenant: "RAAS", stage: "standup" },
    ],
    datasets: [
      {
        id: DATASET_ID,
        initiativeId: "INI-001",
        name: "Refund anomaly scores",
        domainTag: "individual-filing",
        datasetTag: "refund_anomalies",
        owners: [{ principalId: OWNER.principalId, displayName: OWNER.name }],
      },
      {
        id: "ds-payroll-events",
        initiativeId: "INI-002",
        name: "Payroll events",
        domainTag: "business-tax",
        datasetTag: "payroll_events",
        owners: [{ principalId: OWNER.principalId, displayName: OWNER.name }],
      },
    ],
  };
}

export const TEST_GROUP_NAMING: GroupNamingConfig = {
  datasetGroup: "edp-{datasetTag}-{role}",
  overrides: {},
};

/** Test wording, deliberately unlike the checked-in config, so tests prove it's read from config. */
export const TEST_ROLE_DESCRIPTIONS: RoleDescriptions = {
  roles: {
    tester: {
      label: "Tester",
      pluralLabel: "Testers",
      summary: "Test summary: read",
      grants: ["Test grant: read"],
    },
    developer: {
      label: "Dev (test)",
      pluralLabel: "Devs (test)",
      summary: "Test summary: read/write",
      grants: ["Test grant: read/write"],
    },
    manager: {
      label: "Maintainer",
      pluralLabel: "Maintainers",
      summary: "Test summary: manage",
      grants: ["Test grant: read/write", "Test grant: manage"],
    },
  },
  consumerNote: "Test consumer note.",
};

/** A controllable clock: each call returns the current value; `advance` moves it on. */
export function makeClock(start = "2026-10-01T12:00:00.000Z") {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * The members a test's own actions added: every role except the manager role
 * each seeded owner holds from the seed (ADR-0005).
 */
export async function addedMembers(
  store: { datasetRoles: { listMembers(datasetId: string): Promise<DatasetMember[]> } },
  datasetId: string,
): Promise<DatasetMember[]> {
  return (await store.datasetRoles.listMembers(datasetId)).filter((m) => m.addedBy !== INTAKE);
}
