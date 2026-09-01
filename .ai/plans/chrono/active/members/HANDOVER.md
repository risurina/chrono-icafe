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
| 4 — Web UI | jules | fired (out of order) | 5134634266392641182 | fired as UI-only prep ahead of Phases 1-3 landing; **must be re-checked against the real mount path `api.rpc["member-profiles"]`, not `api.rpc.members`, once pulled** |
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
