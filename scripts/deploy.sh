#!/usr/bin/env bash
# INTERNAL: the build-and-ship step of scripts/deploy-turnkey.sh, the one
# operator entry point. Operators never run this directly: the wrapper runs the
# preflight and the resolved-config gate first, and provisions the store and
# applies the grants after. It exports EDP_DEPLOY_VIA_TURNKEY=1 before calling
# this script, which refuses to run without it. The wrapper calls it as:
#
#   scripts/deploy.sh -t <target> --var app_name=<name> [-p <profile>] [--var ...]
#   scripts/deploy.sh -t prod --production [-p <profile>] [--var ...]
#
# It accepts only the arguments in usage() below and passes them unchanged to
# `bundle validate`, `bundle deploy` and `bundle run`. Its production rules
# apply to the target and app name that `bundle validate` resolves, so a
# target form or env var the argument check misses can't reach production.
#
# The app compute installs nothing (databricks-app/app.yaml explains why), so
# this script builds here and ships the result:
#   1. `bundle validate` resolves the target's variables, as deploy will.
#   2. `bundle plan` must not drop a Unity Catalog schema or volume, since the
#      deploy below is auto-approved (#141).
#   3. `npm run build:databricks` with that target's VITE_DATA_BACKEND.
#   4. Stage .output/ into databricks-app/, the app's source.
#   5. `bundle deploy`, then `bundle run` to restart the app on the new build.
#
# Run `npm ci` first; the build uses this checkout's node_modules.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_DIR=databricks-app
PROD_TARGET=prod
PROD_APP_NAME=edp-vending-machine
MIN_NODE_MAJOR=24
# Databricks Apps reject any app source file over 10 MB.
MAX_FILE_BYTES=10485760
ALLOWED_APP_ROOT_ENTRIES=(app.yaml serve.mjs server public build-info.json)

usage() {
  cat >&2 <<EOF
Usage: scripts/deploy.sh -t <target> --var app_name=<name> [-p <profile>] [--var key=value ...]
       scripts/deploy.sh -t $PROD_TARGET --production [-p <profile>] [--var key=value ...]

  -t, --target   Required, exactly once: -t X, -tX, -t=X, --target X or --target=X.
  --var app_name Required on every target but $PROD_TARGET, and never $PROD_APP_NAME
                 there. A PR preview is edp-vm-pr<N>.
  --production   Required to deploy the $PROD_TARGET target, or any target in
                 production mode (or set EDP_DEPLOY_PRODUCTION=yes). Not passed
                 on to the CLI.
  -p, --profile  The ~/.databrickscfg profile.
  --var, --debug Passed on to the CLI.

Nothing else is accepted: not --auto-approve (the script adds it to the deploy
step), -e/--environment, --, other flags or positional arguments. Unset
DATABRICKS_BUNDLE_TARGET, DATABRICKS_BUNDLE_ENV and DATABRICKS_BUNDLE_ROOT.
Internal: only scripts/deploy-turnkey.sh runs this. See docs/databricks-app.md.
EOF
}

refuse() {
  echo "[deploy] $*" >&2
  echo >&2
  usage
  exit 2
}

# Not a second entry point: run directly, this would skip the preflight, the
# resolved-config gate, provisioning and the grants.
if [ "${EDP_DEPLOY_VIA_TURNKEY:-}" != 1 ]; then
  echo "[deploy] scripts/deploy.sh is internal to scripts/deploy-turnkey.sh. Deploy with scripts/deploy-turnkey.sh (docs/databricks-app.md)." >&2
  exit 2
fi

# The CLI also picks a target, or another bundle, from these. -t overrides the
# first two, but nothing except the arguments should choose.
for name in DATABRICKS_BUNDLE_TARGET DATABRICKS_BUNDLE_ENV DATABRICKS_BUNDLE_ROOT; do
  [ -z "${!name:-}" ] || refuse "Unset $name; pass the target with -t."
done

# Accept only the arguments usage() lists, and fail closed on anything else:
# the CLI takes more target forms (-tX, the hidden -e/--environment aliases,
# short-flag clusters like -qtX on deploy) than a pattern list can safely
# cover. --production is taken out; the rest goes to the CLI unchanged.
targets=()
app_names=()
production=no
args=()
argv=("$@")
i=0
while [ "$i" -lt "${#argv[@]}" ]; do
  arg=${argv[$i]}
  i=$((i + 1))
  case "$arg" in
    --production)
      production=yes
      continue
      ;;
    --debug)
      args+=("$arg")
      continue
      ;;
    --auto-approve | --auto-approve=*)
      refuse "Don't pass --auto-approve; the script adds it to the deploy step."
      ;;
    -t | --target | -p | --profile | --var)
      [ "$i" -lt "${#argv[@]}" ] || refuse "$arg needs a value."
      value=${argv[$i]}
      i=$((i + 1))
      args+=("$arg" "$value")
      ;;
    -t=* | --target=* | -p=* | --profile=* | --var=*)
      value=${arg#*=}
      args+=("$arg")
      ;;
    -t?* | -p?*)
      value=${arg#-?}
      args+=("$arg")
      ;;
    *) refuse "Unsupported argument: $arg" ;;
  esac
  [ -n "$value" ] && [[ $value != -* ]] || refuse "$arg needs a value, not '$value'."
  case "$arg" in
    -t | --target | -t=* | --target=* | -t?*) targets+=("$value") ;;
    --var | --var=*)
      if [[ $value == app_name=* ]]; then
        app_names+=("${value#app_name=}")
      fi
      ;;
  esac
done
[ "${EDP_DEPLOY_PRODUCTION:-}" = yes ] && production=yes

[ "${#targets[@]}" -gt 0 ] || refuse "Pass an explicit target with -t <target>."
[ "${#targets[@]}" -eq 1 ] ||
  refuse "Pass exactly one target; got ${#targets[@]}: ${targets[*]}."
target=${targets[0]}
needs_ack() {
  [ "$production" = yes ] ||
    refuse "$1 needs a deliberate acknowledgement: pass --production or set EDP_DEPLOY_PRODUCTION=yes."
}
if [ "$target" = "$PROD_TARGET" ]; then
  needs_ack "Deploying the $PROD_TARGET target"
else
  [ "${#app_names[@]}" -gt 0 ] ||
    refuse "The $target target needs an explicit --var app_name=<name> (edp-vm-pr<N> for a PR preview)."
  for name in "${app_names[@]}"; do
    [ "$name" != "$PROD_APP_NAME" ] ||
      refuse "$PROD_APP_NAME is the production app name; the $target target can't use it."
  done
fi

node_version=$(node --version)
node_major=${node_version#v}
node_major=${node_major%%.*}
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  echo "[deploy] Build with Node >=$MIN_NODE_MAJOR (package.json engines); this is $node_version." >&2
  exit 1
fi

bundle_json=$(databricks bundle validate "${args[@]}" -o json)
read_bundle() {
  printf '%s' "$bundle_json" | node -e '
    let json = "";
    process.stdin.on("data", (chunk) => (json += chunk));
    process.stdin.on("end", () => {
      const bundle = JSON.parse(json);
      const value = {
        target: bundle.bundle?.target ?? "",
        mode: bundle.bundle?.mode ?? "",
        host: bundle.workspace?.host ?? "",
        data_backend: bundle.variables?.data_backend?.value || "memory",
        app_name: bundle.resources?.apps?.edp_vending_machine?.name ?? "",
      }[process.argv[1]];
      process.stdout.write(value);
    });
  ' "$1"
}
# Apply the rules again to what the CLI resolved, which is what deploy and run
# will use: the same arguments, the same env.
resolved_target=$(read_bundle target)
resolved_mode=$(read_bundle mode)
resolved_app_name=$(read_bundle app_name)
resolved_host=$(read_bundle host)
[ "$resolved_target" = "$target" ] ||
  refuse "bundle validate resolved target $resolved_target, but the arguments name $target."
if [ "$resolved_target" = "$PROD_TARGET" ] || [ "$resolved_mode" = production ]; then
  needs_ack "The $resolved_target target is in production mode; deploying it"
elif [ "$resolved_app_name" = "$PROD_APP_NAME" ]; then
  # A target default or BUNDLE_VAR_app_name the argument check can't see.
  refuse "The $target target resolves app_name to $PROD_APP_NAME, the production app name."
fi
data_backend=$(read_bundle data_backend)

# The deploy is auto-approved, so the CLI won't stop at its destructive-action
# prompt. Refuse a plan that deletes or recreates a schema or volume instead:
# signed EIR records and PDFs must survive any deploy (#141).
databricks bundle plan "${args[@]}" -o json | node scripts/bundle-config.ts --check-plan

# The commit being built, marked -dirty if the checkout differs from it.
if commit=$(git rev-parse --short HEAD 2>/dev/null); then
  [ -z "$(git status --porcelain)" ] || commit="$commit-dirty"
else
  commit=unknown
fi

# Clear the previous artifact first, so a failed build leaves nothing to ship.
rm -rf "$APP_DIR/server" "$APP_DIR/public" "$APP_DIR/build-info.json"

echo "[deploy] building $resolved_app_name (target $resolved_target, ${resolved_mode:-unknown} mode, ${resolved_host:-profile host}) with VITE_DATA_BACKEND=$data_backend"
VITE_DATA_BACKEND="$data_backend" npm run build:databricks

cp -R .output/server "$APP_DIR/server"
cp -R .output/public "$APP_DIR/public"
DATA_BACKEND="$data_backend" COMMIT="$commit" node -e '
  const info = {
    dataBackend: process.env.DATA_BACKEND,
    commit: process.env.COMMIT,
    builtAt: new Date().toISOString(),
  };
  require("node:fs").writeFileSync(process.argv[1], JSON.stringify(info, null, 2) + "\n");
' "$APP_DIR/build-info.json"

too_big=$(find "$APP_DIR" -type f -size +"${MAX_FILE_BYTES}"c)
if [ -n "$too_big" ]; then
  echo "[deploy] Databricks Apps reject files over 10 MB: $too_big" >&2
  exit 1
fi

unexpected_root_entries=()
while IFS= read -r -d '' path; do
  entry=${path#"$APP_DIR"/}
  allowed=no
  for allowed_entry in "${ALLOWED_APP_ROOT_ENTRIES[@]}"; do
    if [ "$entry" = "$allowed_entry" ]; then
      allowed=yes
      break
    fi
  done
  [ "$allowed" = yes ] || unexpected_root_entries+=("$entry")
done < <(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print0 | sort -z)
if [ "${#unexpected_root_entries[@]}" -gt 0 ]; then
  echo "[deploy] Refusing to deploy unexpected file(s) in $APP_DIR/." >&2
  echo "[deploy] Allowed root entries are: app.yaml, serve.mjs, build-info.json, server/ and public/." >&2
  echo "[deploy] Remove or move these stale files; deploy does not delete user files:" >&2
  for entry in "${unexpected_root_entries[@]}"; do
    echo "[deploy] - $APP_DIR/$entry" >&2
  done
  exit 1
fi
echo "[deploy] staged $(find "$APP_DIR" -type f | wc -l) files, $(du -sh "$APP_DIR" | cut -f1), commit $commit"

databricks bundle deploy "${args[@]}" --auto-approve
databricks bundle run edp_vending_machine "${args[@]}"
