# Decouple Govdev Resource Names from the Bundle Target

## Goal

Allow a `govdev` deployment to use explicitly supplied, environment-appropriate
resource names such as `edp-vm-test` and `eir_pdfs`. The bundle target selects
the deployment configuration; names do not need to repeat the target string.

## Design

Remove the `govdev` substring checks from both deployment validation seams:

- command-line variable preflight (`resolvePreflight`), and
- resolved bundle validation (`checkResolvedConfig`).

Continue requiring explicit `app_name`, `store_schema_prefix`,
`eir_volume_name`, and numeric `edp_admin_group_id` values for `govdev`.
Continue requiring the Delta backend, blocking the production app name on a
non-production target, requiring production acknowledgement, checking resolved
Unity Catalog coordinates, and applying the existing destructive-plan gate.

## Acceptance criteria

1. `govdev` accepts `app_name=edp-vm-test` and
   `eir_volume_name=eir_pdfs` without requiring `govdev` in either value.
2. The preflight still rejects missing required values, a nonnumeric admin group
   ID, and a non-Delta backend.
3. The resolved-config gate accepts the same names and retains its remaining
   `govdev` and production safety checks.
4. Focused deployment tests and the repository's deterministic gates pass.

## Test seam

The public pure validators `resolvePreflight` and `checkResolvedConfig`.

## Out of scope

No resource is renamed, created, deleted, or migrated. No target defaults or
production naming rules change.
