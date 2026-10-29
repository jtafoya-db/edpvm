# ADR-0009 — Responsive app on a slow transactional backend

- **Status:** Accepted (2026-10-11). Amends ADR-0007 decision 6's warehouse-channel cost note (decision 8 below). Folds in #140 as phase 1.
- **Related:** ADR-0007 (MVP Delta data model), ADR-0008 (separate tenant and staff apps), `docs/research/snappy-on-slow-backend.md` (private source document; not published) (the evidence), [`docs/delta-backend.md`](../delta-backend.md), `docs/production-checklist.md` (private source document; not published), [`GLOSSARY.md`](../../GLOSSARY.md), #140, #177, [wayfinder #141](https://github.com/jtafoya-db/edpvm/issues/141)

## Context

Every save is one Delta `BEGIN ATOMIC` transaction (ADR-0007 decision 6). Measured on both the GovCloud demo workspace and `example-workspace`, an app-shaped save spends **5–9 s inside the atomic block** (research §1). Today the screen waits for all of it.

Three facts rule out the obvious fixes:

- **A bigger warehouse doesn't help.** A Medium serverless warehouse ran the same block no faster than a Small one, and once much slower (research §2). The cost is per-transaction overhead, not compute.
- **Lakebase isn't available in GovCloud.** Databricks lists Lakebase Postgres as unavailable on AWS GovCloud (`us-gov-west-1`), and the demo workspace's Lakebase APIs didn't answer (research §5). Lakebase is the right long-term home for this hot state, but the pilot can't wait for it.
- **Most of the block's time is ours.** A bare transaction costs ~1.2 s whether it holds 1 insert or 10 (research §3). A real save costs ~5 s, so ~4 s is statements we put inside it.

The Databricks Apps runtime adds two constraints:

- **An app can run several instances behind one URL with no affinity guarantee** (research §6). A person's next request may reach another instance, and any instance can restart. So in-memory state can only be a **rebuildable cache**, never the source of truth for what was saved.
- **Push isn't documented for custom apps.** No Databricks Apps doc promises SSE, streaming responses or WebSockets through the Apps proxy. So the browser **polls** for status.

**The goal:** every click is acknowledged in **under 200 ms** while the commit happens behind it, and the UI is honest about which changes are **committed**, which are **pending**, and which were **refused**.

## Decision

The plan has five phases. Phases 1–4 are approved for the pilot. Phase 5 is deferred.

### 1. Phase 1: app-wide pending UX (#140, no longer onboarding-only)

Every save in the app works like this:

1. **The click shows "Saving…" at once,** in under 200 ms, on the thing being saved.
2. **The person can keep working:** navigate, open other records, start other saves. There's no global save lock.
3. **"Saved" appears only after the server confirms the commit.** Until then the change is shown as pending, never as done. It doesn't advance dependent steps or appear in confirmed history.
4. **One idempotency key per confirmation.** The browser creates the key when the person confirms an action, and reuses it on every retry of that same intent. A changed payload, or a retry against a newer version, is a new intent with a new key.
5. **A refusal keeps the person's input,** shows why, and offers the way forward: review the latest version after a version conflict, rather than a silent retry.

#140 started as onboarding decisions only. It's now the phase-1 build ticket for the whole app. Its acceptance criteria stand, and they apply to every area as it moves to this pattern. The actions in decision 2 keep the pending indicator but never show a pending change as done.

**Why:**

- It's the largest perceived win for the least risk. It needs no new server state, because ADR-0007's runner already makes a repeated key harmless.
- It's honest. Nothing claims "saved" before the lead action row exists.
- One key per confirmation is what makes a retry safe: the runner replays the original result if the first attempt committed, and runs it once if not.

### 2. These actions stay synchronous

For these, the action's own control shows **"Saving…"** until the server answers. The change isn't shown anywhere as done in the meantime, nothing downstream starts, and they never show optimistic success:

| Action                                                                      | Why                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **EIR submit and renew, including the PDF**                                 | A signed agreement is filed only when both the PDF and the record are durable. A person who believes they filed one when they didn't may stop acting on an EIR that's about to lapse.      |
| **Safeguards validator decisions on an EIR, and EIR revocation**            | These set whether FTI access is allowed at all. A validator must know the decision is on record before moving on, and nobody may see "validated" or "revoked" that didn't happen.          |
| **EDP staff approvals (business and ROI, CCB), and starting the Apply job** | They cross ADR-0008's privileged boundary: an approval is what lets the change list act on Databricks. Showing an approval before it's committed would invite the next step on a non-fact. |
| **Anything that grants or removes FTI access**                              | Access to FTI must be exactly what the records say. A pending grant or removal shown as done is a Safeguards misstatement, in either direction.                                            |

These still use one idempotency key per confirmation and phase 2's status lookup, so a dropped connection recovers the truth here too.

**Why:** for these the cost of a wrong impression is a safeguard failure, not an annoyance. A few seconds of honest waiting is the price.

### 3. Phase 2: command status by idempotency key

The server answers "what happened to the command with this key?" with one of four states:

| State         | Means                                                                                                                        | Source                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **committed** | The lead action row exists. The answer carries the stored result, the same one a replay returns.                             | Delta, so any instance can answer.                     |
| **refused**   | The command ran and was refused: version conflict, domain rule, not authorized, or the key reused for a _different_ command. | The instance that ran it, held for a retention window. |
| **pending**   | An instance is running it right now.                                                                                         | The instance running it.                               |
| **unknown**   | This instance has no record of it, and it hasn't committed. That isn't proof it won't commit.                                | No record.                                             |

- **Reusing a key for the same command is a replay, not a refusal.** As ADR-0007 requires, the same key with the same command returns the original stored result (or `pending` while it runs). Only the same key with a different command is refused. This is what makes a same-key retry safe.
- **Only the person who issued the key can ask about it,** resolved from the session like every other request (ADR-0008 decision 5).
- **The browser polls with backoff** while a save is pending, and after a dropped tab or connection, instead of guessing.
- **"Unknown" isn't failure.** Another instance may be running it. The browser keeps checking until the command deadline passes, then says it couldn't confirm the save and offers "Try again" with the same key. That's safe: the runner replays the commit if there was one.

**Why:** without it, a dropped tab or connection leaves the person guessing whether the save landed, and guessing wrong either way is dishonest. With it, the browser recovers the truth.

**Trade-off accepted:** pending and refused live only in the instance that ran the command, so a status request that reaches another instance, or comes after a restart, can get "unknown" for a command that's still running. Making pending durable would cost a ~1.1 s Delta write before the acknowledgement, which breaks the 200 ms goal; phase 5 is the durable answer if this turns out not to be enough.

### 4. Phase 3: slim the atomic block

Cut the statements each command adds around and inside its transaction: the idempotency lookup, reads, the display counter (#177), and checks. #173 (merged in #175) already removed the result re-read and the post-insert row counts from creates, which the all-or-nothing commit makes redundant.

ADR-0007's guarantees stay: the key-race predicate, version guards on updates, domain-rule guards, and the lead action row with its command, hash and stored result. Each removal is measured with `scripts/delta-live-check.ts` before and after.

**Why:** the ~4 s gap between a bare transaction and a real save is work we control. It's the only phase that makes the commit itself faster, so every other phase benefits.

#177 replaces display numbers for EIR and onboarding with counter-free codes, and drops the write check's (ADR-0007 decision 2, amended 2026-10-10). The counter path was the single biggest create cost (2.8–4.2 s) and the cause of queueing under concurrent creates (research §4).

### 5. Phase 4: a per-instance read cache, invalidated by a version row

- Each app instance keeps a cache of recent reads.
- Each command transaction also bumps a tiny **"last changed" version row**, inside the same atomic block.
- Each instance checks that row in the background and drops what has changed. Browser reads are then served from memory.
- **The cache never decides a write.** Commands check versions and rules inside the transaction, against Delta. Caller-scoped reads still check the caller on every request.
- After a restart, the cache rebuilds from Delta.

**Why:** a small select costs ~0.4 s (research §7), and a page load makes several. A one-row check in the background is cheap. `DESCRIBE HISTORY` and `table_changes` cost two to five times as much. Writing the bump in the same transaction means the cache can't see a commit without its version change.

The UI shows committed, pending and refused from command status (phase 2), never by inferring them from a cache that may lag on another instance.

### 6. Phase 5, deferred: a durable receipt outbox

Phase 5 would write each command as a file in a UC Volume (~0.3 s, research §8), answer "accepted" at once, and apply it to Delta later with a background worker.

**Deferred for the pilot.** Revisit only if UAT still feels slow after phases 1–4.

**The trade-off:** an outbox answers faster and survives a restart, but it creates a new state, **accepted but later refused**. A person told "accepted" could learn minutes later that the version moved on or a rule failed. It also needs a worker, crash recovery, duplicate-worker safety, stored refusals and a separate receipt audit. That's too much new machinery to put in front of FTI safeguards before the simpler phases have been tried.

### 7. Ready for Lakebase

The browser speaks **commands with status**: send a command with its key, read its status. The status store and the read cache sit behind the existing data seam (`src/data/loadStore.ts`, the adapters and `src/server/delta/`). When Lakebase is available in GovCloud, only what's behind the command and status implementation changes. The client's pending model, the status states and the command definitions stay.

**Why:** Lakebase is the long-term home for this state. Keeping the browser contract independent of Delta means moving there swaps a backend, not the app.

### 8. Serverless SQL warehouses, Current channel

Previews, the IRS rehearsal and production use a **serverless SQL warehouse**. Production uses the **Current channel**.

**Why:**

- **Serverless starts fast.** A classic or pro warehouse takes minutes to start from stopped; a serverless one, seconds. A cold start of ~20 s was still observed after the shared preview warehouse's 10-minute auto-stop (research §10), which is why auto-stop needs sizing for the pilot.
- **Current is validated for transactions.** The transaction live check (`scripts/delta-live-check.ts`) passed on a Current-channel serverless warehouse in the IRS GovCloud demo workspace (example-gov-demo): every check passed, no duplicate or lost writes, median 2.8 s per attempt, run from `main` at `421d6e1` on a temporary warehouse that was deleted afterwards ([results on #141](https://github.com/jtafoya-db/edpvm/issues/141#issuecomment-6061966898)). ADR-0007 decision 6 asked for that check before production could use Current, so production no longer needs a Preview-channel warehouse.
- **Databricks discourages the Preview channel for production.**

`docs/production-checklist.md` records the production settings: serverless, Current channel, and auto-stop and maximum-cluster settings sized for the pilot.

## Rejected alternatives

- **A bigger warehouse.** Medium was no faster than Small for the block (research §2). It would cost more and fix nothing.
- **An in-memory write queue as the source of truth.** Answering "saved" from a queue in one instance's memory is a lie when that instance restarts, or when the next request reaches another instance. The Apps docs rule it out (research §6).
- **SSE or WebSocket push for status.** Not documented for custom Databricks Apps, so it may not survive the proxy. Polling works everywhere; push can be tried later with a throwaway app.
- **Phase 5 now.** See decision 6. It adds accepted-but-later-refused and a worker before UAT has shown phases 1–4 aren't enough.

## Consequences

- **#140 grows** from onboarding decisions to the app-wide phase-1 pattern, area by area. It stays open as the phase-1 build ticket.
- **New build tickets** for phase 2 (the status lookup and the browser's polling and recovery), phase 3 (block slimming, alongside #177) and phase 4 (the version row and per-instance cache). Each is its own vertical slice under `docs/agentic-workflow.md`.
- **The version row is new hot write.** Every command updates it, so it can make unrelated concurrent commands conflict, as the display counter did. The phase-4 ticket measures this under concurrent saves, and uses one row per area or an append-only insert if one shared row conflicts.
- **Background version checks keep a warehouse busy.** An instance that checks constantly stops auto-stop from ever firing. The phase-4 ticket checks only while the instance has had recent requests.
- **A save that ends "unknown" needs a person** to try again or reload. It's rarer once phase 3 makes commits faster, and phase 5 is the fix if it isn't rare enough.
- **ADR-0007 decision 6's channel note is amended** by decision 8: production uses a Current-channel warehouse, validated by the transaction live check.
- **Moving to Lakebase later** replaces the transaction runner, status store and possibly the cache, but not the browser contract (decision 7).
