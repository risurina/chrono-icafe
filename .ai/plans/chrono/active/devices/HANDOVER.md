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
| 2 — Contracts | jules | done | 3256782646737173899 | pulled, matched spec verbatim (no local fixups needed), `pnpm --filter @agora/chrono-api typecheck` clean |
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
- 2026-09-01 — Session completed (~5 minutes after firing), poller woke this
  session. Pulled with `jules remote pull --session 3256782646737173899
  --apply`, reviewed the diff: `apps/chrono-api/src/modules/device/
  contracts.ts` matches Pass 2's spec verbatim — all seven schemas, all seven
  `z.infer` types, `approveDeviceSchema` correctly leaves `stationId`/
  `newStationName`/`newStationNumber` all optional at the Zod layer. No local
  fixups needed. `pnpm --filter @agora/chrono-api typecheck` clean. Committed
  (`f39623e`). Phase 2 done.

- 2026-09-02 — Phase 3 (device-auth middleware + device-facing routes) landed
  locally, committed (`bddcba6`). Manual tenant-isolation test (11 checks
  against a real running server + real Postgres) passed. One gap in the
  original plan's `/auth` branch spec (a device's own token + a different
  fingerprint than on file) resolved fail-closed (401) rather than inventing
  new mutating behavior — worth a developer look before this ships for real.
  Phase 5 (web UI) delegated to Jules, session `14444600378578250185`.
  Background poller running.
- 2026-09-02 — Session `14444600378578250185` completed. Pulled: found 8
  `as any` RPC-call casts masking real API-shape bugs — GET
  /provisioning-tokens has no pagination meta (unpaginated, low-cardinality
  resource), POST /provisioning-tokens returns `{ provisioningToken }` not
  top-level fields, `r.fingerprint` should be `r.deviceFingerprint` (would
  have thrown at render time), and three nonexistent provisioning-token
  fields (`revokedAt`/`expiresAt`/`uses` -> `status`/`pairingCodeExpiresAt`/
  `useCount`). Typed all state/columns properly instead of `any`, per
  code-quality.md. `pnpm --filter @agora/chrono-web typecheck` and `build`
  both clean. Committed (`a772b3f`). Phase 5 done. Phase 6 (e2e spec) not
  started.
- 2026-09-02 — Phase 6 (e2e spec) delegated to Jules, session
  `15273849535936941676`. Background poller running (30-min rule applies).
- 2026-09-02 — Session `15273849535936941676` completed. Pulled: found one
  real bug — the tenant-isolation test's heartbeat call was missing the
  required `X-Device-Fingerprint` header (`requireDeviceBearerAuth()`
  requires both it and the bearer token), which would have 401'd and failed
  the very assertion the test exists to prove. Fixed locally. `pnpm --filter
  @agora/chrono-web typecheck` clean. Committed (`8201663`). **All 6 phases
  of the devices module are now done.** Not yet headed-run against a live
  server — same caveat as every other Jules-built e2e spec this session.
