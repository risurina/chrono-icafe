# Wallet module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/wallet/README.md`.
Split mirrors `branches`'/`members`' own precedent, with one addition specific
to this module: Phase 1 (schema/RLS) is local, never delegated to Jules, per
the `jules` skill's guardrail against delegating RLS/tenant-isolation design.
Phase 3 here is **"Service (locking) + routes + permission gates + concurrency
proof"** — it is kept local because it is the money-moving row-lock/
transaction-integrity mechanism the whole module exists to get right (see the
plan's own "Transaction integrity mechanism" section), exactly the kind of
correctness Jules cannot prove for itself. It also adds a permission resource,
but through the per-app extension seam (`apps/chrono-api/src/auth/
permissions.ts` + `registerAppPermissions()`) — this module never edits
`packages/agora`, per `.ai/rules/business-app.md`.
Phase 2 (contracts + money helper) and Phase 4 (web UI) and Phase 5
(e2e spec) are delegated to Jules, one session per phase, pulled + verified
locally before the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | done | — | `chronoWallet`/`chronoWalletTransaction`, both in `APP_TENANT_TABLES`, migration `0006_add_chrono_wallets.sql`, `rls:proof` PASS |
| 2 — Contracts + money helper | jules | done | 12082141174603202875 | pulled, fixed single→double quote style in `money.ts` locally (cosmetic only), `pnpm --filter @agora/chrono-api typecheck` clean |
| 3 — Service (locking) + routes + permission gates + concurrency proof | local | done | — | committed `74a6881`. Open Question 1 resolved (staff: read/credit/debit; admin+: adjust), registered via the app seam `apps/chrono-api/src/auth/permissions.ts`. `concurrency.test.ts` + `test:wallet-concurrency` against real Postgres; `wallet` gate cases in `permissions.test.ts`. Audit follow-ups owned by `.ai/plans/chrono/active/wallet-hardening/` |
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
- 2026-09-01 — Session completed (~4 minutes after firing), poller woke this
  session. Pulled with `jules remote pull --session 12082141174603202875
  --apply`, reviewed the diff: `contracts.ts` matches Pass 2's spec verbatim.
  `money.ts` matches the spec functionally (`toCents`/`fromCents`/`addMoney`/
  `negateMoney`/`isNegativeMoney`, all string-in/string-out, BigInt-only, no
  `Number()` arithmetic on a money value) but used single-quoted strings
  throughout, inconsistent with the rest of the codebase's double-quote
  convention — fixed locally (cosmetic only, no logic change). Manually
  verified the plan's acceptance-criteria examples against the pulled code:
  `addMoney("10.50", "-3.25") === "7.25"`, `isNegativeMoney("-0.01") ===
  true`, `isNegativeMoney("0.00") === false`. `pnpm --filter @agora/chrono-api
  typecheck` clean. Committed (`a4ca2f5`). Phase 2 done.
- 2026-09-01 — Phase 1 (schema, RLS, `APP_TENANT_TABLES`) built locally, per
  Pass 2's exact table specs: `apps/chrono-api/src/modules/wallet/schema.ts`
  (`chronoWallet` + `chronoWalletTransaction`), wired into `db/schema.ts` and
  `APP_TENANT_TABLES` without clobbering the concurrently-landed `pos`
  entries. `pnpm --filter @agora/chrono-api db:generate --name
  add_chrono_wallets` produced a clean, non-destructive migration
  (`0006_add_chrono_wallets.sql`); applied via `db:migrate`.
  `pnpm --filter @agora/chrono-api typecheck` clean, `rls:proof` → `RLS PROOF:
  PASS ✅` (non-vacuous). Committed (`f75da47`). Phase 1 done — Phase 3 (the
  locking service + routes + permission gates + concurrency proof) is next,
  and stays local per this file's own header note.
- 2026-09-02 — Phase 3 built locally, per Pass 2's exact spec.
  `wallet: ["read", "credit", "debit", "adjust"]` added to the per-app
  extension seam (`apps/chrono-api/src/auth/permissions.ts` — Open Question 1
  resolved per the plan's own recommendation: staff holds read/credit/debit,
  admin+ adds adjust). `service.ts` (`lockWalletForUpdate`/
  `applyWalletDelta`/`creditWallet`/`debitWallet`/`adjustWalletBalance`, row
  lock via `.for("update")`, BigInt-cents money math, `HttpError(422, ...)`
  on a would-go-negative debit), `routes.ts` (staff-facing, every mutation
  re-checks the `tenantMember` exists inside the same `withTenant` call
  before touching the wallet — closes the Pass 1 isolation hole), and
  `portal-routes.ts` (customer-facing balance/history, no auto-create on
  read), wired into `rpc.ts`/`app.ts`. Added the `wallet` gate cases to
  `permissions.test.ts` and a new `concurrency.test.ts`
  (`test:wallet-concurrency`) proving the row lock against a real Postgres
  connection: 10 concurrent credits of `10.00` + 10 concurrent debits of
  `5.00` against the same `memberId` → final balance `50.00` exactly, 20
  ledger rows (no dropped/duplicated), and ledger replay reconstructs the
  same balance. `pnpm --filter @agora/chrono-api typecheck` clean,
  `test:permissions` → 343 passed, `rls:proof` → `RLS PROOF: PASS ✅`,
  `test:wallet-concurrency` → 4 passed. Committed (`74a6881`). Phase 3 done —
  Phase 4 (web UI) is next, Jules-eligible now that the backend is fully
  landed.
- 2026-09-02 — Post-implementation audit run against Phases 1–3. Core
  guarantees re-verified as correct: tenant isolation, the `SELECT … FOR
  UPDATE` row lock, BigInt-cents money math, `requireTenantMember` resolved
  inside the tenant transaction (closing the Pass 1 isolation hole), and
  permission gates on the resolved set via the app-local typed wrapper. Six
  real defects found around that core — audit rows carrying no amount,
  unbounded amounts overflowing `numeric(12,2)` into a 500, `q` accepted but
  never applied on `GET /wallets`, the portal history echoing a sort order it
  does not apply, no DB-level `CHECK` on the ledger invariant, and no
  lock-ordering rule handed to `sessions`. These are owned by a follow-up plan,
  `.ai/plans/chrono/active/wallet-hardening/`, not by re-opening Phase 3.
  Also corrected in this file: the Phase 3 status row above still read
  `not started` while the log entry directly beneath it recorded the phase as
  done and committed. (The audit initially reported that discrepancy as
  Phase 3 being unbuilt, and reported the concurrency test and permission gate
  cases as missing — both false, caused by a stale pre-`74a6881` git snapshot
  passed into its prompt. Verified against `git show 74a6881`: 784 insertions
  across 9 files, including a 296-line `concurrency.test.ts`.)
- 2026-09-02 — Phase 4 (web UI) delegated to Jules, session
  `16503940939407002333`. Phase 5 (e2e spec) delegated to Jules, session
  `13077439649558572904`, fired in parallel. Background pollers running
  (30-min rule applies to each).
- 2026-09-02 — Phase 4 (web UI) session `16503940939407002333` is
  **Awaiting User Feedback** (stalled on a clarifying question) — could not
  reply via Playwright MCP right now (browser locked by another concurrent
  session). Check https://jules.google.com/session/16503940939407002333
  manually, or retry the browser-reply flow once the lock clears.
- 2026-09-02 — Phase 5 (e2e spec) pulled: staff/admin permission-tier gate
  test matches the real landed grants (staff: read/credit/debit, not
  adjust). No `as any`, typecheck clean. Committed (`b337c02`).
