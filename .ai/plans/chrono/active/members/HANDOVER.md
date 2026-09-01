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
| 1 — Schema, RLS, APP_TENANT_TABLES | local | not started | — | not yet touched by this or any known session |
| 2 — Contracts | local | not started | — | depends on Phase 1 |
| 3 — Routes + permission gates | local | not started | — | depends on Phase 1 + 2 |
| 4 — Web UI | jules | not started | — | depends on Phase 3 (see log — started as UI-only prep ahead of Phase 3) |
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
