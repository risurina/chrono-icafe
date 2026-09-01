# Devices module — implementation handover

Tracks phase-by-phase progress for `.ai/plans/chrono/active/devices/README.md`.
This plan has **six** phases, not five like `branches`/`stations`/`shifts` —
see the plan's own phase headers. Split: Phase 1 (schema/RLS) is local, never
delegated to Jules, per the `jules` skill's guardrail against delegating RLS/
tenant-isolation design. Phase 3 (the device-auth bearer middleware) is ALSO
kept local, even though it isn't itself an RLS/schema change — the plan's own
opening section ("Read this before anything else") flags it as genuinely novel
territory (the first non-human, non-session, non-API-key actor this codebase
authenticates; the first module-local auth middleware; the first `withAdmin`
credential lookup outside `packages/agora`) that must be reviewed with the
developer before it's written, not handed to an async agent. Phase 4 (staff-
facing routes + permission gates) is local per the same permission-gate
guardrail as every other module. Phase 2 (contracts), Phase 5 (web UI), and
Phase 6 (e2e spec) are delegated to Jules, one session per phase, pulled +
verified locally before the next phase starts.

Jules session ids for this plan are recorded in `.ai/handover/jules-sessions.md`
(`origin: phase`, `ref` pointing back to the phase row below).

## Phase status

| Phase | Owner | Status | Jules session id | Notes |
|---|---|---|---|---|
| 1 — Schema, RLS, APP_TENANT_TABLES | local | not started | — | |
| 2 — Contracts | jules | fired | 3256782646737173899 | |
| 3 — Device-auth middleware + device-facing routes | local | not started | — | genuinely novel design, confirm Open Question 1 with developer before starting — see plan's own opening warning |
| 4 — Staff-facing routes + permission gates | local | not started | — | resolve Open Question 2 (staff vs admin+ tier) first |
| 5 — Web UI | jules | not started | — | |
| 6 — E2E spec | jules | not started | — | |

## Log

- 2026-09-01 — Firing Phase 2 (contracts) to Jules, part of a batch of five
  Wave-1 modules (`stations`, `shifts`, `devices`, `wallet`, `sessions`) fired
  sequentially in one orchestration pass per the developer's request for max
  safe parallelism. Confirmed via `jules remote list --session` beforehand
  that no session already existed for this module's Phase 2 (unlike
  `stations`/`shifts`, which turned out to already have concurrent sessions
  fired elsewhere — see those modules' own `HANDOVER.md` logs). Prompt named
  every file (`apps/chrono-api/src/modules/device/contracts.ts` only), inlined
  the exact Zod schemas from the plan's Pass 2 "Contracts" section verbatim,
  explicitly barred `packages/agora/src/auth/permissions.ts`,
  `apps/chrono-api/src/db/schema.ts`, `apps/chrono-api/src/routes/rpc.ts`, the
  device-auth middleware, and any route file. Launched the background poller
  per the `jules` skill immediately after firing. Session id:
  `3256782646737173899`.
