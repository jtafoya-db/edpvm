#!/usr/bin/env bash
# Turnkey deploy for the EDP Vending Machine (#138).
#
# The one operator entry point for a deploy, preview or prod. One command
# stands up every piece of infra the bundle + wrapper can create in a Unity
# Catalog catalog you choose, builds and ships the app, and prints its URL. It
# is idempotent: re-running re-deploys, re-provisions (CREATE ... IF NOT
# EXISTS), re-applies grants (GRANT is idempotent) and restarts the app.
#
#   scripts/deploy-turnkey.sh -t preview -p example-workspace \
#     --var app_name=edp-vm-pr<N> \
#     --var catalog=example_catalog \
#     --var store_schema_prefix=edp_vm_pr<N>_ \
#     --var sql_warehouse_id=1111111111111111 \
#     --var eir_volume_name=eir_pr<N> \
#     --var edp_admin_group_id=11111111111111 \
#     --var seed_dataset_owner_ids=<your SCIM user id>
#
#   scripts/deploy-turnkey.sh -t prod --production -p <prod-profile> \
#     --var catalog=edp_prod \
#     --var sql_warehouse_id=<warehouse id> \
#     --var prod_root_path=<deployment-group folder, never /Workspace/Shared> \
#     --var edp_admin_group_id=<scim id> \
#     --var membership_job_sp=<service principal application id>
#
# Human prerequisites a DAB cannot create (see docs/production-checklist.md):
# the catalog itself, the SQL warehouse, and the SCIM account groups. Run
# `npm ci` first: the build uses this checkout's node_modules.
#
# Steps: preflight (inputs + the catalog exists) -> bundle validate ->
# RESOLVED-CONFIG GATE (catalog match + no value-less env) -> scripts/deploy.sh
# (PLAN GATE: no schema/volume delete or recreate; then build locally, stage
# the build into databricks-app/, bundle deploy --auto-approve, bundle run) ->
# provision_store -> EIR schema/volume (CREATE IF NOT EXISTS) -> grants
# (validator + app service principal) -> app URL. In the MVP the EDP admin
# group (edp_admin_group_id) holds every staff role, the Safeguards validator
# role included (#226); the per-role group vars are reserved and ignored.
# The EIR schema/volume and the app-SP + validator catalog grants are applied
# here, not in databricks.yml, because: in dev/preview `mode: development`
# rewrites bundle-managed UC names, a DAB cannot grant on a catalog it does not
# manage, and the app service principal's id is only known after deploy.
#
# GRANT BOUNDARY (ADR-0008, #141): this wrapper grants only to the ONE app
# service principal that exists today, on the schemas its own DDL creates
# (derived from the provision_store DDL: today catalog, requests, access,
# admin, audit, eir) and the EIR volume. It never
# grants to `account users`, `users` or any other broad group. The validator
# group gets no direct volume access unless --grant-validator-volume-read is
# passed (validators read PDFs through the app; production-checklist.md says to
# decide and record a direct grant). LIMITATION: ADR-0008's tenant app, staff
# app and Apply-job principals don't exist yet, so per-principal table rights
# (e.g. approval/application tables) can't be expressed here; that belongs to
# the ADR-0008 refactor and Apply-job tickets.
#
# Every workspace call must succeed: there is NO blanket `|| true`. CREATE ...
# IF NOT EXISTS and GRANT are idempotent, so a healthy workspace returns
# SUCCEEDED every time; anything else fails the wrapper loudly.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET=""
PROFILE=""
PRODUCTION=no
APPLY_GRANTS=1
GRANT_VALIDATOR_VOLUME=0
PASSTHROUGH=() # args forwarded verbatim to databricks and deploy.sh (-t, -p, --var ...)
VAR_ARGS=()    # just the --var pairs, for the preflight

usage() {
  cat >&2 <<'USAGE'
usage: scripts/deploy-turnkey.sh -t <target> [-p <profile>] [--production] \
         [--skip-grants] [--grant-validator-volume-read] \
         --var catalog=<name> --var sql_warehouse_id=<id> [--var ...]

  -t, --target   bundle target (preview | dev | govdev | prod). Required.
  -p, --profile  databricks CLI profile. Required for prod (it supplies the
                 production host, which cannot be a --var).
  --production   Required for -t prod (or EDP_DEPLOY_PRODUCTION=yes); passed
                 on to scripts/deploy.sh as the deliberate acknowledgement.
  --var app_name Required on every target but prod (scripts/deploy.sh
                 enforces it); a PR preview is edp-vm-pr<N>.
  --skip-grants  RECOVERY/DEBUG ONLY, not for a normal deploy (and never a
                 normal prod deploy): deploy + provision + create the EIR
                 volume without applying any UC grant. The app can't read or
                 write the store until a full run applies them.
  --grant-validator-volume-read
                 also give the EDP admin group, which holds the Safeguards
                 validator role in the MVP, direct USE SCHEMA + READ VOLUME
                 on the EIR volume (off by default: validators read PDFs
                 through the app). Record the decision.
USAGE
  exit 2
}

# A flag that takes a value: fail with usage if the value is missing, instead of
# crashing on an unbound variable under `set -u`.
need_value() {
  # $1 = flag name, $2 = remaining arg count ($#)
  if [[ "$2" -lt 2 ]]; then
    echo "deploy-turnkey: $1 requires a value" >&2
    usage
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t | --target)
      need_value "$1" "$#"
      TARGET="$2"
      PASSTHROUGH+=("-t" "$2")
      shift 2
      ;;
    -p | --profile)
      need_value "$1" "$#"
      PROFILE="$2"
      PASSTHROUGH+=("-p" "$2")
      shift 2
      ;;
    --production)
      PRODUCTION=yes
      shift
      ;;
    --skip-grants)
      APPLY_GRANTS=0
      shift
      ;;
    --grant-validator-volume-read)
      GRANT_VALIDATOR_VOLUME=1
      shift
      ;;
    --var)
      need_value "$1" "$#"
      VAR_ARGS+=("--var" "$2")
      PASSTHROUGH+=("--var" "$2")
      shift 2
      ;;
    -h | --help) usage ;;
    *)
      echo "deploy-turnkey: unknown argument '$1'" >&2
      usage
      ;;
  esac
done

[[ -n "$TARGET" ]] || {
  echo "deploy-turnkey: -t <target> is required" >&2
  usage
}
[[ "${EDP_DEPLOY_PRODUCTION:-}" == yes ]] && PRODUCTION=yes
if [[ "$TARGET" == "prod" && -z "$PROFILE" ]]; then
  echo "deploy-turnkey: prod requires -p <profile> (the production host comes from the profile; it cannot be a --var)." >&2
  exit 2
fi
if [[ "$TARGET" == "prod" && "$PRODUCTION" != yes ]]; then
  echo "deploy-turnkey: prod needs a deliberate acknowledgement: pass --production or set EDP_DEPLOY_PRODUCTION=yes." >&2
  exit 2
fi
DEPLOY_ARGS=("${PASSTHROUGH[@]}")
[[ "$PRODUCTION" == yes ]] && DEPLOY_ARGS+=("--production")

PROFILE_ARG=()
[[ -n "$PROFILE" ]] && PROFILE_ARG=("-p" "$PROFILE")

# --- run one SQL statement on the warehouse, failing hard unless it SUCCEEDED.
# Submits via the Statement Execution API and polls until the statement reaches
# a terminal state, so a cold-warehouse resume doesn't look like a failure.
run_sql() {
  local statement="$1" payload resp state statement_id attempt
  payload="$(STMT="$statement" WID="$WAREHOUSE_ID" python3 -I -c '
import json, os
print(json.dumps({"warehouse_id": os.environ["WID"], "statement": os.environ["STMT"],
                  "wait_timeout": "30s", "on_wait_timeout": "CONTINUE"}))')"
  resp="$(databricks api post /api/2.0/sql/statements "${PROFILE_ARG[@]}" --json "$payload")"
  # Read each value with its own $() (never a multi-var positional read): an
  # empty state must not shift statement_id, or the poll below would GET "".
  state="$(printf '%s' "$resp" | python3 -I -c '
import json, sys
print(json.load(sys.stdin).get("status", {}).get("state", ""))')"
  statement_id="$(printf '%s' "$resp" | python3 -I -c '
import json, sys
print(json.load(sys.stdin).get("statement_id", ""))')"
  attempt=0
  while [[ "$state" == "PENDING" || "$state" == "RUNNING" ]]; do
    attempt=$((attempt + 1))
    if [[ "$attempt" -gt 20 ]]; then
      echo "    ! statement did not finish in time: $statement" >&2
      return 1
    fi
    sleep 3
    resp="$(databricks api get "/api/2.0/sql/statements/${statement_id}" "${PROFILE_ARG[@]}")"
    state="$(printf '%s' "$resp" | python3 -I -c '
import json, sys
print(json.load(sys.stdin).get("status", {}).get("state", ""))')"
  done
  if [[ "$state" != "SUCCEEDED" ]]; then
    local msg
    msg="$(printf '%s' "$resp" | python3 -I -c '
import json, sys
print(json.load(sys.stdin).get("status", {}).get("error", {}).get("message", ""))' 2>/dev/null || true)"
    echo "    ! SQL did not SUCCEED (state=${state:-unknown}): $statement" >&2
    [[ -n "$msg" ]] && echo "      $msg" >&2
    return 1
  fi
}

# --- resolve a configured group value to a UC-grantable account-group DISPLAY
# NAME. `GRANT ... TO <group>` needs the display name (e.g. edp-admins), NOT the
# numeric SCIM account-group id the runtime env vars use (the app's
# is_account_group_member() keeps the numeric id). A numeric value is looked up
# via SCIM; a value that is already a name is returned as-is. A numeric id that
# can't be resolved is a hard failure (prints to stderr, returns 1), consistent
# with the no-silent-failure rule — callers use `|| exit 1`.
resolve_group_name() {
  local value="$1" name
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value" # already a display name
    return 0
  fi
  name="$(databricks api get "/api/2.0/preview/scim/v2/Groups/${value}" "${PROFILE_ARG[@]}" 2>/dev/null | python3 -I -c '
import json, sys
try:
    print(json.load(sys.stdin).get("displayName", ""))
except Exception:
    print("")')"
  if [[ -z "$name" ]]; then
    echo "deploy-turnkey: could not resolve group id ${value} to an account-group display name (SCIM /Groups lookup failed); cannot GRANT to it." >&2
    return 1
  fi
  printf '%s' "$name"
}

# --- refuse to GRANT to a broad principal (#141 / production-checklist.md: no
# broad group may hold access to EIR records or PDFs, or any store schema).
assert_narrow_principal() {
  local lowered
  lowered="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    "account users" | "users" | "all users" | "admins")
      echo "deploy-turnkey: refusing to GRANT to broad principal '$1'." >&2
      return 1
      ;;
  esac
}

echo "==> [1/7] preflight: required inputs, and the catalog exists"
node scripts/deploy-preflight.ts "${VAR_ARGS[@]}" -t "$TARGET" "${PROFILE_ARG[@]}"

echo "==> [2/7] bundle validate + resolved-config gate"
CONFIG_JSON="$(databricks bundle validate "${PASSTHROUGH[@]}" -o json)"
# Gate the RESOLVED configuration (not just CLI vars): the rendered store and
# EIR catalogs must match, and no app env entry may be value-less — this catches
# divergence/empties introduced via BUNDLE_VAR_*, a profile, env, or defaults,
# not only --var. Fails (exit 1) before any mutation.
printf '%s' "$CONFIG_JSON" | node scripts/bundle-config.ts --check

# Read each resolved field BY NAME (never positional splitting): an empty field
# — store_schema_prefix is empty in prod/dev — must map to "" and must not shift
# any other field's value.
bundle_field() { printf '%s' "$CONFIG_JSON" | node scripts/bundle-config.ts --field "$1"; }
APP_NAME="$(bundle_field appName)"
STORE_CATALOG="$(bundle_field storeCatalog)"
STORE_PREFIX="$(bundle_field storeSchemaPrefix)"
EIR_CATALOG="$(bundle_field eirCatalog)"
EIR_SCHEMA="$(bundle_field eirSchema)"
EIR_VOLUME="$(bundle_field eirVolume)"
# The EDP admin group holds the Safeguards validator role in the MVP (#226).
VALIDATOR_GROUP="$(bundle_field adminGroupId)"
WAREHOUSE_ID="$(bundle_field warehouseId)"
MEMBERSHIP_CATALOG="$(bundle_field membershipCatalog)"
MEMBERSHIP_SCHEMA="$(bundle_field membershipSchema)"
# The store schemas the provision_store job creates, parsed from the DDL files it
# runs (so a new area's resources/store-<area>.sql is granted with no edit here).
STORE_SCHEMAS="$(printf '%s' "$CONFIG_JSON" | node scripts/bundle-config.ts --schemas)"

# Sanity guard: a field-shift would leave a required field empty or put a
# non-warehouse value in WAREHOUSE_ID. (STORE_PREFIX is legitimately empty.)
if [[ -z "$APP_NAME" || -z "$STORE_CATALOG" || -z "$EIR_CATALOG" || -z "$EIR_SCHEMA" || -z "$EIR_VOLUME" || -z "$MEMBERSHIP_CATALOG" || -z "$MEMBERSHIP_SCHEMA" ]] ||
  [[ ! "$WAREHOUSE_ID" =~ ^[0-9a-f]{16}$ ]]; then
  echo "deploy-turnkey: resolved-config field extraction looks wrong (app=${APP_NAME} store=${STORE_CATALOG} eir=${EIR_CATALOG}/${EIR_SCHEMA}/${EIR_VOLUME} membership=${MEMBERSHIP_CATALOG}/${MEMBERSHIP_SCHEMA} warehouse=${WAREHOUSE_ID})." >&2
  exit 1
fi
echo "    resolved config is valid (store/EIR catalog = ${STORE_CATALOG}; prefix = '${STORE_PREFIX}'; no value-less env)."
echo "    store schemas from the DDL: ${STORE_SCHEMAS}"

echo "==> [3/7] plan gate, build + deploy (scripts/deploy.sh)"
# scripts/deploy.sh runs the PLAN GATE first: `bundle plan -o json` piped to
# `bundle-config.ts --check-plan`, which fails if any UC schema or volume would
# be deleted or recreated (#141: signed EIR records and PDFs must survive any
# deploy). prevent_destroy on the prod EIR schema/volume blocks destroy/recreate
# of a declared resource; the gate also catches one whose block was removed
# from databricks.yml (the plan says "delete" and no lifecycle is left to stop
# it). Only after it passes does deploy.sh build with the target's
# data_backend, stage the build into databricks-app/ (the app's source; the app
# compute installs nothing), `bundle deploy --auto-approve` and `bundle run`,
# which starts the app on the new build. The gate lives there, next to the
# --auto-approve, so no caller can skip it.
# The marker deploy.sh requires: it refuses to run unless this wrapper calls it.
EDP_DEPLOY_VIA_TURNKEY=1 scripts/deploy.sh "${DEPLOY_ARGS[@]}"

echo "==> [4/8] bundle run provision_store (store schemas + tables, idempotent)"
databricks bundle run provision_store "${PASSTHROUGH[@]}"

echo "==> [5/8] bundle run provision_membership_snapshot (membership tables, idempotent)"
databricks bundle run provision_membership_snapshot "${PASSTHROUGH[@]}"

echo "==> [6/8] EIR schema + volume (CREATE IF NOT EXISTS, idempotent)"
# For prod these are also bundle-managed (with lifecycle.prevent_destroy, so
# `bundle destroy` refuses to drop them); the IF NOT EXISTS here is a no-op there and the real create for preview/dev,
# where mode:development would rewrite a bundle-managed UC name.
run_sql "CREATE SCHEMA IF NOT EXISTS \`${EIR_CATALOG}\`.\`${EIR_SCHEMA}\`"
run_sql "CREATE VOLUME IF NOT EXISTS \`${EIR_CATALOG}\`.\`${EIR_SCHEMA}\`.\`${EIR_VOLUME}\`"

if [[ "$APPLY_GRANTS" -eq 1 ]]; then
  echo "==> [7/8] UC grants (validator group + app service principal)"

  # Validator group: no direct grant by default — validators read PDFs through
  # the app, which checks membership server-side. --grant-validator-volume-read
  # adds USE CATALOG + USE SCHEMA + READ VOLUME on the EIR volume only, to the
  # account-group DISPLAY NAME resolved from the configured SCIM id (fails loud
  # if unresolvable). Never SELECT on the EIR tables.
  if [[ "$GRANT_VALIDATOR_VOLUME" -eq 1 ]]; then
    if [[ -z "$VALIDATOR_GROUP" ]]; then
      echo "deploy-turnkey: --grant-validator-volume-read needs edp_admin_group_id (the group that holds the Safeguards validator role)." >&2
      exit 1
    fi
    VALIDATOR_NAME="$(resolve_group_name "$VALIDATOR_GROUP")" || exit 1
    assert_narrow_principal "$VALIDATOR_NAME" || exit 1
    run_sql "GRANT USE CATALOG ON CATALOG \`${EIR_CATALOG}\` TO \`${VALIDATOR_NAME}\`"
    run_sql "GRANT USE SCHEMA ON SCHEMA \`${EIR_CATALOG}\`.\`${EIR_SCHEMA}\` TO \`${VALIDATOR_NAME}\`"
    run_sql "GRANT READ VOLUME ON VOLUME \`${EIR_CATALOG}\`.\`${EIR_SCHEMA}\`.\`${EIR_VOLUME}\` TO \`${VALIDATOR_NAME}\`"
  else
    echo "    note: no direct validator grant on the EIR volume (pass --grant-validator-volume-read to add one)." >&2
  fi

  # App service principal: resolve from the deployed app (its id is not known at
  # bundle-config time). A missing SP is a hard failure, not a warning.
  SP_CLIENT_ID="$(databricks apps get "$APP_NAME" "${PROFILE_ARG[@]}" -o json | python3 -I -c '
import json, sys
print(json.load(sys.stdin).get("service_principal_client_id", ""))')"
  if [[ -z "$SP_CLIENT_ID" ]]; then
    echo "deploy-turnkey: could not resolve the app service principal for '${APP_NAME}'; cannot apply its grants." >&2
    exit 1
  fi
  run_sql "GRANT USE CATALOG ON CATALOG \`${STORE_CATALOG}\` TO \`${SP_CLIENT_ID}\`"
  run_sql "GRANT USE CATALOG ON CATALOG \`${EIR_CATALOG}\` TO \`${SP_CLIENT_ID}\`"
  run_sql "GRANT USE SCHEMA ON SCHEMA \`${EIR_CATALOG}\`.\`${EIR_SCHEMA}\` TO \`${SP_CLIENT_ID}\`"
  run_sql "GRANT READ VOLUME, WRITE VOLUME ON VOLUME \`${EIR_CATALOG}\`.\`${EIR_SCHEMA}\`.\`${EIR_VOLUME}\` TO \`${SP_CLIENT_ID}\`"
  # Only the schemas this app's own DDL creates (STORE_SCHEMAS, derived above;
  # each is a validated plain identifier, so word-splitting is safe). One app SP
  # today; see GRANT BOUNDARY above for the ADR-0008 limitation.
  for schema in $STORE_SCHEMAS; do
    run_sql "GRANT USE SCHEMA, SELECT, MODIFY ON SCHEMA \`${STORE_CATALOG}\`.\`${STORE_PREFIX}${schema}\` TO \`${SP_CLIENT_ID}\`"
  done
  # Membership is provisioned separately above. Keep these SELECT-only grants
  # last so a membership-specific failure cannot prevent the app's EIR/store
  # grants from being applied on a fresh target.
  run_sql "GRANT USE CATALOG ON CATALOG \`${MEMBERSHIP_CATALOG}\` TO \`${SP_CLIENT_ID}\`"
  run_sql "GRANT USE SCHEMA ON SCHEMA \`${MEMBERSHIP_CATALOG}\`.\`${MEMBERSHIP_SCHEMA}\` TO \`${SP_CLIENT_ID}\`"
  run_sql "GRANT SELECT ON TABLE \`${MEMBERSHIP_CATALOG}\`.\`${MEMBERSHIP_SCHEMA}\`.\`group_members\` TO \`${SP_CLIENT_ID}\`"
  run_sql "GRANT SELECT ON TABLE \`${MEMBERSHIP_CATALOG}\`.\`${MEMBERSHIP_SCHEMA}\`.\`snapshot_runs\` TO \`${SP_CLIENT_ID}\`"
else
  echo "==> [7/8] skipping UC grants (--skip-grants)"
fi

echo "==> [8/8] done. App URL:"
databricks apps get "$APP_NAME" "${PROFILE_ARG[@]}" -o json | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("url","(not available)"))'
