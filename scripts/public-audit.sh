#!/usr/bin/env bash
set -euo pipefail

repo=${1:-.}
repo=$(cd "$repo" && pwd -P)

for required in LICENSE PUBLICATION.md PUBLICATION-MANIFEST.md .gitleaks.toml; do
  if [[ ! -f "$repo/$required" ]]; then
    echo "FAIL: $required is missing" >&2
    exit 1
  fi
done

forbidden_names='(^|/)(\.env($|\.)|\.databrickscfg$|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate)$|id_(rsa|dsa|ecdsa|ed25519)$)'
forbidden=()
while IFS= read -r path; do
  forbidden+=("${path#"$repo"/}")
done < <(find "$repo" -path "$repo/.git" -prune -o -type f -print | grep -E -i "$forbidden_names" || true)
if (( ${#forbidden[@]} > 0 )); then
  printf 'FAIL: forbidden credential-like files:\n' >&2
  printf '  %s\n' "${forbidden[@]}" >&2
  exit 1
fi

private_markers='Private — internal|Rob King|github\.com/jtafoya-db/edp-vending-machine|services-bureau|services_bureau_catalog|irs-gov|irs-demo|852e667acfb9b179|80729668828425|2f225c0740dcd22b|fevm-services-bureau|@irs\.gov|npm-proxy\.cloud\.databricks\.com'
if (cd "$repo" && rg -n -i "$private_markers" . \
  --glob '!.git/**' --glob '!scripts/public-audit.sh' --glob '!PUBLICATION-MANIFEST.md'); then
  echo "FAIL: private publication markers remain" >&2
  exit 1
fi

gitleaks_bin=${GITLEAKS_BIN:-gitleaks}
if ! command -v "$gitleaks_bin" >/dev/null 2>&1; then
  echo "FAIL: gitleaks is required" >&2
  exit 1
fi
"$gitleaks_bin" dir "$repo" --config "$repo/.gitleaks.toml" --no-banner --redact --exit-code 1

if [[ -d "$repo/.git" ]]; then
  test -z "$(git -C "$repo" rev-list --min-parents=2 HEAD)" || {
    echo "FAIL: public history must remain linear (merge commit found)" >&2
    exit 1
  }
fi

echo "PASS: publication audit"
