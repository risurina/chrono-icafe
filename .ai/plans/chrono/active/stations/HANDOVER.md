# Stations module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/stations/README.md`.
Split mirrors `branches`'/`members`' own precedent: Phase 1 (schema/RLS) and
Phase 3 (routes + permission gates) are built locally — never delegated to
Jules, per the `jules` skill's guardrail against delegating RLS/tenant-
isolation/permission-gate design. Phase 2 (contracts), Phase 4 (web UI), and
Phase 5 (e2e spec) are delegated to Jules, one session per phase, pulled +
verified locally before the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | done | — | `ChronoStationGroups`/`ChronoStations`, built in an isolated agent worktree, wired into `APP_TENANT_TABLES` + migrated centrally by the orchestrator |
| 2 — Contracts | jules | done | 13241878054430550156 | discovered already fired + Completed by a concurrent session outside this run; pulled, matched spec verbatim, `pnpm --filter @agora/chrono-api typecheck` clean |
| 3 — Routes + permission gates | local | not started | — | |
| 4 — Web UI | jules | not started | — | |
| 5 — E2E spec | jules | not started | — | |

## Log

- 2026-09-01 — Firing Phase 2 (contracts) to Jules, part of a batch of five
  Wave-1 modules (`stations`, `shifts`, `devices`, `wallet`, `sessions`) fired
  sequentially in one orchestration pass per the developer's request for max
  safe parallelism. Before firing, `jules remote list --session` showed a
  session already `Completed` ~20 minutes prior — `13241878054430550156`,
  description "Implement Phase 2 of .ai/plans/chrono/active/stations/README…"
  — created by a different, concurrent Jules-firing process not visible to
  this session (no matching row existed yet in `.ai/handover/jules-sessions.md`
  and no `apps/chrono-api/src/modules/station/contracts.ts` exists on disk).
  Rather than fire a duplicate session for the same phase (wasteful, and risks
  two divergent contracts files), recorded that pre-existing session here
  instead. **Not yet pulled or reviewed by this session** — the description
  match is strong evidence of correct scope but has not been verified against
  the plan's actual acceptance criteria. Whoever picks up Phase 2 next should
  `jules remote pull --session 13241878054430550156`, review the diff against
  Pass 2's contract spec and this phase's acceptance criteria, run
  `pnpm --filter @agora/chrono-api typecheck`, then commit locally.
- 2026-09-01 — Pulled with `jules remote pull --session 13241878054430550156
  --apply`. `apps/chrono-api/src/modules/station/contracts.ts` matches Pass
  2's spec byte-for-byte (all schemas, `updateStationSchema`/
  `updateStationGroupSchema` correctly `.omit({branchId: true})`+`.partial()`,
  `stationStatusSchema` accepts only `available`/`maintenance`/`offline`). No
  local fixups needed. `pnpm --filter @agora/chrono-api typecheck` clean.
  Committed (`20cbf1d`). Phase 2 done.
- 2026-09-01 — **Session stopping here — developer is switching machines.**
  A background subagent (isolated worktree
  `.claude/worktrees/agent-a5849a17554c6e4c2`, branch
  `worktree-agent-a5849a17554c6e4c2`) built Phase 1
  (`apps/chrono-api/src/modules/station/schema.ts` — `ChronoStationGroups` +
  `ChronoStations`, branch-scoped, flat hourly-rate baseline not the full
  oikos pricing-rule engine, `status` free-text with `occupied` reserved for
  `sessions`/`devices` later) but never wired it into `db/schema.ts` /
  `APP_TENANT_TABLES` or migrated it — that's the orchestrator's job per this
  round's safety split. The orchestrator: copied the schema file onto `main`,
  wired the export + `APP_TENANT_TABLES` entries, generated + reviewed +
  applied the migration (`0003_add_chrono_stations_and_shifts.sql`, shared
  with `shifts` since both landed in the same pass — 3 tables, FKs to
  `ChronoBranches`, no destructive statements), re-ran the full verification
  gate (whole-monorepo typecheck clean, `rls:proof` PASS), committed
  (`12cd72f`), and pushed. The worktree itself has since been removed (its
  useful content is now on `main`; nothing else in it was uncommitted).
  **Remaining for the next session**: Phase 3 (routes + permission gates —
  build locally, never via Jules, per this file's own split), Phase 4 (web
  UI, Jules), Phase 5 (e2e spec). Note the permission tier is DIFFERENT from
  `branches`: staff gets `station: ["create", "update"]` (day-to-day floor
  management, oikos precedent), admin+ adds `"delete"`. Unlike `branches`
  (status-flip only, never deleted), stations **does** support a real
  `DELETE /rpc/stations/:id` (admin+ only) — don't copy `branches`' no-delete
  pattern here. Read the plan's Pass 2 "Routes" section and copy `branches`'
  `apps/chrono-api/src/modules/branch/routes.ts` /
  `packages/agora/src/auth/permissions.ts` composition pattern for structure
  (not for permission tier — see above).
