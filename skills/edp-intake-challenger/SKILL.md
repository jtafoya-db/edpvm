---
name: edp-intake-challenger
description: Challenge completed EDP intake sections with IRS-process-aware, evidence-bound suggestions that users can choose to insert into existing wizard fields. Use for reviewing an EDP onboarding draft; do not use to submit, approve, or mutate an intake.
---

# EDP intake challenger

Review one completed wizard section at a time. Challenge omissions, expand the draft toward a concrete MVP and defensible business case, and return only suggestions the user may elect to insert. Never apply a suggestion, change the form, or claim approval.

## Required references

Before producing suggestions:

1. Read [references/context-pack.md](references/context-pack.md) for the EDP review context and evidence limits.
2. Read the matching section in [references/per-section-prompts.md](references/per-section-prompts.md). Use only that section's prompt plus the shared contract.
3. Produce a `challenge_response` conforming to [schemas/suggestion-io.schema.json](schemas/suggestion-io.schema.json). Output the JSON object only—no prose, Markdown, or wrapper.

The current field and section ids deliberately match the state keys and six section labels in `src/legacy/onboarding.jsx` on the base branch. The richer repo-backed `IntakeSchema` described in `docs/build-plan-p1.md` is not present on this branch. Reconcile the enums when that schema lands; do not guess future ids.

## Invariants

- Cite the user's own supplied value for every suggestion with an exact quote and its source field id.
- Treat supplied values as claims, not verified facts. Never add names, amounts, dates, baselines, systems, safeguards, approvals, or technical details the user did not provide.
- A question or placeholder is preferable to invented content. Proposed text may identify what must be supplied, but must not masquerade as a completed fact.
- Target only field ids allowed for the request's section. Suggestions may clarify or extend a field; they may not create fields.
- Return zero or more independent suggestions. The human explicitly accepts or rejects each one; nothing is auto-applied.
- Do not call FMAPI, Model Serving, or any other model endpoint from this standalone artifact.

## Intended live integration (later phase)

The Databricks App backend will eventually send the completed section id and current field values as a `challenge_request` to Sonnet 4.5 through FMAPI/Model Serving. The backend will combine the shared contract, the matching section prompt, and the context pack; require schema-constrained JSON; validate the response; reject unknown targets or citations that do not match submitted values; and return suggestion cards to the wizard. The UI will show rationale and evidence, then write a proposed value only after the user confirms it. This skill performs none of that wiring in P1.
