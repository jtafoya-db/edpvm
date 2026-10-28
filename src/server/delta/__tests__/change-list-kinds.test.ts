// @vitest-environment node
/**
 * `change_list_entries` takes the `onboard-user` kind (#103, slice 103-B)
 * without loosening membership entries: the CHECK constraints in
 * `resources/store-teams.sql`, run by the SQLite fake warehouse, accept a
 * legacy membership row and a well-formed onboard-user row, and refuse
 * either kind missing what it needs.
 */
import { describe, expect, it } from "vitest";

import { createSqliteWarehouse } from "./sqlite-warehouse.ts";

const COMMON = {
  display_number: 1,
  caused_by_action_id: "a1",
  person_display: "Noel Newhire",
  person_email: "noel.newhire@example.gov",
  person_principal_id: null,
  version: 1,
  created_at: "2026-10-19T14:00:00Z",
  created_by_principal_id: "scim-staff",
  updated_at: "2026-10-19T14:00:00Z",
  updated_by_principal_id: "scim-staff",
  last_action_id: "a1",
};
const MEMBERSHIP = {
  ...COMMON,
  kind: "add-member",
  reason: "dataset-role-added",
  dataset_id: "d1",
  group_name: "edp-x-tester",
  role: "tester",
  grants: "[]",
  target_payload: null,
};
const ONBOARD = {
  ...COMMON,
  kind: "onboard-user",
  reason: "owner-not-a-databricks-user",
  dataset_id: null,
  group_name: null,
  role: null,
  grants: null,
  target_payload: JSON.stringify({
    v: 1,
    person: { name: "Noel Newhire", email: "noel.newhire@example.gov" },
    initiative: { onboardingRequestId: "ONB-7K3QFD", name: "Collections case signals" },
  }),
};

function insert(row: Record<string, string | number | null>): void {
  const warehouse = createSqliteWarehouse();
  const columns = Object.keys(row);
  warehouse.query(
    `INSERT INTO change_list__change_list_entries (id, ${columns.join(", ")}) VALUES ('e1', ${columns.map((c) => `:${c}`).join(", ")})`,
    row,
  );
}

describe("change-list kind constraints accept onboard-user", () => {
  it("accepts a membership entry as before, and a well-formed onboard-user entry", () => {
    expect(() => insert(MEMBERSHIP)).not.toThrow();
    expect(() => insert(ONBOARD)).not.toThrow();
  });

  it.each([
    ["no role", { role: null }],
    ["no group", { group_name: null }],
    ["no dataset", { dataset_id: null }],
    ["no grants", { grants: null }],
  ])("refuses a membership entry with %s", (_what, change) => {
    expect(() => insert({ ...MEMBERSHIP, ...change })).toThrow(/CHECK constraint/);
  });

  it.each([
    ["no target payload", { target_payload: null }],
    ["no email", { person_email: null }],
    ["a dataset", { dataset_id: "d1" }],
    ["an unknown kind", { kind: "grant" }],
    ["an unknown reason", { reason: "because" }],
  ])("refuses an onboard-user entry with %s", (_what, change) => {
    expect(() => insert({ ...ONBOARD, ...change })).toThrow(/CHECK constraint/);
  });
});
