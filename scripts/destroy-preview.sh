#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/destroy-preview.sh <positive-integer PR number> [options]

Run from inside a checkout containing databricks.yml.

Options:
  -p <profile>              Databricks CLI profile (default: example-workspace)
  --catalog <catalog>       Unity Catalog catalog (default: example_catalog)
  --sql-warehouse-id <id>   SQL warehouse id (default: 1111111111111111)
  --dry-run                 Print the teardown plan without deleting anything
  --local                   Also remove the PR worktree and branch, if safe and clean
EOF
}
die_usage() { echo "destroy-preview: $1" >&2; usage >&2; exit 2; }

[[ $# -gt 0 ]] || die_usage "a positive-integer PR number is required."
PR_NUMBER="$1"; shift
case "$PR_NUMBER" in
  edp-vending-machine | edp-vm-preview-unset) die_usage "refusing protected app name '$PR_NUMBER'." ;;
esac
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || die_usage "'$PR_NUMBER' is not a positive-integer PR number."

PROFILE="example-workspace"; CATALOG="example_catalog"; WAREHOUSE_ID="1111111111111111"
DRY_RUN=0; REMOVE_LOCAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) [[ $# -ge 2 && -n "$2" ]] || die_usage "-p needs a profile."; PROFILE="$2"; shift 2 ;;
    --catalog) [[ $# -ge 2 && -n "$2" ]] || die_usage "--catalog needs a catalog."; CATALOG="$2"; shift 2 ;;
    --sql-warehouse-id) [[ $# -ge 2 && -n "$2" ]] || die_usage "--sql-warehouse-id needs an id."; WAREHOUSE_ID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --local) REMOVE_LOCAL=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "unknown argument '$1'." ;;
  esac
done
[[ "$CATALOG" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die_usage "catalog must be a single safe SQL identifier."
[[ "$WAREHOUSE_ID" =~ ^[A-Za-z0-9_-]+$ ]] || die_usage "warehouse id contains unsafe characters."

APP_NAME="edp-vm-pr${PR_NUMBER}"; SCHEMA_PREFIX="edp_vm_pr${PR_NUMBER}_"; VOLUME_NAME="eir_pr${PR_NUMBER}"
PROFILE_ARG=(-p "$PROFILE"); SQL_RESPONSE=""; SQL_ERROR=""
BUNDLE_ARGS=("${PROFILE_ARG[@]}" -t preview --var "app_name=${APP_NAME}" --var "catalog=${CATALOG}" --var "sql_warehouse_id=${WAREHOUSE_ID}")

# These are the only shared schema names this command explicitly protects.
refuse_shared_schema() {
  case "$1" in
    edp_vm_preview | membership | demo)
      echo "destroy-preview: refusing shared schema '$1'." >&2; return 0 ;;
  esac
  return 1
}

run_sql() {
  local statement="$1" payload resp state statement_id attempt
  SQL_ERROR=""
  payload="$(STMT="$statement" WID="$WAREHOUSE_ID" python3 -I -c '
import json, os
print(json.dumps({"warehouse_id":os.environ["WID"],"statement":os.environ["STMT"],"wait_timeout":"30s","on_wait_timeout":"CONTINUE"}))')"
  if ! resp="$(databricks api post /api/2.0/sql/statements "${PROFILE_ARG[@]}" --json "$payload" 2>&1)"; then
    SQL_ERROR="$resp"; echo "destroy-preview: SQL submission failed: $statement" >&2; echo "$resp" >&2; return 1
  fi
  state="$(printf '%s' "$resp" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("state",""))')"
  statement_id="$(printf '%s' "$resp" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("statement_id",""))')"
  attempt=0
  while [[ "$state" == PENDING || "$state" == RUNNING ]]; do
    attempt=$((attempt+1)); [[ "$attempt" -le 20 ]] || { echo "destroy-preview: SQL timed out: $statement" >&2; return 1; }
    sleep 3
    if ! resp="$(databricks api get "/api/2.0/sql/statements/${statement_id}" "${PROFILE_ARG[@]}" 2>&1)"; then SQL_ERROR="$resp"; echo "$resp" >&2; return 1; fi
    state="$(printf '%s' "$resp" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("state",""))')"
  done
  if [[ "$state" != SUCCEEDED ]]; then
    SQL_ERROR="$(printf '%s' "$resp" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("error",{}).get("message",""))' 2>/dev/null || true)"
    echo "destroy-preview: SQL did not SUCCEED (state=${state:-unknown}): $statement" >&2
    [[ -n "$SQL_ERROR" ]] && echo "  $SQL_ERROR" >&2
    return 1
  fi
  SQL_RESPONSE="$resp"
}

result_column() {
  local column="$1"
  COLUMN="$column" python3 -I -c '
import json, os, sys
doc=json.load(sys.stdin); cols=doc.get("manifest",{}).get("schema",{}).get("columns",[])
names=[c.get("name") for c in cols]
if os.environ["COLUMN"] not in names: raise SystemExit("missing result column " + os.environ["COLUMN"])
i=names.index(os.environ["COLUMN"])
for row in doc.get("result",{}).get("data_array",[]) or []:
    if len(row)>i and row[i] is not None: print(row[i])' <<<"$SQL_RESPONSE"
}

list_leftovers() {
  local name lower prefix_lower
  ALL_PR_SCHEMAS=(); DROPPABLE_SCHEMAS=(); VOLUMES=(); ALL_PR_VOLUMES=()
  run_sql "SHOW SCHEMAS IN \`${CATALOG}\` LIKE '${SCHEMA_PREFIX}*'" || return 1
  prefix_lower="${SCHEMA_PREFIX,,}"
  while IFS= read -r name; do
    if refuse_shared_schema "$name"; then continue; fi
    lower="${name,,}"
    [[ "$lower" == "$prefix_lower"* ]] || continue
    ALL_PR_SCHEMAS+=("$name")
    [[ "$name" =~ ^${SCHEMA_PREFIX}[A-Za-z0-9_]+$ ]] && DROPPABLE_SCHEMAS+=("$name")
  done < <(result_column databaseName)
  if ! run_sql "SHOW VOLUMES IN \`${CATALOG}\`.\`edp_vm_preview\` LIKE '${VOLUME_NAME}'"; then
    if [[ "$SQL_ERROR" == *SCHEMA_NOT_FOUND* && "$SQL_ERROR" == *edp_vm_preview* ]]; then return 0; fi
    return 1
  fi
  while IFS= read -r name; do
    [[ "${name,,}" == "${VOLUME_NAME,,}" ]] || continue
    ALL_PR_VOLUMES+=("$name")
    [[ "$name" == "$VOLUME_NAME" ]] && VOLUMES+=("$name")
  done < <(result_column volume_name)
  return 0
}

app_state() {
  local error_file output rc
  error_file="$(mktemp)"
  if output="$(databricks apps get "$APP_NAME" "${PROFILE_ARG[@]}" -o json 2>"$error_file")"; then
    rm -f "$error_file"; return 0
  else
    rc=$?
  fi
  output="$(<"$error_file")"; rm -f "$error_file"
  if [[ "$output" == *"${APP_NAME}"* && ( "$output" == *"does not exist or is deleted"* || "$output" == *RESOURCE_DOES_NOT_EXIST* ) ]]; then return 3; fi
  echo "destroy-preview: apps get failed: $output" >&2; return 2
}

resolved="$(databricks bundle validate "${BUNDLE_ARGS[@]}" -o json)" || { echo "destroy-preview: bundle validate failed; run inside the intended checkout." >&2; exit 1; }
BUNDLE_ROOT="$(printf '%s' "$resolved" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("workspace",{}).get("root_path",""))')"
mapfile -t JOB_NAMES < <(printf '%s' "$resolved" | python3 -I -c '
import json,sys
for job in json.load(sys.stdin).get("resources",{}).get("jobs",{}).values():
    if job.get("name"): print(job["name"])')
[[ -n "$BUNDLE_ROOT" && ${#JOB_NAMES[@]} -gt 0 ]] || { echo "destroy-preview: bundle validate did not resolve its root and jobs." >&2; exit 1; }

app_exists=0
if app_state; then app_exists=1; else rc=$?; [[ "$rc" -eq 3 ]] || exit "$rc"; fi
list_leftovers || exit 1
initial_owned=$((app_exists + ${#ALL_PR_SCHEMAS[@]} + ${#ALL_PR_VOLUMES[@]}))
initial_jobs_json="$(databricks jobs list "${PROFILE_ARG[@]}" -o json)" || { echo "destroy-preview: initial jobs check failed." >&2; exit 1; }
initial_jobs="$(JOBS="$(printf '%s\n' "${JOB_NAMES[@]}")" python3 -I -c '
import json,os,sys
wanted=set(os.environ["JOBS"].splitlines()); doc=json.load(sys.stdin); jobs=(doc if isinstance(doc,list) else doc.get("jobs",[])) or []
for job in jobs:
    name=job.get("settings",{}).get("name",job.get("name",""))
    if name in wanted: print(name)' <<<"$initial_jobs_json")"
initial_folder=0
databricks workspace get-status "$BUNDLE_ROOT" "${PROFILE_ARG[@]}" >/dev/null 2>&1 && initial_folder=1
[[ -n "$initial_jobs" ]] && initial_owned=$((initial_owned + 1))
initial_owned=$((initial_owned + initial_folder))

echo "Preview teardown plan for ${APP_NAME}:"
[[ "$app_exists" -eq 1 ]] && echo "  app: ${APP_NAME}"
echo "  bundle root: ${BUNDLE_ROOT}"
for name in "${JOB_NAMES[@]}"; do echo "  bundle job: ${name}"; done
for name in "${ALL_PR_SCHEMAS[@]}"; do echo "  schema: ${CATALOG}.${name}"; done
for name in "${ALL_PR_VOLUMES[@]}"; do echo "  volume: ${CATALOG}.edp_vm_preview.${name}"; done
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: no resources will be deleted."
  [[ "$app_exists" -eq 1 ]] && echo "  databricks apps stop ${APP_NAME} -p ${PROFILE}"
  echo "  databricks bundle destroy -p ${PROFILE} -t preview --var app_name=${APP_NAME} --var catalog=${CATALOG} --var sql_warehouse_id=${WAREHOUSE_ID} --auto-approve"
  for name in "${DROPPABLE_SCHEMAS[@]}"; do echo "  DROP SCHEMA \`${CATALOG}\`.\`${name}\` CASCADE"; done
  for name in "${VOLUMES[@]}"; do echo "  DROP VOLUME \`${CATALOG}\`.\`edp_vm_preview\`.\`${name}\`"; done
  [[ "$REMOVE_LOCAL" -eq 1 ]] && echo "  remove PR ${PR_NUMBER}'s safe, clean local worktree and branch"
  exit 0
fi

if [[ "$app_exists" -eq 1 ]]; then databricks apps stop "$APP_NAME" "${PROFILE_ARG[@]}" || { echo "destroy-preview: app stop failed." >&2; exit 1; }; fi
databricks bundle destroy "${BUNDLE_ARGS[@]}" --auto-approve || { echo "destroy-preview: bundle destroy failed." >&2; exit 1; }

drop_failed=0; removed=()
for name in "${DROPPABLE_SCHEMAS[@]}"; do
  if run_sql "DROP SCHEMA \`${CATALOG}\`.\`${name}\` CASCADE"; then removed+=("schema ${CATALOG}.${name}"); else drop_failed=1; fi
done
for name in "${VOLUMES[@]}"; do
  if run_sql "DROP VOLUME \`${CATALOG}\`.\`edp_vm_preview\`.\`${name}\`"; then removed+=("volume ${CATALOG}.edp_vm_preview.${name}"); else drop_failed=1; fi
done

list_leftovers || exit 1
app_remains=1
for attempt in {1..20}; do
  if app_state; then :; else rc=$?; if [[ "$rc" -eq 3 ]]; then app_remains=0; break; else exit "$rc"; fi; fi
  [[ "$attempt" -lt 20 ]] && sleep 3
done
jobs_json="$(databricks jobs list "${PROFILE_ARG[@]}" -o json)" || { echo "destroy-preview: jobs re-check failed." >&2; exit 1; }
remaining_jobs="$(JOBS="$(printf '%s\n' "${JOB_NAMES[@]}")" python3 -I -c '
import json,os,sys
wanted=set(os.environ["JOBS"].splitlines()); doc=json.load(sys.stdin); jobs=(doc if isinstance(doc,list) else doc.get("jobs",[])) or []
for job in jobs:
    name=job.get("settings",{}).get("name",job.get("name",""))
    if name in wanted: print(name)' <<<"$jobs_json")"
folder_remains=0
if databricks workspace get-status "$BUNDLE_ROOT" "${PROFILE_ARG[@]}" >/dev/null 2>&1; then folder_remains=1; else
  folder_error="$(databricks workspace get-status "$BUNDLE_ROOT" "${PROFILE_ARG[@]}" 2>&1 || true)"
  [[ "$folder_error" == *RESOURCE_DOES_NOT_EXIST* || "$folder_error" == *"does not exist"* || "$folder_error" == *"doesn't exist"* ]] || { echo "destroy-preview: bundle-folder re-check failed: $folder_error" >&2; exit 1; }
fi
if [[ "$drop_failed" -ne 0 || "$app_remains" -ne 0 || ${#ALL_PR_SCHEMAS[@]} -ne 0 || ${#ALL_PR_VOLUMES[@]} -ne 0 || -n "$remaining_jobs" || "$folder_remains" -ne 0 ]]; then
  echo "destroy-preview: teardown incomplete; PR ${PR_NUMBER} resources remain." >&2
  for name in "${ALL_PR_SCHEMAS[@]}"; do echo "  remaining schema: ${CATALOG}.${name}" >&2; done
  for name in "${ALL_PR_VOLUMES[@]}"; do echo "  remaining volume: ${CATALOG}.edp_vm_preview.${name}" >&2; done
  [[ -n "$remaining_jobs" ]] && while IFS= read -r name; do echo "  remaining job: $name" >&2; done <<<"$remaining_jobs"
  [[ "$folder_remains" -ne 0 ]] && echo "  remaining bundle folder: ${BUNDLE_ROOT}" >&2
  exit 1
fi

if [[ "$initial_owned" -eq 0 && ${#removed[@]} -eq 0 ]]; then echo "${APP_NAME}: nothing to do"; else
  echo "Removed:"; echo "  app/bundle resources (if present)"; for item in "${removed[@]}"; do echo "  $item"; done
fi

if [[ "$REMOVE_LOCAL" -eq 1 ]]; then
  command -v gh >/dev/null || { echo "destroy-preview: --local requires gh." >&2; exit 1; }
  branch="$(gh pr view "$PR_NUMBER" --json headRefName --jq .headRefName)" || exit 1
  current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  default_ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"; default_branch="${default_ref#origin/}"
  current_worktree="$(git rev-parse --show-toplevel)" || exit 1
  [[ "$branch" != main && "$branch" != "$default_branch" && "$branch" != "$current_branch" ]] || { echo "destroy-preview: refusing protected/current branch '$branch'." >&2; exit 1; }
  [[ -n "$(git branch --merged HEAD --list "$branch")" ]] || { echo "destroy-preview: refusing unmerged branch '$branch'." >&2; exit 1; }
  worktree=""
  while IFS=' ' read -r key value; do
    [[ "$key" == worktree ]] && candidate="$value"
    if [[ "$key" == branch && "$value" == "refs/heads/${branch}" ]]; then worktree="$candidate"; break; fi
  done < <(git worktree list --porcelain)
  [[ -z "$worktree" || "$worktree" != "$current_worktree" ]] || { echo "destroy-preview: refusing current worktree ${worktree}." >&2; exit 1; }
  if [[ -n "$worktree" ]]; then
    [[ -z "$(git -C "$worktree" status --porcelain)" ]] || { echo "destroy-preview: refusing to remove dirty worktree ${worktree}." >&2; exit 1; }
    git worktree remove "$worktree" || exit 1
  fi
  git show-ref --verify --quiet "refs/heads/${branch}" && git branch -d "$branch"
fi
