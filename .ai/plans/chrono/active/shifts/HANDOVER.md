# Shifts module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/shifts/README.md`.
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
| 1 — Schema, RLS, APP_TENANT_TABLES | local | done | — | `ChronoShifts`, built in an isolated agent worktree, wired into `APP_TENANT_TABLES` + migrated centrally by the orchestrator |
| 2 — Contracts | jules | done | 17681340080825818858 | discovered already fired + Completed by a concurrent session outside this run; pulled, matched spec verbatim, `pnpm --filter @agora/chrono-api typecheck` clean |
| 3 — Routes + permission gates | local | not started | — | |
| 4 — Web UI | jules | not started | — | |
| 5 — E2E spec | jules | not started | — | |

## Log

- 2026-09-01 — Firing Phase 2 (contracts) to Jules, part of a batch of five
  Wave-1 modules (`stations`, `shifts`, `devices`, `wallet`, `sessions`) fired
  sequentially in one orchestration pass per the developer's request for max
  safe parallelism. Before firing, `jules remote list --session` showed a
  session already `Completed` ~24 minutes prior — `17681340080825818858`,
  description "Create ONE new file: apps/chrono-api/src/modules/shift/cont…"
  — created by a different, concurrent Jules-firing process not visible to
  this session (no matching row existed yet in `.ai/handover/jules-sessions.md`
  and no `apps/chrono-api/src/modules/shift/contracts.ts` exists on disk).
  Rather than fire a duplicate session for the same phase (wasteful, and risks
  two divergent contracts files), recorded that pre-existing session here
  instead. **Not yet pulled or reviewed by this session** — the description
  match ("ONE new file" in the `shift` module folder) is consistent with this
  phase's own scope but has not been verified against the plan's actual
  acceptance criteria. Whoever picks up Phase 2 next should
  `jules remote pull --session 17681340080825818858`, review the diff against
  Pass 2's contract spec and this phase's acceptance criteria, run
  `pnpm --filter @agora/chrono-api typecheck`, then commit locally.
- 2026-09-01 — Pulled with `jules remote pull --session 17681340080825818858
  --apply`. `apps/chrono-api/src/modules/shift/contracts.ts` matches Pass 2's
  spec byte-for-byte (`shiftStatusSchema`, `moneyStringSchema`,
  `openShiftSchema`/`closeShiftSchema`/`listShiftsQuerySchema`, all four
  `z.infer` types). No local fixups needed. `pnpm --filter @agora/chrono-api
  typecheck` clean. Committed (`13f9271`). Phase 2 done.
- 2026-09-01 — **Session stopping here — developer is switching machines.**
  A background subagent (isolated worktree
  `.claude/worktrees/agent-aa2bd02d9159cc42d`, branch
  `worktree-agent-aa2bd02d9159cc42d`) built Phase 1
  (`apps/chrono-api/src/modules/shift/schema.ts` — `ChronoShifts`,
  `staffUserId` → `base.user.id` with `onDelete: "restrict"` (never
  cascade/set-null — a shift's cash-accountability history must not
  disappear), a partial unique index `chrono_shift_one_open_per_staff_idx`
  as a DB-level backstop for "one open shift per staff per branch" beyond
  the app-level check) but never wired it into `db/schema.ts` /
  `APP_TENANT_TABLES` or migrated it — that's the orchestrator's job per
  this round's safety split. The orchestrator: copied the schema file onto
  `main`, wired the export + `APP_TENANT_TABLES` entries, generated +
  reviewed + applied the migration
  (`0003_add_chrono_stations_and_shifts.sql`, shared with `stations` since
  both landed in the same pass — 3 tables total, FKs to
  `ChronoBranches`/`Users`, no destructive statements), re-ran the full
  verification gate (whole-monorepo typecheck clean, `rls:proof` PASS),
  committed (`12cd72f`), and pushed. The worktree itself has since been
  removed (its useful content is now on `main`; nothing else in it was
  uncommitted). **Remaining for the next session**: Phase 3 (routes +
  permission gates — build locally, never via Jules), Phase 4 (web UI,
  Jules), Phase 5 (e2e spec). Permission tier: **both** `staffRole` and
  `adminRole` get `shift: ["open", "close"]` (unlike `branch`/`station`,
  this is a floor-level action every tenant role performs — no admin-only
  split here). Shift open/close is deliberately unrestricted by branch in
  this pass (any staff may open/close a shift at any branch the tenant
  operates — see Pass 1). Read the plan's Pass 2 "Routes" section and copy
  `branches`' `apps/chrono-api/src/modules/branch/routes.ts` /
  `packages/agora/src/auth/permissions.ts` composition pattern for
  structure.
- 2026-09-02 — Phase 3 (routes + permission gates) landed. `shift: ["open",
  "close"]` was already registered in the per-app extension seam
  (`apps/chrono-api/src/auth/permissions.ts`'s `CHRONO_PERMISSION_STATEMENTS`/
  `CHRONO_STAFF_GRANTS`/`CHRONO_ADMIN_GRANTS` — both staff and admin hold it,
  no split, per this file's own note above), so no permissions.ts edit was
  needed this round. `routes.ts` (`GET /shifts`, `GET /shifts/current`,
  `POST /shifts/open`, `POST /shifts/:id/close`) was found already written
  but sitting uncommitted and unwired for several checks — reviewed against
  the plan's exact spec (branch-scoped 404s, same-branch/caller 409 on
  double-open, already-closed 409, `expectedCashAmount`/`differenceAmount`
  correctly left `null`), wired into `rpc.ts` via `.route("/",
  shiftRoutes())`, added the `shift` deny-by-default gate case to
  `permissions.test.ts`. `pnpm --filter @agora/chrono-api typecheck` clean,
  `test:permissions` → 333 passed, `rls:proof` → `RLS PROOF: PASS ✅`.
  Committed (`3422731`). Phase 3 done — Phase 4 (web UI) is next, Jules-eligible
  now that the backend is fully landed.
- 2026-09-02 — Phase 4 (web UI) delegated to Jules (session
  `17199632847637106987`, see `.ai/handover/jules-sessions.md`):
  `dashboard/shifts/page.tsx` + `layout.tsx` nav entry, mirroring
  `branches/page.tsx`. `layout.tsx` is also touched by the still-unpulled
  `stations` Phase 4 diff (parked in scratch, Failed session) and by an
  in-flight local nav restructuring — expect a manual merge across all three
  once they land. Background poller running. Phase 5 (e2e spec) not started.
- 2026-09-02 — Session Completed. Diff parked in scratch (same reason as
  `stations`' own entry) until the local nav restructuring landed (`faa856d`).
  Applied via `git apply --reject`: the icon import (`Clock`) and `TITLES`
  entry applied cleanly, the `BASE_NAV` hunk conflicted with the restructured
  file (context lines shifted) — added the `Shifts`/`Clock` nav item by hand,
  in the same pass as `stations`' own nav entry (both landed in one merge
  since they touch the identical file/region). `pnpm --filter
  @agora/chrono-web typecheck` and `build` both clean. Committed (`ea201d3`,
  combined with stations). Phase 4 done. Phase 5 (e2e spec) not started.
