# Branches module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/branches/README.md`.
Split decided with the developer: Phase 1 (schema/RLS) and Phase 3 (routes +
permission gates) are built locally — never delegated to Jules, per the `jules`
skill's guardrail. Phase 2 (contracts), Phase 4 (web UI), and Phase 5 (e2e spec)
are delegated to Jules, one session per phase, pulled + verified locally before
the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | done | — | verified: typecheck clean, `rls:proof` PASS |
| 2 — Contracts | jules | done | 9478133839450940176 | pulled, fixed `socialLinks` missing `.optional()` locally, typecheck clean |
| 3 — Routes + permission gates | local | not started | — | depends on Phase 1 + 2 |
| 4 — Web UI | jules | not started | — | depends on Phase 3 |
| 5 — E2E spec | jules | not started | — | depends on Phase 4 |

## Log

- 2026-09-01 — Plan reviewed. Only one active plan in `.ai/plans/chrono/active/`
  (`branches`). Confirmed hybrid split with developer (local for schema/RLS +
  permission-gate phases, Jules for contracts/UI/e2e-spec-writing). Starting
  Phase 1 locally.
- 2026-09-01 — Phase 1 blocked mid-migration: the shared dev DB had a leftover
  `"Branches"` table (7 rows, forced RLS, non-Chrono-prefixed name) from an
  abandoned pre-reset `chrono` git branch, whose index names collided with the
  new `ChronoBranches` migration. Developer confirmed dropping it. Further
  investigation then found a full, uncommitted set of other Chrono module
  tables already live in the same DB (`ChronoStations`, `ChronoDevices` +
  device-auth/session/login-request tables, `ChronoShifts`, `ChronoWallets`,
  `ChronoWalletLedgers`, `ChronoUserBranchAccesses`) with no matching code
  anywhere in this working directory or git history — evidence of another
  Implementor session (likely a different machine, per the developer's
  multi-machine workflow) writing directly against the same shared dev
  database without syncing back to git. Developer directed a full reset:
  dropped every table in `public` + the `drizzle` migration-tracking schema,
  then re-ran `db:migrate` (0000_init_schema + 0001_add_chrono_branches) +
  `db:rls` + `seed` from a clean slate. **Net effect: the shared dev DB now
  reflects only what's on `main` in this working directory** (foundation
  tables + `ChronoBranches`) — any of that other session's unsynced schema
  work is gone from this DB and will need to be re-applied through its own
  plan + migration once/if it lands here. Flagging for whoever owns that other
  session.
- 2026-09-01 — Phase 1 verified: `pnpm typecheck` clean, `pnpm db:migrate`
  applied `ChronoBranches` with forced RLS, `pnpm rls:proof` → `PASS ✅`.
  Phase 1 done. Starting Phase 2 (contracts) via Jules.
