#!/usr/bin/env bash
# Post-deploy smoke for a deployed EDP Vending Machine app. scripts/deploy-turnkey.sh
# runs it after a full deploy; run it by hand to re-check or diagnose an app:
#
#   scripts/post-deploy-smoke.sh <app-name> [-p <profile>]
#
# It fails, printing what failed and the next diagnostic command, unless:
#   1. `apps get` reports the active deployment SUCCEEDED, with an app URL;
#   2. the deployment's env_vars (`apps get-deployment`) OR the app.yaml in the
#      deployment's workspace source sets VITE_DATA_BACKEND and EDP_CLIENT_MINIFIED;
#   3. an authenticated GET of <app-url>/api/seed-config returns 200 (Bearer
#      token from `databricks auth token`; it retries while the app starts).
# The decisions live in src/deploy/postDeploySmoke.ts; this only gathers inputs.
#
# Windows Git Bash: MSYS_NO_PATHCONV keeps /Workspace/... arguments intact, and
# every local path is relative to the checkout so native node/databricks read it.
# Uses curl (Git for Windows ships it), else node's fetch; EDP_SMOKE_HTTP_CLIENT=curl|node
# forces one. Either way the token goes in on stdin, never in argv or env.
set -euo pipefail

cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

APP_NAME=""
PROFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p | --profile)
      [[ $# -ge 2 ]] || {
        echo "post-deploy-smoke: $1 requires a value" >&2
        exit 2
      }
      PROFILE="$2"
      shift 2
      ;;
    -*)
      echo "post-deploy-smoke: unknown argument '$1'" >&2
      exit 2
      ;;
    *)
      [[ -z "$APP_NAME" ]] || {
        echo "post-deploy-smoke: one app name only" >&2
        exit 2
      }
      APP_NAME="$1"
      shift
      ;;
  esac
done
[[ -n "$APP_NAME" ]] || {
  echo "usage: scripts/post-deploy-smoke.sh <app-name> [-p <profile>]" >&2
  exit 2
}
PROFILE_ARG=()
[[ -n "$PROFILE" ]] && PROFILE_ARG=("-p" "$PROFILE")
ATTEMPTS="${EDP_SMOKE_ATTEMPTS:-10}"
DELAY="${EDP_SMOKE_DELAY_SECONDS:-6}"

WORK=.output/post-deploy-smoke
rm -rf "$WORK"
mkdir -p "$WORK"
read_field() { node scripts/post-deploy-smoke.ts --read "$1" <"$2"; }

if ! databricks apps get "$APP_NAME" "${PROFILE_ARG[@]}" -o json >"$WORK/app.json" 2>"$WORK/apps-get.err"; then
  echo "[smoke] databricks apps get $APP_NAME failed: $(tr -d '\r' <"$WORK/apps-get.err")" >&2
fi
URL="$(read_field app-url "$WORK/app.json")"
DEPLOYMENT_ID="$(read_field deployment-id "$WORK/app.json")"
SOURCE_PATH="$(read_field source-path "$WORK/app.json")"

if [[ -n "$DEPLOYMENT_ID" ]]; then
  databricks apps get-deployment "$APP_NAME" "$DEPLOYMENT_ID" "${PROFILE_ARG[@]}" -o json \
    >"$WORK/deployment.json" 2>/dev/null || rm -f "$WORK/deployment.json"
fi
if [[ -n "$SOURCE_PATH" ]]; then
  databricks workspace export "$SOURCE_PATH/app.yaml" --format AUTO --file "$WORK/app.yaml" \
    "${PROFILE_ARG[@]}" >/dev/null 2>&1 || rm -f "$WORK/app.yaml"
fi

if [[ -n "$URL" ]]; then
  TOKEN=""
  if TOKEN_JSON="$(databricks auth token "${PROFILE_ARG[@]}" 2>"$WORK/token.err")"; then
    TOKEN="$(printf '%s' "$TOKEN_JSON" | node scripts/post-deploy-smoke.ts --read access-token)"
  fi
  if [[ -z "$TOKEN" ]]; then
    echo "[smoke] could not get a token from 'databricks auth token${PROFILE:+ -p $PROFILE}' (U2M login only): $(tr -d '\r' <"$WORK/token.err")" >&2
  fi
  # The token reaches the HTTP client only on stdin: never argv, never env.
  CLIENT="${EDP_SMOKE_HTTP_CLIENT:-auto}"
  if [[ "$CLIENT" == auto ]]; then
    if command -v curl >/dev/null 2>&1; then CLIENT=curl; else CLIENT=node; fi
  fi
  probe() {
    : >"$WORK/body"
    if [[ "$CLIENT" == curl ]]; then
      printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
        curl -sS -o "$WORK/body" -w '%{http_code}' --max-time 30 -K - "$URL/api/seed-config" \
          2>"$WORK/curl.err" || true
    else
      printf '%s' "$TOKEN" | node -e '
        let token = "";
        process.stdin.on("data", (chunk) => (token += chunk));
        process.stdin.on("end", () =>
          fetch(process.argv[1], {
            headers: { authorization: "Bearer " + token.trim() },
            redirect: "manual",
            signal: AbortSignal.timeout(30000),
          })
            .then(async (r) => {
              require("node:fs").writeFileSync(process.argv[2], await r.text());
              process.stdout.write(String(r.status));
            })
            .catch(() => process.stdout.write("0")),
        );' "$URL/api/seed-config" "$WORK/body"
    fi
  }
  attempt=1
  while :; do
    status="$(probe | tr -d '\r')"
    status="${status:-0}"
    case "$status" in
      000 | 0 | 502 | 503 | 504) ;;
      *) break ;;
    esac
    [[ "$attempt" -lt "$ATTEMPTS" ]] || break
    echo "[smoke] /api/seed-config returned ${status}; the app may still be starting (attempt $attempt/$ATTEMPTS)." >&2
    attempt=$((attempt + 1))
    sleep "$DELAY"
  done
  printf '%s' "$((10#$status))" >"$WORK/status"
fi

APP_NAME="$APP_NAME" PROFILE="$PROFILE" node scripts/post-deploy-smoke.ts --evaluate "$WORK"
