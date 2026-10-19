# EDP Vending Machine

Self-service data access & onboarding portal for the IRS Enterprise Data Platform (EDP) — tenants discover governed data, request access, track requests, and onboard new data sources through one governed front door.

> Formerly prototyped as "EDP Front Door" in Lovable. This repo is the build home for making it real. Public history-free snapshot.

## Status

Prototype (React + TanStack Start + shadcn/ui + USWDS), being taken to a real, phased build. See the design docs before touching code:

- **[docs/build-plan-p1.md](docs/build-plan-p1.md)** — the Phase 1 technical/design plan. **Read this first for the architecture.**
- **[docs/data-model.md](docs/data-model.md)** — the target Delta tables, write protocol, monitoring views, and migration path.

## The one idea

Everything hangs on a single **`IntakeSchema`** extracted from the hardcoded onboarding wizard (`src/legacy/onboarding.jsx`). Three consumers read from it: the form renderer, the EDP admin editor, and the LLM challenger. Capabilities advertise a status (`live | stub | planned`) via a registry + `<FeatureGate>` so the app is its own progress board.

## Phased build (P1)

1. Extract `IntakeSchema` from `onboarding.jsx`.
2. `<SchemaForm>` renderer at behavior parity.
3. Capability registry + `<FeatureGate>` + mock module (greying).
4. Re-home to a Databricks App (Delta-backed state; Lakebase deferred — not in GovCloud).
5. EDP admin editor (live, repo-backed schema).
6. `edp-intake-challenger` skill — designed in P1, wired live later (P1 ships it as a grayed stub).

## Dev

npm-based (see `package.json` and `package-lock.json`).

```bash
npm install
npm run dev
```

## Contributing

Read [`AGENTS.md`](AGENTS.md) first. It covers the delivery workflow, the Definition of Done, the preview-deploy gate, and the shared agent skills. `CLAUDE.md` imports it, so Claude Code and Codex both pick it up automatically.
