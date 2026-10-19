# Public release process

Public releases are history-free snapshots produced from a committed ref in
the private source repository. Run `scripts/public-export.sh --help` there for
the supported interface. The exporter applies the versioned exclusion and
sanitization policy, runs Gitleaks, and creates exactly one root commit.

Before publishing, verify the source commit in `PUBLICATION-MANIFEST.md`, run
the repository's deterministic gates, and require this additional gate:

```bash
npm audit --audit-level=high
```

Repository creation, remote configuration, visibility changes, and release
tags remain explicit human actions.
