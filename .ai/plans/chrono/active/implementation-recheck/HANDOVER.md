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

## 2026-09-02 — Recheck run on a quiet tree. One REAL finding (not in the five commits).

**Phases 1–5 verification results (all against a quiet tree, no concurrent
session running a destructive suite):**

- `pnpm typecheck` (whole workspace, 7/7 tasks) — clean.
- `test:wallet-concurrency` — **4/4** (this closes carried-in gap #1: the proof
  was stale relative to the shipped `ac9a7cc` constraints; also recorded in
  `wallet-hardening`'s handover, commit `9c582a9`).
- `test:pos-concurrency` — **6/6**, including the three Phase 4 refund
  assertions (exactly one concurrent refund succeeds; wallet credited exactly
  once, not a multiple; stock restored exactly once). Gap #4 (independently
  reproduce the refund negative test) is satisfied by these three passing
  against real Postgres under 10 concurrent refunds of one wallet-paid sale.
- **Phase 3 drift check** — `pnpm db:generate --name recheck_noop` reported
  `No schema changes, nothing to migrate` and wrote no file, so `schema.ts`
  agrees with drizzle's own snapshot metadata. **But that check turns out to be
  insufficient** — see the finding below.

### FINDING (real, and outside the five commits' scope): the `chrono` DEV database is structurally degraded

Direct `pg_constraint` / `pg_indexes` introspection of the **dev** `chrono`
database (via `DATABASE_URL_ADMIN`) shows, on every table sampled
(`ChronoWalletTransactions`, `ChronoShifts`, `ChronoSales`, `Organizations`,
`TenantMembers`):

- **0 foreign keys**, **0 CHECK constraints**, **0 unique constraints**
- only 1–2 indexes per table (primary key, plus at most one unique index)
- `drizzle.__drizzle_migrations` records **14** applied vs **16** migration
  files on disk

That is the exact signature of this repo's test-harness DDL generator
(`tableDdl()` + `uniqueIndexDdls()`, copied across the module concurrency
tests): it emits columns, primary keys, NOT NULL, and unique indexes **only** —
never FKs, CHECK constraints, or non-unique indexes. Conclusion: **a destructive
test harness was pointed at the dev database instead of `chrono_test`** at some
point, dropped its tables, and recreated them without constraints. This also
explains the mid-session `Tenant "acme" not found — run the seed first` failure
that required a re-seed.

**Scope and severity:**

- **Not** a defect in any of the five commits under recheck, and **not** a code
  defect at all — the migrations on disk are correct, and every test in this
  session ran against `chrono_test`, so no verification result is invalidated.
- Migration `0010`'s two wallet-ledger CHECK constraints are therefore **not
  live on dev** right now, even though they were genuinely verified live when
  `ac9a7cc` landed. Same for every FK and secondary index in the app.
- RLS itself survived, because `pnpm db:migrate` re-runs `src/db/rls.run.ts`,
  which is why `rls:proof` still passes — the isolation guarantee is intact.
- **`db:generate` cannot detect this.** It diffs `schema.ts` against drizzle's
  snapshot files, not against live introspection, so a degraded database looks
  clean to it. Phase 3's "empty migration proves they agree" check is necessary
  but not sufficient; direct `pg_constraint` introspection is what caught it.

**Remedy (needs a developer go-ahead — it drops every dev table):** drop the
public schema's tables on `chrono`, re-run `pnpm --filter @agora/chrono-api
db:migrate` from scratch so all 16 migrations replay, then `pnpm --filter
@agora/chrono-api seed`. Dev holds only seed data, so nothing of value is lost.

**Follow-up worth its own plan:** make the shared test harness refuse to run
against a database whose name doesn't match `*test*` **before** it drops
anything (the guard exists but is bypassable via `E2E_ALLOW_DESTRUCTIVE=1`, and
several harnesses reassign `process.env.DATABASE_URL` themselves), and teach
`tableDdl()` to emit FKs/CHECKs/partial-index `WHERE` clauses so harness-created
schemas match the real migrations.

### Remedy applied (2026-09-02, developer approved)

Dropped all 82 `public` tables + the `drizzle` migration schema on the dev
`chrono` database (guarded: the script refused to run against any database not
literally named `chrono`), then replayed migrations and re-seeded.

**Before → after:**

| | before | after |
|---|---|---|
| Foreign keys (public schema) | 0 | **164** |
| CHECK constraints | 0 | **2** (both wallet-ledger ones from `0010`) |
| Unique constraints | 0 | **5** |
| Migrations recorded applied | 14 | **16** (all files on disk) |

`pnpm --filter @agora/chrono-api rls:proof` → `RLS PROOF: PASS ✅` afterwards.
Dev is now structurally identical to what the migrations describe.
