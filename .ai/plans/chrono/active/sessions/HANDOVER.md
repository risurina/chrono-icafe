# Sessions module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/sessions/README.md`.
This is the last Wave-1 module — it has **six** phases (like `devices`, not
five like `branches`/`stations`/`shifts`/`wallet`) — see the plan's own phase
headers. Split: Phase 1 (schema/RLS) is local, never delegated to Jules, per
the `jules` skill's guardrail against delegating RLS/tenant-isolation design.
Phase 3 ("Service (close/lifecycle) + routes + permission gates") is local for
the same two reasons `wallet`'s own Phase 3 is local: it edits
`packages/agora/src/auth/permissions.ts`, AND it is the atomic-claim
concurrency-safety mechanism (`closeSession`'s `UPDATE ... WHERE status IN
(...) RETURNING *`) this module exists to get right — proven by a dedicated
concurrency test, not something to hand to an async agent. Phase 4
(background expiry sweep, `expiry.ts` + wiring into `index.ts`) is
mechanical and touches no permission/RLS surface — kept local for this first
pass since it reuses `closeSession` directly from Phase 3 and the two are
easiest to verify together, but it is a reasonable Jules candidate later if
the phase split is revisited. Phase 2 (contracts + money helper), Phase 5
(web UI), and Phase 6 (e2e spec) are delegated to Jules, one session per
phase, pulled + verified locally before the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | not started | — | depends on `station`/`member`/`wallet` schema existing on disk first |
| 2 — Contracts + money helper | jules | fired | 2097577537239695559 | |
| 3 — Service (close/lifecycle) + routes + permission gates | local | not started | — | resolve Open Question 3 (no staff-denied action) first; concurrency proof must run against real Postgres, not pglite |
| 4 — Background expiry sweep | local | not started | — | reuses Phase 3's `closeSession` directly |
| 5 — Web UI | jules | not started | — | |
| 6 — E2E spec | jules | not started | — | |

## Log

- 2026-09-01 — Firing Phase 2 (contracts + money helper) to Jules, part of a
  batch of five Wave-1 modules (`stations`, `shifts`, `devices`, `wallet`,
  `sessions`) fired sequentially in one orchestration pass per the developer's
  request for max safe parallelism. Confirmed via `jules remote list --session`
  beforehand that no session already existed for this module's Phase 2. Prompt
  named exactly two new files (`apps/chrono-api/src/modules/session/
  contracts.ts`, `apps/chrono-api/src/modules/session/money.ts`), inlined the
  exact Zod schemas and money-helper function signatures from the plan's
  Pass 2 sections verbatim (including the explicit instruction to import
  `toCents`/`fromCents` from `../wallet/money` rather than reimplement cents
  conversion — noting for Jules that `../wallet/money.ts` may not exist on
  disk yet since `wallet`'s own Phase 2 is a separate, independently-fired
  session; told it to write the import as specified regardless, since this
  phase only needs to typecheck its own two new files' internal logic, not a
  full cross-module resolution), explicitly barred `service.ts`/`routes.ts`/
  `portal-routes.ts`/`concurrency.test.ts`/`expiry.ts`, `packages/agora/src/
  auth/permissions.ts`, `apps/chrono-api/src/db/schema.ts`, `apps/chrono-api/
  src/routes/rpc.ts`, `apps/chrono-api/src/app.ts`, `apps/chrono-api/src/
  index.ts`, and any other file. Process note: this session was fired before
  its ledger row was reserved (the usual "reserve row, push, then fire" order
  slipped for this one module only) — recorded in
  `.ai/handover/jules-sessions.md` immediately after, no gap in the historical
  record beyond ordering. Launched the background poller per the `jules`
  skill immediately after firing. Session id: `2097577537239695559`.
