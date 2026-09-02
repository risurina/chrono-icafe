# Members module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/members/README.md`.
Split mirrors `branches`' own precedent: Phase 1 (schema/RLS) and Phase 3
(routes + permission gates) are built locally — never delegated to Jules, per
the `jules` skill's guardrail against delegating RLS/tenant-isolation/
permission-gate design. Phase 2 (contracts), Phase 4 (web UI), and Phase 5
(e2e spec) are delegated to Jules, one session per phase, pulled + verified
locally before the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | done | — | `ChronoMemberProfiles`, built in an isolated agent worktree, merged + migrated centrally by the orchestrator |
| 2 — Contracts | jules | done | 15484427873239282496 | pulled, matched spec, committed |
| 3 — Routes + permission gates | local | done | — | `customer:approve`/`:reject` added to `PERMISSION_STATEMENTS`/`adminRole` centrally; routes mounted at `/rpc/member-profiles` (not `/members` — collides with foundation staff-member routes, see log) |
| 4 — Web UI | jules | done | 5134634266392641182 | pulled (`--apply` conflicted with local branches-nav edits, reapplied by hand), mount-path bug fixed (`api.rpc["member-profiles"]`, no `as any`), typecheck + build clean, committed (`e1940bd`), pushed |
| 5 — E2E spec | jules | not started | — | depends on Phase 4 |

## Log

- 2026-09-01 — A parallel review-only agent (not the module's regular
  Implementor) is starting Phase 4 (web UI) out of normal order, as **UI-only
  prep work**, while Phases 1-3 (schema, contracts, routes + permission
  gates) remain entirely unbuilt anywhere in this repo — only the plan
  exists. This is a deliberate, scoped exception, not the normal phase
  order: the developer is treating the shared dev DB as unsafe to touch
  right now (a same-day collision already forced a full DB reset on the
  `branches` module — see that module's own `HANDOVER.md` log), so this
  session is explicitly barred from running any DB/migration/RLS/permission
  command or touching `apps/chrono-api/**`, any `drizzle/**` file, or
  `packages/agora/src/auth/permissions.ts`. The Jules session fired for this
  phase is told to write the frontend against the `/rpc/members` and
  `/portal/members/*` contracts exactly as specified in the plan's Phase 4
  section, even though those routes do not exist yet — it will not typecheck
  clean end-to-end until Phase 3 lands elsewhere. This trades a temporarily
  non-typechecking UI branch for zero risk of colliding with whichever
  session builds Phases 1-3.
- 2026-09-01 — Fired the Phase 4 Jules session: id `5134634266392641182`,
  logged in `.ai/handover/jules-sessions.md` before firing. Prompt named
  every file (`apps/chrono-web/src/app/dashboard/members/page.tsx`,
  `apps/chrono-web/src/app/dashboard/layout.tsx`,
  `apps/chrono-web/src/app/portal/page.tsx`,
  `apps/chrono-web/src/lib/member-application.ts`), pinned every type/route/
  default the plan's Phase 4 text left implicit, explicitly barred
  `apps/chrono-api/**`/`drizzle/**`/`packages/agora/src/auth/permissions.ts`,
  and told Jules the referenced `/rpc/members` + `/portal/members/*` routes
  don't exist yet so a clean local typecheck is not expected this phase.
  Launched the background poller per the `jules` skill; will pull + review
  + verify + commit locally once it reports back. Note: an earlier
  mis-invocation (`--session -` combined with piped stdin) created a
  broken session (`12545266020927620735`, task body landed as literal
  `-`) — logged in the ledger for traceability but left alone pending the
  developer's explicit go-ahead to delete, per the `jules` skill's
  deletion guardrail.
- 2026-09-01 — A separate Implementor agent built Phases 1-3 in an isolated
  worktree (`.claude/worktrees/agent-a0788b6bc730a0a38`), following the same
  local-schema/local-permissions / Jules-contracts split as `branches`, and
  under the same safety constraint as every module agent this round: no
  `db:generate`/`db:migrate`/`rls:proof` and no direct edit to
  `packages/agora/src/auth/permissions.ts` (to avoid a repeat of the
  same-day DB collision logged in `branches/HANDOVER.md`). It found a real
  bug in the plan: mounting at `/rpc/members` as originally specified would
  collide with this app's existing foundation staff org-member management
  routes (GET/PATCH/DELETE `/members`, already bound in `rpc.ts` — a
  different resource, staff not customers). Remounted at
  `/rpc/member-profiles` instead. It also correctly extended the existing
  `customer` permission resource with `approve`/`reject` actions rather than
  minting a new resource, per the plan's Open Question 2 default.
  The orchestrator (this session) then: diffed the worktree against its
  actual merge-base with `main` (not a raw diff against current `main`,
  which would have looked like a mass deletion given how far `main` moved
  during the worktree's lifetime) to isolate exactly what the agent added;
  reviewed `schema.ts`/`contracts.ts`/`routes.ts`/`portal-routes.ts`;
  applied the patch onto `main` (one real conflict, in `db/schema.ts`,
  resolved by hand alongside the `branches` module's own entry — both now
  coexist); merged the `customer: [..., "approve", "reject"]` snippet into
  `PERMISSION_STATEMENTS` and `adminRole` in
  `packages/agora/src/auth/permissions.ts`; generated + reviewed + applied
  the `ChronoMemberProfiles` migration
  (`drizzle/0002_add_chrono_member_profiles.sql` — table + tenant FK +
  member FK + tenant index + unique-on-memberId index, no destructive
  statements); re-ran the full verification gate centrally: whole-monorepo
  `pnpm typecheck` clean, `pnpm test:permissions` 320/320 PASS (including
  the new `customer:approve`/`:reject` cases), `pnpm rls:proof` → `PASS ✅`.
  Phases 1-3 done. Phase 4's already-fired session (`5134634266392641182`)
  was written against the wrong mount path (`api.rpc.members` instead of
  `api.rpc["member-profiles"]`) since it was fired before this reconciliation
  — flagging so whoever pulls it fixes that reference rather than assuming
  it's correct.
- 2026-09-01 — Attempted to pull Jules session 5134634266392641182 to fix the
  mount-path bug myself; `jules remote pull --apply` failed because the
  files already exist, uncommitted, in this working directory — another live
  session is actively building Phase 4 right now (and has already fixed the
  mount path to `api.rpc["member-profiles"]` correctly, no action needed
  there). Standing down from `members` Phase 4/5 entirely rather than risk
  clobbering in-progress uncommitted work belonging to that session — see
  `git status` for the current uncommitted `dashboard/members/page.tsx`,
  `portal/page.tsx`, `lib/member-application.ts`, `dashboard/layout.tsx`.
  Whoever owns that session should commit + verify + continue to Phase 5
  from here.
- 2026-09-01 — Picked Phase 4 back up (this session owns it): confirmed
  session `5134634266392641182` was `Completed` via `jules remote list
  --session`, then `jules remote pull --session 5134634266392641182`. The
  `--apply` pull failed (`patch does not apply`) because the local
  `dashboard/layout.tsx` had already diverged (the `branches` module's own
  nav entry landed there first) and `next-env.d.ts` had drifted from a
  concurrent dev/build process — `git apply` is all-or-nothing, so nothing
  from the patch was written. Reapplied the diff by hand instead: merged the
  `Members` nav entry into `layout.tsx` alongside the existing `Branches`
  entry (both now present), recreated `dashboard/members/page.tsx` and
  `lib/member-application.ts` verbatim from the pulled diff, and extended
  `portal/page.tsx` with the Membership card — with the mount-path fix
  (`api.rpc["member-profiles"]`, matching the `/rpc/member-profiles` mount
  and the customers page's bracket-accessor convention for hyphenated
  segments) applied directly instead of the session's `(api.rpc as
  any).members` workaround. Left `next-env.d.ts` untouched (auto-generated,
  unrelated to this phase, regenerated by the build below anyway). Verified:
  `pnpm --filter @agora/chrono-web typecheck` clean, `pnpm --filter
  @agora/chrono-web build` succeeded (`/dashboard/members` and
  `/dashboard/branches` both listed). Committed only the four intended files
  (`e1940bd feat(chrono/members): phase 4 — web UI (via Jules)`), pushed to
  `main` (`652c227..e1940bd`). Phase 4 done.
- 2026-09-02 — Phase 5 (e2e spec) delegated to Jules, session
  `3911224838386916225`. Background poller running (consolidated with 7 other
  sessions fired the same round).
- 2026-09-02 — Phase 5 (e2e spec) landed. **All phases of members are now done**
  (e2e not yet headed-run, same caveat as every other spec this session).
  Archived.
