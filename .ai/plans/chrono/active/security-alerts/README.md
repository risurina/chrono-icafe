# Chrono — `security-alerts` module

**⚠️ Hard dependency on `devices`, which is NOT implemented.** `devices`' own plan
(`.ai/plans/chrono/active/devices/README.md`) is committed but **Phase 1 (schema) has
not landed** — `apps/chrono-api/src/db/schema.ts` has no `chronoDevice` import today (verified
2026-09-02) and `ChronoDevices` is not in `APP_TENANT_TABLES`. Security alerts are, by
their own Pass 1 workflow, substantially device-originated (a kiosk reports tamper,
unauthorized-unlock, unexpected-shutdown events over the device-bearer-auth surface
`devices` defines). **This plan cannot ship a working device-reporting path until
`devices` Phase 1 (schema) and Phase 3 (device-auth middleware + device-facing routes)
exist.** See "Dependency decision" in Pass 2 for how this plan is still written and
sequenced today without blocking on that.

---

## What this is

A per-tenant, per-branch security event log: device tamper, unauthorized access
attempts, unexpected shutdowns, and other kiosk/venue security events, either
device-reported (once `devices` exists) or staff-reported manually today. Staff see a
feed, triage by severity, acknowledge/resolve with a note, and the trail survives as an
audit record — this is the module that gives an owner visibility into "is a PC being
tampered with right now" without a video wall.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff / Admin / Owner** — see the alert feed for their tenant (all branches unless
  filtered), acknowledge an alert (claim it — "someone is on this"), resolve it with a
  closing note.
- **The kiosk device itself** (once `devices` lands) — raises an alert autonomously
  (e.g. "chassis opened," "camera detected an unrecognized user swap mid-session,"
  "unexpected process termination") via the device-bearer-authenticated surface. **Not
  built in Phase 1 of this plan** — see Dependency decision.
- **Platform admin (`/rpc-admin`)** — not built in this pass, same deferral every prior
  module made.

**Workflow:** A kiosk detects its case was opened and calls its device-authenticated
`/heartbeat`-adjacent alert-report endpoint (owned by `devices`, invoked once that
surface exists) with a severity + type + message; the API inserts a
`ChronoSecurityAlerts` row with `status: "open"`, `deviceId` set, `raisedBy: "device"`.
Staff opens **Dashboard → Security Alerts**, sees it at the top (sorted open-first,
severity-desc, then recency), clicks **Acknowledge** (row flips to `acknowledged`,
`acknowledgedByUserId`/`acknowledgedAt` set — this is a distinct step from resolve: it
says "I've seen this and am looking," not "this is handled"). After investigating
in-person, staff clicks **Resolve** with a required closing note (row flips to
`resolved`, `resolvedByUserId`/`resolvedAt`/`resolutionNote` set). Staff can also
**manually report** an alert (e.g. spotting something the kiosk didn't detect, or a
non-device incident like a customer dispute) via a "Report Incident" button — same
table, `raisedBy: "staff"`, no `deviceId`.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()`.
- A tenant member with no `securityAlert:read`/`:manage` grant attempting to view/act →
  403.
- Acknowledging or resolving an alert already in a terminal state (`resolved`) → 409.
- Resolving without a `resolutionNote` → 400 (Zod-required on resolve, unlike
  oikos — see Divergences).
- A `branchId`/`stationId`/`deviceId` not belonging to the caller's tenant → 404, never
  403 (no existence leak), looked up inside the same `withTenant` transaction.
- **Tenant-isolation leak scenario**: tenant A's kiosk alert must never be visible to,
  or acknowledgeable/resolvable by, tenant B — enforced by RLS (`ChronoSecurityAlerts`
  in `APP_TENANT_TABLES`) plus the device-bearer lookup (once `devices` exists)
  resolving `tenantId` from the device row itself, never from client input.
- Stale screen: two staff acting on the same alert — last write wins on the
  acknowledge/resolve transition; the DB-level status check ("must currently be `open`"
  for acknowledge, "must not be `resolved`" for resolve) prevents a stale double-action
  from silently overwriting a colleague's resolution note.
- **Device-origin failure (once `devices` exists)**: a device presents a revoked/unknown
  bearer token attempting to raise an alert → 401/403 per `devices`' own auth
  middleware contract; this module never re-implements device auth, it only consumes
  `c.var.device` (or equivalent) that middleware sets.

**Audit / notifications:** every acknowledge/resolve/manual-report writes a
`recordStaffAudit` entry (`chronoSecurityAlert.reported` / `.acknowledged` /
`.resolved`), capturing severity/type, not just the action name. No email/SMS/push
notification in this pass (**Open Question 1**: should a `critical` alert trigger an
immediate notification via the existing `tenantNotification` bell, or later a real
push/SMS channel — this plan wires the bell only, see Phase 3, and defers external
paging).

---

## Pass 2 — Technical Planning

### Dependency decision — build the schema now with a nullable `deviceId`, gate device-reporting behind `devices` landing

Two options were weighed, matching this plan's own instruction to pick the more
defensible one and justify it:

- **(a) Sequence entirely after `devices` Phase 1** — write this plan assuming
  `chronoDevice` exists, mark the whole thing BLOCKED until then.
- **(b) Design defensively**: `ChronoSecurityAlerts.deviceId` is nullable and the FK is
  added, but Phase 1 (DB) and Phases 2–4 (contracts/staff-facing routes/web UI) ship
  **now**, covering the fully-functional **staff-manual-report** path end to end. Only
  the **device-reporting endpoint** (a route inside `devices`' own device-bearer-gated
  surface, not this module's `/rpc` mount) is written as a clearly-labeled follow-up
  phase that literally cannot compile/run until `devices` Phase 3 (the device-auth
  middleware) exists.

**This plan picks (b)**, for the same reason `reservations` picked "build path 1 now,
leave path 2 for when its dependency lands" rather than blocking entirely: staff-facing
manual incident reporting/acknowledge/resolve is a complete, independently valuable
feature on its own (an owner can log "camera saw someone climb over the counter at
Branch 2" today, with no kiosk involved at all), and gating the *entire* module on
`devices` would leave a materially useful, self-contained slice of the product
unbuilt for no dependency reason — `reservations`' own path-1/path-2 split is the
directly analogous precedent, not `shifts`'/`pos`'s money-columns-left-null pattern
(which is closer in mechanism — a nullable/deferred field — but reservations is the
closer precedent in that it deferred a *whole workflow branch*, not just a column).
The tradeoff: `deviceId` sits unused until `devices` lands, and the device-reporting
route (Phase 5 below) is unimplementable — not just unimplemented — until then; this is
flagged loudly in that phase's Out-of-Scope/Execution-Start-Point rather than silently
built against a table that doesn't exist.

**Concretely**: Phases 1–4 (schema, contracts, staff routes, web UI) do not import
anything from `devices` and do not require it to exist. Phase 5 (device-reporting
endpoint) is explicitly BLOCKED-until-`devices`-Phase-1-and-3 in its own Execution Start
Point, and is the only phase this dependency actually blocks.

### Pattern to copy (worked examples)

- `apps/chrono-api/src/modules/reservation/schema.ts` — nullable optional FK
  (`memberId`) precedent, applied here to `deviceId`/`stationId`.
- `apps/chrono-api/src/modules/shift/schema.ts` — `staffUserId` `restrict`-on-delete
  precedent for "who did this," applied here to `acknowledgedByUserId`/
  `resolvedByUserId`.
- `apps/chrono-api/src/modules/station/routes.ts` — pagination/list-query shape to copy
  for the alert feed.
- `.ai/rules/business-app.md` — module folder: `apps/chrono-api/src/modules/security-alert/`
  (singular, per Naming convention) with `schema.ts` + `contracts.ts` + `routes.ts`.
- `apps/chrono-api/src/auth/permissions.ts` — add `securityAlert` via
  `registerAppPermissions()`, following the exact `reservation`/`station` shape already
  there.

### Divergences from oikos prior art

Read directly from `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/{database/schema/security-alert.ts,modules/security-alerts/{service.ts,routes.ts}}`.
oikos's version is materially weaker than what this plan builds, in specific ways:

1. **No acknowledge step — only `resolvedAt`.** oikos's `SecurityAlert` has exactly one
   state transition: open → resolved. There is no way to signal "someone is actively
   handling this" short of resolving it outright, so either staff resolve prematurely
   (losing the "still investigating" signal) or an alert sits visibly open while
   someone is, in fact, on it. This plan adds a distinct `acknowledged` state (see
   Schema) specifically to fix that gap.
2. **`resolve` requires no note.** oikos's `resolve(id, tenantId, resolvedByUserId)`
   takes no message — the audit trail records *that* someone resolved it and *when*,
   never *why* or *what was found*. For a security incident log, "resolved, no
   explanation" is close to useless six months later. This plan makes
   `resolutionNote` a required field on resolve (Zod-enforced, `.min(1)`).
3. **Only `OWNER` can resolve, but `STAFF` can list — an odd, undermotivated split.**
   oikos's `routes.ts` gates `GET /` to `['OWNER', 'STAFF']` and
   `POST /:id/resolve` to `['OWNER']` only, with no stated reason and no acknowledge
   step for staff to do anything short of escalating to an owner. This plan gives
   staff full `manage` (acknowledge + resolve + manual-report) — a security alert is
   routine front-desk-adjacent work like `reservation`/`shift`, not an owner-only
   financial/config action; see Permission vocabulary below. (Flagged as **Open
   Question 2** rather than silently asserted — the developer may prefer oikos's
   split if security triage is meant to always escalate to an owner.)
4. **No rate limiting or per-device throttling on alert ingestion.** Nothing in
   oikos's service/route caps how many alerts one device (or one attacker holding a
   stolen device token) can insert per minute — a compromised/buggy kiosk could flood
   the table. This plan's Phase 5 (device-reporting endpoint, blocked on `devices`)
   explicitly requires a per-device rate limit at insert time (**Open Question 3**:
   exact threshold, e.g. 20/minute) — called out now so it isn't silently dropped once
   `devices` unblocks that phase.
5. **`severity` values (`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`) have no defined taxonomy of
   `type`s** — `type` is unconstrained free text with no registry, so "chassis_open" and
   "ChassisOpened" could both exist as distinct, ungrouped strings. This plan keeps
   `type` free-text (matches the dominant Chrono convention — no pg enum ceremony) but
   documents a **starter taxonomy** in Contracts below as a Zod `.enum` with an
   `"other"` escape hatch, rather than fully unconstrained text — a stricter middle
   ground than oikos, looser than a closed enum that would need a migration for every
   new alert type.
6. **`list()` defaults `limit: 50` with no upper bound enforced server-side beyond the
   caller's own optional query param** — a caller can pass an arbitrarily large
   `limit`. This plan uses the shared `listQuerySchema` (`.ai/rules/pagination.md`),
   which caps `pageSize` at 100.
7. **Generic error messages leak implementation detail** (`err.message` returned
   directly to the client in `resolve`'s catch block). This plan throws `HttpError`
   with a fixed message per `.ai/rules/api.md` — never echoes a raw driver/service
   error string to the client.

### Schema — `ChronoSecurityAlerts`

New file `apps/chrono-api/src/modules/security-alert/schema.ts`:

```ts
import { pgTable, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";

export const chronoSecurityAlert = pgTable(
  "ChronoSecurityAlerts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    stationId: text("stationId").references(() => chronoStation.id, {
      onDelete: "set null",
    }),
    // Nullable by design (Dependency decision above) — set once `devices`
    // lands and a kiosk reports the alert itself. Never populated by this
    // plan's own Phases 1-4.
    deviceId: text("deviceId"),
    // "device" | "staff" — who/what created the row. Not a pg enum (matches
    // convention); Zod-validated at the contract layer instead.
    raisedBy: text("raisedBy").notNull(),
    // Set only when raisedBy === "staff" and no signed-in device context
    // exists yet; restrict, not cascade/set null — an incident report must
    // survive the reporting staff account being deleted later (matches
    // ChronoShifts.staffUserId / ChronoReservations.createdByUserId).
    reportedByUserId: text("reportedByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    // "low" | "medium" | "high" | "critical"
    severity: text("severity").notNull(),
    // Starter taxonomy, see Contracts — free text at the DB layer, Zod-enum
    // constrained at the contract layer with an "other" escape hatch.
    type: text("type").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    // "open" | "acknowledged" | "resolved"
    status: text("status").notNull().default("open"),
    acknowledgedByUserId: text("acknowledgedByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    acknowledgedAt: timestamp("acknowledgedAt"),
    resolvedByUserId: text("resolvedByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolvedAt"),
    resolutionNote: text("resolutionNote"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_security_alert_tenant_idx").on(t.tenantId),
    index("chrono_security_alert_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_security_alert_station_idx").on(t.stationId),
    index("chrono_security_alert_status_idx").on(t.status),
    index("chrono_security_alert_severity_idx").on(t.severity),
    index("chrono_security_alert_created_idx").on(t.createdAt),
  ],
);

export type NewChronoSecurityAlert = typeof chronoSecurityAlert.$inferInsert;
export type ChronoSecurityAlertRow = typeof chronoSecurityAlert.$inferSelect;
```

**`deviceId` has no FK constraint declared in Phase 1** (plain `text`, not
`.references(() => chronoDevice.id)`) — because `chronoDevice`/`ChronoDevices` does not
exist yet. Once `devices` Phase 1 lands, a follow-up migration adds the FK
(`ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT ... REFERENCES "ChronoDevices"(id) ON DELETE SET NULL`)
— tracked explicitly in Phase 5 below, not silently assumed.

### `APP_TENANT_TABLES`

Add `"ChronoSecurityAlerts"` to `apps/chrono-api/src/db/schema.ts`'s array and re-export
`chronoSecurityAlert`, mirroring the existing re-export style. Check the file's current
state first (other Wave-2 modules may have landed entries concurrently).

### Permission vocabulary — `securityAlert`

Added via the per-app extension seam (`apps/chrono-api/src/auth/permissions.ts` +
`registerAppPermissions()`), never edited directly in `packages/agora`:

```ts
securityAlert: ["read", "manage"],
```

`manage` covers report/acknowledge/resolve — no staff/admin split (**Open Question 2**
above; this plan's default follows `reservation`'s "routine, not owner-only" framing).
`CHRONO_STAFF_GRANTS` and `CHRONO_ADMIN_GRANTS` both get `securityAlert: ["read", "manage"]`.

### Contracts — `apps/chrono-api/src/modules/security-alert/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const securityAlertSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

// Starter taxonomy (Divergence 5) — "other" is the escape hatch for anything
// not yet named; the DB column stays free text so a new named type never
// needs a migration, only a contract update.
export const securityAlertTypeSchema = z.enum([
  "device_tamper",
  "unauthorized_access",
  "unexpected_shutdown",
  "chassis_open",
  "camera_flagged",
  "customer_dispute",
  "theft_suspected",
  "other",
]);

export const reportSecurityAlertSchema = z.object({
  branchId: z.string().min(1),
  stationId: z.string().min(1).optional(),
  severity: securityAlertSeveritySchema,
  type: securityAlertTypeSchema,
  message: z.string().min(1).max(2000),
  metadata: z.record(z.unknown()).optional(),
});

export const resolveSecurityAlertSchema = z.object({
  resolutionNote: z.string().min(1).max(2000), // required — Divergence 2
});

export const securityAlertListQuerySchema = listQuerySchema([
  "createdAt",
  "severity",
]).extend({
  branchId: z.string().optional(),
  status: z.enum(["open", "acknowledged", "resolved"]).optional(),
  severity: securityAlertSeveritySchema.optional(),
});

export type ReportSecurityAlertInput = z.infer<typeof reportSecurityAlertSchema>;
export type ResolveSecurityAlertInput = z.infer<typeof resolveSecurityAlertSchema>;
```

### Routes — `apps/chrono-api/src/modules/security-alert/routes.ts`

All staff-facing, mounted at `/rpc/security-alerts` from `apps/chrono-api/src/routes/rpc.ts`,
inside `tenantMiddleware()`:

- `GET /` — list, paginated, filterable by `branchId`/`status`/`severity`. Gate:
  `securityAlert:["read"]`.
- `POST /` — manual staff report (`raisedBy: "staff"`, `reportedByUserId: c.var.tenant.userId`).
  Gate: `securityAlert:["manage"]`.
- `POST /:id/acknowledge` — 404 if wrong tenant, 409 if not currently `open`. Gate:
  `securityAlert:["manage"]`.
- `POST /:id/resolve` — validates `resolveSecurityAlertSchema`, 409 if already
  `resolved`. Gate: `securityAlert:["manage"]`.

Every mutation writes `recordStaffAudit` and looks up `branchId`/`stationId` inside the
same `withTenant` transaction before use (no existence leak).

---

## Phase 1 — DB Schema + RLS

**Files to Update**
- New: `apps/chrono-api/src/modules/security-alert/schema.ts`
- Update: `apps/chrono-api/src/db/schema.ts` (import + re-export + `APP_TENANT_TABLES`)

**Step-by-Step Tasks**
1. Write `chronoSecurityAlert` exactly as specified in Schema above.
2. Wire it into `db/schema.ts` following the existing re-export convention; add
   `"ChronoSecurityAlerts"` to `APP_TENANT_TABLES`.
3. `pnpm db:generate --name add_chrono_security_alerts`, review the generated SQL (no
   destructive ops expected — pure new table).
4. `pnpm db:migrate`.

**Acceptance Criteria**
- `ChronoSecurityAlerts` exists in the target DB with FKs to `Organization`,
  `ChronoBranches`, `ChronoStations` (nullable), `user` (three nullable FKs). No FK to a
  device table (none exists yet).
- Table is RLS-forced (part of `APP_TENANT_TABLES`).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/api rls:proof` → must print `RLS PROOF: PASS ✅`

**Out-of-Scope**
- The `chronoDevice` FK on `deviceId` (added once `devices` Phase 1 lands, Phase 5
  below).
- Any device-facing route.

**Execution Start Point**
- Read `apps/chrono-api/src/db/schema.ts`'s current state first (concurrent Wave-2
  modules may have landed entries) before editing.

---

## Phase 2 — Contracts + Permission Vocabulary

**Files to Update**
- New: `apps/chrono-api/src/modules/security-alert/contracts.ts`
- Update: `apps/chrono-api/src/auth/permissions.ts` (add `securityAlert` resource +
  staff/admin grants)

**Step-by-Step Tasks**
1. Write the contracts exactly as specified above.
2. Add `securityAlert: ["read", "manage"]` to `CHRONO_PERMISSION_STATEMENTS`,
   `CHRONO_STAFF_GRANTS`, `CHRONO_ADMIN_GRANTS`.

**Acceptance Criteria**
- `registerChronoPermissions()` compiles and the new resource shows up wherever
  `CHRONO_PERMISSION_STATEMENTS` is consumed (e.g. any permissions matrix test).

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/api test:permissions` (if a drift-guard test enumerates
  resources, confirm it doesn't need a manual update — check the test file first)

**Out-of-Scope**
- Routes (Phase 3).

**Execution Start Point**
- Read `apps/chrono-api/src/auth/permissions.ts` in full before editing — do not
  clobber a concurrently-landed resource from another Wave-2 module.

---

## Phase 3 — Staff-Facing Routes

**Files to Update**
- New: `apps/chrono-api/src/modules/security-alert/routes.ts`
- Update: `apps/chrono-api/src/routes/rpc.ts` (mount at `/rpc/security-alerts`)

**Step-by-Step Tasks**
1. Implement `GET /`, `POST /`, `POST /:id/acknowledge`, `POST /:id/resolve` exactly per
   Routes above — `zValidator`, `requirePermission` first, `withTenant` for every query,
   look up `branchId`/`stationId` inside the transaction.
2. `recordStaffAudit` on every mutation.
3. Mount the router.

**Acceptance Criteria**
- Manual `curl`/httpie smoke test: create → list → acknowledge → resolve, each state
  transition enforced (wrong-state transitions 409).
- Cross-tenant id → 404, not 403 or 500.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/api rls:proof`
- A focused route/unit test for the state-machine transitions (open→acknowledged→resolved,
  and the two 409 cases), following `reservation`'s `overlap.test.ts` style.

**Out-of-Scope**
- The device-reporting endpoint (Phase 5).
- Web UI (Phase 4).

**Execution Start Point**
- Copy `apps/chrono-api/src/modules/station/routes.ts`'s pagination/list-query shape
  and `apps/chrono-api/src/modules/reservation/routes.ts`'s state-transition-guard shape.

---

## Phase 4 — Web UI + E2E

**Files to Update**
- New: `apps/chrono-web/src/app/dashboard/security-alerts/page.tsx` (+ layout nav entry)
- New: `apps/chrono-web/e2e/tests/security-alerts/*.spec.ts`

**Step-by-Step Tasks**
1. Build the feed page using the shared `DataTableToolbar`/`DataTable`/
   `DataTablePagination` stack (`.ai/rules/data-listing.md`) — filters for `status`/
   `severity`/`branchId`, `useListQuery()` for URL state.
2. Row actions: Acknowledge, Resolve (dialog requiring a note), Report Incident
   (dialog form for manual report).
3. Add nav entry to the dashboard shell.
4. Write the e2e spec: happy path (report → acknowledge → resolve), role gate (a
   session with no `securityAlert:manage` cannot acknowledge/resolve — visibility only
   in the UI, 403 confirmed server-side), cross-tenant isolation (tenant B never sees
   tenant A's alert).

**Acceptance Criteria**
- Page renders, all actions work end to end against real routes.
- e2e spec passes.

**Verification Commands**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web test:e2e` (or equivalent script — confirm exact name
  in `apps/chrono-web/package.json` before running)

**Out-of-Scope**
- Any push/SMS notification beyond the existing `tenantNotification` bell
  (**Open Question 1**).

**Execution Start Point**
- Copy `apps/chrono-web/src/app/dashboard/reservations/` structure and its e2e spec
  shape verbatim.

---

## Phase 5 — Device-Reporting Endpoint (BLOCKED until `devices` Phase 1 + Phase 3 land)

**Files to Update**
- Update: `apps/chrono-api/src/modules/security-alert/schema.ts` (add the `deviceId` FK
  once `chronoDevice` exists)
- New: a route inside `devices`' own device-bearer-gated surface (owned by `devices`'
  plan, not mounted under `/rpc`) that inserts a `ChronoSecurityAlerts` row with
  `raisedBy: "device"`.
- Update: `apps/chrono-api/src/modules/security-alert/contracts.ts` (a device-facing
  Zod schema for the report payload, likely narrower than the staff one — no
  `branchId`/`stationId` from the client, derived from the authenticated device row).

**Step-by-Step Tasks**
1. Confirm `devices` Phase 1 (schema) and Phase 3 (device-auth middleware) are both
   implemented and merged.
2. Migrate the `deviceId` FK (raw-SQL `ALTER TABLE ... ADD CONSTRAINT`, since Drizzle
   already generated the column as plain `text` in Phase 1).
3. Add the device-facing insert route per `devices`' own mount pattern.
4. Add per-device rate limiting on this insert path (**Open Question 3**: exact
   threshold).
5. Update this plan's own Contracts/Schema sections in a follow-up commit once the
   concrete `devices`-Phase-3 middleware shape is known (its exact `c.var` shape isn't
   knowable until that code exists).

**Acceptance Criteria**
- A device with a valid, approved bearer token can raise an alert; a revoked/unknown
  device gets 401/403 per `devices`' own contract.
- Rate limit enforced and tested.

**Verification Commands**
- `pnpm typecheck`, `pnpm --filter @agora/api rls:proof`, a concurrency/rate-limit test.

**Out-of-Scope**
- Everything else — this phase is additive only.

**Execution Start Point**
- **Do not start this phase until `devices` Phase 1 + Phase 3 are verified merged on
  `main`.** Check `.ai/handover/chrono-migration.md`'s Plan status table for current
  `devices` implementation state before picking this up.

---

## CRUD & Feedback Contract

| Action | Who | Feedback |
|---|---|---|
| Create (manual report) | staff/admin/owner (`securityAlert:manage`) | toast success, row appears at top of feed |
| Create (device report) | device (bearer auth, Phase 5) | 201, no UI feedback (no human in the loop) |
| Read (list/detail) | staff/admin/owner (`securityAlert:read`) | table + filters |
| Update (acknowledge) | staff/admin/owner (`securityAlert:manage`) | toast success, status badge updates |
| Update (resolve) | staff/admin/owner (`securityAlert:manage`) | dialog requires note, toast success on save |
| Delete | **not supported** — a security incident log is never deleted, only resolved (append-only history, matches audit-log conventions) |

No soft-delete needed since delete is never offered. Every mutating action is
audit-linked via `recordStaffAudit`.
