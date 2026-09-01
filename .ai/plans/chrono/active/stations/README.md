# Chrono — `stations` module

**Depends on:** `branches` (plan done/committed; implementation Phase 1 — schema/RLS —
in progress as of this writing). A station belongs to a branch
(`branchId: text("branchId").references(() => chronoBranch.id, { onDelete: "cascade" })`,
importing `chronoBranch` from `apps/chrono-api/src/modules/branch/schema.ts`). This
plan assumes `chronoBranch`/`ChronoBranches` exists by the time `stations`' own
Phase 1 executes — it does not block on branches' full implementation to be written.
`devices` (planned next, separately) depends on this plan's output; `sessions`
(planned last) also depends on it. See "Forward references for `devices`" below.

## What this is

Stations are the individual PC/console gaming seats inside a branch — the thing a
customer sits at and a session runs on. This plan covers the **station entity itself**
(create/edit/list/delete, a lightweight pricing-tier grouping, and a manually-settable
operational status) — not device pairing (kiosk client auth, heartbeat, reboot/shutdown/
lock/unlock commands — all `devices`, landing after this) and not session/billing logic
(`sessions`, landing last).

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Owner / Admin** — full station CRUD: create/edit/delete stations, create/edit/
  delete station groups (pricing tiers), across every branch.
- **Staff** — day-to-day floor management: create and edit stations and station groups
  (this is oikos precedent — front-desk staff configure/reconfigure the floor
  constantly, unlike branch/venue-level configuration which is rare). Staff **cannot
  delete** a station or station group (destructive, admin+ only — same split
  `PERMISSION_STATEMENTS.file` already draws between `create`/`read` (staff) and
  `delete` (admin+)).
- **Platform admin (`/rpc-admin`)** — not built in this pass. Out of scope.

**Workflow:** Owner/Admin/Staff opens **Dashboard → Stations**, picks a branch from a
filter (URL-state, via `useListQuery(["branchId"])` — no `[branchCode]` route segment
exists yet, see `.ai/plans/chrono/active/branches/README.md`'s own deferred "current
branch" switcher), sees a paginated/searchable list of that branch's stations, clicks
**Add Station**, fills a form (name + station number required, station group/type/zone/
specs optional), saves. A second tab/section, **Groups & Rates**, manages station
groups (pricing tiers: name, code, hourly rate, optional member rate) — a station
optionally belongs to one group. Editing follows the same dialogs, pre-filled. Deleting
a station or group requires confirmation (destructive — unlike branches, this pass does
support a real delete; see "Deliberate differences from oikos" below).

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Staff attempts delete (station or group) → 403 `Forbidden`, gated by
  `requirePermission`.
- Duplicate `stationNumber` within a branch → 409 (unique per `(branchId,
  stationNumber)`).
- Duplicate station-group `code` within a branch → 409 (unique per `(branchId, code)`).
- Deleting a station group that's still referenced by a station → 409 (`A station group
  in use cannot be deleted` — matches oikos's `DEVICE_GROUP_IN_USE` guard).
- Wrong tenant/host → `tenantMiddleware()` never resolves a `c.var.tenant`, so the
  request never reaches the handler.
- **Tenant-isolation leak scenario**: tenant A creates a station "PC-01" in its branch;
  tenant B (which may also have a "PC-01") must never see tenant A's row, must get 404
  (never 403 — no existence leak) editing/deleting tenant A's station id directly, and
  the `(branchId, stationNumber)` / `(branchId, code)` unique indexes must not falsely
  conflict across tenants — `branchId` itself already belongs to exactly one tenant (FK
  to `chronoBranch`), so the composite index is inherently tenant-safe, not just an RLS
  backstop.
- A station referencing a branch id from a **different tenant** (e.g. a stale/forged
  `branchId` in the create payload) must be rejected — the route validates the target
  branch belongs to `c.var.tenant.tenantId` before insert (RLS on `chronoBranch` makes a
  cross-tenant `branchId` simply unreadable inside the same `withTenant` transaction, so
  a lookup-then-insert pattern is both the natural implementation and the safety net —
  see Phase 3).
- Stale screen: two staff editing the same station — last write wins (no optimistic
  lock in this pass, matching `project`/`branch`'s own simplicity).

**Audit / notifications:** every create/update/delete on a station or station group
writes a `recordStaffAudit` entry (`station.created` / `station.updated` /
`station.deleted` / `stationGroup.created` / `stationGroup.updated` /
`stationGroup.deleted`), matching the `project`/`branch` pattern. No webhook event in
this pass (`station.*` isn't in `WEBHOOK_EVENTS` — same deferral branches made; trivial
follow-up, not required to ship).

---

## Pass 2 — Technical Planning

### What exists today in oikos (source of truth for "what exists")

Oikos's chrono-api module folder is at `apps/chrono-api/src/modules/stations/` (note:
oikos's `@chrono/db` path-aliases to `apps/chrono-api/src/database/`, **not** a
`packages/chrono-db` package — worth knowing since a naive package search for
`@chrono/db` finds nothing; it's a `tsconfig.json` `paths` alias to a local folder).

- `apps/chrono-api/src/database/schema/stations.ts` (oikos) — two tables:
  - `Station` (`Stations`, uuid PK): `tenantId`, `branchId`, `deviceGroupId` (nullable
    FK to `DeviceGroup`), `name`, `stationType` (nullable text, app defaults `'PC'`),
    `stationNumber`, `status` (`StationStatusEnum`: `AVAILABLE | IN_USE | LOCKED |
    MAINTENANCE | RESERVED | AWAY_LOCKED`), `locationZone`, `specsJson` (jsonb —
    `cpu`/`gpu`/`ram`/`monitorHz`), `isActive` (boolean, separate from `status`),
    `lastSeenAt` (device-heartbeat-driven, duplicated on `Device.lastSeenAt` too — see
    "Deliberate differences" below), timestamps. Unique `(branchId, stationNumber)`.
  - `DeviceGroup` (`DeviceGroups`, uuid PK) — despite the name, this is a **station
    pricing-tier grouping**, not related to the `devices` module's device-pairing
    concept at all (the oikos name is genuinely confusing — this plan renames it, see
    below): `tenantId`, `branchId`, `name`, `code`, `description`, `metadataJson`.
    Unique `(branchId, code)`. The actual **hourly rate lives on a separate table**,
    `PricingRule` (`apps/chrono-api/src/database/schema/station-operations.ts`) — a
    generic multi-type pricing engine (`type`: `HOURLY | PACKAGE | PROMO | OPEN_TIME`,
    `membershipTier`, `userType`, `dayOfWeek`/`startTime`/`endTime` windows, `priority`,
    keyed loosely by `deviceGroupId`/`branchId`). A device group's "hourly rate" /
    "member rate" is really two `PricingRule` rows (`type: 'HOURLY'`, one with
    `membershipTier: 'MEMBER'`, one without) — see "Deliberately narrowed" below for why
    this plan does **not** port `PricingRule`.
- `apps/chrono-api/src/database/schema/device.ts` (oikos) — confirms the
  device↔station relationship is **`Device.stationId` → `Station.id`** (`onDelete: 'set
  null'`, plus a partial unique index limiting one *approved* `PC_CLIENT` device per
  station). **The FK lives on the device side, not the station side** — `Station` has
  no `deviceId` column anywhere in oikos. This directly answers the "does the station
  schema have a direct device FK" question the developer asked to check: **no**. See
  "Forward references for `devices`" below.
- `apps/chrono-api/src/modules/stations/routes.ts` + `service.ts` (oikos) — Hono routes
  mounted under a branch-scoped path (`requireBranch` middleware resolves branch from a
  `branchCode` URL segment agora doesn't have yet — branches deferred that switcher):
  `GET /` (station grid: joins `Station` + `DeviceGroup` + `Device` (approved) +
  `DeviceSession` (active) + `User`, for a live floor-status view — **not** ported here,
  see "Deliberately narrowed"), `POST/PUT/DELETE /:id` (station CRUD, role-gated
  `requireRole(['OWNER', 'STAFF'])` — **both** tenant roles, unlike branches which
  oikos gated `OWNER`-only), `GET/POST/PUT/DELETE /device-groups[/:id]` (device-group —
  i.e. station-group — CRUD, same `OWNER`+`STAFF` gate, plus the `PricingRule`
  read/write side-effects described above), `POST /:id/lock` + `/:id/unlock` (device
  commands — **not** this module, belongs to `devices`).
- `apps/chrono-api/src/modules/public-stations/` (oikos) — `dto.ts`/`routes.ts`/
  `service.ts`: an **unauthenticated** `GET /public/tenants/:tenantSlug/
  station-availability` endpoint joining `Station` + `Branch` + `Device` +
  `DeviceSession` + `PricingRule` + `Reservation` into a public-facing live
  availability/pricing summary (used by a customer-facing page, not the tenant admin
  dashboard). **Confirmed out of scope**: `.ai/handover/chrono-migration.md` lists
  `public-stations` under "Deferred (later waves, not planned yet)". Nothing in this
  plan builds it or a route shaped like it.
- `apps/chrono-web/src/lib/tenant-estate.ts` (oikos) — the actual station API client
  (not `tenant-stations.ts`, which is the **public**-availability client only, see
  below). `Station`/`DeviceGroup`/`StationGridItem` types + `tenantEstateService`
  (`listStations`, `getStationGrid`, `listDeviceGroups`, `create/update/
  deleteDeviceGroup`, `create/update/deleteStation`, `getStationClientConfig`). The
  `StationClientConfig` (pairing-code/auto-update/lock-on-startup/min-charge settings)
  is a `devices`-module concern (kiosk client provisioning), not this one.
- `apps/chrono-web/src/lib/tenant-stations.ts` (oikos) — **misleadingly named**: this is
  the **public** station-availability client (`getPublicStationAvailability`), not the
  tenant-admin station CRUD client. Confirms the `public-stations` deferral above; not
  ported.
- `apps/chrono-web/src/app/tenant/admin/.../[branchCode]/stations/stations-client.tsx` +
  `station-actions-dialog.tsx` + `station-grid-client.tsx` + `.../station-client/
  station-client-client.tsx` (oikos) — the admin stations table mixes true station-CRUD
  concerns (name, stationNumber, group, "Add/Edit Station") with **device**-operational
  concerns (reboot/shutdown/revoke actions, live connectivity dot, IP address, last
  heartbeat, "Client Settings" pairing-code page) in the same screen. This plan ports
  only the station-CRUD half; the device-operational half is `devices`' UI to build
  later against this module's station rows.

### Deliberately narrowed from oikos (and why)

- **No `PricingRule` engine.** Oikos's `PricingRule` table is a genuinely separate,
  much larger system (multi-type: hourly/package/promo/open-time; day-of-week and
  time-of-day windows; membership-tier and user-type overrides; priority-ranked
  resolution) shared by promos, packages, and session billing — none of which are
  Wave-1 modules (`promos`/`pos`/`reservations` are explicitly deferred per
  `.ai/handover/chrono-migration.md`; there is no Wave-1 `pricing` module at all).
  Building that engine now, ahead of `sessions` (the only Wave-1 module that will
  actually *consume* a resolved price), would be exactly the "business-specific
  module nobody asked for yet" `.ai/rules/ai-agent.md` warns against. Instead, this
  plan folds a **flat `hourlyRate` + optional `memberRate`** directly onto the
  station-group row — enough to answer "what does this tier cost" for the admin UI and
  for `sessions` to read literally, without the dynamic rule-resolution machinery.
  **Open Question 3** below flags this explicitly for the developer.
- **No station grid / live floor-status endpoint.** Oikos's `GET /stations` joins in
  live `DeviceSession` + `Device` connectivity data that don't exist yet (`devices`,
  `sessions` are later modules). This plan's `GET /stations` returns the station rows
  themselves (name, number, group, type, zone, status, specs) — a real-time occupancy
  view is `sessions`' concern once sessions exist, and `devices`' concern for live
  connectivity.
- **`isActive` + `status` duality collapsed into one `status` column.** Oikos carries
  both a boolean `isActive` (enable/disable) and a 6-value `status` enum where several
  values (`IN_USE`, `LOCKED`, `RESERVED`, `AWAY_LOCKED`) are exclusively
  session/device-driven state that doesn't exist as a concept yet. This plan uses a
  single free-text `status` column with a **3-value admin-settable vocabulary**
  (`"available" | "maintenance" | "offline"` — `"offline"` doubling as oikos's
  `isActive: false`) and reserves a 4th value, `"occupied"`, in the column's domain but
  **not** in this pass's Zod contract — `sessions`/`devices` will be the ones to
  actually set it, once they exist to back it with a real session. See Open Question 2.
- **No `lastSeenAt` on the station.** Oikos duplicates a heartbeat timestamp on both
  `Station.lastSeenAt` and `Device.lastSeenAt` — the device's own heartbeat is the
  source of truth; a station-level copy is redundant and unwritten by anything in this
  pass. Dropped; `devices` owns `ChronoDevices.lastSeenAt` when it lands.
- **Real hard `DELETE`, unlike `branches`.** `branches` deferred delete entirely
  because nothing downstream existed to cascade/reassign. Stations are different:
  oikos supports a real delete, and at the point this plan lands (before `devices`/
  `sessions` exist), a station has no downstream rows of its own to worry about either
  — so this plan matches oikos and the `project`/`file` resource precedent and ships a
  real `DELETE`. The one thing to flag forward: once `devices` lands and defines
  `ChronoDevices.stationId → ChronoStations.id`, **that plan** (not this one) decides
  the FK's `onDelete` behavior — recommend mirroring oikos's `set null` (deleting a
  station un-pairs its device rather than deleting device history).

### Pattern to copy in agora (worked example: `branch`, one level removed from `project`)

- `apps/chrono-api/src/modules/branch/schema.ts` — table shape, `text`/`createId()`
  ids, `*_tenant_idx` index, composite unique index.
- `apps/chrono-api/src/db/schema.ts` — re-export + `APP_TENANT_TABLES` composition
  point (already has the `chronoBranch` re-export wired; this plan adds two more).
- `apps/chrono-api/src/routes/rpc.ts` — the `project`/`file` GET (paginated via
  `listQuerySchema`) / POST (`requirePermission`) / DELETE (`requirePermission`) shape,
  `withTenant(tenantId, tx => …)`, `recordStaffAudit` after each mutation,
  `buildPaginationMeta`.
- `.ai/rules/business-app.md` — module folder is `apps/chrono-api/src/modules/station/`
  (singular, kebab-case — `business-app.md` literally uses `station` as its own naming
  example), holding `schema.ts` + `contracts.ts` + `routes.ts`, composed into
  `apps/chrono-api/src/db/schema.ts` / `apps/chrono-api/src/routes/rpc.ts` (the only
  two files that change to wire in a new module, per that rule).
- `packages/agora/src/auth/permissions.ts` — `PERMISSION_STATEMENTS` + `staffRole`/
  `adminRole` composition (Open Question 1 below).

### Schema — `ChronoStations` + `ChronoStationGroups`

New file `apps/chrono-api/src/modules/station/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex, jsonb, numeric } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";

export const chronoStationGroup = pgTable(
  "ChronoStationGroups",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    // Flat baseline rate — NOT the full oikos `PricingRule` engine (day/time
    // windows, promos, packages). See Pass 2 "Deliberately narrowed".
    hourlyRate: numeric("hourlyRate", { precision: 12, scale: 2 }).notNull().default("0"),
    memberRate: numeric("memberRate", { precision: 12, scale: 2 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_station_group_tenant_idx").on(t.tenantId),
    index("chrono_station_group_branch_idx").on(t.branchId),
    uniqueIndex("chrono_station_group_branch_code_idx").on(t.branchId, t.code),
  ],
);

export const chronoStation = pgTable(
  "ChronoStations",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    stationNumber: text("stationNumber").notNull(),
    // Free-text physical category (e.g. "pc", "console", "vip"), not a pg enum —
    // matches the dominant agora convention (see branches' own `status`).
    stationType: text("stationType").notNull().default("pc"),
    // "available" | "maintenance" | "offline" are admin-settable this pass;
    // "occupied" is a reserved 4th value `sessions`/`devices` will set later —
    // see Pass 2 "Deliberately narrowed" + Open Question 2.
    status: text("status").notNull().default("available"),
    locationZone: text("locationZone"),
    specs: jsonb("specs").$type<{
      cpu?: string | null;
      gpu?: string | null;
      ram?: string | null;
      monitorHz?: number | null;
    } | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_station_tenant_idx").on(t.tenantId),
    index("chrono_station_branch_idx").on(t.branchId),
    index("chrono_station_group_idx").on(t.stationGroupId),
    uniqueIndex("chrono_station_branch_number_idx").on(t.branchId, t.stationNumber),
  ],
);
```

No `deviceId` column — confirmed above the FK belongs on the future `ChronoDevices`
row, not here.

### `APP_TENANT_TABLES`

Add `"ChronoStationGroups"` and `"ChronoStations"` to the array in
`apps/chrono-api/src/db/schema.ts`, and re-export both from the module into that file
(same composition point already used for `chronoBranch`).

### Contracts — `apps/chrono-api/src/modules/station/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const stationStatusSchema = z.enum(["available", "maintenance", "offline"]);

const stationSpecsSchema = z
  .object({
    cpu: z.string().max(255).nullable().optional(),
    gpu: z.string().max(255).nullable().optional(),
    ram: z.string().max(255).nullable().optional(),
    monitorHz: z.number().int().positive().max(1000).nullable().optional(),
  })
  .optional();

export const createStationGroupSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  hourlyRate: z.coerce.number().nonnegative().max(999999),
  memberRate: z.coerce.number().nonnegative().max(999999).optional(),
});
export const updateStationGroupSchema = createStationGroupSchema
  .omit({ branchId: true })
  .partial();

export const createStationSchema = z.object({
  branchId: z.string().min(1),
  stationGroupId: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  stationNumber: z.string().min(1).max(50),
  stationType: z.string().min(1).max(50).optional(),
  status: stationStatusSchema.optional(),
  locationZone: z.string().max(255).optional(),
  specs: stationSpecsSchema,
});
export const updateStationSchema = createStationSchema.omit({ branchId: true }).partial();

export const stationListQuerySchema = listQuerySchema([
  "name",
  "stationNumber",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
  stationGroupId: z.string().optional(),
});

export const stationGroupListQuerySchema = listQuerySchema([
  "name",
  "code",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
});

export type CreateStationGroupInput = z.infer<typeof createStationGroupSchema>;
export type UpdateStationGroupInput = z.infer<typeof updateStationGroupSchema>;
export type CreateStationInput = z.infer<typeof createStationSchema>;
export type UpdateStationInput = z.infer<typeof updateStationSchema>;
export type StationStatus = z.infer<typeof stationStatusSchema>;
```

`branchId` is required on create (a station/group must belong to a specific branch —
there's no `[branchCode]` route context to infer it from yet) but **not** re-validated
as "belongs to this tenant" at the Zod layer — that's a DB-level check in the route
(see Routes below), since Zod has no DB access.

### Routes — `apps/chrono-api/src/modules/station/routes.ts`

A Hono factory `stationRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/stations", stationRoutes())`:

- `GET /` — **ungated** (any authenticated tenant member/role can list — staff need
  this to work the floor). `zValidator("query", stationListQuerySchema)`, optional
  `branchId`/`stationGroupId` filters, `withTenant`, returns `{ items, meta }`
  (`buildPaginationMeta` pattern).
- `GET /groups` — **ungated**, same shape, `zValidator("query",
  stationGroupListQuerySchema)`.
- `POST /groups` — `requirePermission(c.var.tenant.permissions, { station: ["create"] })`.
  Validates `createStationGroupSchema`. Looks up `branchId` inside the same
  `withTenant` transaction (RLS makes a foreign-tenant branch id simply not found —
  404, never a leaked "belongs to someone else" signal) before insert. 409 on
  `(branchId, code)` conflict. `recordStaffAudit({ action: "stationGroup.created", ... })`.
- `PATCH /groups/:id` — `requirePermission(..., { station: ["update"] })`. 404 if the
  group isn't in the caller's tenant. `recordStaffAudit({ action:
  "stationGroup.updated", ... })`.
- `DELETE /groups/:id` — `requirePermission(..., { station: ["delete"] })`. 409
  (`STATION_GROUP_IN_USE`-style message) if any `chronoStation` row still references
  it — mirrors oikos's `DEVICE_GROUP_IN_USE` guard. `recordStaffAudit({ action:
  "stationGroup.deleted", ... })`.
- `POST /` — `requirePermission(..., { station: ["create"] })`. Validates
  `createStationSchema`. Same branch-ownership lookup-before-insert as groups. 409 on
  `(branchId, stationNumber)` conflict. `recordStaffAudit({ action: "station.created",
  ... })`.
- `PATCH /:id` — `requirePermission(..., { station: ["update"] })`. 404 cross-tenant.
  `recordStaffAudit({ action: "station.updated", ... })`.
- `DELETE /:id` — `requirePermission(..., { station: ["delete"] })`. 404 cross-tenant.
  `recordStaffAudit({ action: "station.deleted", ... })`.

No `emitTenantEvent` webhook calls in this pass (same deferral `branches` made —
`station.*`/`stationGroup.*` aren't in `WEBHOOK_EVENTS`).

### Permission vocabulary

**Open Question 1 (resolve before Phase 3):** oikos gates *all* station and
device-group mutation (`POST`/`PUT`/`DELETE`) with `requireRole(['OWNER', 'STAFF'])` —
i.e. staff has full CRUD, including delete. `branches` (this codebase's own precedent)
deliberately excluded `staff` entirely from branch mutation. This plan takes a middle
position, matching the existing `file` resource's own staff/admin split (`file:
["create", "read"]` for staff, `+"delete"` for admin): **staff gets create+update, not
delete**. Adds:

```ts
// packages/agora/src/auth/permissions.ts
export const PERMISSION_STATEMENTS = {
  ...
  station: ["create", "update", "delete"],
} as const;
```

- `staffRole` — `station: ["create", "update"]` (day-to-day floor management: add a
  new PC, rename it, move it to a different group/zone, flip it to maintenance/offline
  — all reversible, non-destructive). Matches oikos parity for the actions staff
  actually needs; withholds the one destructive action.
- `adminRole` — `station: ["create", "update", "delete"]`.
- `ownerRole` — inherits automatically.

One resource (`station`) covers **both** the station and station-group entities —
they're always managed by the same actor tier with no scenario needing to differ, so a
second `stationGroup` resource would be exactly the "unused permission granularity"
`.ai/rules/rbac.md` warns against.

**Open Question 2:** the `status` column's domain includes a 4th value, `"occupied"`,
that this pass's Zod contract (`stationStatusSchema`) deliberately excludes — only
`sessions`/`devices`, once they exist, should be able to mark a station occupied
(backed by a real session), not an admin manually typing it into a form. Confirm this
reading; if the developer wants the full future vocabulary reserved in the *contract*
now (even though nothing sets it yet), that's a one-line change to
`stationStatusSchema`.

**Open Question 3:** this plan's `hourlyRate`/`memberRate` on `chronoStationGroup` is a
flat placeholder, explicitly **not** a port of oikos's `PricingRule` engine (dynamic
multi-type, time-windowed, priority-resolved pricing shared with promos/packages/
sessions). Confirm this scope is acceptable — `sessions` (or a future dedicated
`pricing` module, not currently in the Wave-1 list) will need to decide how it actually
resolves a charge, and may consume this flat rate as-is or need something richer.
Flagging now so it's a deliberate scope line, not a default nobody noticed.

### Forward references for `devices`

- `devices`' own Phase 1 defines `ChronoDevices.stationId` referencing
  `ChronoStations.id`, **nullable**, matching oikos's `Device.stationId` (`onDelete:
  'set null'` there) — the FK lives on the device row, this module adds nothing to
  `ChronoStations` for it.
- If the developer wants oikos's integrity guarantee ("at most one *approved* device
  paired per station") ported too, that's a partial unique index on `ChronoDevices`
  (`stationId` where `status = 'approved'`) — `devices`' plan to write, not this one.
- `devices`' own `lastSeenAt`/connectivity/reboot-shutdown-lock-unlock commands operate
  against `chronoStation.id` as a foreign key target only; nothing else here couples to
  it.

### Web UI — `apps/chrono-web/src/app/dashboard/stations/`

- `page.tsx` — client component (mirrors
  `apps/chrono-web/src/app/dashboard/projects/page.tsx`): `useListQuery(["branchId"])`
  for URL-driven page/pageSize/q/sort/order/view **plus** a `branchId` filter,
  `api.rpc.stations.$get({ query: {...} })`, `DataTable`/`DataTableGrid` +
  `DataTableToolbar` + `DataTablePagination` from `agora/ui`. A `Select` at the top of
  the toolbar filters by branch (options from `api.rpc.branches.$get`, "All branches"
  as the default/cleared state) — the same shape as oikos's own branch filter in
  `stations-client.tsx`, just URL-state-driven instead of route-segment-driven.
- Two `Tabs` (`agora/ui`, `tabs.tsx` already exists): **Stations** (default) and
  **Groups & Rates**. The second tab lists `chronoStationGroup` rows (name, code, rate,
  member rate) with its own create/edit/delete dialog — small, low-cardinality per
  branch, so `useClientListPage` (`.ai/rules/data-listing.md`) is acceptable here **if**
  the page's own code says why in a one-line comment; otherwise use the same
  server-paginated `DataTable` shape as the Stations tab for consistency. Leave the
  choice to whoever implements Phase 4, both are compliant.
- A create/edit `Dialog` (`agora/ui`) for stations: `name`, `stationNumber` (required),
  `stationGroupId` (`Select`, populated from the groups list, "None" as a valid choice),
  `stationType`, `status` (`Select`: Available/Maintenance/Offline — never "Occupied",
  per Open Question 2), `locationZone`, and three optional spec fields (`cpu`/`gpu`/
  `ram`) plus `monitorHz` (`Input type="number"`) — all via `agora/ui` primitives only
  (`.ai/rules/component-first-ui.md`).
- A create/edit `Dialog` for station groups: `name`, `code`, `description`,
  `hourlyRate`, `memberRate` — same primitives.
- `toast.success`/`toast.error` on every mutation, matching the `Projects` page's
  inline-error convention.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Stations` entry to
  `BASE_NAV` (a `Monitor`/`Gamepad2`-style `lucide-react` icon) and a
  `"/dashboard/stations": "Stations"` line to `TITLES`, mirroring the `Projects` entry
  (and whatever `Branches` entry lands from that plan's own Phase 4 — exact line
  numbers aren't pinned here since `branches` Phase 4 hasn't landed at the time this
  plan is written; insert alongside it, don't assume a fixed line number).
- No module-registry feature-flag gate (core to every Chrono tenant, same reasoning as
  `branches`).

### CRUD & Feedback Contract

| Entity | Action | Method | Permission | Notes |
|---|---|---|---|---|
| Station | List | `GET /rpc/stations` | none (any tenant member) | paginated, filterable by `branchId`/`stationGroupId`, searchable by name/number |
| Station | Create | `POST /rpc/stations` | `station:create` | 409 on duplicate `(branchId, stationNumber)`; 404 if `branchId` isn't the caller's tenant |
| Station | Update | `PATCH /rpc/stations/:id` | `station:update` | 404 cross-tenant; `status` limited to `available`/`maintenance`/`offline` |
| Station | Delete | `DELETE /rpc/stations/:id` | `station:delete` | 404 cross-tenant; real hard delete (see "Deliberate differences") |
| Station Group | List | `GET /rpc/stations/groups` | none (any tenant member) | paginated, filterable by `branchId` |
| Station Group | Create | `POST /rpc/stations/groups` | `station:create` | 409 on duplicate `(branchId, code)` |
| Station Group | Update | `PATCH /rpc/stations/groups/:id` | `station:update` | 404 cross-tenant |
| Station Group | Delete | `DELETE /rpc/stations/groups/:id` | `station:delete` | 409 if any station still references it |

Feedback: `toast.success`/`toast.error` at the point of the API call
(`.ai/rules/ui.md`), no separate `<FormError>`.

Audit linkage: `recordStaffAudit` on every create/update/delete for both entities, same
as `project`/`branch`. Delete (both entities) shows a `ConfirmationDialog`-style confirm
step client-side before firing the request — destructive, unlike a status-only PATCH.

### Out of Scope (this plan)

- `devices` module: kiosk pairing/auth, device connectivity/heartbeat, reboot/
  shutdown/lock/unlock commands, `ChronoDevices.stationId` FK itself. Forward-referenced
  above; built as its own plan.
- `sessions` module: anything session-driven — the `"occupied"` status value, live
  floor/grid view, actual price resolution/billing against a station's rate.
- The full oikos `PricingRule` engine (promos/packages/time-windows/priority
  resolution) — Open Question 3.
- `public-stations` (public/customer-facing station-availability view) — confirmed
  deferred per `.ai/handover/chrono-migration.md`; nothing in this plan builds it.
- `admin-station-client` (oikos's kiosk pairing-code admin screen) — deferred per the
  same handover list; belongs with `devices` if ever un-deferred.
- The `/rpc-admin` platform-admin cross-tenant station view. No `PLATFORM_PERMISSION_STATEMENTS`
  resource exists for stations today; a separate, later plan if platform staff need it.
- The `[branchCode]` URL-segment "current branch" context switcher — same deferral
  `branches` made; this plan uses a URL-query `branchId` filter instead.
- A `station.*`/`stationGroup.*` webhook event — trivial follow-up, not required to
  ship.
- Module-registry (`modules.station`) feature-flag gating of the nav entry.
- `shifts` — a sibling Wave-1 module, depends only on `branches`, not on this plan.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/station/schema.ts` (new) — `chronoStationGroup` +
  `chronoStation` tables (see Pass 2 above).
- `apps/chrono-api/src/db/schema.ts` — import + re-export both, add
  `"ChronoStationGroups"` and `"ChronoStations"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Create `apps/chrono-api/src/modules/station/` and write `schema.ts` exactly as
   specified in Pass 2 (`chronoStationGroup` **before** `chronoStation` in the file —
   the latter's FK references the former). Import `chronoBranch` from
   `../branch/schema` (peer-module import, not via `../../db/schema`, to avoid a
   circular import through the composition file).
2. In `apps/chrono-api/src/db/schema.ts`, add
   `export { chronoStationGroup, chronoStation } from "../modules/station/schema";`
   (matching the existing `chronoBranch` re-export style) and append
   `"ChronoStationGroups"`, `"ChronoStations"` to the `APP_TENANT_TABLES` tuple (groups
   before stations, matching creation order — cosmetic, but keep it consistent).
3. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_stations` (never
   `db:push`). Review the generated SQL: expect `CREATE TABLE "ChronoStationGroups"`
   then `CREATE TABLE "ChronoStations"` plus their indexes, no destructive statements.
   Confirm the migration's `ChronoBranches` FK reference matches whatever `branches`'
   own Phase 1 already produced (if it has landed by then) — if `branches` Phase 1
   hasn't landed yet when this phase runs, this migration will fail at
   `db:migrate` time until it does; that's the real dependency-ordering gate, not
   just a documentation note.
4. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.

**Acceptance criteria**

- `ChronoStationGroups` and `ChronoStations` exist with `FORCE ROW LEVEL SECURITY` on.
- Both names are present in `APP_TENANT_TABLES` in `apps/chrono-api/src/db/schema.ts`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/station/schema.ts`.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/station/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `stationStatusSchema`, `createStationGroupSchema`/`updateStationGroupSchema`,
   `createStationSchema`/`updateStationSchema`, `stationListQuerySchema`/
   `stationGroupListQuerySchema`, and their `z.infer` types exactly as specified in
   Pass 2.
2. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- All types compile and are importable from `../modules/station/contracts` inside
  `apps/chrono-api`.
- `updateStationSchema`/`updateStationGroupSchema` accept a single-field payload (no
  field required) and reject `branchId` (immutable after creation — `.omit({branchId:
  true})`).
- `stationStatusSchema` accepts `"available"`/`"maintenance"`/`"offline"` and rejects
  `"occupied"` and any other string.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create `apps/chrono-api/src/modules/station/contracts.ts`.

---

## Phase 3 — Routes + permission gates

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `station: ["create", "update",
  "delete"]` to `PERMISSION_STATEMENTS`, `station: ["create", "update"]` to
  `staffRole`, `station: ["create", "update", "delete"]` to `adminRole` (resolve Open
  Question 1 first — see Pass 2).
- `apps/chrono-api/src/modules/station/routes.ts` (new) — `stationRoutes()` factory.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/stations", stationRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add `station` gate cases (staff
  denied `delete`, allowed `create`/`update`; admin/owner allowed all three), mirroring
  the existing `project`/`branch` cases.

**Step-by-step tasks**

1. Edit `packages/agora/src/auth/permissions.ts` per Pass 2's Open Question 1
   resolution.
2. Write `apps/chrono-api/src/modules/station/routes.ts`: `GET /` and `GET /groups`
   (ungated, paginated via the two list-query schemas, optional `branchId`/
   `stationGroupId` filters), `POST /groups` / `PATCH /groups/:id` / `DELETE
   /groups/:id` and `POST /` / `PATCH /:id` / `DELETE /:id` exactly as specified in
   Pass 2's Routes section — including the branch-ownership lookup-before-insert (a
   `withTenant` select on `chronoBranch` by the payload's `branchId`; 404 if not found,
   never a generic 400) and the group-in-use delete guard. Follow the exact structure
   of the `project`/`file` blocks in `apps/chrono-api/src/routes/rpc.ts` (import style,
   `HttpError`, pagination meta shape).
3. Compose into `apps/chrono-api/src/routes/rpc.ts` via
   `.route("/stations", stationRoutes())`.
4. Add `station` cases to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { station: ["create"] }) === true`,
   `hasPermission("staff", { station: ["update"] }) === true`,
   `hasPermission("staff", { station: ["delete"] }) === false`,
   `hasPermission("admin", { station: ["delete"] }) === true`,
   `hasPermission("owner", { station: ["delete"] }) === true`.

**Acceptance criteria**

- `GET /rpc/stations` and `GET /rpc/stations/groups` return `{ items, meta }` for any
  authenticated tenant member.
- `POST /rpc/stations` with a `branchId` from a different tenant → 404 (not 400/403 —
  no existence leak).
- `POST /rpc/stations` as staff → 201; `DELETE /rpc/stations/:id` as staff → 403; as
  admin/owner → 200.
- Duplicate `(branchId, stationNumber)` → 409; the same `stationNumber` in a different
  branch (even same tenant) succeeds.
- `DELETE /rpc/stations/groups/:id` while a station still references it → 409.
- `PATCH /rpc/stations/:id` on another tenant's station id → 404.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `station`
  cases included.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`

**Out of scope:** UI, e2e browser spec (Phase 5).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (the
routes file imports `requirePermission` against the new resource, so the vocabulary
must exist before the route file typechecks).

---

## Phase 4 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/stations/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (none
  expected; `Dialog`/`Select`/`Tabs`/`Input`/`Label` already exist).

**Step-by-step tasks**

1. Build `page.tsx` mirroring `apps/chrono-web/src/app/dashboard/projects/page.tsx`,
   extended with a `branchId` filter: `useListQuery(["branchId"])`,
   `api.rpc.stations.$get/$post/$patch/$delete` typed calls,
   `DataTable`/`DataTableGrid` + `DataTableToolbar` + `DataTablePagination`, a branch
   `Select` in the toolbar.
2. Add the **Stations** / **Groups & Rates** `Tabs` split (Pass 2's Web UI section).
3. Add the station create/edit `Dialog` (`name`, `stationNumber`, `stationGroupId`
   `Select`, `stationType`, `status` `Select` limited to Available/Maintenance/
   Offline, `locationZone`, `cpu`/`gpu`/`ram`/`monitorHz`) and the station-group
   create/edit `Dialog` (`name`, `code`, `description`, `hourlyRate`, `memberRate`) —
   `agora/ui` primitives only.
4. Wire `toast.success`/`toast.error` on every mutation; a `ConfirmationDialog`-style
   confirm before delete (both entities).
5. Add `{ type: "item", name: "Stations", href: "/stations", icon: <pick an
   appropriate lucide-react icon> }` to `BASE_NAV` in
   `apps/chrono-web/src/app/dashboard/layout.tsx`, and `"/dashboard/stations":
   "Stations"` to `TITLES`.

**Acceptance criteria**

- `/dashboard/stations` renders the list, branch filter + search/sort/paginate/
  view-toggle all update the URL.
- Create/edit/delete on both tabs submit successfully and the list refreshes.
- A staff-role session can create/edit a station but gets a toast error attempting
  delete (server 403 surfaces client-side).
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 5), `[branchCode]` routing, module-registry gating,
any device-operational UI (connectivity dot, reboot/shutdown/lock/unlock — `devices`).

**Execution start point:** create
`apps/chrono-web/src/app/dashboard/stations/page.tsx`.

---

## Phase 5 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/stations/stations.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring
   `apps/chrono-web/e2e/tests/data-listing/projects-listing.spec.ts`'s structure and
   `signUp()` helper, covering three cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant, create a branch (reuse `branches`' own e2e
     helper/flow if it has landed, otherwise drive it inline), navigate to
     `/dashboard/stations`, create a station group (name/code/rate), create a station
     assigned to that group, edit it (confirm group/status changes persist), delete
     it, confirm the row is gone (real delete, not a status flip — unlike branches).
   - **Role gate**: owner creates a station, invites a staff teammate (reuse the
     invite-link flow from `projects-listing.spec.ts`), staff can create/edit a
     station but attempting delete surfaces a 403-driven toast and the row remains.
   - **Tenant isolation**: tenant A creates a branch + a station "PC-01 Only Tenant A";
     tenant B's stations list (search included, across branches) never shows it, and a
     direct id-based edit/delete attempt against it 404s.
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for slugs/emails/
   names/station numbers, per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config).
- No `.env` present in `apps/chrono-api` while running.

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/stations/stations.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage (no platform-admin routes exist for
stations in this pass).

**Execution start point:** create
`apps/chrono-web/e2e/tests/stations/stations.spec.ts`.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/stations/` to
`.ai/plans/chrono/archive/stations/` once all five phases are verified and committed
separately. Update `.ai/handover/chrono-migration.md`'s status table row for `stations`
to reflect implementation progress as phases land. Do **not** delete
`apps/chrono-api/src/modules/README.md` from this plan — that instruction belongs to
whichever module lands first (`branches`, already in progress); check it hasn't already
been deleted before assuming it still needs doing.
