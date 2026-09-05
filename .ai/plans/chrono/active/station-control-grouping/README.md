# Station Control: group by station group, surface live session state on the card

Status: Draft — awaiting approval.
App: chrono (`apps/chrono-api` + `apps/chrono-web`)

## Problem

The developer asked to "improve Admin > Station Control" so stations are grouped by
their assigned group/category, with the station number prominent on every card, a
status badge, a live timer, the active customer's name, and quick actions (Start / Add
Time / Pause / End / Transfer).

**There is no single existing screen that matches this description.** Two existing,
separate dashboard pages between them cover half of it each:

- `apps/chrono-web/src/app/(tenant-admin)/dashboard/stations/page.tsx` (nav label
  "Stations", `/admin/stations`) — a **CRUD/config** page: two tabs, "Stations" (create/
  edit/delete a station, assign it to a group) and "Groups & Rates" (create/edit/delete
  a `ChronoStationGroups` row). It shows `stationNumber`/`status`/group name per row, but
  has **no session/timer/customer data and no quick actions** — its rows are physical
  inventory, not the live floor state.
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/sessions/page.tsx` (nav label
  "Sessions", `/admin/sessions`) — a **session lifecycle board**: a flat, paginated
  `DataTable`/`DataTableGrid` of session rows (active/paused/ended only — stations with
  no session don't appear at all), with a ticking duration display and Start/Pause/
  Resume/Extend/End actions already wired to real routes. It is **not grouped by station
  group** and shows nothing for an idle/available station.

So this plan is not a cosmetic tweak to one existing page — it adds a new **"Station
Control"** view that shows every station (idle or occupied) grouped by station group,
merging data these two pages already fetch separately. The good news: **grouping data
already exists as a first-class relation** (`ChronoStationGroups` / `chronoStation.
stationGroupId`) — no schema/migration is needed for the grouping itself. The one piece
of the request with no backing capability today is **Transfer** (moving an active
session to a different station) — see "Open Questions" below; everything else (Start,
Add Time = Extend, Pause, End) already has a working route.

## Current-state findings (read in full before this plan was written)

- **`ChronoStationGroups`** (`apps/chrono-api/src/modules/station/schema.ts:6-31`):
  `id, tenantId, branchId, name, code, description, hourlyRate, memberRate,
  createdAt, updatedAt`. No `sortOrder`/`order` column — "configured order" (requirement
  #5) has no backing column today. `chronoStation.stationGroupId` (schema.ts:43-45) is a
  nullable FK, `onDelete: "set null"` — a station legitimately has no group.
- **`chronoStation`** (schema.ts:33-78): `stationNumber` and `name` are both
  free-text `text`, not numeric — sorting "numerically by stationNumber" needs a
  natural-sort comparator (e.g. `localeCompare(..., { numeric: true })`), not a plain
  string or SQL numeric sort, because values look like `"VIP-01"`, `"S042"`. `status` is
  free text holding one of `available | occupied | maintenance | offline` — only the
  first/third/fourth are admin-settable (`createStationSchema`'s `stationStatusSchema`
  in `contracts.ts:4` deliberately excludes `occupied`); `occupied` is set only by
  `session/service.ts`'s `startSession`/`closeSession`. The canonical 4-value enum
  already lives in `apps/chrono-api/src/modules/realtime/contracts.ts:27-32`
  (`chronoStationStatusSchema`) — reuse it, don't redeclare a second one.
- **`chronoSession`** (`apps/chrono-api/src/modules/session/schema.ts`): one row per
  session, `status: active|paused|ended`, a **partial unique index** enforcing at most
  one non-ended session per station (`chrono_session_active_per_station_uq`,
  schema.ts:85-87) — this is the DB-level invariant Transfer must not violate.
  `startSession`/`closeSession` (`session/service.ts:96-269, 283-375`) are the *only*
  code paths that start/end a session and flip `chronoStation.status`; there is **no
  `transferSession` today**.
- **`GET /rpc/stations`** (`station/routes.ts:325-365`) is paginated via the shared
  `listQuerySchema` (`packages/agora/src/core/contracts/core.ts:64-67`): `pageSize` is
  `z.coerce.number().int().min(1).max(100).default(10)` — **capped at 100**, and returns
  only station columns, no session/member join. Several existing call sites (e.g.
  `sessions/page.tsx:128`, and `e2e/tests/sessions/sessions.spec.ts:117-118,236-238`)
  already request `pageSize: "1000"` against this route as a "load them all for a
  dropdown" workaround — a **pre-existing latent bug** (that value should fail the
  `.max(100)` validation), out of scope to fix here, but reason enough not to build the
  new board view on top of `listQuerySchema` at all.
- **`GET /rpc/sessions`** (`session/routes.ts:41-96`) already does the join this plan
  needs a *variant* of: `innerJoin(chronoStation, ...)` +
  `innerJoin(base.tenantMember, ...)` to project `stationName`, `stationNumber`,
  `memberName`, `memberEmail` alongside session fields — good precedent for the new
  board query, except it's `innerJoin` (sessions only) and still paginated at 10/page
  default.
- **Precedent for an unpaginated, full-branch station read already exists in this exact
  module**: `publicStationRoutes()` (`station/routes.ts:263-310`) reads **every**
  station for every active branch with no pagination, with the comment "We read all
  stations for the public aggregate view. (Pagination left out as this is an aggregate +
  full grid)." This is the direct precedent for Phase 1's new board route.
- **Realtime is already wired for this page**: `stations/page.tsx:213-231` already opens
  a `connectChronoRealtime([`branch:${branchId}`])` socket and patches station status
  live via `onStationStatus`. `session.state` (`SessionStateEvent = {sessionId,
  stationId, status}`) is already published on every session transition
  (`session/service.ts:34-81`'s `publishSessionTransition`, which also re-publishes
  `station.status`/`branch.summary` via `publishStationTransition`) but **no page
  currently subscribes to `onSessionState`** even though `apps/chrono-web/src/lib/
  realtime.ts:36-38` already exports the helper to do so.
- **Permissions already cover every quick action except Transfer**: `session:
  ["create","update"]` is granted to `staff` *and* `admin` (`apps/chrono-api/src/auth/
  permissions.ts:82-85,139-156` — "No staff-denied action exists on session... a first
  for this codebase"). Start = `session:create`; Pause/Resume/Add-Time(Extend)/End =
  `session:update`. **No new permission resource is needed** for any of Start/Add Time/
  Pause/End; Transfer (if built, see Open Questions) rides on the same `session:update`
  gate — not a new resource, per `.ai/rules/business-app.md`'s extension-seam rule
  (don't add a permission with no real behavior behind it, and don't invent a resource
  where an existing one already fits the risk tier).
- **Frontend permission-gating precedent**: `dashboard/loyalty/page.tsx` and `dashboard/
  vouchers/page.tsx` both fetch `api.rpc.me.$get()` once into local state and wrap
  gated controls in `<Can permissions={me?.permissions} resource="..." action="...">`
  — this is the pattern to copy for hiding quick actions the signed-in actor can't use
  (visibility only; the server route is the real gate, per `.ai/rules/rbac.md`).
- **Seed data already models exactly the kind of groups the request describes**
  (`apps/chrono-api/src/seed.ts:253,266`): `"Regular"`, `"VIP"` groups — confirms
  grouping is a live, exercised concept already, not a new one.
- **Nav**: `apps/chrono-web/src/app/(tenant-admin)/dashboard/layout.tsx:77,79` — "Stations"
  (`/stations`) and "Sessions" (`/sessions`) are separate nav entries today. This plan
  does not add a third nav entry or a third URL — see Pass 2 architecture decision below.

## Pass 1 — Workflow Analysis

- **Who uses this**: tenant staff/admin/owner physically working the floor of an
  internet café/gaming branch — the primary day-to-day operational screen, glanced at
  constantly while seating walk-ins, watching for sessions about to expire, and
  handling a customer who wants to move seats.
- **Workflow**: staff opens Station Control, sees every station on the selected branch
  grouped into its pricing/category group (VIP Room, Regular Area, Unassigned, ...),
  scans for available (green) stations to seat a walk-in, sees which stations are
  running low on time, and acts directly from the card — Start a session on an idle
  station, add time / pause / end / transfer an active one — without navigating to a
  different page or hunting through a paginated session table.
- **What they see / click**: a group header ("VIP Room — 8 Stations"), a dense grid of
  compact cards under it, each showing the station number as the dominant text, a color
  status badge, (if occupied) the customer's name and a live counting timer, and the
  quick-action buttons appropriate to that station's current state. A search box filters
  by station number, group, or status across the whole board.
- **Failure cases**:
  - A session ends or a station goes offline while the page is open → must update live,
    not only on next full reload (realtime, see Pass 2).
  - Two staff try to seat the same station at once → the existing `chrono_session_
    active_per_station_uq` unique index plus `startSession`'s existing `STATION_
    OCCUPIED` 409 already prevents a double-booking; the board must surface that error
    as a toast, not crash.
  - Staff without `session:update`/`session:create` (there is none today — see
    findings above) — N/A for Start/Add Time/Pause/End. A **portal member/customer**
    session hitting these staff routes must still get 401/403, exactly like the existing
    `/rpc/sessions` routes already do (this is the actual "role gate" axis to test, not
    staff-vs-admin — see Phase 4).
  - Transfer to an already-occupied or wrong-branch station must 409/422, never silently
    move the session (see Phase 2 concurrency handling).
  - Tenant isolation: tenant B must never see tenant A's stations/sessions on this board,
    and a direct API call against another tenant's session id must 404, mirroring every
    existing session-route test.
- **Audit/notifications**: every quick action already writes a `recordStaffAudit` row
  today (session start/pause/resume/extend/end) — Transfer, if built, gets its own audit
  action `session.transferred`, matching that existing convention. No new notifications.

## Pass 2 — Technical Planning

### Architecture decision: one new tab, not a new page/route

`/admin/stations` already has the branch selector, the group list (for the dropdown),
and the realtime station-status socket this feature needs — duplicating those into a
brand-new page/nav entry would be pure duplication. This plan adds a **third tab**,
**"Station Control"**, to the existing `stations/page.tsx`, made the **default active
tab** (the day-to-day reason staff opens this page), and renames the existing CRUD tab
label from "Station**s**" to "Manage Stations" to disambiguate the two (internal tab
`value`s change too, but nothing external depends on those — only the *visible* label
matters to Playwright's `getByRole(..., { name })`, which does substring matching, so
`stations.spec.ts`'s existing `getByRole("tab", { name: "Stations" })` still matches
"Manage Stations" unmodified — verified against Playwright's default non-exact string
match). No new nav entry, no new URL, no new page file.

### Architecture decision: one new aggregate read endpoint, not client-side stitching

Requirement #1 asks for one card that already knows the station's live session state.
Building that by having the browser separately call the existing paginated `/rpc/
stations` and `/rpc/sessions` and stitching them client-side would (a) inherit the
`pageSize` cap-at-100 problem above for any branch with >100 stations, and (b) require
two round trips plus manual reconciliation on every realtime tick. Instead: **one new
route, `GET /rpc/stations/board?branchId=<id>`**, returns every station for that branch
with its group name denormalized and its current active/paused session (if any) already
joined in — mirroring `publicStationRoutes()`'s own "read everything for this branch,
no pagination" precedent, which already establishes that an unpaginated full-branch
station read is an accepted pattern in this exact module. `branchId` is a **required**
query param (400 if missing) — this keeps the unbounded read bounded to "one branch's
station count" (the same 50–200 order of magnitude the developer's own prompt uses),
never "every station across every branch this tenant has."

Per `.ai/rules/data-listing.md`'s own client-side escape hatch ("only for genuinely
low-cardinality... resources where a backend list contract would be pure overhead"):
grouping, searching, and sorting the fetched board happen **client-side**, in memory,
over this one bounded per-branch payload — there is no server-side pagination, sort, or
filter param on the new route at all. This is the deliberate, reasoned exception this
repo's own rule anticipates, not an oversight; it is justified by the existing
unpaginated precedent above, not invented fresh here.

### Architecture decision: reuse `session.state`/`station.status`, don't extend them

`session.state`'s payload (`{sessionId, stationId, status}`) is too thin to patch every
card field (no member name, no timestamps) on receipt. Rather than widen this shared
realtime contract (blast radius: every existing subscriber, plus
`realtime/contracts.test.ts`/`service.test.ts`), the board reacts to *either*
`station.status` or `session.state` by (a) patching the one field `station.status`
gives immediately for a snappy status-badge flip, and (b) triggering a debounced
(~500ms, coalescing bursts of multiple events) re-fetch of `GET /rpc/stations/board`
to pick up the full session/member detail. A visible-but-stale board is never acceptable
here; a debounced full refetch is cheap given the bounded per-branch payload size.

### Reuse inventory

- `chronoStationStatusSchema` (`realtime/contracts.ts:27-32`) — reused for the board
  DTO's per-station `status`, not redeclared.
- `stationColumns` explicit-projection convention (`station/routes.ts:26-39`) — the new
  board query follows the same never-`SELECT *`, never-leak-`qrSecret` discipline.
- `session/routes.ts:56-95`'s join shape (station + `tenantMember`) — the pattern to
  copy for the board's session sub-join, `leftJoin` instead of `innerJoin` since a
  station may have no active session.
- `publishStationTransition` / `publishSessionTransition` (`station/routes.ts:86-112`,
  `session/service.ts:34-81`) — reused as-is by Phase 2's Transfer route; Transfer adds
  one extra explicit publish for the *freed* station (see Phase 2).
- `connectChronoRealtime`, `onStationStatus`, `onSessionState`
  (`apps/chrono-web/src/lib/realtime.ts`) — all already exist; the board is the first
  caller of `onSessionState`.
- `<Can permissions={me?.permissions} resource=".." action="..">` +
  `api.rpc.me.$get()` pattern (`dashboard/loyalty/page.tsx`, `dashboard/vouchers/
  page.tsx`) — reused for hiding quick actions, not a new gating mechanism.
- `DataTableToolbar`'s `q`/`onQChange` + `children` filter-slot (used already in both
  `stations/page.tsx` and `sessions/page.tsx`) — reused for the board's search box and
  group/status filter `Select`s; **not** its `view`/`onViewChange` props (Station
  Control has one fixed grouped-grid layout, no table/grid toggle).
- `Badge` variants already in the design system (`success`/`warning`/`secondary`/
  `destructive`/`default`/`outline`, `badge.tsx:9-21`) — sufficient for
  available=`success`, occupied/in-use=`default`, paused=`warning`,
  maintenance=`secondary`, offline=`destructive`; no new variant needed.
- `computeElapsedSeconds`/`formatDuration` (`sessions/page.tsx:61-85`) — extracted into
  a new shared `apps/chrono-web/src/lib/session-time.ts` so the board doesn't
  reimplement (or subtly diverge from) the exact elapsed/paused-time math a third time.
  `sessions/page.tsx` is refactored to import from the new module instead of its local
  copy — a mechanical extraction, not a behavior change.

### Tenant/RLS impact

No new table, no new column, no schema migration. The new `GET /stations/board` route
is tenant-scoped via `withTenant`/RLS exactly like every other route in this module — no
new isolation surface, but it is a genuinely new cross-table read path (station + group
+ session + member), so Phase 1 still gets a dedicated e2e tenant-isolation case (Phase
4) rather than relying on `rls:proof` alone (per this module's own precedent: the public-
stations aggregate read is proven by its own e2e case, not `rls:proof`, since no
schema/RLS policy changes). `pnpm --filter @agora/api rls:proof` is re-run anyway as a
sanity check since Phase 2 (if built) writes to two `chronoStation` rows in one
transaction, but is not expected to change its output.

### Out of scope

- A UI to configure `ChronoStationGroups`' display order — no `sortOrder` column exists;
  default is alphabetical by group name, "Unassigned Stations" always last. Adding a
  `sortOrder` column is a real (small) schema change, deliberately deferred — see Open
  Questions.
- Any change to the existing "Manage Stations" or "Groups & Rates" CRUD tabs' own logic
  — only their tab label/value and default-active-tab wiring change (Phase 3 is
  additive: a new tab + new state/effects alongside the existing two, not a refactor of
  them).
- Extracting `stations/page.tsx`'s existing ~980 lines into per-tab component files —
  tempting given the file's size, but that widens this phase's blast radius over
  already-tested CRUD code for no functional gain. Left as an accepted, separate future
  cleanup.
- A second, wider `session.state` realtime payload — see architecture decision above.
- Cross-branch session transfer — Transfer (if built) is same-branch only (see Phase 2).
- Any new permission resource — every quick action rides an existing gate.

## Open Questions — resolved

1. **Build Transfer now, or defer it?** → **Deferred.** Phase 2 is not built in this
   pass — it stays fully specified below (ready to implement as its own follow-up plan/
   phase once picked back up) but is explicitly **out of scope for this plan's
   implementation**. Phases 1, 3, and 4 ship a fully working board with Start / Add
   Time / Pause / Resume / End; the card omits the Transfer button entirely (Phase 3's
   "only if Phase 2 shipped" branch does not apply — there is no such branch to build
   in this pass), and Phase 4's Transfer-specific e2e assertions are dropped from this
   plan's scope. Rationale: it is the one piece of real new business logic in an
   otherwise pure read-aggregation + UI plan, and isolating it keeps this plan's risk
   surface to what's actually needed for the core ask (grouping + station number
   display + the four actions that already have backing routes).
2. **Does transferring a session into a station in a *different* pricing group re-rate
   it?** → **Moot for this plan** (Transfer is deferred, see #1). Recorded for
   whoever picks up the Transfer follow-up: keep the original rate snapshot frozen on
   transfer (only `stationId` moves) — matches `rateSnapshot`/`rateSource`'s existing
   "frozen at start" convention (`session/schema.ts:45,49-58`) and avoids inventing a
   new mid-session re-rating behavior that doesn't exist anywhere else in this module.
3. **Is per-tenant "configured group order" wanted in this pass?** → **No — MVP ships
   alphabetical** (with "Unassigned Stations" always last), per Phase 3's existing
   design. A `sortOrder` column + reorder UI is a real but small addition, left for a
   future request rather than bundled here.

## Phase 1 — Station board aggregate contract + route (`apps/chrono-api`)

**Files to update:**
- `apps/chrono-api/src/modules/station/contracts.ts` — add `stationBoardQuerySchema`
  (`{ branchId: z.string().min(1) }`), `stationBoardSessionSchema` (`id, memberId,
  memberName, status: z.enum(["active","paused"]), startedAt, scheduledEndAt,
  pausedAt` — all strings/ISO dates, no raw `Date`), `stationBoardStationSchema`
  (`id, stationNumber, name, stationType, status` — reuse `chronoStationStatusSchema`
  imported from `../realtime/contracts`, not redeclared — `locationZone,
  stationGroupId, stationGroupName: z.string().nullable(), activeSession:
  stationBoardSessionSchema.nullable()`), `stationBoardResponseSchema` (`{ branchId,
  stations: z.array(stationBoardStationSchema) }`). Export the matching TS types.
- `apps/chrono-api/src/modules/station/routes.ts` — add
  `.get("/stations/board", zValidator("query", stationBoardQuerySchema), async (c) => {...})`
  inside `stationRoutes()`, ungated beyond tenant membership (matches the existing
  `GET /stations` / `GET /stations/groups` convention — staff need this to work the
  floor, no `requirePermission` call).

**Step-by-step tasks:**
1. Add the 4 schemas/types above to `contracts.ts`, importing `chronoStationStatusSchema`
   from `../realtime/contracts` (existing cross-module import direction already used by
   this same file's `routes.ts`, so no new dependency direction is introduced).
2. In `routes.ts`, inside `withTenant`, query: `chronoStation` `leftJoin`
   `chronoStationGroup` on `stationGroupId` `leftJoin` `chronoSession` on
   `(chronoSession.stationId = chronoStation.id AND chronoSession.status IN
   ('active','paused'))` `leftJoin` `base.tenantMember` on `chronoSession.memberId`,
   filtered `WHERE chronoStation.branchId = :branchId` (branch ownership implied by
   RLS + the explicit filter, matching `requireOwnBranch`'s existing defense-in-depth
   style — but a 400/empty result for an unowned branchId is acceptable here since this
   is a read, not a write, matching `GET /stations`'s own un-validated `branchId` filter
   today).
3. Project into `StationBoardStation[]` via an explicit `toStationBoardDto`-style
   mapper (never a raw row) — one row per station; a station with no matching session
   row yields `activeSession: null`, a station with more than one non-ended session is
   impossible today (the DB unique index guarantees at most one).
4. Order the SQL result by `chronoStationGroup.name` (nulls last) then
   `chronoStation.stationNumber` as a best-effort pre-sort — the client re-sorts with a
   natural-sort comparator regardless (Phase 3), so this ordering is a minor nicety,
   not the source of truth.
5. Return `c.json({ branchId, stations: [...] })`.

**Acceptance criteria:**
- `GET /rpc/stations/board?branchId=<id>` (with a valid session/tenant) returns every
  station for that branch, each with `stationGroupName` populated when assigned and
  `activeSession` populated only for a station with a live (active/paused) session.
- Missing `branchId` → 400 (Zod validation failure via `zValidator`).
- A tenant member with no membership in the branch's tenant gets the same 401 every
  other `/rpc/*` route gives (via `tenantMiddleware()`, unchanged).
- No `qrSecret`/`qrSecretVersion` or any other private column reaches the response.

**Verification commands:** `pnpm typecheck`; manual `curl` against the running API with
a seeded tenant's branch id, comparing the response against `stationBoardResponseSchema`.

**Out of scope:** any write path (Phase 2), any UI (Phase 3).

**Execution start point:** `apps/chrono-api/src/modules/station/contracts.ts`.

## Phase 2 — Session transfer capability (`apps/chrono-api`) — DEFERRED, not built in this pass

**Status: out of scope for this plan's implementation** (Open Question 1, resolved
above). Left fully specified below so a follow-up plan can pick it up directly instead
of re-deriving the design; nothing in Phases 1/3/4 depends on it.

**Files to update:**
- `apps/chrono-api/src/modules/session/contracts.ts` — add `transferSessionSchema =
  z.object({ stationId: z.string().min(1) })`.
- `apps/chrono-api/src/modules/session/service.ts` — add `transferSession(tx, {
  tenantId, sessionId, toStationId, performedByUserId })`, modeled directly on
  `closeSession`'s locking discipline (`.for("update")` on the session row first).
- `apps/chrono-api/src/modules/session/routes.ts` — add
  `.post("/sessions/:id/transfer", zValidator("json", transferSessionSchema), async (c) => {...})`.

**Step-by-step tasks:**
1. `transferSession`: `SELECT ... FOR UPDATE` the session row scoped to `tenantId`; 404
   if not found; 409 `"Session has already ended."` if `status === "ended"` (matches
   `extendSessionSchema`'s existing message style); 400 `"Session is already on this
   station."` if `toStationId === session.stationId`.
2. Load the target station scoped to `tenantId`; 404 if not found (never leak cross-
   tenant existence, matching `requireOwnBranch`'s convention). 422 `"Cannot transfer to
   a station in a different branch."` if `target.branchId !== session.branchId`
   (Transfer is same-branch only per the architecture decision above). 409
   `"STATION_OCCUPIED"` (reusing the exact existing error string from `startSession`) if
   `target.status !== "available"`.
3. In one transaction: update the **old** station to `status: "available"`; update
   `chronoSession.stationId = toStationId` (leaving `rateSnapshot`, `rateSource`,
   `stationGroupId`, `branchId` untouched — see Open Question 2's default); update the
   **new** station to `status: "occupied"`.
4. Route handler: `requirePermission(c.var.tenant.permissions, { session: ["update"] })`
   (existing resource/action — no new permission). After the transaction commits: call
   `publishSessionTransition(tenantId, updatedSession)` (handles the new station +
   its device channel, unchanged) **and** an explicit
   `publishStationTransition(tenantId, { id: oldStationId, branchId, status:
   "available" })` for the freed station (captured from the locked row *before* the
   update — `publishSessionTransition` only re-reads the session's *current*
   `stationId`, so nothing else announces the old station going free). Then
   `recordStaffAudit(c, { action: "session.transferred", targetType: "session",
   targetId: id, metadata: { fromStationId, toStationId } })`.

**Acceptance criteria:**
- Transferring an active session to an `available` same-branch station succeeds: old
  station flips to `available`, new station flips to `occupied`, the session's
  `stationId` updates, `rateSnapshot`/`stationGroupId` unchanged.
- Transferring to an occupied station 409s with `STATION_OCCUPIED` and neither station's
  status changes (transaction rolls back cleanly).
- Transferring to a different branch's station 422s.
- Two concurrent transfer attempts onto the same target station: exactly one succeeds,
  the other 409s (proven by the DB's own partial unique index rejecting the second
  session-row update attempt, mirroring `startSession`'s existing concurrency guarantee
  — add a note in `session/concurrency.test.ts`-style coverage if time allows, otherwise
  covered adequately by the existing unique index + `.for("update")` lock without a
  dedicated new concurrency test).
- Both stations' realtime `station.status` events fire; the moved session's
  `session.state` fires once.

**Verification commands:** `pnpm typecheck`; `pnpm --filter @agora/api rls:proof`
(sanity check — no RLS policy changed, expected unchanged PASS); manual exercise via
`curl` or the Phase 3 UI once it exists.

**Out of scope:** cross-branch transfer, re-rating on transfer (Open Question 2 default
is "no"), a transfer history/audit log UI beyond the existing audit-event row.

**Execution start point:** `apps/chrono-api/src/modules/session/contracts.ts`.

## Phase 3 — Station Control board UI (`apps/chrono-web`)

**Files to update (new):**
- `apps/chrono-web/src/lib/session-time.ts` — `computeElapsedSeconds`/`formatDuration`,
  extracted verbatim from `sessions/page.tsx:61-85`, plus a new
  `computeRemainingSeconds(scheduledEndAt, nowMs)` helper (for a station with a
  `scheduledEndAt` — negative/overdue is clamped to `0` and the card should flag it,
  e.g. a `destructive` badge, rather than show a negative countdown).
- `apps/chrono-web/src/components/dashboard/stations/station-control-board.tsx` — the
  new board component (business-specific, built only from `agora/ui` primitives per
  `.ai/rules/component-first-ui.md` — `Card`, `Badge`, `Button`, `Stack`, `Row`,
  `Select`, `Can`).

**Files to update (edit):**
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/stations/page.tsx`:
  - Add a third `TabsTrigger value="control"` labeled "Station Control", placed first;
    change `useState("stations")` → `useState("control")` so it's the default.
  - Rename the existing CRUD tab's internal `value` from `"stations"` to
    `"manage-stations"` everywhere it's checked (`activeTab === "stations"` →
    `activeTab === "manage-stations"`, in `loadGroups`/`loadStations`'s early-return
    guards and the `TabsTrigger`/`TabsContent` pair) and change its visible label from
    "Stations" to "Manage Stations". "Groups & Rates" tab is untouched.
  - Add a new `<TabsContent value="control">` rendering `<StationControlBoard
    branchId={branchId} />`, passing the same `branchId` already resolved at the page
    level (`query.filters.branchId`) — no new branch-selection state.
  - Widen the page's `useListQuery` filter keys from `["branchId"]` to `["branchId"]`
    unchanged at the page level (the board's own group/status/search filters are
    **internal** to `StationControlBoard`, using their own `useListQuery(["groupId",
    "status"])` call scoped to that component — kept separate from the page-level query
    so switching CRUD tabs never resets the board's filters or vice versa).
- `apps/chrono-web/src/app/(tenant-admin)/dashboard/sessions/page.tsx` — replace the
  local `computeElapsedSeconds`/`formatDuration` definitions with an import from the new
  `@/lib/session-time` (behavior unchanged, pure extraction).

**Step-by-step tasks:**
1. Extract the shared time helpers (mechanical, no behavior change); confirm
   `sessions/page.tsx` still renders identically.
2. Build `StationControlBoard`:
   - Fetch `GET /rpc/stations/board?branchId=...` on mount and whenever `branchId`
     changes; render nothing (an empty-state `Card`: "Select a branch to see its
     stations.") when `branchId` is falsy.
   - Group the fetched `stations[]` client-side by `stationGroupId ?? "unassigned"`,
     label `stationGroupName ?? "Unassigned Stations"`. Sort groups alphabetically by
     label, with `"Unassigned Stations"` forced last regardless of alphabetical
     position. Sort stations within a group via
     `a.stationNumber.localeCompare(b.stationNumber, undefined, { numeric: true })`.
     Empty groups cannot occur by construction (a group section only exists because at
     least one station referenced it).
   - Render each group as a header (`"{label} — {count} Station{count===1?"":"s"}"`)
     followed by a dense responsive grid of compact `Card`s (2/3/4/6 columns at
     increasing breakpoints — dense enough to monitor 50–200 stations per the
     requirement's own framing).
   - Each card: station number as the largest text element on the card (e.g.
     `text-2xl font-bold`), a status `Badge` (mapping per the Reuse section above), the
     assigned group's name as a small secondary label, and:
     - **available**: a "Start" button opening a small inline form (station
       pre-filled, pick a member, optional duration) → `POST /rpc/sessions`.
     - **occupied, active session**: customer name, a live-ticking elapsed-or-
       remaining time (`computeElapsedSeconds`/`computeRemainingSeconds` + the 1s tick
       interval, identical pattern to `sessions/page.tsx:154-160`), and "Add Time"
       (→ `POST /sessions/:id/extend`), "Pause" (→ `.../pause`), "End"
       (→ `.../end`). No "Transfer" button — Phase 2 is deferred (Open Question 1),
       so this pass ships the four actions with a real backing route.
     - **paused session**: same as above with "Resume" (→ `.../resume`) in place of
       "Pause".
     - **maintenance / offline**: no quick actions, just the status.
   - Gate every quick-action button with `<Can permissions={me?.permissions}
     resource="session" action="create"|"update">` (fetch `api.rpc.me.$get()` once on
     mount, matching the `loyalty`/`vouchers` pages' exact pattern).
   - Realtime: `connectChronoRealtime([`branch:${branchId}`])`,
     `onStationStatus` patches that one station's `status` field immediately;
     `onSessionState` (first real caller of this existing helper) and
     `onStationStatus` both additionally schedule a debounced (~500ms) re-fetch of the
     whole board, coalescing bursts. A 15s interval poll runs as a fallback/
     reconciliation net (shorter than the endpoint's payload would tolerate lightly, but
     conservative enough given this is the primary floor-monitoring screen — matches the
     existing `sessions/page.tsx`'s own 10s-poll precedent in spirit, tuned slightly
     longer since this payload is heavier).
   - Search/filter: `DataTableToolbar` with `q`/`onQChange` (matches station number,
     name, group label, or status via substring, case-insensitive) plus two `Select`
     children (group, status) — no `view`/`onViewChange` (single fixed layout).
     `useListQuery(["groupId","status"])`, scoped to this component, persists these in
     the URL per `.ai/rules/data-listing.md`.
3. Wire the new tab into `page.tsx` per the file-edit list above.

**Acceptance criteria:**
- Visiting `/admin/stations` lands on "Station Control" by default, showing every
  station for the tenant's first/selected branch grouped by its station group, with
  "Unassigned Stations" last and hidden entirely if empty.
- The station number is visually the largest text on each card.
- An active session shows a live-ticking timer and the customer's name; starting,
  pausing, resuming, adding time, and ending all work from the card and match the
  toasts/behavior already proven in `sessions.spec.ts`.
- Switching branches, typing in search, and picking a group/status filter all update
  the board without a full page reload.
- `apps/chrono-web/e2e/tests/stations/stations.spec.ts` and `apps/chrono-web/e2e/tests/
  sessions/sessions.spec.ts` still pass unmodified (regression check for the tab
  rename/reorder).

**Verification commands:** `pnpm typecheck`; `npx playwright test e2e/tests/stations
e2e/tests/sessions` (existing specs, regression); manual check via `pnpm dev`.

**Out of scope:** the CRUD tabs' own internals (untouched beyond the rename), any
config UI for group order (Open Question 3), the page-file extraction noted under
"Out of scope" above.

**Execution start point:** `apps/chrono-web/src/lib/session-time.ts`.

## Phase 4 — E2E coverage

**Files to update (new):**
- `apps/chrono-web/e2e/tests/stations/station-control.spec.ts`.

**Step-by-step tasks** (mirrors the structure and helper style of the existing
`stations.spec.ts`/`sessions.spec.ts` — sign up a fresh tenant via `/sign-up`, `faker`-
generated slugs/emails, no seeded fixtures, per `.ai/rules/e2e-testing.md`):
1. **Happy path**: sign up, create a branch, create two station groups ("VIP", code
   `VIP`; leave a third station ungrouped), create 3 stations (2 in "VIP", 1
   unassigned), sign up a portal member, top up their wallet, navigate to `/admin/
   stations` (confirm it lands on "Station Control"), assert the "VIP — 2 Stations"
   group header and the "Unassigned Stations — 1 Station" header both render, assert a
   station number renders. Start a session on one VIP station from its card, assert the
   card now shows the member's name and a ticking timer, Pause it, assert the button
   set changes to "Resume", Add Time, then End it, assert the card returns to
   "available" with no customer/timer. If Phase 2 shipped: start a session, Transfer it
   to the branch's other available VIP station, assert the original station's card
   returns to available and the destination shows the session.
2. **Role gate** (matches `sessions.spec.ts`'s own "no staff-denial case by design"
   precedent — the axis here is portal-member vs. staff, not staff-vs-admin): a portal
   member's session cookie calling `GET /rpc/stations/board` and
   `POST /rpc/sessions/:id/transfer` (if built) gets 401/403, exactly like the existing
   cross-check in `sessions.spec.ts`'s role-gate test.
3. **Tenant isolation**: tenant B's `/admin/stations` Station Control view never shows
   tenant A's stations/groups/sessions; a direct `GET /rpc/stations/board?branchId=<A's
   branch>` call from tenant B's session returns an empty `stations` array (RLS-scoped,
   no cross-tenant leak — matches this module's existing "empty, not 404" convention for
   a branchId filter, since branchId itself isn't validated for ownership on this read
   path per Phase 1); a direct cross-tenant `POST /rpc/sessions/:id/transfer` (if built)
   404s, matching the existing pause/end/extend 404 precedent in `sessions.spec.ts`.

**Acceptance criteria:** all 3 cases pass headed, per this repo's existing manual
Playwright setup (`pnpm dev` running first, no `apps/chrono-api/.env` present).

**Verification commands:** `npx playwright test e2e/tests/stations/station-control.spec.ts`.

**Out of scope:** load-testing the board at 200 stations (accepted risk, see below).

**Execution start point:** `apps/chrono-web/e2e/tests/sessions/sessions.spec.ts` (read
for the exact helper functions — `signUp`, `portalSignUp`, `createBranchStationAndGroup`,
`findMemberId`, `topUpWallet` — to reuse or closely mirror).

## Risks

- **Unbounded-but-large branch**: nothing in Phase 1 caps station count per branch; a
  branch with, say, 2,000 stations would return a large uncached payload. Accepted for
  MVP (the developer's own framing is 50–200); a future safeguard (a hard cap + a "too
  many stations, use search" fallback) is a cheap follow-up, not built now.
- **Debounced-refetch storms**: a burst of realtime events (e.g. many sessions ending at
  once via a background sweep) could still trigger frequent board refetches even with
  the 500ms debounce. Mitigated by the same debounce plus the 15s poll being a floor,
  not a ceiling — not expected to be a real problem at this scale, but worth watching in
  practice.
- **Phase 2's business-rule risk** (re-rating on transfer) is exactly why Open Question
  2 exists — implementing it before that's answered risks building the wrong billing
  behavior.
- **Tab rename regression**: covered by re-running the two existing specs unmodified in
  Phase 3's own verification step.

## Plan Closure

Move this plan from `.ai/plans/chrono/active/` to `.ai/plans/chrono/archive/` once Phase
4 passes (or once Phases 1/3/4 pass, if Transfer/Phase 2 is deferred per Open Question
1 — in that case, leave a note here and in the closing commit that Phase 2 is tracked
separately, not silently dropped).
