# Implementation re-check — handover

Tracks `.ai/plans/chrono/active/implementation-recheck/README.md`.

**This plan verifies; it does not remediate.** A defect found here is filed
against the owning module's plan with file:line evidence, not fixed in place.

**Do not run any concurrency phase while another session is active** — the
shared `TEST_DATABASE_URL` gets dropped and recreated underneath the run. See
"Environmental preconditions" in the README.

## Phase status

| Phase | Commit under review | Status | Result |
|---|---|---|---|
| 1 — Wallet money bounds | `f9b3736` | not started | |
| 2 — Wallet route changes | `beab675` | not started | |
| 3 — Ledger constraints + migration drift | `ac9a7cc` | not started | **highest risk — migration already applied to the DB** |
| 4 — POS refund fix | `f756dca` | not started | re-run the negative test independently |
| 5 — Plan/doc corrections | `a5377c5` | not started | |
| 6 — Close the wallet e2e gap | — | not started | mandatory per `.ai/rules/e2e-testing.md`; owed by the `wallet` plan |

## Log

- 2026-09-02 — Plan created at the developer's request after deciding to KEEP
  five commits that were made during an audit session by an agent whose role in
  this repo is planning and plan-audit only, not implementation
  (`.ai/rules/feature-planning.md`, and the standing feedback recorded in
  memory). The commits are kept; this plan exists so they receive the review
  they bypassed. Nothing here re-does the work.
- 2026-09-02 — Four verification gaps carried in from the authoring session's
  own account, all of which must be independently confirmed rather than trusted:
  (1) `test:wallet-concurrency` was never re-run after the `ac9a7cc`
  constraints landed — it passed twice BEFORE them, so the proof is stale
  relative to the shipped schema; (2) `tableDdl()` in the concurrency harnesses
  does not emit CHECK constraints, so `0010` is exercised by no automated
  suite; (3) no `wallet` e2e spec exists anywhere under
  `apps/chrono-web/e2e/tests/`; (4) workspace `typecheck` was red from an
  unrelated in-progress `voucher/routes.ts` in another session, so "clean" was
  only ever established for the touched modules.
- 2026-09-02 — Phase 3 is called out as highest-risk deliberately: migration
  `0010_add_wallet_ledger_checks.sql` has ALREADY been applied to the database.
  The failure mode to look for is not a missing constraint but **drift** — the
  live `pg_constraint` definitions disagreeing with
  `modules/wallet/schema.ts` — because a later `db:generate` would then try to
  re-add what already exists. The `db:generate --name recheck_noop` →
  empty-migration check is the cheap way to prove they agree; delete the
  generated file, do not commit it.
- 2026-09-02 — Phase 4 note: the authoring session reported running the negative
  test (removing `.for("update")` → all 10 concurrent refunds succeeded, wallet
  90.00 → 190.00 instead of 100.00, stock 14 instead of 5). That is the only
  evidence the new regression test is not vacuous, and it was produced by the
  same session that wrote the test. **Reproduce it independently** — a
  concurrency test that passes with the guard removed is testing plumbing, the
  same way a permission test that passes with the grant removed is
  (`.ai/rules/rbac.md`).
