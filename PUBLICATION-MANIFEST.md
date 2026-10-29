# Publication manifest

- Source ref: `origin/main`
- Source commit: `49fcad5ee6d64f03f9ddb9f1f493b6741d223a5b`
- Source commit date: `2026-10-29T10:39:41-04:00`
- Previous publication source commits: `5aebac68abf4d228c27ef082a674362b923c2e30`, `35a20f091057322cfa232c3c5580604fd404cc04`
- Included private PRs: `#277`, `#275`, `#276`, `#287`, `#270`, `#281`, `#280`, `#291`, `#292`, `#290`, `#296`, `#295`, `#302`, `#303`, `#300`, `#297`, `#328`, `#289`, `#306`, `#308`, `#310`, `#327`, `#307`, `#334`, `#309`, `#326`, `#329`, `#279`, `#331`, `#330`, `#338`, `#337`, `#333`, `#339`
- Exported at: `2026-10-29T14:43:26Z`
- Public repository: `https://github.com/jtafoya-db/edpvm`
- Export method: source delta since `70c18f737a58ffcc8031ff024073ff1340219422`, adapted through the versioned publication policy and applied on top of public `main`
- Preserved public-only files: `PUBLICATION.md`, `LICENSE`, `.gitleaks.toml`, blank `README.md`, and `README.original.md`
- Publication audit adaptation: `scripts/public-audit.sh` rejects a merge publication commit while accepting the inherited PR #1 and #2 merge history
- Excluded private-only paths (enforced by `scripts/public-sanitize.mjs`): `.agents/`, `.claude/`, `.github/pull_request_template.md`, `AGENTS.md`, `CLAUDE.md`, `docs/agentic-workflow.md`, `docs/agents/domain.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/compute-policy-defaults.md`, `docs/eir-volume.md`, `docs/evidence/113-shared-accessibility.md`, `docs/governance-research.md`, `docs/implementation-plan.md`, `docs/onepager-copy.md`, `docs/production-checklist.md`, `docs/research/govcloud-identity-proof-2026-10-08.md`, `docs/research/snappy-on-slow-backend.md`, `docs/slide-distilled.md`, and `docs/superpowers/specs/2026-10-21-release-readiness-fix-design.md`
- Sanitization: internal workspace/profile/catalog names, workspace and group IDs, workspace host, IRS email fixtures, private repository links, and the FedRAMP registry host use the existing public example values
- Link sanitization: links from published Markdown to excluded documents are rendered as non-link text; `README.original.md` is preserved verbatim as the historical public README arrangement
- New-surface review: the client artifact scanner, person-name module, Windows deployment documentation, and `.gitattributes` contain no additional secrets or environment-specific identifiers after sanitization
