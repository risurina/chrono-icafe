# Wallet hardening — implementation handover

Tracks phase-by-phase progress for
`.ai/plans/chrono/active/wallet-hardening/README.md`.

Every phase here is **local, none delegated to Jules** — Phase 4 by the
schema/RLS guardrail, Phases 2–3 because each is a handful of lines inside
money-moving, permission-gated routes where reviewing a delegated diff costs
more than writing it.

## Phase status

| Phase | Owner | Status | Notes |
|---|---|---|---|
| 1 — Correct the `wallet` plan + handover | local | done | committed `a5377c5` |
| 2 — Bound money amounts (contract + cumulative) | local | done | committed `f9b3736` |
| 3 — Route correctness (audit metadata, `q` search, portal sort) | local | done | committed `beab675` |
| 4 — Ledger integrity constraints (migration) | local | done | committed `ac9a7cc`, migration `0010_add_wallet_ledger_checks.sql`. **`test:wallet-concurrency` could not be re-run to completion — see the log entry below; not a defect in this phase** |

## Log

- 2026-09-02 — Plan written following a post-implementation audit of `wallet`.
  **Correction to that audit's own report:** it was run with a stale git
  snapshot (taken before commit `74a6881` landed) passed into its prompt, and
  on that basis reported two blockers that are false — it claimed
  `concurrency.test.ts`, the `test:wallet-concurrency` script, and the `wallet`
  gate cases in `permissions.test.ts` were all missing, and that Phase 3 was
  uncommitted. Verified against git: `74a6881` ("feat(chrono/wallet): phase 3 —
  service (row-lock), routes, permission gates, concurrency proof") contains all
  three (784 insertions across 9 files, including a 296-line
  `concurrency.test.ts`). Phase 3 is done and committed. The only true part of
  that finding is that `wallet/HANDOVER.md`'s status *table* row still reads
  `not started` while its own log entry below it correctly records the phase as
  done — fixed in Phase 1 here.
- 2026-09-02 — The audit's remaining findings were each re-verified against the
  committed code before being written into this plan: plan text naming
  `packages/agora/src/auth/permissions.ts` (real — the code correctly uses the
  app seam); `recordStaffAudit` passing no `metadata` (real, `routes.ts:164`,
  `:194`, `:223`); unbounded amount regexes (real, `contracts.ts:3-11`); `q`
  validated but never destructured or applied (real, `routes.ts:53` vs `:57`);
  portal history hardcoding `desc()` while echoing the requested `order` (real,
  `portal-routes.ts:72` vs `:80`); no DB-level `CHECK` on the ledger invariant
  (real). The uncommitted `M apps/chrono-api/src/auth/permissions.ts` in the
  working tree at the time was POS work, unrelated to wallet.
- 2026-09-02 — Phase 1 done, committed `a5377c5`. Five corrections to
  `wallet/README.md`: the permission block now shows
  `apps/chrono-api/src/auth/permissions.ts` with all three grant objects and
  the `registerAppPermissions()` bootstrap (plus an explicit "this module does
  not touch `packages/agora`" line); Open Question 1 marked RESOLVED as shipped,
  with the original reasoning kept for the record; Phase 3's Files-to-Update and
  Execution Start Point repointed to the app seam; both route-mount references
  corrected to `.route("/", walletRoutes())` (the factory declares its own full
  `/wallets/...` paths); and a new **lock-ordering rule** added to the exported-
  surface contract — acquire the wallet lock last, never hold it across an
  external call — with the `onConflictDoNothing` blocking behaviour spelled out
  as the reason. `wallet/HANDOVER.md`: Phase 3 row corrected to `done`, the
  header's claim that Phase 3 edits `packages/agora` rewritten rather than
  annotated, and a log entry recording the audit's real findings and the two
  false ones. Verified: `grep -rn "packages/agora/src/auth/permissions"` over
  the wallet plan folder returns nothing.
- 2026-09-02 — Phases 2–4 implemented and committed. **Phase 2** (`f9b3736`):
  both amount regexes bounded to 10 integer digits with `MAX_BALANCE`
  (`"9999999999.99"`, the `numeric(12,2)` ceiling) exported from `contracts.ts`,
  plus a cumulative magnitude guard on `balanceAfter` in `applyWalletDelta`
  — checked as a magnitude because an `adjustment` may legitimately drive the
  balance negative. Verified with an 11-assertion script: 11-digit amounts
  rejected, `9999999999.99` still accepted, zero/3dp still rejected, signed
  variants likewise, and cumulative overflow detectable at the cent boundary.
  **Phase 3** (`beab675`): `walletAuditMetadata()` helper feeding all three
  `recordStaffAudit` calls (member id, transaction id, amount, both balances,
  reason); `q` applied via `or(ilike(name), ilike(email))` to BOTH the rows
  query and the count query — the count needed the `innerJoin` added, without
  which `meta.totalItems` would have described the unfiltered set; portal
  history now applies the requested `order` instead of hardcoding `desc()`.
  **Phase 4** (`ac9a7cc`): pre-flight query first confirmed 0 invariant
  violations and 0 unknown-type rows, so `ADD CONSTRAINT` was safe; two
  `check()` constraints added to `chronoWalletTransaction`, migration
  `0010_add_wallet_ledger_checks.sql` reviewed before applying (exactly two
  `ADD CONSTRAINT` statements, no drops) and applied via `db:migrate`. Both
  constraints verified live against Postgres: a hand-written INSERT with a
  wrong `balanceAfter`, and one with `type = 'transfer'`, are each rejected by
  name.
- 2026-09-02 — **Verification gap to close: `test:wallet-concurrency` could
  not be re-run after Phase 4.** It passed cleanly twice during Phase 2 (4/4),
  then began failing with a *different* missing relation on each attempt —
  `ApiKeys`, then `ChronoDeviceProvisioningTokens`, then
  `AnnouncementDeliveries`. Confirmed NOT caused by this work: the same
  failure reproduces with the Phase 4 schema change stashed, and `tableDdl()`
  in the test harness does not emit check constraints at all, so the new
  constraints are inert for it. Root cause is environmental — a second Claude
  session was concurrently editing `apps/chrono-api/src/db/schema.ts` and
  running its own destructive suite against the same `TEST_DATABASE_URL`, so
  the harness's drop/recreate loop raced against a schema module changing
  under it (`AnnouncementDeliveries` is that session's new table, absent from
  the RLS list earlier in the same session). **Re-run
  `pnpm --filter @agora/chrono-api test:wallet-concurrency` once the tree is
  quiet and no other session is running; expect 4/4.** `typecheck`,
  `test:permissions` (354 passed), and `rls:proof` (`PASS ✅`, non-vacuous)
  all passed against the final state.
- 2026-09-02 — Confirmed with the developer that the wallet's per-tenant,
  non-transferable scoping is correct as built (a customer signs up globally via
  `agora/customer-auth`, applies to a tenant shop, and the wallet is keyed on
  the resulting `tenantMember.id`) — no scoping change is in scope here. The
  three balance "types" the developer described (cash / pricing-group time
  credit / rewards) map to three separate existing plans — `wallet` (cash,
  built), `credits` (station-group-scoped lots), `loyalty` (points) — and stay
  separate ledgers. A unified customer-facing view spanning all three is a
  separate plan, not yet written.

- 2026-09-02 — **Verification gap CLOSED. Plan complete.**
  `pnpm --filter @agora/chrono-api test:wallet-concurrency` re-run on a quiet
  tree (no concurrent session touching `db/schema.ts` or the shared
  `TEST_DATABASE_URL`): **4/4 passed** — no call rejected, final balance equals
  the arithmetic sum of every delta (50.00), transaction-row count equals the
  call count (20), and replaying the ledger in `createdAt` order reconstructs
  the same final balance. That was the last item outstanding on this plan
  (Phases 1-4 had already landed: `f9b3736`, `beab675`, `ac9a7cc`, plus the
  plan/handover correction).

  Standing caveat, unchanged and NOT a defect in this plan: `tableDdl()` in the
  test harnesses does not emit CHECK constraints, so migration `0010`'s two
  `check()` constraints are inert for the automated suite. They were verified
  live against Postgres by hand at the time (a wrong `balanceAfter` and a
  `type = 'transfer'` INSERT are each rejected by name). This is one instance of
  a broader shared-harness limitation — the same generator also drops the
  `WHERE` clause on partial unique indexes, which caused a false collision while
  building `reconciliation`'s route test. Worth a dedicated harness fix
  eventually; it belongs to no single feature plan.
