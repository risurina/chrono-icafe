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
| 2 — Bound money amounts (contract + cumulative) | local | not started | `numeric(12,2)` max is `9999999999.99` |
| 3 — Route correctness (audit metadata, `q` search, portal sort) | local | not started | |
| 4 — Ledger integrity constraints (migration) | local | not started | run the pre-flight violation query BEFORE editing the schema |

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
- 2026-09-02 — Confirmed with the developer that the wallet's per-tenant,
  non-transferable scoping is correct as built (a customer signs up globally via
  `agora/customer-auth`, applies to a tenant shop, and the wallet is keyed on
  the resulting `tenantMember.id`) — no scoping change is in scope here. The
  three balance "types" the developer described (cash / pricing-group time
  credit / rewards) map to three separate existing plans — `wallet` (cash,
  built), `credits` (station-group-scoped lots), `loyalty` (points) — and stay
  separate ledgers. A unified customer-facing view spanning all three is a
  separate plan, not yet written.
