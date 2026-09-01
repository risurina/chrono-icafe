# Wallet module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/wallet/README.md`.
Split mirrors `branches`'/`members`' own precedent, with one addition specific
to this module: Phase 1 (schema/RLS) is local, never delegated to Jules, per
the `jules` skill's guardrail against delegating RLS/tenant-isolation design.
Phase 3 here is **"Service (locking) + routes + permission gates + concurrency
proof"** — it is kept local for two independent reasons, not just the usual
permission-gate guardrail: it edits `packages/agora/src/auth/permissions.ts`
AND it is the money-moving row-lock/transaction-integrity mechanism the whole
module exists to get right (see the plan's own "Transaction integrity
mechanism" section) — exactly the kind of correctness Jules cannot prove for
itself. Phase 2 (contracts + money helper) and Phase 4 (web UI) and Phase 5
(e2e spec) are delegated to Jules, one session per phase, pulled + verified
locally before the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | not started | — | |
| 2 — Contracts + money helper | jules | fired | 12082141174603202875 | |
| 3 — Service (locking) + routes + permission gates + concurrency proof | local | not started | — | resolve Open Question 1 (staff wallet:credit/:debit) first; concurrency proof must run against real Postgres, not pglite |
| 4 — Web UI | jules | not started | — | |
| 5 — E2E spec | jules | not started | — | |

## Log

- 2026-09-01 — Firing Phase 2 (contracts + money helper) to Jules, part of a
  batch of five Wave-1 modules (`stations`, `shifts`, `devices`, `wallet`,
  `sessions`) fired sequentially in one orchestration pass per the developer's
  request for max safe parallelism. Confirmed via `jules remote list --session`
  beforehand that no session already existed for this module's Phase 2. Prompt
  named exactly two new files (`apps/chrono-api/src/modules/wallet/
  contracts.ts`, `apps/chrono-api/src/modules/wallet/money.ts`), inlined the
  exact Zod schemas and the money-helper function signatures from the plan's
  Pass 2 sections verbatim, explicitly barred `service.ts`/`routes.ts`/
  `portal-routes.ts`/`concurrency.test.ts`, `packages/agora/src/auth/
  permissions.ts`, `apps/chrono-api/src/db/schema.ts`, `apps/chrono-api/src/
  routes/rpc.ts`, `apps/chrono-api/src/app.ts`, and any other file. Launched
  the background poller per the `jules` skill immediately after firing.
  Session id: `12082141174603202875`.
