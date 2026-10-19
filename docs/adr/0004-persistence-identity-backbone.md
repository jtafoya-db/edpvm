# ADR-0004 — Persistence & Identity Backbone (system of record)

**Status:** Accepted (design). Supersedes the "P1 runs in-memory" posture for the
request/attestation/identity surface. Sequenced after the logic layer
(lifecycle, SLA, waiver, domain-owners, discovery) is in place.
Amended by ADR-0006 (dataset owners). Refined by ADR-0007 (the Delta data model).

## Context

Today the app is a **logic + prototype layer with no system of record**:

- The Delta adapter (`src/data/adapters/delta.ts`) is a throwing "SHAPE ONLY"
  stub; the live app runs the **memory** adapter seeded from fictional
  `window.AppData`. Submitted requests live in an in-process array and are lost
  on reload.
- `waiver.attest()` is a pure function whose `attestedBy` is an arbitrary
  caller-supplied string — no principal, no table, no write; it is not yet
  called by any screen.
- The current user is a **hardcoded seed** (`Dana Whitfield, isAdmin: true`).
  There is **no Databricks identity integration** — no forwarded OBO token,
  no `current_user`, no SDK. Consequently the admin gate added for the Rules
  Inspector currently trusts _mock_ identity and is **not real authorization**.
- `docs/delta-schema.md` models catalog/requests/lifecycle but has **no
  users/principals table and no attestation table**.

The product goal that forces this ADR: _when a user attests they hold a
live-data waiver (LDW), that attestation must be attributed to **their** record
in a Delta table_ — which requires real identity, a durable schema, and a write
path, none of which exist.

## Decisions

1. **Identity source — real Databricks App identity.** The app server reads the
   signed-in user from the identity the Databricks Apps platform forwards
   (e.g. `X-Forwarded-Access-Token` / forwarded email/username headers),
   resolves the authenticated principal server-side, and threads it into request
   context. The hardcoded seed `user` is replaced. Roles (e.g. `isAdmin`) are
   derived from **real group membership**, not a seed flag — this also converts
   the Inspector's admin gate into genuine authorization. A **dev/test fallback
   identity** applies only when the platform headers are absent (local dev).

2. **Stable principal key.** Every record keys off the **account SCIM principal
   id** (stable) plus **username/email** (display). Email alone is not the key.

3. **Profile model — minimal for MVP.** Store `principal_id` + `username/email`
   directly on each request/attestation. Defer a full `users`/`principals`
   table and SCIM sync until profile attributes are actually needed.
   Refined by ADR-0007: the columns are `<role>_principal_id`, `<role>_display` and
   `<role>_email`, and every action row uses `actor_principal_id`, `actor_display`, `occurred_at`.

4. **Attestation model — separate normalized table.** LDW (and future)
   attestations live in `requests.waiver_attestations`, one row per
   (request, checklist item, attestor), with `attested_at` and optional note —
   not embedded in the request blob. Auditability is a gov requirement.

5. **Write path — SP-backed, admin-gated.** The app **server backend** performs
   Delta/UC writes by authenticating **as the provisioner service principal
   (OAuth M2M)** behind an **admin-gated endpoint with an audit record** (the
   pattern from the provisioning work). A **Databricks Asset Bundle creates the
   schema + tables**. The user's OBO token is **workspace-scoped** and is used
   for identity resolution and per-user reads/attribution where possible;
   account-plane work stays on the SP. No account-admin power is exposed to the
   browser.

6. **Sequencing.** **Identity first** (foundational; closes the real-auth gap) →
   **DAB + tables** (create the durable schema) → **write path** (requests and
   attestations land durably, keyed to the principal). Only then are the
   Inspector / waiver / request surfaces backed by real records.

## Consequences

- The admin gate becomes real authorization once identity lands (until then it
  is explicitly mock — tracked, not shipped as a security control).
- `delta-schema.md` is extended with `requests.waiver_attestations` and a
  documented principal-key convention on `requests.access_requests` /
  `requests.pipeline_decisions` (actor becomes a principal id, not a free
  string).
- The Delta adapter stops being a stub for the request/attestation write path;
  the memory adapter remains the local/dev + test backend behind the same seam.
- This backbone is the prerequisite for meaningful UAT of "attest → persists to
  my record", which cannot be validated on the in-memory build.

## Relationship to backlog

- **#24 (P3 request store)** and **#25 (P4 Delta persistence + DAB)** partially
  cover the request store and Delta write path; they are extended by this ADR.
- **Net-new** (not previously ticketed): the **identity integration** (decision
  1–2) and the **per-user attestation attribution** (decision 4). These become
  their own vertical-slice tickets, sequenced identity-first.
- The SP-backed write path aligns with the provisioner-SP / M2M pattern
  (backlog #45).
