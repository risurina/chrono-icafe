# Chrono — `app-usage` module

**Sessions:**
- Planning: plan-folder-taxonomy-refactor [6a865f]

**2026-09-05 — moved from `blocked/` to `draft/`, Pass 1/2 rewritten against current
reality.** Two of the three prior "Unblocking condition" gates are now satisfied:
`devices` shipped schema + bearer-auth middleware (`apps/chrono-api/src/modules/device/`,
all 6 phases archived at `.ai/plans/chrono/archive/devices/`), and `sessions` shipped its
schema (`apps/chrono-api/src/modules/session/`, fully implemented). The third gate — a
product decision — is now answered by the developer:

1. **`app-usage` is wanted.** Scope: per-station telemetry of both regular applications
   *and* games (two categories), not just generic process launch/close.
2. **Write path: best practice = reuse `devices`' existing bearer-auth mechanism
   verbatim**, following the exact shape already established by
   `POST /api/v1/device/heartbeat` and `POST /api/v1/device/security-alert` — no second
   parallel device-auth integration.
3. **Retention/volume: best practice = a Chrono-local retention sweep**, mirroring
   `packages/agora/src/core/server/retention.ts`'s shape but scoped to `apps/chrono-api`
   (business-specific data does not belong in the foundation sweep, per
   `.ai/rules/architecture.md`'s Non-Goals) — a normal RLS-forced Postgres table, not a
   partitioned/specialized store, is sufficient once paired with a periodic prune.

`apps/chrono-pc-client` itself remains **out of scope** for this plan (and for the whole
migration pass, per `.ai/handover/chrono-migration.md`). This plan defines the ingestion
**contract** a future PC-client must satisfy — it does not build a producer.

## What this is

Per-station telemetry of what's running on a paired kiosk PC: launch/close events for
named applications **and** games (a `category` the device itself asserts, since only the
device/PC-client owns a local "which exe is which game" catalog — see "Divergence from
prior art," point 3). Two consumers:

- **Live view**: "what's running right now" per station, for staff/ops to spot
  unauthorized software or confirm a customer's game actually launched.
- **Usage report**: aggregated totals (session count, total duration) per app/game over
  a date range and branch — the actual "apps and games usage" analytics the developer
  asked for, useful for licensing/purchase decisions on which games to keep provisioning
  and for troubleshooting unexpected software.

---

## Pass 1 — Workflow Analysis

**Who uses it:**
- **Writer**: the PC-client agent on a paired station (machine identity via
  `requireDeviceBearerAuth()`, never a human session) — posts batched launch/close
  events keyed by its own device identity.
- **Reader**: any tenant `staff`/`admin`/`owner` viewing the Chrono dashboard. Unlike
  `device` (approve/revoke, admin+-only — a hardware-trust decision) or
  `security-alert` (staff can report, but only admin+ resolves), reading app-usage
  telemetry carries no comparable blast radius — it's inert historical/live data with no
  mutation surface at all. This plan follows `device`'s own GET precedent ("GET stays
  ungated so staff retain read visibility") and leaves reads **ungated** — any
  authenticated tenant member, any role. See Open Question 1 if the developer wants a
  narrower default instead.

**Workflow:** the PC-client watches OS process launch/close events, tags each with a
category (`"app"` | `"game"`) from its own local catalog, and posts a batch to
`POST /api/v1/device/app-usage/events` keyed by its own bearer credential. Staff opens
`/dashboard/app-usage` → sees currently-running apps/games per station, and a usage
report (top apps/games by total duration, filterable by branch + date range).

**What they see/click:** a `DataTable` (per `.ai/rules/admin-table.md`) for both the live
list and the report list, `DataTableToolbar` filters (branch, station, category,
date-range per `.ai/rules/data-listing.md`), no row actions — this surface has no
mutations, so no confirm dialogs, no Sonner toasts on the read side.

**Failure cases:**
- **Device posting for a station it isn't paired to** — never trusted from the client;
  `stationId`/`branchId`/`tenantId` are resolved server-side from the authenticated
  device's own row (`c.var.device`), exactly like `heartbeat`/`security-alert` already
  do. A device with no assigned station (`c.var.device.stationId === null`) gets a 409 —
  there's no station to attribute the event to.
- **Offline device replaying a backlog of events must not double-count.** Solved by
  requiring the device to generate a stable `runId` per process instance (see "Divergence
  from prior art," point 1) — the API upserts by `(deviceId, runId)`, so a retried
  `launched` event is a no-op insert-if-absent, and a retried `closed` event is an
  idempotent "set `endedAt` if still null" update.
- **A `closed` event with no matching `launched` row** (out-of-order delivery across
  requests, not just within one batch) — dropped silently, counted in the response for
  device-side visibility, never a 500.
- **Telemetry volume** — a hot per-process event stream, unlike an occasional heartbeat.
  Bounded by (a) a per-device rate limiter on the POST endpoint (mirrors
  `deviceSecurityAlertLimiter`'s shape) and (b) a Zod `.max()` cap on array length per
  request, forcing the device to batch rather than spam.
- **Wrong tenant/branch** — `withTenant` on every read/write, same as every other
  module; no new leak surface.
- **Tenant-isolation leak** — identical `withTenant` discipline; the one cross-tenant
  step (device credential lookup by hash) already exists and is proven inside `devices`'
  own `rls:proof`/e2e — this plan adds no new cross-tenant read path.

**Audit/notifications:** **none.** Unlike `security-alert`'s approve/revoke or
`device`'s approve/revoke — human-confirmed, sensitive mutations — this module has no
human-triggered mutation at all: the only writes are automated device-ingested telemetry
and the retention sweep's deletes. Neither fits `.ai/rules/feature-planning.md`'s
"sensitive confirmed action" CRUD-contract category, so no `auditEvent` row is proposed.

---

## Pass 2 — Technical Planning

### Divergence from prior art (oikos) — read first

1. **oikos matched `closed` events to their `launched` row implicitly by `appName` +
   most-recent-open-row-for-that-device** — fragile the moment two instances of the same
   executable run concurrently on one station (unusual for a kiosk, but not impossible),
   and outright breaks the "backlog replay must not double-count" requirement in Pass 1.
   This plan instead requires the device to generate a stable, client-side `runId` (a
   UUID) per detected process instance and include it on both the `launched` and
   `closed` payloads for that instance — the server never has to guess which row a close
   event belongs to. This is a contract the future PC-client must implement; it is not
   this plan's own thing to build, but it must be specified now so a PC-client plan has a
   concrete target.
2. **oikos wrote one row per event** (`APP_LAUNCH`, `APP_CLOSE` as separate rows) — this
   plan instead writes **one row per app-run**, created on `launched` and updated
   (`endedAt`, `durationSeconds`) on the matching `closed`. Halves row volume for a
   telemetry stream expected to already need a retention sweep, and makes the usage-report
   aggregation (`SUM(durationSeconds) GROUP BY appName`) a single-table scan instead of a
   launch/close self-join.
3. **oikos's `games.json` (a curated per-station allowlist of launchable games with
   `id`/`name`/`category`/`exePath`) lives entirely in the PC-client
   (`apps/chrono-pc-client-tauri`), not the API** — this plan does not attempt to model a
   server-side games catalog. The device asserts its own `category` per event
   (`"app" | "game"`), validated only against the two-value enum; curating *which*
   executables count as which category stays a PC-client-local concern (whatever
   catalog/config mechanism its own future plan designs), not modeled here. If a
   per-tenant server-side games catalog is ever wanted (e.g. so staff can configure it
   from the dashboard instead of a local JSON file on each kiosk), that is a separate,
   additive follow-up — flagged, not built.
4. **oikos's own read side (`GET /current/:stationId`) was a stub returning `[]`, and its
   web page under the same route name actually rendered unrelated platform-quota
   metrics** — there is no working prior-art UI to port for either the live view or the
   usage report. Both are designed fresh in this plan (see "Web UI" below), consistent
   with [[feedback_improve_dont_port_prior_art]].
5. **No rate-limiting/audit gap distinct from what devices' own plan already solved** —
   this reuses `requireDeviceBearerAuth()` and a `createRateLimiter`-shaped limiter
   verbatim; no new auth mechanism, no new abuse-surface reasoning needed beyond scaling
   the existing device-ingest pattern to higher expected volume.

### Schema

New module folder `apps/chrono-api/src/modules/app-usage/` (mirrors `security-alert`'s
file layout: `schema.ts`, `contracts.ts`, `routes.ts`, `retention.ts`, test files
co-located).

`ChronoAppUsageEvents` (tenant-scoped, RLS-forced):

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `createId()` |
| `tenantId` | text, FK `organization.id` cascade | standard |
| `branchId` | text, FK `chronoBranch.id` cascade | denormalized from the device at ingestion, matches `session.branchId`'s own denormalization precedent |
| `stationId` | text, FK `chronoStation.id` **set null** | from `device.stationId`; ingestion 409s if the authenticated device has no station |
| `deviceId` | text, FK `chronoDevice.id` **set null** | the authenticated device; history survives device decommission, matches `security-alert.deviceId` |
| `sessionId` | text, FK `chronoSession.id` **set null**, nullable | best-effort: the active/paused session on `stationId` at the moment the `launched` event is written (`SELECT id FROM ChronoSessions WHERE tenantId=? AND stationId=? AND status IN ('active','paused') LIMIT 1`), frozen at write time — never re-resolved on the `closed` update |
| `runId` | text, not null | device-generated stable id per process instance (see Divergence #1) |
| `category` | text, not null | `"app"` \| `"game"`, free text at the DB layer + Zod `.enum()` at the contract layer, matching the dominant convention (`status`-shaped columns elsewhere) |
| `appName` | text, not null | |
| `executablePath` | text, nullable | |
| `startedAt` | timestamp, not null | device-reported process-start time (domain time, distinct from `createdAt`) |
| `endedAt` | timestamp, nullable | null = still running; set by the matching `closed` event |
| `durationSeconds` | integer, nullable | frozen once `endedAt` is set (`endedAt - startedAt`), matches `session.actualBillableSeconds`'s own "freeze a computed value at close" precedent — avoids recomputing at every report read |
| `metadata` | jsonb, nullable | cpu/memory samples, catch-all like `device.metadata` |
| `createdAt` | timestamp, not null, default now | row-write time (when the `launched` event first arrived) |
| `updatedAt` | timestamp, not null, default now | |

Indexes: `tenantId`; `(tenantId, branchId)`; `(tenantId, stationId)` (for "currently
running at this station": `WHERE stationId=? AND endedAt IS NULL`); `(tenantId,
category)` (report grouping); `appName` (report grouping); `createdAt` (retention sweep's
cutoff scan); **unique** `(deviceId, runId)` (upsert key).

### API surface

**Device-ingest (bearer-auth, outside `/rpc`):**
- `POST /api/v1/device/app-usage/events` — new factory `appUsageDeviceRoutes()` in the
  new module, `.route("/api/v1/device", appUsageDeviceRoutes())` in `app.ts` alongside
  the existing `deviceAuthRoutes()`/`deviceRealtimeRoutes()` calls at that same prefix
  (mirrors the existing "separate file, same prefix" composition — see `app.ts:1133-1140`).
  `requireDeviceBearerAuth()` + a new `createRateLimiter(...)`-based limiter (higher
  ceiling than `deviceSecurityAlertLimiter`'s 10/hour — this is expected, routine
  traffic, not an incident report; propose 60 requests/minute per device) + `zValidator`
  against `reportAppUsageEventsSchema` (`{ launched: [...max 50], closed: [...max 50] }`,
  each entry carrying `runId`).
  - 409 if `device.stationId` is null.
  - `launched`: insert-if-absent per `(deviceId, runId)`.
  - `closed`: update-if-present-and-still-open per `(deviceId, runId)`; sets `endedAt` +
    `durationSeconds`; a no-match is dropped silently.
  - Response reports counts (`launchedAccepted`, `closedApplied`, `closedSkipped`) so the
    device can log/alert on its own drops.

**Staff-facing (tenant-gated, under `/rpc`):** new factory name **must not** collide with
the existing platform-global `appUsageRoutes` already imported in `app.ts` (the
`agora/platform-admin` cross-tenant usage/limits routes at `/rpc-admin/usage`) — name it
`chronoAppUsageRoutes()`. Composed as `.route("/app-usage", chronoAppUsageRoutes())` in
`apps/chrono-api/src/routes/rpc.ts`, mirroring `security-alert`'s own
`.route("/security-alerts", securityAlertRoutes())` line.

- `GET /rpc/app-usage/current` — `{ stationId }` query, ungated (any tenant role, see
  Pass 1) — rows for that station with `endedAt IS NULL`.
- `GET /rpc/app-usage` — paginated history, `listQuerySchema`-shaped
  (`.ai/rules/pagination.md`) + filters (`branchId`, `stationId`, `category`, `appName`,
  date range), ungated.
- `GET /rpc/app-usage/summary` — `{ branchId?, category?, from, to }`, server-side
  aggregation (`GROUP BY appName, category` with `COUNT(*)`, `SUM(durationSeconds)`,
  ordered by total duration desc, paginated) — never fetch-all-then-aggregate
  client-side, per `.ai/rules/data-listing.md`.

All three `withTenant`-scoped, reading `c.var.tenant.tenantId` only.

### Retention

New `apps/chrono-api/src/modules/app-usage/retention.ts`: a `pruneAppUsageEvents()`
mirroring `packages/agora/src/core/server/retention.ts`'s shape (delete rows older than a
cutoff via `withAdmin`, cross-tenant, since retention is a platform-operational sweep,
not a per-tenant action) but living in `apps/chrono-api` — business-specific data,
per `.ai/rules/architecture.md`'s Non-Goals, never edits the foundation sweep file
directly. Cutoff: `CHRONO_APP_USAGE_RETENTION_DAYS` env var (default `90`), matching the
existing `RETENTION_SWEEP_INTERVAL_MS` env-var convention. Started via its own
`setInterval`-based worker in `apps/chrono-api/src/index.ts`, alongside (not replacing)
the existing `startRetentionWorker()` call from `agora`.

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| App-usage event | Device-ingested only (`POST .../app-usage/events`), never human-created | `GET /rpc/app-usage/current`, `/rpc/app-usage`, `/rpc/app-usage/summary` — ungated | Device-ingested `closed` event sets `endedAt`/`durationSeconds` on its own row only | Retention sweep only (hard delete past the cutoff — this is high-volume telemetry, not a financial/audit record, so no soft-delete/history-preservation need) |

- No human-facing mutation exists, so no Sonner toast/confirm-dialog contract applies to
  this module's own UI (the report/live views are read-only).
- No audit linkage (see Pass 1's "Audit/notifications").

### Web UI

- `apps/chrono-web/src/app/(tenant-admin)/dashboard/app-usage/page.tsx` — two sections:
  - **Currently Running**: `DataTable` (station, branch, category badge, appName,
    startedAt, running-duration-so-far), filter by branch/station via
    `DataTableToolbar`, `useListQuery()`-driven, polling refresh (no live push — matches
    `chrono-realtime-updates` being deferred platform-wide, same as the superseded
    `admin-station-client` plan already noted).
  - **Usage Summary**: `DataTable` of `{ appName, category, sessionCount,
    totalDuration }`, date-range + branch + category filters, backed by
    `GET /rpc/app-usage/summary` (server-side sort/paginate).
- Nav entry: `apps/chrono-web/src/app/(tenant-admin)/dashboard/layout.tsx` — add
  `{ type: "item", name: "App Usage", href: "/app-usage", icon: <TBD, e.g. AppWindow> }`
  to the same nav array `Devices`/`Security Alerts` live in (`layout.tsx:71-97`), plus a
  breadcrumb title entry (`"/admin/app-usage": "App Usage"`, matching the existing
  `"/admin/devices"`/`"/admin/security-alerts"` entries at `layout.tsx:127/143`).

---

## Phases

### Phase 1 — Schema, RLS, contracts

**Files to Update**
- `apps/chrono-api/src/modules/app-usage/schema.ts` (new)
- `apps/chrono-api/src/modules/app-usage/contracts.ts` (new)
- `apps/chrono-api/src/db/schema.ts` (compose `chronoAppUsageEvent`, add
  `"ChronoAppUsageEvents"` to `APP_TENANT_TABLES`)

**Step-by-Step Tasks**
1. Define `chronoAppUsageEvent` per the Schema section above (columns, FKs, indexes,
   unique `(deviceId, runId)`).
2. Add `"ChronoAppUsageEvents"` to `APP_TENANT_TABLES`.
3. `pnpm db:generate --name add_chrono_app_usage_events` + `pnpm db:migrate`.
4. Define `reportAppUsageEventsSchema`, `appUsageListQuerySchema`
   (`listQuerySchema`-composed), `appUsageCurrentQuerySchema`,
   `appUsageSummaryQuerySchema` in `contracts.ts`.

**Acceptance Criteria**
- Migration applies cleanly; `ChronoAppUsageEvents` exists with FORCE RLS.
- `pnpm --filter @agora/chrono-api rls:proof` passes — this only proves the RLS
  *mechanism* (forced RLS, non-bypassing app role); it does **not** probe
  `ChronoAppUsageEvents` or any other Chrono table specifically (confirmed:
  `apps/chrono-api/src/rls-proof.ts` is an unmodified copy of the scaffold's own proof,
  hardcoded to four foundation tables — see
  `.ai/analysis/2026-09-05-chrono-rls-proof-gap.md`, filed separately, not fixed here).
  The real per-table isolation proof for this module is Phase 5's e2e cross-tenant
  assertion.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Routes, UI (later phases).

**Execution Start Point**
- Copy `apps/chrono-api/src/modules/security-alert/schema.ts` as the structural
  template (closest existing FK/index shape), then diverge per the table above.

### Phase 2 — Device-ingest routes

**Files to Update**
- `apps/chrono-api/src/modules/app-usage/routes.ts` (new — device-facing half)
- `apps/chrono-api/src/app.ts` (mount `appUsageDeviceRoutes()`)

**Step-by-Step Tasks**
1. `appUsageDeviceRoutes()`: `POST /app-usage/events`, `requireDeviceBearerAuth()` +
   new rate limiter (`createRateLimiter(60, 60_000, "device-app-usage")` — confirm the
   ceiling against real device batching frequency once a PC-client exists; this is a
   starting number, not load-tested) + `zValidator("json", reportAppUsageEventsSchema)`.
2. 409 if `c.var.device.stationId` is null.
3. Resolve the active/paused session for `(tenantId, stationId)` once per request (not
   per event) inside the same `withTenant` transaction as the writes.
4. `launched`: `INSERT ... ON CONFLICT (deviceId, runId) DO NOTHING`, tagging
   `sessionId` from step 3.
5. `closed`: `UPDATE ... WHERE deviceId=? AND runId=? AND endedAt IS NULL`, computing
   `durationSeconds`; track which `runId`s matched vs. didn't for the response counts.
6. `.route("/api/v1/device", appUsageDeviceRoutes())` in `app.ts`, next to the existing
   two calls at that prefix.

**Acceptance Criteria**
- A device posting `launched` then `closed` for the same `runId` produces exactly one
  row with both `startedAt` and `endedAt` set.
- Replaying the identical `launched` payload twice produces no duplicate row (idempotent
  insert).
- Replaying the identical `closed` payload twice is a no-op the second time (idempotent
  update).
- A `closed` event with no matching row is dropped, not a 500.
- A device with no assigned station gets 409, not a silently-dropped/misattributed row.
- Cross-tenant isolation: a device's bearer token only ever resolves its own tenant's
  rows (proven by the existing device-auth lookup path, no new surface here).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Staff-facing read routes (Phase 3), UI (Phase 4).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/device/routes.ts`'s `heartbeat`/`security-alert`
  route bodies in full (already the pattern to copy for bearer-auth + rate-limit +
  `withTenant` shape) before writing this route.

### Phase 3 — Staff-facing read routes + retention worker

**Files to Update**
- `apps/chrono-api/src/modules/app-usage/routes.ts` (staff-facing half, same file or a
  second exported factory — match whatever `security-alert/routes.ts` does if it also
  splits concerns in one file)
- `apps/chrono-api/src/modules/app-usage/retention.ts` (new)
- `apps/chrono-api/src/routes/rpc.ts` (mount `chronoAppUsageRoutes()`)
- `apps/chrono-api/src/index.ts` (start the new retention worker)

**Step-by-Step Tasks**
1. `chronoAppUsageRoutes()`: `GET /current`, `GET /` (list), `GET /summary`, all
   `withTenant`-scoped, ungated (no `requirePermission` call — see Pass 1's reasoning;
   confirm this default against Open Question 1 before shipping).
2. `.route("/app-usage", chronoAppUsageRoutes())` in `rpc.ts`.
3. `pruneAppUsageEvents()`: delete rows with `createdAt < now - CHRONO_APP_USAGE_RETENTION_DAYS days`, via `withAdmin` (cross-tenant sweep, matches the foundation sweep's own `withAdmin` use).
4. Start it in `index.ts` alongside the existing `startRetentionWorker()` call; stop it
   in the same shutdown path.
5. Add `CHRONO_APP_USAGE_RETENTION_DAYS` to `.env.example` (default documented as `90`).

**Acceptance Criteria**
- `GET /current` returns only `endedAt IS NULL` rows for the given station.
- `GET /summary` returns server-aggregated totals, correctly filtered/paginated, never a
  full-table client-side aggregation.
- Cross-tenant isolation: tenant A cannot read tenant B's events via any of the three
  routes.
- Retention sweep deletes rows older than the configured window and leaves newer rows
  untouched (test with a seeded old + new row).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`

**Out-of-Scope**
- Web UI (Phase 4).

**Execution Start Point**
- Read `packages/agora/src/core/server/retention.ts` in full for the sweep shape to
  mirror (cutoff-via-env, `withAdmin`, delete-and-count, logged interval worker).

### Phase 4 — Web UI + nav

**Files to Update**
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/app-usage/page.tsx` (new)
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/layout.tsx` (nav entry +
  breadcrumb title)

**Step-by-Step Tasks**
1. Build the "Currently Running" + "Usage Summary" sections per the Web UI sketch,
   using `agora/ui` primitives only (`.ai/rules/component-first-ui.md`).
2. Wire both to the typed `/rpc/app-usage/*` client, `useListQuery()`-driven for the
   Usage Summary table.
3. Add the nav entry + breadcrumb title.

**Acceptance Criteria**
- Both sections render real data end-to-end against a running dev server.
- Filters (branch/station/category/date-range) round-trip through the URL
  (`useListQuery()`), not local state.

**Verification Commands**
- `pnpm typecheck`
- Manual check against `pnpm dev` (per this repo's UI-change verification norm — start
  the dev server and exercise the page before calling this phase done).

**Out-of-Scope**
- Any device-simulator tooling to generate fake telemetry for manual testing — write a
  minimal seed script or curl the device-ingest route directly with a test device
  credential; do not build a fake PC-client.

**Execution Start Point**
- Copy `apps/chrono-web/src/app/(tenant-admin)/dashboard/devices/page.tsx`'s overall
  page shell/toolbar pattern, since it's the nearest existing device-adjacent dashboard
  page.

### Phase 5 — E2E spec

**Files to Update**
- `apps/chrono-web/e2e/tests/app-usage/app-usage.spec.ts` (new)

**Step-by-Step Tasks**
1. Happy path: seed a test device (reuse the `devices` e2e helper for minting an
   approved device + bearer token), POST a `launched` + `closed` event pair directly to
   `/api/v1/device/app-usage/events`, then assert the tenant dashboard's Usage Summary
   and (while the app is still open, before posting `closed`) Currently Running views
   reflect it.
2. **No role-gate case** — this module deliberately has none (Pass 1). Assert instead
   that a `staff`-role session can read all three endpoints without a 403, documenting
   the deliberate absence of a gate rather than silently having no test for it.
3. Cross-tenant isolation: tenant A's device-posted events never appear in tenant B's
   `current`/list/summary reads.

**Acceptance Criteria**
- All three assertions pass.

**Verification Commands**
- Chrono web Playwright suite (manual runner, `pnpm dev` running first, per
  `.ai/rules/rbac.md`'s testing note).

**Out-of-Scope**
- Load-testing the rate limiter's real-world ceiling.

**Execution Start Point**
- Copy `apps/chrono-web/e2e/tests/devices/devices.spec.ts` for the device-minting
  helper pattern.

---

## Out of Scope (this plan)

- `apps/chrono-pc-client` itself — a separate, not-yet-commissioned plan (see
  `.ai/plans/chrono/blocked/admin-station-client/README.md` for the parallel PC-client
  dependency on the remote-command side of that plan).
- A per-tenant, dashboard-configurable games catalog (Divergence #3) — additive
  follow-up if wanted.
- Live push updates for the "Currently Running" view — polling only.
- Billing/pricing differentiation between app vs. game usage (e.g. a game-specific
  rate) — a materially larger cross-cutting change to `station`/`session` pricing, not
  implied by "track usage."
- Anomaly/security alerting on unexpected software (cross-reference:
  `security-alert` module already exists for staff/device-reported incidents; wiring
  app-usage telemetry into it automatically is a separate, later integration).

---

## Open Questions (developer to confirm/override)

1. **Reads ungated for every tenant role** (this plan's default, matching `device`
   GET's own precedent) — confirm, or restrict to staff+ if raw process-level telemetry
   is considered more sensitive than this plan assumes.
2. **Rate-limiter ceiling** (60/min per device, Phase 2) — a starting guess, not
   load-tested against a real PC-client's actual batching cadence.
3. **Retention window** (90 days default) — confirm against actual reporting needs (a
   longer window helps "which games to keep this quarter" analysis; a shorter one
   reduces storage/row volume).
4. **`durationSeconds` precision** — this plan computes it once at close and never
   revisits it; if a session pause/resume-style "was this app actually foregrounded the
   whole time" nuance matters later, that's a materially bigger feature (foreground/
   background tracking), not in scope here.

---

## After Implementation

Once all five phases are verified and committed: move this plan from
`.ai/plans/chrono/draft/app-usage/` → `.ai/plans/chrono/archive/app-usage/`, update
`.ai/handover/chrono-migration.md`'s deferred-modules table to drop `app-usage` from the
deferred list, and update `apps/chrono-api/AGENTS.md`'s own module list if it enumerates
shipped modules.
