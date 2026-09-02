# Reservations — implementation handover

**All 5 phases done, committed, on `main` (local, not pushed).**

- 2026-09-01 — Phases 1-3 landed and committed: schema/RLS (`28a4a44`), Zod contracts
  (`9562ec8`), routes + permission gates + an overlap concurrency test (`7862d14`,
  `4dae5ce`). Backend is done.
- 2026-09-01 — **⚠️ Phase 4 collision, resolved in favor of the local build.** A
  Jules session (`15408613030576279092`) was fired for Phase 4 (web UI) by a
  concurrent session — see the now-stale note this replaces. Independently, a
  different concurrent orchestrator built Phase 4 **locally** the same day:
  `packages/agora/src/ui/components/date-time-input.tsx` (new `DateTimeInput`
  primitive, `7fe3680`) + `dashboard/reservations/page.tsx` + `layout.tsx` nav
  entry (`5d6f16e`). **The local build landed on `main` first.** Do NOT pull
  Jules session `15408613030576279092` — its diff would duplicate/conflict with
  the already-committed Phase 4 work. Mark that session abandoned (same
  disposition as `2577307037069386547` in `.ai/handover/jules-sessions.md`) once
  you've confirmed with whoever fired it.
- 2026-09-01 — Phase 5 (e2e spec) landed: `2a6bb4c`,
  `apps/chrono-web/e2e/tests/reservations/reservations.spec.ts` — happy path,
  tenant-membership gate (no role split this pass — see Open Question 7), tenant
  isolation. **Not yet run** — the plan's own acceptance criterion ("no `.env`
  present in `apps/chrono-api` while running, drives an in-process PGlite
  harness") is now stale: a real dedicated `chrono` Neon project + `.env` exist
  on this machine (set up for the Phase 1 migration and Phase 3 overlap test),
  so `pnpm dev` connects to that real database, not PGlite. Developer to decide:
  run the spec against the real dev DB as-is, or temporarily move `.env` aside
  for a clean PGlite-backed run, before calling Phase 5 verified.

**Next up:** run/verify the Phase 5 spec per the above, then move this plan from
`active/` to `archive/` per `.ai/rules/feature-planning.md`'s Plan Closure step.

---

## 2026-09-02 — Un-archived: the concurrency guarantee this plan claimed was never real

This plan was archived while its own stated next step ("run/verify the Phase 5
spec") was never actually done, and its Phase 3 "Overlap concurrency" section
specced a `SELECT ... FOR UPDATE` pre-check (`assertNoOverlap`, routes.ts) as
the load-bearing guarantee against double-booking. The cross-plan
`audit-remediation` review (`.ai/plans/chrono/active/audit-remediation/README.md`,
Phase 2) found that guarantee does not hold: `FOR UPDATE` can only lock a row
that already exists, so a station's **first** reservation of a given window can
still be double-booked — there is no existing row for the second concurrent
request to block on. `overlap.test.ts` also silently skipped without
`TEST_DATABASE_URL` set, so this was never actually proven to fail or pass
under real concurrency before archival.

**Fixed as `audit-remediation` Phase 2** (see that plan for full detail):

- Added a genuine Postgres exclusion constraint,
  `chrono_reservation_no_overlap` — `EXCLUDE USING gist ("tenantId" WITH =,
  "stationId" WITH =, tsrange("startAt", "endAt", '[)') WITH &&) WHERE (status
  IN ('confirmed', 'checked_in'))` — via `btree_gist`, hand-written into
  `apps/chrono-api/drizzle/0011_add_reservation_overlap_exclusion.sql` (Drizzle
  has no EXCLUDE API). This, not the row lock, is now the real guarantee;
  `assertNoOverlap` stays only as a friendly fail-fast pre-check.
- `routes.ts` now maps Postgres `23P01` (exclusion_violation) to the same 409
  the pre-check throws, on both create and update.
- `overlap.test.ts` now applies this same constraint to its own schema setup
  (it previously only replayed Drizzle's table config, which cannot express
  EXCLUDE, so the constraint was never present when the test ran) and adds a
  boundary case proving the half-open `[start, end)` interval: a booking
  ending exactly at 14:00 does not conflict with one starting at 14:00.
- Confirmed `TEST_DATABASE_URL` is set in `apps/chrono-api/.env` and the test
  genuinely runs (not skips) — verified deterministic across two consecutive
  runs, all 6 checks passing both times.
- Pre-flight check against the real chrono database found zero existing
  overlapping reservation rows, so `ADD CONSTRAINT` applied cleanly.

**Status now:** the double-booking guarantee is real and proven. Re-archive
once a developer has independently confirmed this note and the
`audit-remediation` Phase 2 commit.
