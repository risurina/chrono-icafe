# Sessions module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/sessions/README.md`.
This is the last Wave-1 module — it has **six** phases (like `devices`, not
five like `branches`/`stations`/`shifts`/`wallet`) — see the plan's own phase
headers. Split: Phase 1 (schema/RLS) is local, never delegated to Jules, per
the `jules` skill's guardrail against delegating RLS/tenant-isolation design.
Phase 3 ("Service (close/lifecycle) + routes + permission gates") is local for
the same two reasons `wallet`'s own Phase 3 is local: it edits
`apps/chrono-api/src/auth/permissions.ts` (via `registerAppPermissions()` —
never `packages/agora`, see `.ai/rules/business-app.md`), AND it is the atomic-claim
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
| 1 — Schema, RLS, APP_TENANT_TABLES | local | done | — | landed as part of a 9-module batch (`9943aa5`) |
| 2 — Contracts + money helper | jules | done | 2097577537239695559 | |
| 3 — Service (close/lifecycle) + routes + permission gates | local | done | — | committed (`af8ce16`) |
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
- 2026-09-02 — Phase 1 (schema, migration, RLS) landed locally, committed as part of a 9-module batch (`9943aa5`). All 15 new tables registered in APP_TENANT_TABLES, RLS forced, `rls:proof` PASS, whole-workspace typecheck clean.
- 2026-09-02 — Phase 3 (service + routes + permission gates) built locally,
  per Pass 2's exact spec. `session: ["create", "update"]` added to the
  per-app extension seam — no staff/admin split (Open Question 3 resolved
  per the plan's own default: no staff-denied action exists on this
  resource). `service.ts`'s `closeSession` is the only code path that ends a
  session — **caught and fixed a real double-debit bug during
  implementation**: the first draft read the session row, computed the
  charge, called `debitWallet`, and only THEN did the atomic claim UPDATE —
  which meant a losing racer would still have already debited the wallet
  before discovering it lost the race. Fixed by switching to the same
  row-lock discipline `wallet`'s own `lockWalletForUpdate` uses:
  `SELECT ... FOR UPDATE` on the session row FIRST (serializes concurrent
  closers), THEN compute billing and debit only after the lock is held — a
  losing racer blocks until the winner commits, then sees `status: "ended"`
  and returns `alreadyClosed: true` before ever touching the wallet.
  `routes.ts` (start's full station/group/member/balance pre-check chain +
  rate resolution incl. the `chronoMemberProfile.applicationStatus ===
  "approved"` member-rate check, pause/resume/extend/end), `portal-routes.ts`
  (`GET /active`, no auto-create), wired into `rpc.ts`/`app.ts`. Added the
  `session` gate cases to `permissions.test.ts` (no denial case, documented
  explicitly per Open Question 3) and a new `concurrency.test.ts`
  (`test:session-concurrency`) proving the row lock against a real Postgres
  connection: 10 concurrent `closeSession` calls against a backdated
  (30-minutes-elapsed) session → exactly one closes, the other 9 correctly
  report `alreadyClosed: true`, exactly one wallet transaction row exists
  (no double-billing), station status is `"available"` exactly once.
  `pnpm --filter @agora/chrono-api typecheck` clean, `test:permissions` →
  374 passed, `rls:proof` → `RLS PROOF: PASS ✅`, `test:session-concurrency`
  → 4 passed. Committed (`af8ce16`). Phase 3 done — Phase 4 (background
  expiry sweep, reuses `closeSession` directly) is next.
- 2026-09-02 — Phase 4 (background expiry sweep) built locally, per Pass 2's
  exact spec: `expiry.ts`'s `runSessionExpirySweepOnce()` (a `withAdmin`
  due-row scan, batch-capped at 200, `WHERE status IN ('active','paused') AND
  scheduledEndAt < now()`, so an open-ended session is never touched) closes
  each due row via `withTenant(row.tenantId, tx => closeSession(...))` —
  reusing Phase 3's function directly, never a second billing
  implementation — wrapped by `startSessionExpiryWorker()` (`setInterval` +
  `.unref()`, `SESSION_EXPIRY_SWEEP_INTERVAL_MS` env override, default
  60s), wired into `index.ts` mirroring `startRetentionWorker()`'s exact
  structure (bootstrap call + `stop...()` in the `SIGINT`/`SIGTERM`
  handler). Verified with a throwaway script (per the plan's own "no
  dedicated automated test file required" note, deleted after use) against
  a real Postgres test DB: seeded one past-due session (`scheduledEndAt` 5
  minutes ago) and one open-ended session, ran the sweep once — the
  past-due session closed (`status: "ended"`, station `"available"`,
  exactly one wallet debit recorded), the open-ended session stayed
  untouched. `pnpm --filter @agora/chrono-api typecheck` clean. Committed
  (`135966f`). Phase 4 done — Phase 5 (web UI) is next, Jules-eligible now
  that the backend is fully landed. **`sessions` backend is now
  complete — every core Wave-1 module has a full backend.**
- 2026-09-02 — Phase 5 (web UI) delegated to Jules, session `16137985652170510598`. Fired in parallel with pos/credits/reports UI.
