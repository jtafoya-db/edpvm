# Public release process

The first public release was a history-free snapshot. Later releases preserve
that public history: each publication applies one reviewed, sanitized source
delta on top of public `main` and creates one ordinary public commit. Never
replace the root commit or force-push `main`.

Start from a committed private ref. Apply only that commit's delta to a branch
from current public `main`; do not copy whole files when the private source has
unpublished intervening changes. Adapt rejected hunks explicitly to the public
tree and replace internal workspace names, IDs, hosts, users and account data
with the repository's existing example values. Review the complete staged diff
and update `PUBLICATION-MANIFEST.md` with the exact private source commit. Run
`node scripts/public-sanitize.mjs --apply .` after applying the private delta;
the sanitizer removes the manifest's exact private-only path inventory,
applies the established substitutions, and replaces links to excluded documents
with explicit non-link text.

Before publishing, verify the source commit in `PUBLICATION-MANIFEST.md`, run
the repository's deterministic gates, and require this additional gate:

```bash
npm audit --audit-level=high
```

Also run `scripts/public-audit.sh` and Gitleaks against the candidate commit.
The audit runs `node scripts/public-sanitize.mjs --check .` to reject excluded
paths and dangling relative Markdown links.
The publication commit must contain only the reviewed source delta, required
public sanitization adaptations, and publication metadata.

Repository creation, remote configuration, visibility changes, and release
tags remain explicit human actions.
