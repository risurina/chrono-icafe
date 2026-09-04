# Chrono — `reservations`: member self-service, queue/hold, and restrictions

**App:** `chrono`. **Extends:** the already-shipped, archived plan at
`.ai/plans/chrono/archive/reservations/README.md` ("path 1" — staff-created scheduled
bookings on `ChronoReservations`). That plan explicitly deferred "path 2" (Open Questions
8–11: member self-service live queue/hold, `MemberReservationRestriction` bans, a
per-tenant/branch policy surface, and the grace/promotion background job) until
`devices`/`sessions` existed. **Both now exist and are routed** — `apps/chrono-api/src/
modules/session/{schema,service,expiry,portal-routes}.ts` and `modules/device/*` are
built, `chronoSession.status` transitions drive `chronoStation.status` (`available` ↔
`occupied`), and `/portal/*` (member-auth-gated, `memberMiddleware()`) is an established
mount pattern (`/portal/wallet`, `/portal/sessions`, `/portal/credits`, `/portal/
inquiries`). This plan is exactly the deferred follow-up those open questions predicted,
built against the real tables instead of guessed ones.

**Path 1's core behavior is untouched**, but `routes.ts` and the EXCLUDE-constraint
migration are **not** frozen files — Phase 1 makes two narrow, required edits to both
(a new active status added to the overlap guard; the constraint's `WHERE` clause
rewritten) so path 1's double-booking guarantee keeps covering the new `hold` status.
Everything else about path 1 (staff board, existing statuses, contracts) is unchanged.

> **Audit note (2026-09-04):** this plan was drafted, then run through a Principal-
> Engineer plan audit (`plan-auditor`), which returned **BLOCKED** — 5 blockers, 9
> conditions. Every finding is folded into the plan below (the EXCLUDE-constraint gap for
> `hold` rows, NULL-range semantics, a self-contradicting CHECK constraint, a
> claim-endpoint that didn't exist, wrong `pnpm` filter targets, a missing DB backstop for
> "one active reservation," branch-scope inconsistency in bans, `apps/chrono-docs` not
> existing, and the audit-helper deferral). Where the audit flagged an open product
> decision (queue-failure counting window, wallet-debit-vs-record-only for cancellation
> fees, per-field vs. whole-row policy override), a decision is made and stated explicitly
> below rather than left open, per the improvement-latitude the developer gave this run —
> each is marked **(judgment call, confirm or override)** at its point of decision.

---

## Pass 1 — Workflow Analysis

**Who uses it:** the tenant's `tenantMember` customers, self-service, through
`/portal/reservations` (new — first Chrono reservation surface for members; staff keep
their existing `/dashboard/reservations` board unchanged). Staff/admin/owner get one new
read surface (a member's active restrictions, for support purposes) but no new staff
workflow — this plan is member-facing.

**Flow 1 — direct reservation on an AVAILABLE station** (see prompt's corrected framing):
member picks a station showing `available`, picks a start time and a duration preset
(1–6h or custom, capped by the existing 12h `MAX_WINDOW_HOURS`), submits. Server validates
`startAt > now` and `startAt <= now + reservationAdvanceWindowMinutes`, one active
reservation per member, no active `RESERVATION_BAN`, policy enabled for the branch. On
success: a `ChronoReservations` row, `status: "confirmed"`, `fromQueue: false`. The
station's `chronoStation.status` is **not** touched at booking time — it stays usable by
walk-ins/staff until `startAt` (this is the corrected framing over the original prompt:
holding a PC for up to 60 minutes of dead time is a real business cost). A background
sweep (Phase 5) flips a `confirmed` reservation to `hold` at `startAt`, opening a
`holdExpiresAt = startAt + holdPeriodMinutes` claim window; the sweep additionally
enforces the reservation exclusively from that point (see Phase 5.2, "activation lock").

**Claim mechanism — resolved (audit BLOCKER 4).** There is no member-initiated
`POST /portal/sessions`; the only member-triggered `startSession` call in the codebase is
the QR-scan-at-station flow (`apps/chrono-api/src/modules/qr/public-routes.ts:254`,
`memberMiddleware()`-gated, mounted `/public/qr`). This matches the product's actual
physical model (and the prompt's own "member logs into PC" phrasing) better than inventing
a new in-portal self-start endpoint that bypasses the device/QR pairing this codebase
already built — **adopted as the sole claim path**: the member scans the station's QR
code, which is what "logs into the PC" means operationally. Phase 3 wires the
reservation-claim detection into that QR-consume route's call to `startSession`, not a new
portal route. The member portal never itself starts a session — it shows the hold/
countdown and a "Log in at the PC to claim it" instruction, plus the Option B `/confirm`
action (below), which schedules only. Unclaimed at `holdExpiresAt` → `NO_SHOW`, penalty,
`RESERVATION_BAN`.

**Flow 2 — queue for a RESERVED-active or IN_USE station:** member on a station whose
`chronoStation.status` is `occupied`, or whose active reservation is `hold`/`checked_in`
for a future/current window, joins the queue: a `ChronoReservations` row with
`fromQueue: true`, `status: "pending"`, `requestedDurationMinutes` captured from the
join request, `startAt`/`endAt` NULL until promoted (queue entries have no scheduled time
until they reach the front — see Schema, "queue row window" below). FIFO by `createdAt`.
When the station frees (session ends) **or** the head-of-line reservation's own hold
lapses without being claimed, the sweep promotes the oldest `pending` row for that
station: sets `startAt = now()`, `endAt = now() + requestedDurationMinutes`,
`status: "hold"`, `holdExpiresAt = now + holdPeriodMinutes` (setting concrete `startAt`/
`endAt` at promotion — not before — is what keeps the row inside the EXCLUDE constraint
and the plan's own CHECK constraint the instant it becomes station-locking; see Schema).
The member claims via the same QR-scan-at-station path as Flow 1, or explicitly confirms
via `POST /portal/reservations/:id/confirm` (schedules it, doesn't start play — matches
the prompt's Option B). Unclaimed at `holdExpiresAt` → `QUEUE_HOLD_EXPIRED` failure row,
`QUEUE_BAN` evaluated against `queueFailureLimit`, next `pending` row promoted.

**Failure cases (new, beyond path 1's existing set):**
- Unauthenticated → `memberMiddleware()` 401 before the handler runs (never
  `tenantMiddleware`/staff permission — these are member-session routes).
- Reservations/queue disabled for the branch (`enabled: false` after resolution) → 403
  with a body the UI renders as "Reservations unavailable" (not a raw 500).
- `startAt` outside the advance window → 400, exact message quoting the resolved
  `reservationAdvanceWindowMinutes`.
- A second active reservation/queue entry while one is already active
  (`confirmed`/`hold`/`checked_in`/`pending`) → 409 `RESERVATION_ALREADY_ACTIVE`.
- Under an active `RESERVATION_BAN` → 403 `RESERVATION_BANNED` with `expiresAt`, no
  reason/history leaked to the member (staff-only detail).
- Under an active `QUEUE_BAN` → 403 `QUEUE_BANNED` with `expiresAt`.
- Queueing a station whose branch policy has `allowQueueForReservedPc`/
  `allowQueueForInUsePc` false for that station's actual state → 403
  `QUEUE_NOT_ALLOWED`.
- A non-holder scanning the station's QR code (attempting to claim a hold that belongs to
  a **different** member) → the existing `startSession` 409 `STATION_OCCUPIED` path fires
  (station may still read `available` in `chronoStation.status`; the hold is a soft-lock
  — see Phase 3) — no new error code needed, but Phase 3 must not let a non-holder
  silently steal a held station.
- Two members racing to join queue position #1 on the same just-freed station, or two
  sweep runs racing to promote the same station → Phase 5's row-lock discipline (below)
  makes exactly one win; the loser's request/run is a no-op, never a duplicate hold.
- Cancelling a reservation that is not `confirmed`/`hold`/`pending` → 409.
- Cross-tenant / cross-member: a member requesting another member's reservation id → 404
  (existing `withTenant` + ownership filter — never a 403 that leaks existence).

**Audit:** every state-changing route/sweep transition writes a `recordStaffAudit`-style
entry — but these are **member-initiated**, so use `recordMemberAudit` if it exists, else
follow the nearest actor-agnostic audit helper (check at implementation time; do not
invent a bespoke logger — see Phase 2 Files to Update). Sweep-driven transitions
(activation, hold-expiry, promotion, no-show) are recorded with `performedByUserId: null`
/ system actor, exactly mirroring `expiry.ts`'s `closeSession(..., performedByUserId:
null)` precedent.

---

## Pass 2 — Technical Planning

### Boundaries touched
`apps/chrono-api` (schema/migration/RLS, contracts, routes, background sweep,
permissions) and `apps/chrono-web` (`(member-portal)/portal/reservations/*` pages, one
new `agora/ui` primitive if a countdown timer doesn't already exist — check first).
Nothing in `packages/agora` — this is entirely business-app-owned per `.ai/rules/
business-app.md` (the module's own `src/modules/reservation/` folder, its own
permission grants already registered in `apps/chrono-api/src/auth/permissions.ts`).

### Naming decision: unify `holdPeriodMinutes`

The prompt's own follow-up correction asks to consider unifying the grace-period-after-
`startAt` (Flow 1) and the hold-after-promotion (Flow 2) into one concept. **Adopted**:
both are literally "you have N minutes to claim a station that's yours." One policy field,
`holdPeriodMinutes` (default 30), used for both `startAt`-triggered activation and
queue-promotion. The prompt's admin-config list names two separate keys
(`lateCancellationWindowMinutes` stays separate — that's a different concept, the
cancellation-penalty lookback window) — `queueHoldMinutes` is **dropped** as a distinct
key and replaced by `holdPeriodMinutes` everywhere. Documented here so the divergence
from the prompt's literal field list is a deliberate call, not a miss.

### Schema

**1. Extend `apps/chrono-api/src/modules/reservation/schema.ts`** (additive columns only,
no existing column changed/dropped — a straight `db:generate` migration):

```ts
status: text("status").notNull().default("confirmed"),
// adds: "pending" | "hold" | "cancelled_late" | "queue_expired"
// existing: "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show"
// ("no_show" already existed for path 1 — reused as-is for Flow 1's no-show too;
// it is NOT a new value, unlike the other three)
fromQueue: boolean("fromQueue").notNull().default(false),
requestedDurationMinutes: integer("requestedDurationMinutes"),
// Captured at queue-join time (a queue entry has no startAt yet to derive a
// duration from). NULL for a Flow-1 direct reservation, where startAt/endAt are
// set at creation and imply the duration already. Required (not null) whenever
// fromQueue=true — enforced by the CHECK constraint below.
holdExpiresAt: timestamp("holdExpiresAt"),
claimedAt: timestamp("claimedAt"), // set when the QR-scan claim consumes the hold
sessionId: text("sessionId").references(() => chronoSession.id, { onDelete: "set null" }),
// resolves Open Question 6 from the archived plan: closes the loop to sessions.
cancelledLateFeeAmount: numeric("cancelledLateFeeAmount", { precision: 12, scale: 2 }),
// snapshot of the fee actually applied at cancel time (policy may change later;
// this row must keep what was charged, same "snapshot, don't recompute" precedent
// as ChronoSessions.rateSnapshot).
```

**Breaking change requiring care**: `startAt`/`endAt` are currently `notNull()`. A queue
entry (`fromQueue: true`, `status: "pending"`) has neither until it is promoted to `hold`
— at which point promotion (Phase 5.3) sets **concrete** `startAt = now()`,
`endAt = now() + requestedDurationMinutes` in the same write that flips `status`. A
queue row is therefore *never* in a state where `status` is anything other than
`'pending'` while `startAt`/`endAt` are NULL — this is what fixes audit BLOCKER 3 (the
original draft tried to promote to `hold` while leaving the window NULL, which its own
CHECK constraint would have rejected).

**Resolution — schema + two hand-written migration edits (audit BLOCKERs 1–2):**
1. Make `startAt`/`endAt` nullable (drop `.notNull()`).
2. Add a CHECK constraint: `(status = 'pending' AND "startAt" IS NULL AND "endAt" IS
   NULL) OR ("startAt" IS NOT NULL AND "endAt" IS NOT NULL)`.
3. **`DROP CONSTRAINT chrono_reservation_no_overlap` and re-add it** (an exclusion
   constraint's `WHERE` cannot be `ALTER`ed in place) as:
   ```sql
   ALTER TABLE "ChronoReservations" ADD CONSTRAINT chrono_reservation_no_overlap
     EXCLUDE USING gist ("tenantId" WITH =, "stationId" WITH =,
       tsrange("startAt", "endAt", '[)') WITH &&)
     WHERE (status IN ('confirmed', 'checked_in', 'hold') AND "startAt" IS NOT NULL);
   ```
   Two things this fixes, found by the audit: (a) the original `WHERE` only covered
   `confirmed`/`checked_in`, so a `hold` row — which carries a real, station-locking
   window for up to `holdPeriodMinutes` — was invisible to the double-booking guarantee
   the moment Phase 5.1 activated it; (b) Postgres treats `tsrange(NULL, NULL)` as an
   **unbounded** range `(,)`, not "no range" — so `AND "startAt" IS NOT NULL` is required
   in the predicate, not optional, or a NULL-windowed row that ever reaches `checked_in`/
   `confirmed`/`hold` (it should never be able to per the CHECK constraint above, but the
   exclusion predicate must not depend on that alone) would block every other booking on
   the station.
4. Also add `"hold"` to `ACTIVE_STATUSES` in `apps/chrono-api/src/modules/reservation/
   routes.ts:30` (the app-level `assertNoOverlap` pre-check) so both layers of the
   two-layer guarantee agree — this file is **in scope for Phase 1**, narrowly (see
   Phase 1's Files to Update).

**One-active-reservation-per-member — DB backstop (audit CONDITION 14).** The
application-level check in Phase 3 cannot serialize two concurrent
`POST /portal/reservations` from the same member (identical "can't lock a row that
doesn't exist yet" gap the original overlap check had). Add a partial unique index:
```sql
CREATE UNIQUE INDEX chrono_reservation_one_active_per_member_uq
  ON "ChronoReservations" ("tenantId", "memberId")
  WHERE status IN ('confirmed', 'hold', 'checked_in', 'pending') AND "memberId" IS NOT NULL;
```
This enforces exactly **one** active reservation/queue-entry per member — i.e.
`maxActiveReservationsPerMember` is fixed at `1` in practice; the policy column with that
name is kept (parity with the prompt's field list, and because the resolver still needs
somewhere to read it from) but the DB constraint does not generalize to N>1. **(judgment
call, confirm or override):** if a tenant genuinely needs `N>1` later, replace the unique
index with a `SELECT count(*) ... FOR UPDATE` guard under an advisory lock — deferred
until asked for, since the prompt's own default is `1` and every example uses `1`. Map
Postgres `23505` on this index to the 409 `RESERVATION_ALREADY_ACTIVE` the routes already
need, mirroring how `session/service.ts:210-215` maps its own uniqueness violation.

**2. New table `ChronoMemberReservationRestrictions`**
(`apps/chrono-api/src/modules/reservation/restriction-schema.ts`, new file, re-exported
alongside `chronoReservation` from `db/schema.ts`):

```ts
export const chronoMemberReservationRestriction = pgTable(
  "ChronoMemberReservationRestrictions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId").notNull().references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId").notNull().references(() => chronoBranch.id, { onDelete: "cascade" }),
    memberId: text("memberId").notNull().references(() => base.tenantMember.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "reservation_ban" | "queue_ban"
    reason: text("reason").notNull(),
    // "queue_hold_expired" | "late_cancellation" | "no_show" |
    // "scheduled_time_cancellation" | "admin_manual"
    reservationId: text("reservationId").references(() => chronoReservation.id, { onDelete: "set null" }),
    stationId: text("stationId").references(() => chronoStation.id, { onDelete: "set null" }),
    startsAt: timestamp("startsAt").notNull().defaultNow(),
    expiresAt: timestamp("expiresAt").notNull(),
    metadataJson: jsonb("metadataJson").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_reservation_restriction_tenant_idx").on(t.tenantId),
    index("chrono_reservation_restriction_member_idx").on(t.tenantId, t.memberId),
    // Branch-scoped (audit CONDITION 11): a ban is checked and counted per branch,
    // matching the per-branch policy surface — a ban earned at branch A must not
    // silently block branch B. `assertNotBanned` (Phase 3) and the failure counter
    // (Phase 5.2) both take `branchId` and must agree with this index's column order.
    index("chrono_reservation_restriction_active_idx")
      .on(t.tenantId, t.memberId, t.branchId, t.type, t.expiresAt),
    // Dedupe backstop for duplicate sweep runs (audit SUGGESTION 16): tenant-scoped,
    // only applies when a reservationId exists (a manual/admin ban has none).
    uniqueIndex("chrono_reservation_restriction_no_dup_uq")
      .on(t.tenantId, t.reservationId, t.reason)
      .where(sql`${t.reservationId} is not null`),
  ],
);
```
Immutable history — no update/delete route; "active" is computed as
`expiresAt > now()` at query time, never a separate boolean flag (avoids a second
source of truth). This table (not `chronoReservation.status`) is the audit source of
truth per the prompt's explicit requirement.

**3. New table `ChronoReservationPolicies`**
(`apps/chrono-api/src/modules/reservation/policy-schema.ts`):

```ts
export const chronoReservationPolicy = pgTable(
  "ChronoReservationPolicies",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId").notNull().references(() => base.organization.id, { onDelete: "cascade" }),
    // NULL branchId = tenant-wide default row. Non-null = a specific branch's override.
    branchId: text("branchId").references(() => chronoBranch.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    reservationAdvanceWindowMinutes: integer("reservationAdvanceWindowMinutes").notNull().default(60),
    maxActiveReservationsPerMember: integer("maxActiveReservationsPerMember").notNull().default(1),
    lateCancellationWindowMinutes: integer("lateCancellationWindowMinutes").notNull().default(30),
    cancellationFeeEnabled: boolean("cancellationFeeEnabled").notNull().default(true),
    cancellationFeeAmount: numeric("cancellationFeeAmount", { precision: 12, scale: 2 }).notNull().default("20"),
    reservationBanDurationHours: integer("reservationBanDurationHours").notNull().default(24),
    noShowBanDurationHours: integer("noShowBanDurationHours").notNull().default(24),
    holdPeriodMinutes: integer("holdPeriodMinutes").notNull().default(30),
    queueFailureLimit: integer("queueFailureLimit").notNull().default(1),
    queueBanDurationHours: integer("queueBanDurationHours").notNull().default(24),
    allowQueueForReservedPc: boolean("allowQueueForReservedPc").notNull().default(true),
    allowQueueForInUsePc: boolean("allowQueueForInUsePc").notNull().default(true),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_reservation_policy_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_reservation_policy_tenant_branch_uq").on(t.tenantId, t.branchId),
    // NOTE: Postgres unique treats NULL as distinct per-row, so this does NOT enforce
    // "only one tenant-default row" by itself. Add a second partial unique index:
    uniqueIndex("chrono_reservation_policy_one_default_uq")
      .on(t.tenantId)
      .where(sql`${t.branchId} is null`),
  ],
);
```
Resolution order at read time (code, `resolveReservationPolicy(tenantId, branchId)`): a
branch row (if one exists for that branch) is used **in full**; otherwise the
tenant-default row (`branchId IS NULL`) is used in full; otherwise the hardcoded defaults
above apply. **Decided as whole-row, not per-field** (Decisions made #3, below) — a
branch either fully overrides all 13 fields or uses the tenant default in full; a
branch row, once created, sets every field explicitly (no partial-row concept in a flat
table). Per-field inheritance would need a nullable-column-means-"inherit" scheme, more
complex than this feature's payoff justifies for a first pass.
**Existing tenants**: no row for a tenant/branch = hardcoded defaults apply exactly (the
resolver returns code defaults when neither row exists) — zero migration/backfill needed,
satisfying "existing tenants with old reservation settings must continue working" (there
were no old reservation settings to begin with — path 1 never had a policy surface).

**4. `APP_TENANT_TABLES`**: add `"ChronoMemberReservationRestrictions"` and
`"ChronoReservationPolicies"` in `apps/chrono-api/src/db/schema.ts`, re-export both new
tables, mirroring the existing `chronoReservation` re-export.

### Contracts (`apps/chrono-api/src/modules/reservation/contracts.ts` — extend)

Add: `reservationStatusSchema` gains the new statuses; `createDirectReservationSchema`
(member-facing subset — no `memberId` param, taken from session; no `customerName`/
`customerPhone`); `joinQueueSchema` (`{ stationId }` only); `cancelReservationSchema`
stays; `reservationPolicySchema`/`updateReservationPolicySchema` (admin PATCH, all 13
fields, `.strict()`); restriction row DTO (never expose `metadataJson` internals the UI
doesn't need — allowlist `type`, `reason`, `expiresAt` only per the prompt's "do not
expose unnecessary internal penalty information").

### Routes — three surfaces

**A. Member portal** (new file `apps/chrono-api/src/modules/reservation/portal-
routes.ts`, mounted `.route("/portal/reservations", reservationPortalRoutes())` in
`app.ts` next to the other `/portal/*` mounts):
- `GET /portal/reservations` — the member's current active reservation/queue entry (if
  any) + resolved queue position (computed: count of earlier `pending` rows for the same
  station, not stored).
- `GET /portal/reservations/policy?stationId=` — resolved policy for that station's
  branch (enabled flags, advance window, fee amounts) — the UI needs this before showing
  "Reserve"/"Join Queue" buttons and before the cancel-confirmation dialog.
- `GET /portal/reservations/restrictions` — the member's own active
  `RESERVATION_BAN`/`QUEUE_BAN` rows (type + `expiresAt` only).
- `POST /portal/reservations` — direct reservation (Flow 1) — body: `stationId`,
  `startAt`, `durationMinutes`. Validates policy, advance window, ban, one-active-cap,
  station currently `available`(-shaped — see Phase 3), inserts `confirmed`.
- `POST /portal/reservations/queue` — join queue (Flow 2) — body: `stationId`. Validates
  policy, `allowQueueFor*`, ban, one-active-cap, station state is occupied/held (not
  plain available — reject with a message pointing at direct reservation instead).
  Inserts `pending`, `fromQueue: true`.
- `POST /portal/reservations/:id/confirm` — Flow 2 Option B (schedule from a live hold);
  409 if not currently `hold` or not the caller's own row.
- `POST /portal/reservations/:id/cancel` — computes on-time vs late per
  `lateCancellationWindowMinutes`/`startAt`, applies fee + `RESERVATION_BAN` if late,
  distinguishes a queue-entry cancel (`pending`/`hold` + `fromQueue`, no fee ever — the
  prompt's queue-cancel-is-free-vs-reservation-cancel-fee split) from a scheduled-
  reservation cancel.

All gated by `memberMiddleware()`, reading `c.var.member.{tenantId,memberId}` — **never**
`requirePermission`/staff role.

**B. Staff dashboard extension** (`apps/chrono-api/src/modules/reservation/routes.ts` —
extend, don't replace): `GET /reservations/:id/restrictions?memberId=` (staff support
view, gated `reservation:read`, same tier as today) and `GET`/`PATCH /reservations/
policy?branchId=` (gated by a **new** permission action `reservation:managePolicy` —
policy config is not routine front-desk work, unlike booking/cancel; see Permission
vocabulary below).

**C. Background sweep** — see Phase 5.

### Permission vocabulary (`apps/chrono-api/src/auth/permissions.ts`)

`reservation: ["read", "manage"]` already exists for all three tiers (staff/admin/owner —
archived plan's Open Question 7). Add `"managePolicy"` to the `reservation` action list,
granted **only** to `admin`/`owner` (the real in-file precedent for "an action staff
doesn't get" is `shift: ["...", "closeAny"]` / `wallet: ["...", "adjust"]` /
`pos: ["...", "void", "manageProducts"]`, not the foundation's `billing`/`tenant`
resources, which don't live in this file — corrected per audit CONDITION 8's minor note):
staff keeps `["read", "manage"]`, admin/owner get `["read", "manage", "managePolicy"]`
(owner inherits automatically — no explicit owner grant object needed, same pattern
`apps/chrono-api/src/e2e/permissions.test.ts:1294` already demonstrates for
`reservation`). **Required test addition**: extend that same file with three cases —
staff does NOT hold `managePolicy`, admin does, owner does — and run
`pnpm --filter @agora/chrono-api test:permissions` as part of Phase 2's verification, not
just Phase 2's typecheck. Member-portal routes need no `PERMISSION_STATEMENTS` entry at
all — they're gated by `memberMiddleware()`, a wholly separate mechanism (`.ai/rules/
rbac.md` doesn't cover member-auth; it's `agora/member-auth`'s own session check).

### Phase 3 — the claim wiring into the QR-consume route's `startSession` call

Per the Claim mechanism resolution in Pass 1 (audit BLOCKER 4), the claim path is the
existing QR-scan-at-station flow: `apps/chrono-api/src/modules/qr/public-routes.ts:254`
calls `startSession` (`session/service.ts:95`), which currently 409s with
`STATION_OCCUPIED` if `station.status !== "available"`. This plan adds, **inside the same
transaction `startSession` already opens, before that check** (so the change lives in
`session/service.ts`, reached from the QR route with no route-level change needed): look
up the caller's own `hold`-status reservation for this exact station (if any). Three
cases:
1. **The caller holds this station** (their own `hold`-status row, unexpired) → claim it:
   set `chronoReservation.status = "checked_in"`, `claimedAt = now`, `sessionId =
   <new session id>` in the same transaction as the session insert; proceed to create the
   session normally (station flips to `occupied` as it already does).
2. **Someone else holds this station** (a different member's unexpired `hold` row) →
   throw the existing `STATION_OCCUPIED` 409 even though `chronoStation.status` might
   still read `available` (the station is soft-locked by the hold, not yet
   `occupied`) — this is the "soft-lock" mentioned in Pass 1's failure cases. Implemented
   as one extra `SELECT ... FOR UPDATE` on the reservation row before the station-status
   check, inside `startSession`'s existing transaction.
3. **No hold on this station** → existing behavior, unchanged (a walk-in or a member with
   no queue/reservation history still starts a session normally).
`closeSession` needs **no** change for the claim path itself, but its **call sites**
(`session/routes.ts:249`, `session/expiry.ts:41`) each gain one call to
`promoteNextInQueue` after the `withTenant` transaction they already wrap commits — see
Phase 5.4, which names both files explicitly (audit CONDITION 10: `closeSession` itself
receives a `TenantTx`, not a transaction it owns, so it structurally cannot run
post-commit code — the hook belongs at the call sites, not inside the function).

**Audit call shape (audit CONDITION 7 — resolved, not deferred):** there is no
`recordMemberAudit` helper; the correct primitive is `recordAudit` (`packages/agora/src/
observability/audit/index.ts:27`), which takes an explicit `actorType: "staff" | "member"
| "system"`. Member-portal routes call `recordAudit({ tenantId, actorType: "member",
actorId: memberId, ip: clientIp(c), action: "chronoReservation.<verb>", targetType:
"reservation", targetId, metadata })` (verbs: `created`, `queued`, `confirmed`,
`cancelled`, `cancelledLate`). The background sweep calls `recordAudit({ tenantId,
actorType: "system", actorId: null, action: "chronoReservation.<verb>", ... })` (verbs:
`activated`, `noShow`, `queueExpired`, `promoted`) — no `Context` available in a
`setInterval`, exactly like `expiry.ts`'s own `performedByUserId: null` precedent.

### Concurrency

Two new race surfaces beyond path 1's existing EXCLUDE constraint:
1. **Two members both reaching queue position #1 for a freed station.** The sweep (Phase
   5) is the only writer that promotes `pending → hold`; it processes one station at a
   time inside `withTenant(tenantId, tx => ...)`, `SELECT ... FOR UPDATE` on **all**
   `pending` rows for that station ordered by `createdAt`, and promotes only the first —
   the row lock plus "only the sweep promotes" (no member-facing route ever sets
   `status: 'hold'` from `pending`) removes the client-race entirely; the only remaining
   race is two sweep ticks overlapping, prevented by
   `pg_advisory_xact_lock(hashtext('chrono_reservation_station_' || "stationId"))` around
   each station's promotion block. **No shared helper for this exists in Chrono today**
   (audit RISK 15 — the only precedent is raw `sql` calls in `packages/agora`'s
   platform-admin routes, e.g. `.../admin/platform-admin/routes/iam.ts:269`'s
   `'tenant_member_' || orgId` key convention); Phase 5 writes this as a raw
   `sql\`SELECT pg_advisory_xact_lock(hashtext(${key}))\`` call inside
   `apps/chrono-api/src/modules/reservation/sweep.ts`, using the exact same
   `'chrono_reservation_station_' || stationId` key string at every call site (Phase 4's
   explicit-cancel-triggers-promotion path included) so they contend on the same lock.
2. **Expiry vs. claim/cancel race** on a single reservation: the sweep's hold-expiry
   check and a member's claim (`startSession`)/cancel both mutate the same row —
   guarded by locking that one reservation row `FOR UPDATE` first and re-checking
   `status === 'hold' && holdExpiresAt > now` inside the transaction before proceeding,
   in both the sweep and the member routes. Whichever transaction commits first wins;
   the other's re-check fails and it 409s (member route) or skips the row (sweep) —
   never double-processes.
3. **Duplicate background-job execution** (`runSessionExpirySweepOnce`'s own docstring
   established this precedent): idempotency is structural, not a dedupe table — a
   sweep tick only acts on rows matching a precise `WHERE` (e.g. `status = 'hold' AND
   holdExpiresAt < now()`), and its own update includes `status = 'hold'` in the `WHERE`
   clause of the transition (`UPDATE ... SET status = 'no_show' WHERE id = ? AND status =
   'hold'`, checking `rowCount`) — a second concurrent/overlapping tick finds zero
   matching rows and no-ops. Same discipline for restriction-row creation: the
   `chrono_reservation_restriction_no_dup_uq` partial unique index defined in Schema
   above (`tenantId`, `reservationId`, `reason`) is the DB-level backstop — insert and
   swallow the `23505` conflict rather than pre-checking with a SELECT.

---

## Phase Plan

### Phase 1 — Schema, RLS, migration

**Files to Update:**
- `apps/chrono-api/src/modules/reservation/schema.ts` (extend: new columns, nullable
  `startAt`/`endAt`)
- `apps/chrono-api/src/modules/reservation/restriction-schema.ts` (new)
- `apps/chrono-api/src/modules/reservation/policy-schema.ts` (new)
- `apps/chrono-api/src/db/schema.ts` (re-exports + `APP_TENANT_TABLES` additions)
- `apps/chrono-api/src/modules/reservation/routes.ts` — **narrow, required edit** (audit
  CONDITION 6), not out of scope: add `"hold"` to `ACTIVE_STATUSES` (line 30); make
  `assertNoOverlap` skip/never receive NULL-window rows (its `startAt`/`endAt` params
  become non-optional call-site guarantees — a `pending` row is never passed in, since it
  has no window to check); fix the two now-`Date | null` typecheck breaks at
  `existing.startAt`/`existing.endAt` (line ~339) by keeping `PATCH` restricted to rows
  that already have a concrete window (`fromQueue: false`), which is already implied by
  its current `status !== "confirmed"` guard — confirm that guard still excludes every
  NULL-window state (it does: NULL-window rows are only ever `pending`).
- The staff reservation board list route (`GET /reservations`) — exclude `pending` rows
  from the default query (a queue entry has nothing for the board to display) unless the
  caller explicitly passes `status=pending`; note this in the same commit.

**Step-by-Step Tasks:**
1. Write the three schema files per Pass 2 above (including the CHECK constraint and the
   one-active-per-member partial unique index as Drizzle-expressible pieces where
   possible — the EXCLUDE-constraint rewrite below is not Drizzle-expressible).
2. `pnpm --filter @agora/chrono-api db:generate --name reservation_queue_restrictions_policy`.
3. Hand-edit the generated SQL (Drizzle cannot express any of these — same pattern the
   original EXCLUDE constraint migration used):
   - the CHECK constraint for pending-vs-scheduled rows (Schema section, exact clause
     above);
   - `DROP CONSTRAINT chrono_reservation_no_overlap` + re-`ADD CONSTRAINT` with the
     rewritten `WHERE` clause covering `hold` and requiring `"startAt" IS NOT NULL`
     (Schema section, exact SQL above) — **do not** assume the existing constraint is
     unaffected; it is not, and this is the migration's single most important edit;
   - the `chrono_reservation_one_active_per_member_uq` partial unique index;
   - the `chrono_reservation_restriction_no_dup_uq` partial unique index.
4. Edit `routes.ts` per the Files-to-Update note above.
5. `pnpm --filter @agora/chrono-api db:migrate`.
6. Pre-flight check (mirroring the archived plan's own precedent before its EXCLUDE
   constraint landed): query the real chrono DB for any existing row that would violate
   either new constraint before applying — there shouldn't be any (path 1 never produced
   a `hold` status or a second active reservation per member), but confirm rather than
   assume.

**Acceptance Criteria:** migration applies cleanly against the real chrono DB; three
tables exist with forced RLS; existing `ChronoReservations` rows are untouched
(`startAt`/`endAt` still populated, nullable change doesn't null out data); `routes.ts`
and the staff board still typecheck and pass `overlap.test.ts` unmodified in assertions
(only `ACTIVE_STATUSES` changes).

**Verification Commands:** `pnpm --filter @agora/chrono-api rls:proof` (must print `RLS
PROOF: PASS ✅`), `pnpm typecheck`, `apps/chrono-api`'s existing `overlap.test.ts`
(must still pass — it exercises the constraint this phase rewrites).

**Out-of-Scope:** contracts, member/portal routes, permissions, sweep.

**Execution Start Point:** `apps/chrono-api/src/modules/reservation/schema.ts`.

### Phase 2 — Contracts + permission vocabulary

**Files to Update:** `apps/chrono-api/src/modules/reservation/contracts.ts` (extend),
`apps/chrono-api/src/auth/permissions.ts` (add `managePolicy` action for admin/owner).

**Step-by-Step Tasks:** per Pass 2's Contracts + Permission vocabulary sections above.

**Acceptance Criteria:** every new route in Phases 3–4 has a matching Zod schema; the
member-portal DTOs never include `metadataJson`, staff-only reasons, or another member's
data.

**Verification Commands:** `pnpm typecheck`.

**Out-of-Scope:** routes.

**Execution Start Point:** `apps/chrono-api/src/modules/reservation/contracts.ts`.

### Phase 3 — Member portal routes + `startSession` claim wiring

**Files to Update:** `apps/chrono-api/src/modules/reservation/portal-routes.ts` (new),
`apps/chrono-api/src/modules/reservation/service.ts` (new — extract the policy-
resolution + ban-check + overlap-aware insert logic shared by both the member routes and
Phase 5's sweep, so the sweep isn't duplicating route logic), `apps/chrono-api/src/
modules/session/service.ts` (extend `startSession` per Pass 2's three-case claim logic),
`apps/chrono-api/src/app.ts` (mount `/portal/reservations`).

**Step-by-Step Tasks:**
1. `resolveReservationPolicy(tx, tenantId, branchId)` in `reservation/service.ts` — branch
   row else tenant-default row else hardcoded defaults (Pass 2).
2. `assertNotBanned(tx, tenantId, memberId, type)` — reads
   `ChronoMemberReservationRestrictions` for an unexpired row of that `type`.
3. `createDirectReservation` / `joinQueue` / `confirmHold` / `cancelReservation` in
   `service.ts`, each wrapped by the caller's `withTenant` transaction, reusing
   `assertNoOverlap`-style row locks from the existing `routes.ts` where a scheduled
   window is involved (Flow 1 only — Flow 2 has no window to overlap-check).
4. `portal-routes.ts` — five routes per Pass 2 Route section A, thin: validate → call
   service function → `c.json`.
5. Extend `startSession` per the three-case claim logic; extend `closeSession` with
   **no** change (Phase 5 owns promotion, not this phase — keep this phase's diff
   reviewable).
6. Mount in `app.ts`.

**Acceptance Criteria:** a member can create a direct reservation, get 400 outside the
advance window, get 409 on a second active reservation, get 403 when banned; a member can
join a queue on an occupied station and see their position; starting a session on a
station the member holds claims it (reservation → `checked_in`, `sessionId` set); starting
a session on a station someone else holds still 409s `STATION_OCCUPIED`.

**Verification Commands:** `pnpm typecheck`, `pnpm --filter @agora/chrono-api rls:proof`
(session-service touched), manual `pnpm dev:chrono` smoke test of each route via
`{slug}.localtest.me:3000`'s portal session cookie.

**Out-of-Scope:** cancellation fee/ban path (Phase 4), background promotion/expiry
(Phase 5), UI (Phase 6).

**Execution Start Point:** `apps/chrono-api/src/modules/reservation/service.ts`.

### Phase 4 — Cancellation (fee + ban) and staff policy routes

**Files to Update:** `apps/chrono-api/src/modules/reservation/service.ts` (extend
`cancelReservation`), `apps/chrono-api/src/modules/reservation/portal-routes.ts` (cancel
route — may already exist as a stub from Phase 3; fill in the fee/ban branch),
`apps/chrono-api/src/modules/reservation/routes.ts` (staff `GET`/`PATCH .../policy`,
`GET .../restrictions`).

**Step-by-Step Tasks:**
1. `cancelReservation`: resolve policy, compute `isLate = now >= startAt -
   lateCancellationWindowMinutes*60_000` (covers both "inside the window" and "at/after
   scheduled start" per the prompt's example) for a **scheduled** (`fromQueue: false`)
   reservation only; a queue entry (`fromQueue: true`) is always free to cancel, no ban,
   regardless of timing.
2. On late: `status = "cancelled_late"`, insert a restriction row
   (`type: "reservation_ban"`, `reason: "late_cancellation"` or
   `"scheduled_time_cancellation"` if `now >= startAt`), snapshot
   `cancelledLateFeeAmount` on the reservation row if `cancellationFeeEnabled`. **Do not
   actually debit the wallet here (judgment call, confirm or override):** records the fee
   amount on the row (`cancelledLateFeeAmount`) without an automatic wallet debit — staff
   can manually charge it at the counter. Auto-debiting a member's wallet for a
   *cancellation* penalty (not a service rendered) is a materially different trust
   boundary than session billing, and the prompt doesn't specify collection mechanics;
   recording-only is the safer default and is easy to upgrade to `debitWallet` later
   without a schema change (the amount is already captured on the row either way).
3. On cancelling an active `hold` (either flow): after the cancel commits, call the same
   station-promotion helper Phase 5 defines (extracted so both the sweep and an explicit
   cancel can trigger "promote next in line" — avoids a queue member waiting an extra
   sweep-interval after a cancel).
4. Staff `GET/PATCH /reservations/policy?branchId=` — `PATCH` creates/updates the branch
   row (or the tenant-default row when `branchId` omitted), gated `managePolicy`.
5. Staff `GET /reservations/restrictions?memberId=` — lists a member's restriction
   history (staff sees full detail, unlike the member's own allowlisted view).

**Acceptance Criteria:** on-time cancel → no fee, no ban; late cancel → fee amount
recorded + `RESERVATION_BAN` for `reservationBanDurationHours`; queue cancel never bans or
fees regardless of timing; cancelling a held station promotes the next queued member
immediately (not after up to one sweep interval).

**Verification Commands:** `pnpm typecheck`, `pnpm --filter @agora/chrono-api rls:proof`.

**Out-of-Scope:** background sweep itself (Phase 5).

**Execution Start Point:** `apps/chrono-api/src/modules/reservation/service.ts`.

### Phase 5 — Background sweep (activation, hold-expiry, promotion, no-show)

**Files to Update:** `apps/chrono-api/src/modules/reservation/sweep.ts` (new, mirrors
`session/expiry.ts`'s shape exactly), `apps/chrono-api/src/index.ts` (start the worker
alongside `startSessionExpiryWorker()`), `apps/chrono-api/src/modules/session/routes.ts`
(the `POST /:id/end` handler at line 249 — add the post-commit promotion call),
`apps/chrono-api/src/modules/session/expiry.ts` (line 41 — same call, from the sweep's own
already-committed `withTenant` result), `apps/chrono-api/.env.example`
(`RESERVATION_SWEEP_INTERVAL_MS`).

**Step-by-Step Tasks:**
1. **Cross-tenant scan (audit CONDITION 9)**: `ChronoReservations` is RLS-forced, so a
   sweep tick cannot select due rows under `withTenant`. Mirror `expiry.ts:19-31` exactly:
   each of 5.1/5.2 opens with a `withAdmin` (RLS-bypassing, read-only) scan selecting
   `{ id, tenantId, stationId, branchId }` for the relevant `WHERE`, `.limit(200)`
   (same batch cap), then processes each due row inside its own
   `withTenant(row.tenantId, tx => ...)`.
2. **5.1 Activation**: due rows = `confirmed` with `startAt <= now`. Inside
   `withTenant`: lock the reservation row `FOR UPDATE`, re-check `status === 'confirmed'`,
   set `status = 'hold'`, `holdExpiresAt = now + holdPeriodMinutes` (policy-resolved per
   branch). This is what makes the station exclusively the member's from `startAt`
   (Phase 3's soft-lock reads this `hold` state).
3. **5.2 Hold-expiry → no-show / queue-failure**: due rows = `hold` with
   `holdExpiresAt < now`. Inside `withTenant`: lock `FOR UPDATE`, re-check, branch on
   `fromQueue`:
   - `fromQueue: false` → `status = "no_show"`, insert `RESERVATION_BAN`
     (`noShowBanDurationHours`, `reason: "no_show"`).
   - `fromQueue: true` → `status = "queue_expired"`, insert a restriction with
     `reason: "queue_hold_expired"`, **then** count that member's `queue_hold_expired`
     restrictions **(judgment call, confirm or override):** cumulative-forever per
     `(memberId, branchId)` — every such restriction ever recorded, not windowed —
     matching the prompt's literal "failure #3 → ban" example, which names no expiry on
     the count itself. If the count reaches `queueFailureLimit`, insert a `QUEUE_BAN`
     restriction too (`queueBanDurationHours`).
4. **5.3 Promotion**: `promoteNextInQueue(tenantId, stationId)` — its own top-level
   `withTenant` call (it is invoked from three different already-committed contexts, so
   it opens its own transaction rather than assuming one): wrap the whole body in
   `pg_advisory_xact_lock(hashtext('chrono_reservation_station_' || stationId))`, then
   lock all `pending` rows for that station `FOR UPDATE ... ORDER BY createdAt ASC`,
   promote the first (if any) to `hold` — setting concrete `startAt`/`endAt` from
   `requestedDurationMinutes` per the Schema section's "queue row window" resolution —
   with a fresh `holdExpiresAt`. Called from: 5.2's queue-expiry branch (same tenant/
   station just freed), and the two post-commit call sites below.
5. **Session-end trigger (audit CONDITION 10 — `closeSession` cannot run post-commit
   code itself; the hook lives at its callers):**
   - `session/routes.ts:249`, after the existing `publishSessionTransition` call following
     `closeSession`'s `withTenant`, add `await promoteNextInQueue(tenantId,
     result.session.stationId)`.
   - `session/expiry.ts:41`, same addition after its own `publishSessionTransition` call,
     using `row.tenantId` / `result.session.stationId`.
   Both mirror the existing "publish after commit, never inside the transaction" rule
   those files already follow for `publishSessionTransition`.
6. Sweep runs on the same interval pattern as `session/expiry.ts`
   (`RESERVATION_SWEEP_INTERVAL_MS`, default 60_000, documented in
   `apps/chrono-api/.env.example` — not the root one).

**Acceptance Criteria:** a `confirmed` reservation flips to `hold` within one sweep tick
of `startAt`; an unclaimed hold becomes `no_show`/`queue_expired` within one tick of
`holdExpiresAt`, exactly once even if the sweep overlaps itself (test: fire two
concurrent `runReservationSweepOnce()` calls, assert only one transition + one
restriction row); a queue member is promoted within one tick of the station freeing via
session end, sweep-driven expiry, or explicit cancel.

**Verification Commands:** `pnpm typecheck`, `pnpm --filter @agora/chrono-api rls:proof`, the
new `sweep.test.ts` (idempotency + promotion-ordering + advisory-lock races, mirroring
`overlap.test.ts`'s use of a real `TEST_DATABASE_URL`, not a mock).

**Out-of-Scope:** UI.

**Execution Start Point:** `apps/chrono-api/src/modules/reservation/sweep.ts`.

### Phase 6 — Member UI (`apps/chrono-web`)

**Files to Update:** `apps/chrono-web/src/app/(member-portal)/portal/reservations/
page.tsx` (new), a client fetch hook alongside the existing portal ones (check
`portal/wallet`/`portal/sessions` for the pattern — likely `src/lib/rpc.ts` typed client
+ a small hook), and one new primitive only if a countdown component doesn't already
exist in `agora/ui` (check `packages/agora/src/presentation/ui/components/custom/`
first — `Sparkline`/`TrendChart` exist; a countdown timer likely doesn't and would be
added there, never as a page-local component, per `component-first-ui.md`).

**Step-by-Step Tasks:**
1. Station list (reuse the existing `/portal` station-listing pattern if one exists from
   `public-stations`, else a simple `agora/ui` `DataTableGrid`/cards) — each row/card
   shows state-appropriate CTA: `available` → "Reserve PC" (opens a start-time + duration
   picker); `occupied` (or held-by-someone-else) → "Join Queue".
2. Active-reservation panel: if the member has a `pending` row, show "You are #N in
   line"; if `hold`, show the held station + a live countdown to `holdExpiresAt`,
   explicit "This hold is FREE" copy, and both claim paths (a "Log in at the PC" hint,
   and a "Confirm reservation" button hitting `POST .../confirm` for Flow 2 Option B).
3. Restriction banners: if `GET /portal/reservations/restrictions` returns an active
   `queue_ban`/`reservation_ban`, replace the relevant CTA with the "unavailable until
   `expiresAt`" messaging per the prompt's copy — no reason/penalty detail shown.
4. Cancel confirmation dialog: fetch policy + compute client-displayed penalty preview
   (server is still authoritative on the actual `POST .../cancel` call — this is a
   preview, never trusted for the charge itself), branching copy for "no fee" vs. "₱X fee
   + 24h suspension" vs. "queue cancellation, no fee" per the prompt's three examples.
5. All markup via `agora/ui` primitives only — no raw `div`/`button`/`input`.

**Acceptance Criteria:** manually exercised in a real browser against `pnpm dev:chrono`
(`.ai/rules/AGENTS.md`'s "For UI or frontend changes... test in a browser" rule) — golden
path (reserve → claim via session start), queue path (join → promoted → claim), a banned
member sees the correct banner, a late cancel shows the correct fee preview before
confirming.

**Verification Commands:** `pnpm typecheck`, `pnpm build` (web), manual browser pass.

**Out-of-Scope:** staff-facing policy-editor UI (a `/dashboard/reservations/policy` page)
— **Deferred item 5**: policy is server-enforced regardless; the admin API-only surface
(staff use the API directly until a UI is asked for) is this pass's default.

**Execution Start Point:** `apps/chrono-web/src/app/(member-portal)/portal/
reservations/page.tsx`.

### Phase 7 — E2E spec

**Files to Update:** `apps/chrono-web/e2e/tests/reservations/member-self-service.spec.ts`
(new, alongside the existing `apps/chrono-web/e2e/tests/reservations/reservations.spec.ts`
staff spec — do not merge them).

**Step-by-Step Tasks:** cover, per `.ai/rules/e2e-testing.md`'s mandatory three plus the
scenarios this plan's Testing section lists: happy-path direct reservation → claim;
advance-window rejection; one-active-reservation cap; ban blocks reservation; queue join
→ FIFO position → promotion → claim; hold expiry → failure record → ban after
`queueFailureLimit`; on-time vs. late cancellation fee/ban; tenant isolation (tenant A's
member cannot see/act on tenant B's reservation or restriction rows, even guessing an
id); **a booking attempt overlapping a live `hold`-status window is refused** (the
regression case the plan audit called out — proves the EXCLUDE-constraint rewrite in
Phase 1 actually covers `hold`, not just `confirmed`/`checked_in`). Faker-based test
data (`test-` prefix), driven through the real `{slug}.localtest.me:3000/portal/*`
surface.

**Acceptance Criteria:** spec passes locally against a real dev DB (or PGlite per the
archived plan's own precedent — confirm which is set up on this machine before running,
same caveat the archived plan's `HANDOVER.md` already flagged).

**Verification Commands:** the feature spec first, then the full e2e suite.

**Out-of-Scope:** load/perf testing of the sweep at scale.

**Execution Start Point:** `apps/chrono-web/e2e/tests/reservations/member-self-
service.spec.ts`.

### Phase 8 — Docs

**Retargeted (audit CONDITION 12):** `apps/chrono-docs/` does not exist in this
repo — `apps/chrono-api/AGENTS.md` lists the original source implementation's
`apps/chrono-docs` explicitly under "Out of scope for this pass" (this is a different
app entirely, not a docs folder inside the current apps). The developer's own follow-up
prompt names `apps/chrono-docs/product/member-reservations.md` directly, though, so this
phase creates that path as a **new, minimal docs app placeholder** rather than silently
relocating the deliverable — the first file in a folder that doesn't exist yet has no
sibling convention to check, so this phase states its own frontmatter/heading shape
instead of assuming one.

**Files to Update:**
- `apps/chrono-docs/product/member-reservations.md` (new — a plain Markdown file, no
  app scaffolding; if the developer later wants `chrono-docs` as a real docs site, that's
  a separate, unrelated decision this phase does not make)
- `apps/chrono-api/AGENTS.md` — update the "Status"/"Modules" sections to note the queue/
  self-service follow-up landed, per this repo's own convention of keeping that file's
  module-status snapshot current (every other landed module does this).
- This plan's own closure note (see Plan Closure in Phase Plan's final step).

**Step-by-Step Tasks:** document the finished business flow (both flows, restrictions,
cancellation, policy fields + defaults + resolution order), the API surface (member +
staff), and a short "differences from the original oikos design / from the original
prompt" note (the `startAt`-delayed-lock corrected framing, the unified
`holdPeriodMinutes`, the simplified whole-row-not-per-field policy override, the
QR-scan-is-the-claim-path decision).

**Acceptance Criteria:** a new developer can read `member-reservations.md` alone and
understand the flow without reading the code; `apps/chrono-api/AGENTS.md`'s module
snapshot reflects the landed feature.

**Verification Commands:** none (docs).

**Out-of-Scope:** building out `apps/chrono-docs` as a real documentation site/app.

**Execution Start Point:** `apps/chrono-docs/product/member-reservations.md`.

---

## CRUD & Feedback Contract (admin/control-plane portion — the policy surface)

- **Create/Update**: `PATCH /reservations/policy` upserts (branch row or tenant-default
  row); no separate POST.
- **Delete**: not supported in MVP — Deferred item 6 ("reset branch to tenant default").
- **Feedback contract**: mutating member routes return the updated reservation/queue
  state; the web layer toasts success/error via `agora/ui`'s `toast` per
  `component-first-ui.md`.
- **Audit linkage**: every restriction-row insert and every policy PATCH calls
  `recordAudit` with the concrete `actorType`/`action` shapes pinned in Phase 3's
  "Audit call shape" note — staff routes use `recordStaffAudit` unchanged (existing
  helper, `Context<TenantVars>`-only), member/system paths use `recordAudit` directly.

## Testing (full list — see also each phase's Acceptance Criteria)

Direct reservation: available-PC reserve; advance-window edges (exactly at boundary,
one minute over); one-active-per-member; ban blocks; disabled-policy blocks; branch
overrides tenant default. Queue: busy-PC queue; reserved-PC queue when allowed; in-use-PC
queue when allowed; FIFO order under concurrent joins; ban blocks; hold duration/free;
claim via session start; claim via confirm; hold-expiry → failure record; failure → ban
at threshold; next member promoted. Cancellation: on-time no penalty; late fee + ban;
queue-cancel always free; cancelling an active hold promotes next immediately. No-show:
detected at hold-expiry; penalty + ban; idempotent under duplicate sweep runs.
Concurrency: two members can't get the same available PC (existing EXCLUDE constraint,
regression-checked); two members can't both become queue position #1; expiry and cancel
can't both process the same row; concurrent promotion stays correct under the advisory
lock.

## Out of Scope (this plan)

- Any change to the **staff** `/dashboard/reservations` board's existing behavior beyond
  the two new read-only staff routes (policy view/edit, restriction history).
- Wallet auto-debit of the late-cancellation fee (Decisions made #2) — recorded, not
  auto-collected, by default.
- A staff-facing policy-editor **UI page** (Deferred item 5).
- Blackout windows (oikos's `reservation-blackout.ts`) — not requested in this prompt;
  not built.
- Any change to `apps/chrono-api/src/seed.ts` beyond what's needed to keep it typechecking
  against the new nullable `startAt`/`endAt` columns (the file already shows as modified
  in `git status` — inspect it at Phase 1 to confirm nothing else in that diff is
  unrelated/stray before committing on top of it).

## Decisions made (judgment calls — resolved here, not left open, per the developer's own
"use judgment and document the call" instruction; override any of these at any time)

1. **Queue-failure counting is cumulative-forever**, not a rolling window — count every
   `queue_hold_expired` restriction ever recorded for a member at a branch against
   `queueFailureLimit`. Matches the prompt's literal failure-#3 example, which names no
   expiry on the count. (Phase 5.2, Schema.)
2. **Late-cancellation fee is recorded on the row, not auto-debited from the wallet.**
   Staff collect it manually if wanted. Charging a wallet for a cancellation penalty (not
   a service rendered) is a bigger trust decision than session billing and the prompt
   doesn't specify collection mechanics — recording-only is the safer default and doesn't
   foreclose adding `debitWallet` later (the amount is already captured either way).
   (Phase 4.2.)
3. **Policy override is whole-row, not per-field.** A branch either has its own complete
   `ChronoReservationPolicies` row (every field explicit) or falls back entirely to the
   tenant-default row, then to hardcoded defaults. True per-field inheritance needs a
   nullable-column-means-"inherit" schema, which is materially more complex than this
   feature's payoff justifies for a first pass. (Schema.)
4. **The claim path is QR-scan-at-station only** — no new in-portal "start session"
   endpoint. Matches the existing device/QR architecture and the prompt's own "member
   logs into PC" phrasing. (Pass 1, Phase 3.)

## Deferred, not blocking (confirm before or after — neither changes schema or Phase 1–5)

5. **Staff policy-editor UI** — API-only for now (`GET`/`PATCH /reservations/policy`,
   staff-gated). Confirm whether Phase 6 also needs a `/dashboard/reservations/policy`
   admin page, or whether API-only is fine until asked for.
6. **"Reset branch policy to tenant default"** — not built (no DELETE route on
   `ChronoReservationPolicies`) unless confirmed wanted; a branch row, once created,
   stays until manually edited back.
