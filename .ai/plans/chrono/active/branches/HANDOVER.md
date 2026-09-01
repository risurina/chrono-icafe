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
| 3 — Routes + permission gates | local | done | — | typecheck clean (whole monorepo), test:permissions 314/314 PASS, rls:proof PASS |
| 4 — Web UI | local | done | 2577307037069386547 (abandoned — see log) | typecheck + build clean |
| 5 — E2E spec | local | done | — | written locally (mechanical, no round-trip through Jules needed); not run — this suite is manual/headed per `.ai/rules/rbac.md`, requires `pnpm dev` |

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
- 2026-09-01 — Phase 2: Jules session 9478133839450940176 completed and was
  pulled (`--apply`). One deviation from the plan fixed locally:
  `branchSocialLinksSchema` was missing its `.optional()` wrapper (Jules
  dropped it), which would have made `socialLinks` a required field on
  create — restored per plan Pass 2. Typecheck clean. Phase 2 done.
- 2026-09-01 — Phase 3 built locally: `packages/agora/src/auth/permissions.ts`
  gets `branch: ["create", "update"]` added to `PERMISSION_STATEMENTS` and to
  `adminRole` (Open Questions 1 & 2 resolved as the plan's stated default —
  shared foundation file, admin+ tier; `staffRole` deliberately excluded, no
  staff mutation exists). `apps/chrono-api/src/modules/branch/routes.ts`
  mirrors `domainRoutes()`/`apiKeyRoutes()`'s composition pattern (no own
  `tenantMiddleware()` call, composed via `.route("/", branchRoutes())`, full
  internal paths) rather than the plan's literal
  `.route("/branches", branchRoutes())` text, which would have double-prefixed
  — this matches the actual dominant codebase convention the plan itself says
  to follow ("exact structure of the project/customer blocks"). Added a
  `branch` gate case (staff denied, admin/owner allowed, both actions) to
  `apps/chrono-api/src/e2e/permissions.test.ts`. Verified: whole-monorepo
  `pnpm typecheck` clean, `pnpm test:permissions` 314/314 PASS, `pnpm
  rls:proof` → `PASS ✅`. Phase 3 done.
- 2026-09-01 — Note: my `git commit` for Phase 3 raced with a concurrent
  session also committing directly to this same `main` checkout (a
  members-module reviewer/logger agent — see `members/HANDOVER.md`). My
  staged Phase 3 files landed inside that session's own commit
  (`559311f docs(chrono/members): record Phase 4 Jules session id
  5134634266392641182`) instead of under my intended message — confirmed via
  `git log --oneline -- apps/chrono-api/src/modules/branch/routes.ts`. No
  content lost (re-verified typecheck/test:permissions/rls:proof all clean
  after). Left the history as-is rather than rewriting shared `main` history
  other concurrent sessions may already be building on. Flagging for
  visibility only.
- 2026-09-01 — Phase 4: fired Jules session 2577307037069386547 (the prompt
  assumed the branch backend was visible to Jules since it's "already
  implemented and merged to main" — true locally, but Jules clones GitHub
  `main`, and nothing had been pushed yet). The session stalled at "Awaiting
  User Feedback" with a clarifying question before producing any diff, and
  no Playwright/browser MCP tool was available in this session to read or
  answer it (the `jules` skill's documented workaround for replying to a
  stalled session). Raised this as a broader operational question — pushing
  to GitHub was local-only up to this point across every module — and the
  developer confirmed: push now and after each phase going forward, for
  every module. Pushed `main` (`5dea063..11bb2cf`) immediately after. For
  this specific stalled session, the developer directed abandon-and-build-
  locally rather than debug it further; marked `Awaiting User Feedback` in
  the ledger (not deleted — no diff ever existed to lose). Building Phase 4
  locally instead, to the same spec that was in the abandoned prompt.
  `apps/chrono-web/src/app/dashboard/branches/page.tsx` (list + create/edit
  Dialog with every field from the plan + inline enable/disable status
  toggle) and the `Branches` nav entry in `dashboard/layout.tsx`, mirroring
  `dashboard/projects/page.tsx`'s pattern exactly. `pnpm --filter
  @agora/chrono-web typecheck` and `build` both clean. Phase 4 done.
- 2026-09-01 — Phase 5: wrote
  `apps/chrono-web/e2e/tests/branches/branches.spec.ts` locally (mechanical
  adaptation of `data-listing/projects-listing.spec.ts`'s structure —
  straightforward enough not to round-trip through Jules). Added
  `aria-label`s to the Edit/Disable/Enable row action buttons in
  `branches/page.tsx` for reliable multi-row selectors, matching the
  `Delete ${p.name}` pattern on the Projects page. Four cases: happy path
  (create with name-only → confirms auto-generated `code`, edit, disable —
  row stays listed), search/sort/grid-view URL state, role gate (staff lists
  but create is refused, no row added), tenant isolation. Uses `faker`
  per `.ai/rules/e2e-testing.md`, not `Date.now()`. `pnpm --filter
  @agora/chrono-web typecheck` clean. **Not run** — per
  `.ai/rules/rbac.md`'s "Testing" section this suite is manual/headed with
  no `webServer` in the Playwright config; running it needs `pnpm dev`
  already up, which wasn't started here to avoid resource contention with
  the other module agents' background builds running concurrently. Phase 5
  written; execution is the developer's/next session's to run. All five
  phases of `branches` are now done.
