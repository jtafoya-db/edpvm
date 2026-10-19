# Data Architecture & the Store Seam

How the EDP Vending Machine reads and writes data: the layers, the data seam,
the TanStack Query cache, what is real vs. stubbed today, what is still needed
to make the Delta backend live, and how a future swap to Lakebase (Postgres)
would work.

> Grounded in the code at the time of writing. File references are pointers to
> read the real thing, not a substitute for it.

---

## 1. The layers (top to bottom)

```
 React / legacy screens        BrokerApp -> LegacyAppHost -> legacy App
        |
        v
 Application hooks             useLegacyAppData (7 read hooks) + useSubmitRequest
        |
        v
 TanStack Query               QueryClient . 11 query keys . optimistic mutation + invalidation
        |                      (v5 defaults today - see the staleTime caveat)
        v
 DataStore context            useStore()   <-- the app depends ONLY on this
        |
        v
 Backend selector             loadStore()  -- the single switch (VITE_DATA_BACKEND)
        |-- "memory" -> createMemoryStore(seed)     <-- DEFAULT, live today
        |-- "delta"  -> createDeltaStore(config)     <-- server API (see sec. 7)
        |
        v
 Adapters                     memory: window.AppData snapshot + in-process request array
                              delta:  fetch to /api/reads/* and /api/commands/* (no SQL)
        |
        v
 Backend                      memory: window.AppData seed
                              delta:  server handlers -> SqlClient (app SP) -> SQL warehouse -> Delta
```

**The load-bearing rule:** everything above the seam (components, hooks, the
legacy bridge) depends only on the `DataStore` interfaces. No component, hook,
or cache entry knows SQL, a warehouse id, or which backend answered. Swapping
backends is a change at `loadStore()` + one adapter, not a rewrite.

Key files:

| Layer | File |
|---|---|
| Query client / provider | `src/router.tsx`, `src/routes/__root.tsx` |
| Query keys + hooks | `src/data/queries.ts` |
| Legacy aggregate | `src/data/legacy-bridge.ts` |
| Store context/provider | `src/data/store-context.ts`, `src/data/store-provider.tsx` |
| Seam interfaces | `src/data/store.ts` |
| Backend selector | `src/data/loadStore.ts` |
| Adapters | `src/data/adapters/memory.ts`, `src/data/adapters/delta.ts` |
| Delta DDL / DAB | `resources/store-schema.sql`, `databricks.yml` |
| Identity | `src/server.ts`, `src/server/session.ts`, `src/data/session.ts` |

---

## 2. The data seam (`src/data/store.ts`)

One `DataStore` object = three typed repositories, all methods async so a
network-backed implementation is a drop-in:

- **`CatalogStore`** - reference reads: domains, datasets, bundles, systems,
  personas, tenants, and `getUser()` (the session profile).
- **`RequestStore`** - request reads + writes: `listRequests`, `getRequest`,
  `createRequest`, `transitionRequest`, `appendWaiverAttestation`,
  `listPipeline`.
- **`StatusStore`** - `listStages`, `getRequestStatus`, `getMyAccess`.

Callers obtain an injected `DataStore` via `useStore()`; only `StoreProvider`
calls `loadStore()`.

---

## 3. Backend selector (`src/data/loadStore.ts`)

`loadStore()` returns a process-wide `DataStore` singleton. `activeBackend()`
reads `VITE_DATA_BACKEND`:

- unset / empty -> `memory` (default)
- `"memory"` / `"delta"` -> that backend
- anything else -> **throws** (fail-closed; it never silently serves seed data)

Delta config is read from `VITE_DBX_*` env (`warehouseId`, `catalog`,
`catalogSchema`, `requestSchema`). These are non-secret identifiers - see the
Lakebase note (sec. 8) for why real credentials must NOT live in `VITE_*`.

---

## 4. Caching layer - TanStack Query

`@tanstack/react-query` is the active client cache.

- 11 query keys centralized in `src/data/queries.ts`
  (`["catalog"]`, `["requests","list"]`, `["status","detail",id]`, ...).
- 9 read hooks + 1 mutation. `useSubmitRequest` is the mature write path:
  cancel affected queries -> optimistic seed of list/detail/status -> rollback
  on failure -> invalidate the `requests`/`status` families on settle.
- Hooks never touch `loadStore()`, adapters, SQL, or `window.AppData` - they
  read the injected store from `useStore()`.

### staleTime caveat

`new QueryClient()` is created with no `defaultOptions`, so React Query v5
defaults apply: `staleTime: 0` (data is stale immediately), `gcTime: 5m`, and
refetch on mount / window focus / reconnect. That is harmless against the
in-memory seed, but once Delta (or Lakebase) is live it means the warehouse is
re-queried on every refocus. **Set an explicit `staleTime` policy before the
Delta backend goes live.**

---

## 5. Identity path

Identity is a separate server seam, surfaced through `catalog.getUser()`:

```
useUser -> DataStore.catalog.getUser()
        -> memory adapter fetchSessionProfile()
        -> GET /api/session
        -> server handleSessionRequest()
        -> forwarded Databricks identity headers / OBO token
        -> workspace SCIM /Me
        -> sanitized UserProfile -> Query cache ["catalog","user"]
```

The OBO token stays server-side. This is Databricks-specific coupling, but it
is *identity* coupling, independent of the persistence backend.

Every read and command endpoint resolves its caller the same way. The server
keeps each token's `/Me` answer for `EDP_IDENTITY_CACHE_TTL_MS` (default 60s,
at most 5 minutes, `0` turns it off), keyed by a SHA-256 of the token, and
concurrent lookups share one call (`src/server/identity-cache.ts`). Only an
answer with a stable principal id is kept: a failed `/Me`, or a 200 without
one, is asked again next time. Roles are still derived per request, and a
write's actor is still whoever owns that request's token.

**Known limit: role revocation is delayed by up to the TTL.** Removing someone
from the EDP staff, reviewer or validator group, or revoking their token,
takes effect in this app only once their cached `/Me` answer expires: up to
60s by default, 5 minutes at most. Set `EDP_IDENTITY_CACHE_TTL_MS=0` to make
revocations immediate, at the cost of one SCIM call per request.

---

## 6. Coupling inventory

**Abstract-seam-only (no backend knowledge):** `BrokerApp.tsx`,
`src/data/queries.ts`, `src/data/legacy-bridge.ts`, the store context/provider,
and `src/data/store.ts`.

**Concrete Databricks/Delta coupling:**

1. Selector + build config - `src/data/loadStore.ts` (backend name, `VITE_DBX_*`).
2. Delta adapter - `src/data/adapters/delta.ts` (all runtime SQL, the
   `SqlClient` contract, backtick identifiers, named `:param` binding, the
   `/api/data/sql` proxy call).
3. Delta DDL - `resources/store-schema.sql` (`USE CATALOG`, `USING DELTA`,
   `ARRAY<STRING>`, etc.). SQL is therefore not confined to the adapter.
4. DAB provisioning - `databricks.yml` (`jobs.provision_store`, warehouse id,
   catalog target).
5. Identity - `src/server/session.ts` (`DATABRICKS_HOST`, SCIM `/Me`, admin
   group). Identity coupling, not persistence.
6. Hosting - `databricks-app/app.yaml` + `databricks.yml` (Databricks Apps). Can stay even if
   persistence moves.
7. Seed bypass wart - `src/data/tags.ts` reads `readAppDataSeed()` directly,
   skipping both the seam and the cache.

---

## 7. Current state: memory vs. delta

| Piece | State |
|---|---|
| TanStack Query cache | Live |
| Memory adapter | Live (session-local; seeded from `window.AppData`) |
| `/api/session` identity | Implemented |
| Delta adapter | Live over the server API (#76): catalog, tenants, my access, pipeline, #72 cart requests, EIRs (#126), datasets, roles, teams and the change list (#123), and onboarding requests (#125). Access requests are still an in-memory stub until their area ticket |
| Delta command and read API | Implemented (#76): `src/server/delta/`, see [`delta-backend.md`](delta-backend.md) |
| `/api/data/sql` proxy | **Never built, by design** (ADR-0007): the browser never sends SQL |
| Provision job (tables) | Defined (DAB): `store-schema.sql`, `store-admin.sql`, `store-eir.sql`, `store-onboarding.sql`, `store-teams.sql`, `store-audit.sql` |

### What is still needed to make the Delta backend live

The Delta path is a correct, tested *shape*, not yet a working backend. To turn
it on end to end:

1. ~~Server SQL proxy~~ - replaced by the command and read API (#76,
   [`delta-backend.md`](delta-backend.md)).
2. ~~Complete `DataStore` coverage in the delta adapter~~ - done in #76 for
   #72's reads; each area ticket replaces its in-memory stub.
3. **Load reference data into the `catalog.*` Delta tables** - the DDL creates
   empty tables; the memory path reads `window.AppData`, but a Delta-backed app
   reads empty tables until reference data is loaded (seed job or bootstrap).
4. **Wire the write mutations** - `transitionRequest` and
   `appendWaiverAttestation` exist at the adapter level but have no
   `useMutation` hook or cache invalidation yet.
5. **Run the provision job** to create the tables in the target workspace
   (real infra step; idempotent).
6. **Set an explicit `staleTime`/`gcTime` policy** (sec. 4) so live reads are
   not refetched on every focus.
7. **Route `src/data/tags.ts` through the store** to remove the seed bypass.

---

## 8. Future: swapping to Lakebase (managed Postgres)

Lakebase is Databricks' managed Postgres (OLTP), a different engine from the
current Delta-via-SQL-warehouse path. The seam makes this **architecturally
clean at the app layer (no UI/hook/cache rewrite)**, but PR #72's SQL / client /
provisioning path is **not portable as-is** - you write a new adapter.

**Reusable:** the `DataStore` contract, the whole cache layer, and the
row<->object mapping logic in the adapter.

**Rewrite per Postgres dialect:**

| Area | Delta today | Postgres / Lakebase |
|---|---|---|
| Parameters | named `:id` | positional `$1,$2` (or a named-param layer) |
| Identifiers | backticks | double quotes |
| Catalog | `USE CATALOG IDENTIFIER(...)` | database via connection + qualified schemas |
| Table create | `CREATE TABLE ... USING DELTA` | plain Postgres DDL |
| Types | `STRING/INT/DOUBLE` | `text/integer/double precision` |
| Arrays | `ARRAY<STRING>` | `text[]` / JSONB / child tables |
| Decimal | `DECIMAL(18,2)` | `numeric(18,2)` |
| Timestamp | `TIMESTAMP` | decide `timestamptz` |
| Transactions | batch may partially apply | real transactions (an upgrade) |
| Auth/conn | SP OAuth M2M via SQL proxy | Postgres endpoint + credential + TLS + pooling |

**Beyond a new adapter file:** extend `loadStore()` + the `DataBackend` union;
add a **server-side** config/secret layer (a Postgres credential must NOT be a
`VITE_*` var - Vite bakes those into the client bundle); implement the
server-side data API; write Postgres migrations instead of the Delta DDL; and
cover all `DataStore` methods.

**Effort: Medium.** Top risks: (1) secure server-side credentials/TLS/pooling
without leaking secrets to the client; (2) dialect + schema migration (arrays,
catalog semantics, identifiers, timestamps); (3) transactional atomicity + full
method coverage.
