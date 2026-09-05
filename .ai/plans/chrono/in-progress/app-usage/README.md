# Chrono — `app-usage` module

**Status:** Ready — accepted, passed the Concreteness Gate and a `plan-auditor` review
(revision applied 2026-09-05). Queued, unclaimed — no phase started yet.

**Sessions:**
- Planning: plan-folder-taxonomy-refactor [6a865f]
- Implementation: agora-19 [75ff11]

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

**2026-09-05 — revised after `plan-auditor` review (verdict: NEEDS REVISION, 2 blockers
+ 9 conditions/risks).** All required fixes are folded in below. Summary of what changed:

- **Blocker fixed**: `launched`/`closed` payload shapes are now enumerated field-by-field
  (see "Payload Contracts"), with `endedAt` explicit as **device-reported**, not
  server-`now()` — this was previously unstated and would have silently corrupted every
  duration on offline-backlog replay.
- **Blocker fixed**: timestamp/duration validation is now specified (reject
  `endedAt < startedAt`, clamp `durationSeconds >= 0`, cap at a stated upper bound).
- **Open Question 1 (permission gate) is now decided, not left open**: reads are
  **gated** on a new `appUsage: ["read"]` resource, staff+. The "ungated, matching
  `device` GET" reasoning was the outlier precedent — four closer ones
  (`securityAlert`, `report`, `reconciliation`, `inquiry`) all gate reads, and this
  table's `sessionId` FK links usage to a specific `tenantMember` (which customer played
  what, when), which is exactly the kind of identifying data those four precedents
  exist to protect.
- **New**: an explicit orphaned-open-run policy (a device that goes offline without
  sending `closed` no longer leaves a permanent zombie row in the primary "Currently
  Running" view).
- **New**: test deliverables added to Phases 2 and 3 (previously all acceptance criteria
  were behavioral with nothing to verify them).
- **New**: the enforced `apps/chrono-api/src/e2e/run.ts` gate is now a Phase 5
  deliverable (previously only the manual Playwright suite was listed).
- **Fixed**: the index list, retention sweep cadence/batch cap, and Phase 3's
  "match whatever security-alert does" hedge (replaced with a stated decision).
- Open Questions 2–4 (rate-limit ceiling, retention window, duration precision) remain
  intentionally open as **stated defaults with a revisit trigger**, per the auditor's
  own recommendation — they don't block moving to `ready/`.

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
- **Reader**: a tenant `staff`/`admin`/`owner`, gated on a new `appUsage: ["read"]`
  permission resource (staff-tier, per the decision above — see "Permissions" under
  Pass 2). This surface is not comparably sensitive to `device` (approve/revoke,
  admin+-only — a hardware-trust decision) or `security-alert` (staff can report, only
  admin+ resolves) since it has no mutation at all, but it **is** comparably sensitive to
  `securityAlert`/`report`/`reconciliation`/`inquiry` reads — all four gate on a `read`
  action, and all four are staff-tier, not ungated. This module follows that precedent,
  not `device` GET's ungated one (`device` is the outlier: a hardware-trust list with no
  read action defined at all, not a deliberate "reads are always ungated" convention).

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
  idempotent "set `endedAt` if still null" update. Both `startedAt`/`endedAt` are
  **device-reported timestamps**, not server-receive time — see "Payload Contracts" —
  so a backlog replayed hours late still records the true run duration, not the delay.
- **A device-reported timestamp pair that doesn't make sense** (skewed clock, DST jump,
  or a hostile/buggy client) — `endedAt < startedAt` is rejected (counted as
  `closedSkipped`, never a 500), and `durationSeconds` is clamped to `>= 0` with a stated
  upper bound (see "Payload Contracts") so one bad clock can't dominate the usage report.
- **A `closed` event with no matching `launched` row** (out-of-order delivery across
  requests, not just within one batch) — dropped silently, counted in the response for
  device-side visibility, never a 500.
- **A device that goes offline mid-run and never sends `closed`** (crash, force
  power-off, reimage) — without a policy this leaves the row `endedAt IS NULL` forever,
  permanently polluting the "Currently Running" view with zombie entries (the module's
  own headline use case). Solved by a periodic stale-run sweep (see "Orphaned-run
  policy" under Pass 2) that force-closes a run once its device has been unreachable
  past a threshold, stamping `endedAt` from the device's own last-known-alive timestamp
  so the duration stays honest rather than guessed.
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
human-triggered mutation at all: the only writes are automated device-ingested telemetry,
the retention sweep's deletes, and the stale-run sweep's force-closes. None fits
`.ai/rules/feature-planning.md`'s "sensitive confirmed action" CRUD-contract category, so
no `auditEvent` row is proposed.

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

### Permissions

New resource `appUsage: ["read"]` in `apps/chrono-api/src/auth/permissions.ts`'s
`CHRONO_PERMISSION_STATEMENTS`, granted to `CHRONO_STAFF_GRANTS` and
`CHRONO_ADMIN_GRANTS` (owner inherits every statement automatically per
`.ai/rules/rbac.md`'s "owner: every statement" rule — no separate owner grant object to
edit). This is a **read-only** resource — no `manage`/`write` action exists because this
module has no human-triggered mutation (see Pass 1's "Audit/notifications"). All three
staff-facing GET routes call
`requirePermission(c.var.tenant.permissions, { appUsage: ["read"] })` before querying.

### Payload Contracts (device-ingest)

`reportAppUsageEventsSchema` (`apps/chrono-api/src/modules/app-usage/contracts.ts`):

```ts
const appUsageLaunchedEntrySchema = z.object({
  runId: z.string().min(1).max(128),          // device-generated, stable per process instance
  category: z.enum(["app", "game"]),
  appName: z.string().min(1).max(255),
  executablePath: z.string().max(1024).optional(),
  startedAt: z.string().datetime(),            // device-reported process-start time
  metadata: z.record(z.unknown()).optional(),  // e.g. { cpu, memory }
});

const appUsageClosedEntrySchema = z.object({
  runId: z.string().min(1).max(128),
  endedAt: z.string().datetime(),              // device-reported process-close time — NEVER server receive time
});

export const reportAppUsageEventsSchema = z.object({
  launched: z.array(appUsageLaunchedEntrySchema).max(50),
  closed: z.array(appUsageClosedEntrySchema).max(50),
});
```

**Both `startedAt` and `endedAt` are always device-reported domain timestamps, never
server-`now()`.** This is the load-bearing fix from the auditor's Finding 1: without it,
a kiosk that reconnects after being offline for hours and replays its backlog would have
every `closed` timestamp stamped at server-receive time, producing a duration equal to
"how long the device was offline" instead of the real run length — silently corrupting
every `SUM(durationSeconds)` in the usage report, which is the entire point of the
feature. `createdAt` (row-write time) stays separate and is never used for duration math.

**Validation on `closed` (server-side, Zod + route logic):**
- If no `(deviceId, runId)` row exists yet: dropped silently, counted as `closedSkipped`
  (see Pass 1's "no matching `launched` row" case).
- If a matching row exists but `endedAt < startedAt` (the row's own `startedAt`): the
  event is rejected — counted as `closedSkipped`, never applied, never a 500.
- `durationSeconds = endedAt - startedAt` is clamped to `>= 0` by construction (rejected
  above if it would be negative) and capped at an upper bound of **7 days**
  (604,800 seconds) — a run reporting longer than that is treated the same as a bad
  clock: rejected as `closedSkipped` rather than silently accepted and let it dominate
  every aggregate. (A legitimate kiosk app genuinely never runs for a week straight; if
  that assumption turns out wrong for some venue's usage pattern, raise the cap — do not
  remove it.)

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
| `endedAt` | timestamp, nullable | null = still running; set by the matching `closed` event (device-reported) or the stale-run sweep (device's own `lastSeenAt`) |
| `durationSeconds` | integer, nullable | frozen once `endedAt` is set (`endedAt - startedAt`, clamped `>= 0`, capped at 604800), matches `session.actualBillableSeconds`'s own "freeze a computed value at close" precedent |
| `closedReason` | text, nullable | `"device_closed"` (normal `closed` event) \| `"stale_device"` (force-closed by the sweep) — lets the UI/report distinguish an honest close from an inferred one |
| `metadata` | jsonb, nullable | cpu/memory samples, catch-all like `device.metadata` |
| `createdAt` | timestamp, not null, default now | row-write time (when the `launched` event first arrived) |
| `updatedAt` | timestamp, not null, default now | |

Indexes (named `chrono_app_usage_*_idx` per `.ai/rules/database.md`'s `*_tenant_idx`
convention):
- `chrono_app_usage_tenant_idx` on `tenantId`
- `chrono_app_usage_tenant_branch_idx` on `(tenantId, branchId)`
- `chrono_app_usage_tenant_station_idx` on `(tenantId, stationId)`
- `chrono_app_usage_current_idx` — **partial**, `(tenantId, stationId) WHERE endedAt IS NULL` (serves `GET /current` directly)
- `chrono_app_usage_tenant_category_idx` on `(tenantId, category)` (report grouping)
- `chrono_app_usage_tenant_app_name_idx` on `(tenantId, appName)` — **not** a bare
  `appName` index: every query already carries RLS's implicit `tenantId` predicate, so a
  single-column index on `appName` alone is nearly useless for the report grouping it
  exists to serve
- `chrono_app_usage_tenant_started_idx` on `(tenantId, startedAt)` — backs the report's
  date-range filter (see "API surface": the range filters `startedAt`, the domain time,
  not `createdAt`)
- `chrono_app_usage_created_idx` on `createdAt` (retention sweep's cutoff scan — this one
  intentionally stays a plain index since the sweep itself runs cross-tenant via
  `withAdmin`, matching `pruneAuditForPlan`'s own equivalent index shape in
  `packages/agora/src/core/server/retention.ts`)
- **unique** `chrono_app_usage_device_run_uq` on `(deviceId, runId)` (the upsert key)

### API surface

**Device-ingest (bearer-auth, outside `/rpc`):**
- `POST /api/v1/device/app-usage/events` — new factory `appUsageDeviceRoutes()` in the
  new module, `.route("/api/v1/device", appUsageDeviceRoutes())` in `app.ts` alongside
  the existing `deviceAuthRoutes()`/`deviceRealtimeRoutes()` calls at that same prefix
  (mirrors the existing "separate file, same prefix" composition — see `app.ts:1133`,
  `:1142`). **Mount this above `app.ts`'s `.use("/api/v1/*", ...)` maintenance/read-only
  gate (currently at `app.ts:1173`)** — deliberately, the same reason `heartbeat` and the
  device websocket already bypass it: a kiosk must not lose telemetry because the
  platform is in a maintenance window or global read-only mode. State this explicitly at
  the mount site so a future edit doesn't "fix" the ordering by accident.
  `requireDeviceBearerAuth()` + a new `createRateLimiter(...)`-based limiter (higher
  ceiling than `deviceSecurityAlertLimiter`'s 10/hour — this is expected, routine
  traffic, not an incident report; propose 60 requests/minute per device — see Open
  Question 2) + `zValidator` against `reportAppUsageEventsSchema` (see "Payload
  Contracts" above).
  - 409 if `device.stationId` is null.
  - `launched`: insert-if-absent per `(deviceId, runId)`.
  - `closed`: validated per "Payload Contracts," then update-if-present-and-still-open
    per `(deviceId, runId)`; sets `endedAt` + `durationSeconds` + `closedReason:
    "device_closed"`.
  - Response reports counts (`launchedAccepted`, `closedApplied`, `closedSkipped`) so the
    device can log/alert on its own drops.

**Staff-facing (tenant-gated, under `/rpc`, `appUsage:read`-gated):** new factory name
**must not** collide with the existing platform-global `appUsageRoutes` already imported
in `app.ts` (the `agora/platform-admin` cross-tenant usage/limits routes at
`/rpc-admin/usage`) — name it `chronoAppUsageRoutes()`. Composed as
`.route("/app-usage", chronoAppUsageRoutes())` in `apps/chrono-api/src/routes/rpc.ts`,
mirroring `security-alert`'s own `.route("/security-alerts", securityAlertRoutes())`
line. **Exported as a second factory from the same `app-usage/routes.ts` file** that
also exports `appUsageDeviceRoutes()` — a deliberate divergence from `security-alert`'s
own placement (whose device-ingest half actually lives in
`apps/chrono-api/src/modules/device/routes.ts`'s `deviceAuthRoutes()`, not in
`security-alert/routes.ts` itself), because app-usage has no pre-existing owning module
to attach its device half to and the rate-limit/volume concern is module-local — putting
both halves in one file keeps them next to each other rather than splitting across two
modules for no benefit.

- `GET /rpc/app-usage/current` — `{ stationId }` query, `appUsage:read` — rows for that
  station with `endedAt IS NULL` (served by the partial index above).
- `GET /rpc/app-usage` — paginated history, `listQuerySchema`-shaped
  (`.ai/rules/pagination.md`) + filters (`branchId`, `stationId`, `category`, `appName`,
  a `startedAt` date range — **not** `createdAt`, since "usage in September" means when
  the run actually happened, not when its row was written), `appUsage:read`.
- `GET /rpc/app-usage/summary` — `{ branchId?, category?, from, to }` (filtering
  `startedAt`), server-side aggregation (`GROUP BY appName, category` with `COUNT(*)`,
  `SUM(durationSeconds)`, ordered by total duration desc, paginated), `appUsage:read`.
  Pagination `meta.totalItems` needs a second `COUNT(*) FROM (SELECT DISTINCT
  appName, category ...)` query, same two-query shape `apps/chrono-api/src/modules/
  report/routes.ts` already uses for its own aggregated list — never
  fetch-all-then-aggregate client-side, per `.ai/rules/data-listing.md`.

All three `withTenant`-scoped, reading `c.var.tenant.tenantId` only.

### Orphaned-run policy

A run whose device goes offline (crash, force power-off, reimage) without ever sending
`closed` must not stay `endedAt IS NULL` forever — that would permanently pollute
`GET /current`, the module's own headline "what's running right now" use case, with
zombie entries.

**Policy: a periodic sweep force-closes a run once its device has gone stale.** "Stale"
= `chronoDevice.lastSeenAt` (already maintained by the existing `heartbeat` route,
`apps/chrono-api/src/modules/device/routes.ts`) is older than
`APP_USAGE_STALE_DEVICE_MINUTES` (default 15 — three times a typical heartbeat interval,
so one or two missed heartbeats don't false-positive). For each such run: set
`endedAt = <device's lastSeenAt>` (the device's last confirmed-alive moment — an honest
upper bound on when the run could still have been active, not a guess), compute
`durationSeconds` with the same clamp/cap rules as a normal close, and set
`closedReason: "stale_device"`. This is the same sweep that runs the retention prune
(see "Retention" below) — one worker, two jobs per tick, since both are periodic
maintenance passes over the same table.

### Retention

New `apps/chrono-api/src/modules/app-usage/retention.ts`, exporting two functions run by
one worker on one interval:

- `closeStaleAppUsageRuns()` — the orphaned-run policy above. Reads due rows (`endedAt
  IS NULL`, joined to `chronoDevice.lastSeenAt < now - staleThreshold`) via `withAdmin`
  (cross-tenant scan, read-only), capped `.limit(200)` per tick — same batch-cap
  precedent as `runSessionExpirySweepOnce()`
  (`apps/chrono-api/src/modules/session/expiry.ts`) — then closes each one via
  `withTenant(row.tenantId, tx => ...)`, one RLS-scoped transaction per row, mirroring
  that same function's own per-row `withAdmin`-read-then-`withTenant`-write shape. Not
  looped-to-drain within one call — like the session sweep, a capped batch per tick and
  letting the next interval tick pick up the rest is the established, simpler pattern
  here; introducing a new "loop until drained" shape would be inconsistent with it.
- `pruneAppUsageEvents()` — delete rows with `createdAt < now - APP_USAGE_RETENTION_DAYS`
  days, via `withAdmin`, same `.limit(200)`-per-tick batch cap (an uncapped
  `DELETE ... RETURNING` over a 90-day telemetry table's full backlog would be a
  long-running transaction materializing every deleted id in memory — the foundation
  sweep gets away without a cap only because audit-event volume is much lower; this
  table's whole premise is that it isn't).

Both scoped to `apps/chrono-api` — business-specific data, per
`.ai/rules/architecture.md`'s Non-Goals, never edits the foundation sweep file directly.
Config (new env vars, `apps/chrono-api/.env.example`, unprefixed with `CHRONO_` to match
the existing `CREDIT_EXPIRY_SWEEP_INTERVAL_MS` convention in
`apps/chrono-api/src/modules/credit/expiry.ts`, not the foundation's `RETENTION_`-prefixed
one):
- `APP_USAGE_RETENTION_DAYS` (default `90`)
- `APP_USAGE_STALE_DEVICE_MINUTES` (default `15`)
- `APP_USAGE_SWEEP_INTERVAL_MS` (default `300_000` — 5 minutes; drives both jobs above on
  one `setInterval`)

Started via its own worker in `apps/chrono-api/src/index.ts` (own `setInterval`,
`.unref()`'d, returning a stop function — same shape as `startSessionExpiryWorker()`),
alongside (not replacing) the existing foundation `startRetentionWorker()` call; stopped
in the same shutdown path.

### CRUD & Feedback Contract

| Entity | Create | Read | Update | Delete |
|---|---|---|---|---|
| App-usage event | Device-ingested only (`POST .../app-usage/events`), never human-created | `GET /rpc/app-usage/current`, `/rpc/app-usage`, `/rpc/app-usage/summary` — `appUsage:read` | Device-ingested `closed` event, or the stale-run sweep, sets `endedAt`/`durationSeconds`/`closedReason` on its own row only | Retention sweep only (hard delete past the cutoff — this is high-volume telemetry, not a financial/audit record, so no soft-delete/history-preservation need) |

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
  to the **`Business`** nav group (the same group `Devices` lives in, `layout.tsx:72`;
  not `Security`, where `Security Alerts` lives at `:97` — this is operational/usage
  data, not a security surface), plus a breadcrumb title entry
  (`"/admin/app-usage": "App Usage"`, matching the existing `"/admin/devices"`/
  `"/admin/security-alerts"` entries at `layout.tsx:127/143`).

---

## Phases

### Phase 1 — Schema, RLS, contracts, permissions

**Files to Update**
- `apps/chrono-api/src/modules/app-usage/schema.ts` (new)
- `apps/chrono-api/src/modules/app-usage/contracts.ts` (new)
- `apps/chrono-api/src/db/schema.ts` (compose `chronoAppUsageEvent`, add
  `"ChronoAppUsageEvents"` to `APP_TENANT_TABLES`)
- `apps/chrono-api/src/auth/permissions.ts` (add `appUsage: ["read"]` to
  `CHRONO_PERMISSION_STATEMENTS`, `CHRONO_STAFF_GRANTS`, `CHRONO_ADMIN_GRANTS`)
- `apps/chrono-api/src/e2e/permissions.test.ts` (drift-guard entry for the new
  `appUsage` resource, per `.ai/rules/rbac.md`)

**Step-by-Step Tasks**
1. Define `chronoAppUsageEvent` per the Schema section above (columns including
   `closedReason`, FKs, all named indexes, unique `(deviceId, runId)`).
2. Add `"ChronoAppUsageEvents"` to `APP_TENANT_TABLES`.
3. `pnpm db:generate --name add_chrono_app_usage_events` + `pnpm db:migrate`.
4. Define `reportAppUsageEventsSchema` (+ its two entry schemas), `appUsageListQuerySchema`
   (`listQuerySchema`-composed), `appUsageCurrentQuerySchema`,
   `appUsageSummaryQuerySchema` in `contracts.ts`, per "Payload Contracts" above.
5. Add `appUsage: ["read"]` to `CHRONO_PERMISSION_STATEMENTS`,
   `CHRONO_STAFF_GRANTS`, `CHRONO_ADMIN_GRANTS`.
6. Add `appUsage` to the resource-coverage drift guard in
   `apps/chrono-api/src/e2e/permissions.test.ts`.

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
- `pnpm --filter @agora/chrono-api test:permissions` passes with `appUsage` present and
  correctly scoped (staff+ holds `read`, no `manage` action exists at all).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out-of-Scope**
- Routes, UI (later phases).

**Execution Start Point**
- Copy `apps/chrono-api/src/modules/security-alert/schema.ts` as the structural
  template (closest existing FK/index shape), then diverge per the table above.

### Phase 2 — Device-ingest routes

**Files to Update**
- `apps/chrono-api/src/modules/app-usage/routes.ts` (new — exports both
  `appUsageDeviceRoutes()` and `chronoAppUsageRoutes()`, see "API surface")
- `apps/chrono-api/src/modules/app-usage/ingest.test.ts` (new)
- `apps/chrono-api/src/app.ts` (mount `appUsageDeviceRoutes()`)

**Step-by-Step Tasks**
1. `appUsageDeviceRoutes()`: `POST /app-usage/events`, `requireDeviceBearerAuth()` +
   new rate limiter `createRateLimiter(60, 60_000, "device-app-usage")` (starting value —
   load-testing the real ceiling is explicitly Out-of-Scope, see below, not a caveat on
   this task) + `zValidator("json", reportAppUsageEventsSchema)`.
2. 409 if `c.var.device.stationId` is null.
3. Resolve the active/paused session for `(tenantId, stationId)` once per request (not
   per event) inside the same `withTenant` transaction as the writes.
4. `launched`: `INSERT ... ON CONFLICT (deviceId, runId) DO NOTHING`, tagging
   `sessionId` from step 3.
5. `closed`: apply the "Payload Contracts" validation (drop if no matching row; drop if
   `endedAt < startedAt`; clamp/cap `durationSeconds`), then
   `UPDATE ... WHERE deviceId=? AND runId=? AND endedAt IS NULL SET endedAt=?,
   durationSeconds=?, closedReason='device_closed'`; track which `runId`s matched vs.
   didn't (and vs. were rejected on validation) for the response counts.
6. `.route("/api/v1/device", appUsageDeviceRoutes())` in `app.ts`, next to the existing
   two calls at that prefix (`app.ts:1133`, `:1142`), and **above** the
   `.use("/api/v1/*", ...)` maintenance/read-only gate at `:1173` — deliberately, per
   "API surface" above.

**Acceptance Criteria**
- A device posting `launched` then `closed` for the same `runId` produces exactly one
  row with both `startedAt` and `endedAt` set to the **device-reported** values (not
  server-receive time) and `closedReason: "device_closed"`.
- Replaying the identical `launched` payload twice produces no duplicate row (idempotent
  insert).
- Replaying the identical `closed` payload twice is a no-op the second time (idempotent
  update).
- A `closed` event with no matching row is dropped (`closedSkipped`), not a 500.
- A `closed` event whose `endedAt` precedes the row's `startedAt` is dropped
  (`closedSkipped`), not applied.
- A `closed` event implying a duration beyond the 604,800-second cap is dropped
  (`closedSkipped`).
- A device with no assigned station gets 409, not a silently-dropped/misattributed row.
- A backlog of events replayed hours after the fact (simulate: post `launched` with an
  old `startedAt`, then `closed` with an `endedAt` shortly after it) records the true
  short duration, not the elapsed wall-clock delay since the device went offline.
- Cross-tenant isolation: a device's bearer token only ever resolves its own tenant's
  rows (proven by the existing device-auth lookup path, no new surface here).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:app-usage-ingest` (new script,
  `apps/chrono-api/src/modules/app-usage/ingest.test.ts`)

**Out-of-Scope**
- Staff-facing read routes (Phase 3), UI (Phase 4).
- Load-testing the rate limiter's real-world ceiling (Open Question 2 — a stated
  starting value, not something this phase re-litigates).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/device/routes.ts`'s `heartbeat`/`security-alert`
  route bodies in full (already the pattern to copy for bearer-auth + rate-limit +
  `withTenant` shape) before writing this route.

### Phase 3 — Staff-facing read routes + retention/stale-run worker

**Files to Update**
- `apps/chrono-api/src/modules/app-usage/routes.ts` (add `chronoAppUsageRoutes()` to
  the same file Phase 2 created)
- `apps/chrono-api/src/modules/app-usage/retention.ts` (new)
- `apps/chrono-api/src/modules/app-usage/retention.test.ts` (new)
- `apps/chrono-api/src/routes/rpc.ts` (mount `chronoAppUsageRoutes()`)
- `apps/chrono-api/src/index.ts` (start the new worker)
- `apps/chrono-api/.env.example` (document the three new env vars)

**Step-by-Step Tasks**
1. `chronoAppUsageRoutes()`: `GET /current`, `GET /` (list), `GET /summary`, all
   `withTenant`-scoped, each calling `requirePermission(c.var.tenant.permissions,
   { appUsage: ["read"] })` before querying.
2. `.route("/app-usage", chronoAppUsageRoutes())` in `rpc.ts`.
3. `closeStaleAppUsageRuns()` and `pruneAppUsageEvents()` per "Retention" above (batch
   cap 200 each, `withAdmin` reads, `withTenant` per-row writes for the stale-close
   path).
4. Start one worker in `index.ts` (single `setInterval` at `APP_USAGE_SWEEP_INTERVAL_MS`
   calling both functions each tick) alongside the existing `startRetentionWorker()`
   call; stop it in the same shutdown path.
5. Add `APP_USAGE_RETENTION_DAYS`, `APP_USAGE_STALE_DEVICE_MINUTES`,
   `APP_USAGE_SWEEP_INTERVAL_MS` to `.env.example` with their defaults documented.

**Acceptance Criteria**
- `GET /current` returns only `endedAt IS NULL` rows for the given station; a `staff`
  session without `appUsage:read` gets 403 (see Finding-3 resolution — this module IS
  gated).
- `GET /summary` returns server-aggregated totals, correctly filtered/paginated
  (including a correct `totalItems` via the two-query count shape), never a full-table
  client-side aggregation.
- Cross-tenant isolation: tenant A cannot read tenant B's events via any of the three
  routes.
- `pruneAppUsageEvents()`: a seeded row older than `APP_USAGE_RETENTION_DAYS` is deleted;
  a seeded newer row is untouched.
- `closeStaleAppUsageRuns()`: a seeded open run (`endedAt IS NULL`) whose device's
  `lastSeenAt` is older than `APP_USAGE_STALE_DEVICE_MINUTES` gets force-closed with
  `endedAt` set to that `lastSeenAt` and `closedReason: "stale_device"`; a seeded open
  run whose device is still within the threshold is untouched.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:app-usage-retention` (new script,
  `apps/chrono-api/src/modules/app-usage/retention.test.ts`)

**Out-of-Scope**
- Web UI (Phase 4).

**Execution Start Point**
- Read `apps/chrono-api/src/modules/session/expiry.ts`
  (`runSessionExpirySweepOnce()`) in full for the due-row-scan-via-`withAdmin` +
  per-row-`withTenant`-write + batch-cap shape to mirror for both new sweep functions.

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
3. Add the nav entry to the `Business` group + breadcrumb title (see "Web UI" above).

**Acceptance Criteria**
- Both sections render real data end-to-end against a running dev server.
- Filters (branch/station/category/date-range) round-trip through the URL
  (`useListQuery()`), not local state.
- A `staff` member without `appUsage:read` does not see the nav entry (`<Can>`-gated,
  per `.ai/rules/rbac.md` — visibility only, the server route is the real gate).

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

### Phase 5 — E2E spec (enforced gate + browser suite)

**Files to Update**
- `apps/chrono-api/src/e2e/run.ts` (new block: ingest → the three reads →
  cross-tenant isolation — this is the enforced gate per `.ai/rules/business-app.md`,
  not optional)
- `apps/chrono-web/e2e/tests/app-usage/app-usage.spec.ts` (new — manual browser suite)

**Step-by-Step Tasks**
1. `src/e2e/run.ts` block: pair + approve a test device **with a station assigned**
   (ingestion 409s otherwise), POST a `launched`+`closed` pair to
   `/api/v1/device/app-usage/events`, assert the row lands correctly, assert
   `GET /rpc/app-usage/current|/|summary` all require `appUsage:read` (a session without
   it gets 403), assert tenant A cannot read tenant B's device-posted rows.
2. Playwright spec: copy the inline pair→auth→approve sequence from
   `apps/chrono-web/e2e/tests/devices/devices.spec.ts` (there is no shared device-minting
   helper today — it's written inline per test there, not extracted; the Execution Start
   Point below is about copying that *pattern*, not calling a helper that doesn't exist),
   making sure the approved device is assigned a station. Happy path: POST
   `launched`+`closed`, assert the tenant dashboard's Usage Summary reflects it, and
   (posting only `launched`, before `closed`) assert Currently Running shows it.
3. **No role-gate case in the usual sense** — `appUsage:read` is a single-tier gate
   (staff+ all hold it; there's no "staff blocked, admin allowed" split for this
   resource). Assert instead that a session with NO `member` role/permissions (or a
   custom role granting nothing) gets 403 on all three GETs — this is the module's real
   gate, just not a staff-vs-admin split.
4. Cross-tenant isolation: tenant A's device-posted events never appear in tenant B's
   `current`/list/summary reads.

**Acceptance Criteria**
- The `src/e2e/run.ts` block passes as part of `pnpm --filter @agora/chrono-api test:e2e`.
- All four Playwright assertions pass.

**Verification Commands**
- `pnpm --filter @agora/chrono-api test:e2e` (the enforced gate)
- Chrono web Playwright suite (manual runner, `pnpm dev` running first, per
  `.ai/rules/rbac.md`'s testing note)

**Out-of-Scope**
- Load-testing the rate limiter's real-world ceiling.

**Execution Start Point**
- Read `apps/chrono-web/e2e/tests/devices/devices.spec.ts` in full for the inline
  pair→auth→approve sequence to copy (see step 2 above — there is no extracted helper).

### Phase 6 — Docs

**Files to Update**
- `.ai/handover/chrono-migration.md` (drop `app-usage` from the "Deferred" table)
- `apps/chrono-api/AGENTS.md` (drop `app-usage` from its own deferred list, add it
  wherever shipped modules are enumerated, if that file does so)

**Step-by-Step Tasks**
1. Update both files' module lists to reflect `app-usage` as shipped, not deferred.

**Acceptance Criteria**
- Both docs are internally consistent with the actual shipped state.

**Verification Commands**
- None (docs-only).

**Out-of-Scope**
- Rewriting either file's other stale entries (a separate, broader staleness issue
  unrelated to this module — out of scope for this plan).

**Execution Start Point**
- Grep both files for `app-usage` and update each hit.

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
- Load-testing the rate limiter's real ceiling (Open Question 2).
- Foreground/background tracking nuance for `durationSeconds` (Open Question 4).

---

## Open Questions (developer to confirm/override — none of these block moving to `ready/`)

1. ~~Reads ungated for every tenant role~~ — **resolved**: gated on `appUsage: ["read"]`,
   staff+ (see "Permissions").
2. **Rate-limiter ceiling** (60/min per device, Phase 2) — a stated starting default,
   not load-tested against a real PC-client's actual batching cadence. Revisit trigger:
   once a real PC-client exists and its batching frequency is known.
3. **Retention window** (`APP_USAGE_RETENTION_DAYS = 90`) — a stated starting default.
   Revisit trigger: actual reporting needs once real usage data exists (a longer window
   helps "which games to keep this quarter" analysis; a shorter one reduces storage/row
   volume).
4. **`durationSeconds` precision** — computed once at close/force-close, never revisited
   for foreground/background state. Revisit trigger: if a "was this app actually
   foregrounded the whole time" nuance is wanted later — that's a materially bigger
   feature (foreground/background tracking), not in scope here.

---

## After Implementation

Once all six phases are verified and committed: move this plan from
`.ai/plans/chrono/draft/app-usage/` → `.ai/plans/chrono/archive/app-usage/` and mark
phase statuses complete (Phase 6 already handles the deferred-list/AGENTS.md updates as
its own deliverable, not a post-hoc step).
