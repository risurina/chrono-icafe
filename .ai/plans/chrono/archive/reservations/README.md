# Chrono — `reservations` module

**Depends on:** `branches` (plan done, committed `b3b3550`, **all 5 phases implemented** —
`ChronoBranches` exists on disk) and `stations` (plan done, committed `557b43e`, **Phases
1–2 implemented** — `ChronoStationGroups`/`ChronoStations` schema + RLS migrated;
Phases 3–5 not yet built, but this plan only needs the schema to exist, which it does).
**No hard schema dependency on `members`** — `ChronoReservations.memberId` references the
foundation's `tenantMember` table directly, the same anchor choice `wallet`'s and `pos`'s
plans made (see `.ai/rules/business-app.md`'s ratified cross-cutting decision: reuse
`tenantMember` for customer identity, never rebuild it). Read `members`' plan only for the
"is a customer link nullable" convention this plan follows (it is, exactly like `pos`'s
walk-in case). **No dependency on `pos`** — the two Wave 2 modules are independent;
`reservations` neither reads nor writes anything `pos` owns. **No dependency on `devices`/
`sessions`** — this plan does not create or start a `sessions` row on check-in; see Out of
Scope.

Per the handover's dependency graph, `reservations` has no Wave-2 dependency conflicts and
can be planned/implemented in parallel with `pos`. **This plan is deliberately narrower
than oikos's real reservations module** — see "Critical scope finding" in Pass 2: oikos's
live queue/hold/grace/ban system is wired to `devices`/`sessions`, neither of which is
implemented in Chrono-on-Agora yet, so it is out of scope here and deferred to a follow-up
plan once those land.

## What this is

Reservations let a customer (or staff on a customer's behalf) book a specific station at a
branch for a future time window, so the seat is held instead of first-come-first-served.
Staff at the branch see the day's bookings, check a customer in when they arrive (flipping
the reservation to occupied), and can cancel or mark a no-show. This is the module that
turns Chrono from "walk up and hope a PC is free" into a bookable venue.

---

## Pass 1 — Workflow Analysis

**Who uses it:**

- **Staff / Admin / Owner** — the primary users in this pass. Staff create a reservation
  on behalf of a customer (walk-in call/in-person request), see the day's/branch's
  reservation board, check a customer in when they arrive, cancel a reservation, and mark
  a no-show for one that was never honored.
- **Admin / Owner** — no separate elevated action beyond staff in this pass (see
  Permission vocabulary below) — reservations are a routine front-desk operation, not a
  configuration or financial action, so this plan does not draw a staff/admin split the
  way `wallet`/`pos` did for money-moving actions.
- **Customer (portal)** — **not built in this pass.** `apps/chrono-web/src/app/portal/`
  today only has the foundation's generic tenant-member auth pages (login/sign-up/reset) —
  no Chrono-specific portal page exists yet for any module, including `members`' own
  approval-status view. Self-service booking is a genuinely new customer-facing surface,
  not a small addition to an existing one — flagged as **Open Question 1**, not silently
  built or silently dropped.
- **Platform admin (`/rpc-admin`)** — not built in this pass, same as every prior module.

**Workflow:** A customer calls ahead wanting Station 12 tomorrow at 3pm for two hours.
Staff opens **Dashboard → Reservations**, picks the branch and station, sets the date/time
window, searches the member by name/email (or leaves it a phone-number-only booking with no
member link), adds an optional note, and saves — the reservation appears as `confirmed` on
the board (no separate "pending → confirm" step in this pass; a staff-created booking is
authoritative the moment it's made, since there's no self-service intake that would need a
staff confirmation step yet — see Open Question 1). When the customer arrives, staff finds
the reservation on the board and clicks **Check In** — the reservation flips to
`checked_in` (does **not** itself start a `sessions` timer; see Out of Scope). If the
customer never shows, staff clicks **No Show** after the window has passed. If the
customer calls to cancel, staff clicks **Cancel** with an optional reason. A reservation
can be edited (time window, station, notes) any time before check-in.

**Failure cases:**

- Unauthenticated → blocked by `tenantMiddleware()` before the route runs.
- Any tenant member attempting a reservation mutation with no `reservation:manage`
  grant → 403, gated by `requirePermission` (see Permission vocabulary — this pass has no
  staff/admin split, so this only fires for a genuinely unauthenticated/wrong-tenant
  caller, not a role distinction within the tenant).
- **Double-booking a station**: creating or updating a reservation whose `[startAt,
  endAt)` window overlaps another **active** (`confirmed`/`checked_in`) reservation on the
  same station → **409** `"This station is already booked for the requested time."` —
  checked under a row lock inside the same transaction the insert/update happens in, the
  identical discipline `pos`'s stock-concurrency guard and `wallet`'s balance guard both
  use, applied here to a time range instead of a counter (see "Overlap concurrency" in
  Pass 2 — this is the module's single load-bearing correctness mechanism).
- A `startAt` in the past, or `endAt <= startAt` → **400** (Zod-level cross-field check).
- A reservation window longer than a sane cap (this plan proposes 12 hours) → **400** —
  guards against a fat-fingered multi-day booking silently locking a station; see Open
  Question 2 for the exact cap.
- Checking in a reservation that is not `confirmed` (already checked in, cancelled, or a
  no-show) → **409**.
- Cancelling or marking no-show on a reservation already in a terminal state
  (`cancelled`/`no_show`/`completed`) → **409**.
- A `stationId`/`branchId`/`memberId` that doesn't belong to the caller's tenant → **404**,
  never 403 (no existence leak) — looked up **inside** the same `withTenant` transaction
  before being used, the same discipline every prior Wave 1/2 module applies to foreign
  ids.
- A `stationId` whose `branchId` doesn't match the reservation's own `branchId` → **400**
  (a station belongs to exactly one branch; a mismatched pair is a client bug, not a
  409-worthy race).
- **Tenant-isolation leak scenario**: tenant A books Station 5 at its branch for 3pm;
  tenant B (which may also happen to have a "Station 5") must never see tenant A's booking
  on its own board, and a direct request to tenant A's reservation id from tenant B's
  session gets 404.
- Stale screen: two staff viewing the same day's board — last write wins on display; the
  row lock inside the create/update transaction is what makes the *booking* itself safe,
  not client-side staleness detection (matches `pos`'s own framing for its stock count).

**Audit / notifications:** every create/update/check-in/cancel/no-show writes a
`recordStaffAudit` entry (`chronoReservation.created` / `.updated` / `.checkedIn` /
`.cancelled` / `.noShow`), capturing the station/time window, not just the action name —
matching `wallet`'s "an amount must be in the audit entry" principle applied to a booking
instead of money. No transactional email/SMS reminder in this pass — see Out of Scope.

---

## Pass 2 — Technical Planning

### Source note (revised — oikos IS inspectable from this machine)

An earlier draft of this plan assumed the oikos source was unreachable and designed
purely from `apps/chrono-api/AGENTS.md`'s domain description. That assumption was wrong:
the real prior art is at `/Users/risurina/karta/karta-tenant/apps/chrono-api/src/modules/
reservations/` (`service.ts`, `routes.ts`, `policy.ts`, `restrictions.ts`) +
`src/database/schema/station-operations.ts` (`Reservation` table) + `src/database/schema/
reservation-restrictions.ts` (`MemberReservationRestriction` table) +
`src/jobs/reservation-grace.ts` / `reservation-blackout.ts`. This section replaces the
prior placeholder with what was actually found there, and the plan below is revised
accordingly.

### Critical scope finding — oikos's reservations module is a live queue/hold system wired to `devices`/`sessions`, not a calendar-booking system

oikos's `Reservation` table (`ix_Reservations_stationId_status` etc.) and its
`reservationService` support **two materially different models in the same table**:

1. **A legacy scheduled-booking path** (`createReservation`/`cancelReservation`/
   `getReservations`) — a staff-created booking with a fixed `startTime`/`endTime`, a
   `stationId`, and either a member or a synthesized walk-in `User` row. This is the
   shape this plan's first draft already converged on independently.
2. **A live member self-service queue/hold system** (`reserveStation`/`confirmHold`/
   `promoteNextInQueue`/`cancelMemberReservation`/`extendTopUpGrace`/`leaveTopUpGrace`,
   plus `policy.ts`'s `ReservationPolicy` and the two cron jobs) — a member reserves a
   *station*, not a *time slot*: if the PC is free now, they get an immediate `CONFIRMED`
   hold with a grace-period countdown (`graceExpiresAt`) to walk over and claim it
   (`confirmHold` → `CHECKED_IN`); if the PC is busy, they join a FIFO `PENDING` queue on
   that station, and `promoteNextInQueue` (called from a session-end hook and the grace-
   expiry job) advances the next queued member into a `CONFIRMED` hold automatically. A
   whole subsystem exists around this: `MemberReservationRestriction` (temporary
   `RESERVATION_BAN`/`QUEUE_BAN` penalties for no-shows/late-cancels, checked before a new
   hold/queue-join is allowed), a per-tenant/per-branch `ReservationPolicy` (grace
   minutes, ban durations, max-active-reservations cap, queue-eligibility flags,
   auto-start-on-expiry behavior, low-balance top-up grace, a scheduled blackout window),
   and two scheduled jobs (`reservation-grace.ts` expires lapsed holds/promotes the
   queue/applies no-show bans; `reservation-blackout.ts` enforces the blackout window).

**This plan deliberately builds only path 1 (the scheduled-booking shape) in this pass**,
for a concrete, structural reason, not a preference: path 2 is fundamentally a live
station-occupancy feature — "is this PC free right now" is answered by joining
`DeviceSession`/`Device`, and "hand the PC to the next queued member" fires from a
session-end hook. **Neither `devices` nor `sessions` is implemented in Chrono-on-Agora
yet** (per `.ai/handover/chrono-migration.md`'s Plan status table: `devices` has only
Phase 2 contracts landed, no schema; `sessions`' plan is committed but zero phases
implemented). Building the queue/grace/promotion system now would mean building it
against tables that don't exist, or building throwaway stand-ins for them — worse than
deferring it to whenever `devices`+`sessions` actually land, at which point it becomes its
own well-scoped follow-up plan (see Open Questions 8–11 below, one per deferred
subsystem) that can wire real occupancy checks and a real session-end hook instead of
guessing at their shape now. This is the same reasoning `pos`'s plan used to defer
wallet-top-up/credit-package cart lines — build the real thing the dependency graph
actually supports this pass, not a stub of something bigger.

**What this means concretely for this plan's design below**: `ChronoReservations`,
its status vocabulary, and its routes are the direct, informed equivalent of oikos's
*path 1 only*. The schema is intentionally narrower than oikos's own `Reservation` table
(no `fromQueue`, `availableAt`, `graceExpiresAt`, `metadataJson` — those all belong to
path 2) but is designed so path 2's fields could be added as a later, additive migration
without reshaping what ships here, mirroring how `shifts` left
`expectedCashAmount`/`differenceAmount` null for `pos` to fill in later rather than
guessing at the shape prematurely.

### Pattern to copy (worked examples: `branch`, `station`, `shift`, `pos`)

- `apps/chrono-api/src/modules/branch/schema.ts` — id/tenantId/timestamps convention,
  `*_tenant_idx` index shape.
- `apps/chrono-api/src/modules/station/schema.ts` — the `chronoStation` table this plan's
  FK points at (`stationGroupId` nullable pattern for an optional grouping FK is a useful
  precedent, though not reused directly here).
- `apps/chrono-api/src/modules/shift/schema.ts` — the partial-unique-index-as-DB-backstop
  pattern (`chrono_shift_one_open_per_staff_idx`, a `uniqueIndex(...).where(sql\`...\`)`) —
  this plan's own DB-level double-booking backstop follows the same shape, extended to a
  range-overlap (see Schema below).
- `apps/chrono-api/src/modules/pos/schema.ts` + `service.ts` — the row-lock-then-validate
  transactional pattern (`lockAndValidateProducts`) this plan's overlap check mirrors, and
  the "walk-in customer, nullable `memberId` + freeform `customerName`" precedent this
  plan reuses verbatim.
- `.ai/rules/business-app.md` — module folder convention:
  `apps/chrono-api/src/modules/reservation/` (singular domain noun, per its Naming
  section) with `schema.ts` + `contracts.ts` + `routes.ts`.
- `.ai/rules/rbac.md` / `apps/chrono-api/src/auth/permissions.ts` —
  `CHRONO_PERMISSION_STATEMENTS` vocabulary; this plan adds `reservation` there via the
  per-app permission extension seam (`.ai/rules/business-app.md`, "Permissions: the
  per-app extension seam" — supersedes this plan's original "add directly to
  packages/agora" wording, see the "Permission vocabulary" section below).

### Schema — `ChronoReservations`

New file `apps/chrono-api/src/modules/reservation/schema.ts`:

```ts
import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";

export const chronoReservation = pgTable(
  "ChronoReservations",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    stationId: text("stationId")
      .notNull()
      .references(() => chronoStation.id, { onDelete: "cascade" }),
    // Nullable — a phone-only booking with no linked customer identity, the
    // same "walk-in is genuinely nullable" precedent `pos` set for
    // ChronoSales.memberId (see business-app.md's ratified decision: reuse
    // tenantMember, never a bespoke identity row). Confirmed against oikos:
    // its own createReservation synthesizes a throwaway User row
    // (email: walkin-<uuid>@chrono.local) for a WALKIN booking, the identical
    // customer-pool-pollution anti-pattern pos's plan already found and
    // rejected for its own walk-in sales. This plan does the honest thing
    // oikos doesn't: no identity row is ever created for a walk-in booking.
    memberId: text("memberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // Freeform snapshot for a booking with no memberId (name + phone taken
    // over the call/counter). Ignored when memberId is set (the member's own
    // profile is used instead) — same convention as pos's customerName.
    customerName: text("customerName"),
    customerPhone: text("customerPhone"),
    startAt: timestamp("startAt").notNull(),
    endAt: timestamp("endAt").notNull(),
    status: text("status").notNull().default("confirmed"),
    // "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show"
    // Deliberate divergence from oikos's ReservationStatusEnum (pgEnum:
    // PENDING/CONFIRMED/CANCELLED/CHECKED_IN/EXPIRED): free-text, not a pg
    // enum (matches every other Chrono module's convention, sidesteps
    // non-idempotent CREATE TYPE ceremony); no PENDING (that's oikos's queue
    // state — path 2, deferred, see Critical scope finding); no EXPIRED
    // (oikos's grace-lapse outcome — also path 2/the grace job, deferred);
    // adds "completed" and "no_show" (oikos's path 1 never modeled either —
    // its legacy createReservation/cancelReservation only ever go
    // PENDING→CONFIRMED/CANCELLED with no check-in or no-show concept at
    // all). This plan's status set is the informed superset path 1 actually
    // needs for the staff workflow in Pass 1, not a port of the enum.
    notes: text("notes"),
    // Who took the booking. restrict, not cascade/set null: a reservation's
    // history must survive even if the staff account is later deleted —
    // identical reasoning to ChronoShifts.staffUserId / ChronoSales.cashierUserId.
    createdByUserId: text("createdByUserId")
      .notNull()
      .references(() => base.user.id, { onDelete: "restrict" }),
    checkedInAt: timestamp("checkedInAt"),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: text("cancelReason"),
    noShowAt: timestamp("noShowAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_reservation_tenant_idx").on(t.tenantId),
    index("chrono_reservation_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_reservation_station_idx").on(t.stationId),
    index("chrono_reservation_member_idx").on(t.memberId),
    index("chrono_reservation_status_idx").on(t.status),
    index("chrono_reservation_start_idx").on(t.startAt),
  ],
);

export type NewChronoReservation = typeof chronoReservation.$inferInsert;
export type ChronoReservationRow = typeof chronoReservation.$inferSelect;
```

**Scope call: a reservation always targets a specific station, never "any station in a
group" or "just a branch slot."** The task description says "booking a station/branch
slot" — this plan resolves that toward the concrete, buildable interpretation (a specific
`chronoStation`, which itself belongs to exactly one `chronoBranch`, so `branchId` is
technically derivable from `stationId` and is stored redundantly here only for query
convenience/indexing, mirroring `pos`'s own `ChronoSales.branchId` denormalization
reasoning). A "book any available station in this group, we'll assign one at check-in"
mode is a real, plausible venue workflow but a materially different feature (a queue/
allocation step, not a fixed FK) — **Open Question 4** flags this for confirmation rather
than silently picking one.

### Overlap concurrency — the load-bearing correctness mechanism

This plan does **not** rely on a Postgres range-type `EXCLUDE` constraint (which would
need the `btree_gist` extension enabled and a generated `tstzrange` column — a bigger,
riskier schema change than this module needs to justify on its own). Instead it follows
the exact same two-layer discipline `shifts` and `pos` already established:

1. **App-level guard, inside the transaction**: before inserting or updating a
   reservation, the route locks every **other** active (`confirmed`/`checked_in`)
   reservation row for the same `stationId` with `SELECT ... FOR UPDATE`, then checks in
   application code whether `[startAt, endAt)` overlaps any locked row's window
   (`startAt < existing.endAt AND endAt > existing.startAt`). This is the primary guard,
   proven with a dedicated concurrency test mirroring `pos`'s stock-race test: `N`
   concurrent create-requests for the same station and the same time window; assert
   exactly 1 succeeds and `N-1` get 409.
2. **DB-level backstop is deliberately NOT built as a range-EXCLUDE constraint in this
   pass** — flagged as **Open Question 5**. `shifts`' own precedent (a partial unique
   index as a DB-level backstop closing "the race window between two rapid double-submits
   the app-only check didn't have") is the right instinct, but a plain `uniqueIndex` can't
   express range overlap the way `shifts`' one-open-shift-per-staff check could express
   exact equality. The correct real fix is a GiST exclusion constraint:
   ```sql
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ALTER TABLE "ChronoReservations" ADD COLUMN "timeRange" tstzrange
     GENERATED ALWAYS AS (tstzrange("startAt", "endAt", '[)')) STORED;
   ALTER TABLE "ChronoReservations" ADD CONSTRAINT chrono_reservation_no_overlap
     EXCLUDE USING gist ("stationId" WITH =, "timeRange" WITH &&)
     WHERE (status IN ('confirmed', 'checked_in'));
   ```
   This is a genuinely stronger guarantee than the app-level lock alone (it survives a
   bug in the lock-acquisition code, a raw `db:generate`-authored row, or a future direct
   write) and is standard Postgres practice for booking systems — but it is also outside
   Drizzle's schema DSL (needs a raw-SQL migration, like the enum-wrapping pattern
   `.ai/rules/database.md` documents) and adds `btree_gist` as a new extension dependency
   this app doesn't have today. **This plan defaults to shipping the app-level lock only
   in Phase 1**, with the exclusion constraint as a clearly-labeled Phase 1b the developer
   can opt into — do not skip asking; the two `pos`/`shifts` precedents both chose a DB
   backstop, so silently omitting one here is a real gap, not a neutral default.

### `APP_TENANT_TABLES`

Add `"ChronoReservations"` to the array in `apps/chrono-api/src/db/schema.ts`, and
re-export `chronoReservation` from the module into that file, mirroring the existing
`chronoBranch`/`chronoStation`/`chronoShift` re-export style exactly. Check the file's
current state first — don't clobber a concurrently-landed `pos` entry
(`"ChronoProducts"`/`"ChronoSales"`/`"ChronoSaleItems"`/`"ChronoSalePayments"`), since
`pos` is landing in the same Wave 2 window.

### Contracts — `apps/chrono-api/src/modules/reservation/contracts.ts`

```ts
import { z } from "zod";
import { listQuerySchema } from "agora";

export const reservationStatusSchema = z.enum([
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
]);

const MAX_WINDOW_HOURS = 12; // see Open Question 2

export const createReservationSchema = z
  .object({
    branchId: z.string().min(1),
    stationId: z.string().min(1),
    memberId: z.string().min(1).optional(), // omit for a phone/name-only booking
    customerName: z.string().max(255).optional(),
    customerPhone: z.string().max(50).optional(),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), {
    message: "endAt must be after startAt",
    path: ["endAt"],
  })
  .refine(
    (v) =>
      new Date(v.endAt).getTime() - new Date(v.startAt).getTime() <=
      MAX_WINDOW_HOURS * 60 * 60 * 1000,
    { message: `A reservation cannot exceed ${MAX_WINDOW_HOURS} hours.`, path: ["endAt"] },
  )
  .refine((v) => v.memberId || v.customerName, {
    message: "Either memberId or customerName is required.",
    path: ["customerName"],
  });

export const updateReservationSchema = z
  .object({
    stationId: z.string().min(1).optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => !(v.startAt && v.endAt) || new Date(v.endAt) > new Date(v.startAt), {
    message: "endAt must be after startAt",
    path: ["endAt"],
  });

export const cancelReservationSchema = z.object({
  reason: z.string().max(255).optional(),
});

export const reservationListQuerySchema = listQuerySchema([
  "startAt",
  "createdAt",
]).extend({
  branchId: z.string().optional(),
  stationId: z.string().optional(),
  status: reservationStatusSchema.optional(),
  memberId: z.string().optional(),
  // Board view: filter to reservations overlapping a given day/range.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;
export type CancelReservationInput = z.infer<typeof cancelReservationSchema>;
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;
```

No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
contracts stay local unless a second business app needs them.

### Service — `apps/chrono-api/src/modules/reservation/service.ts`

Every overlap-sensitive function takes an already-open `tx: TenantTx`, the same discipline
`wallet`/`pos` established:

```ts
/**
 * Locks every OTHER active (confirmed/checked_in) reservation row for this
 * station, then checks the requested [startAt, endAt) window against each
 * locked row's window in application code. Throws 409 on any overlap.
 * excludeReservationId is passed on update, so a reservation never conflicts
 * with itself.
 */
async function assertNoOverlap(
  tx: TenantTx,
  args: {
    tenantId: string;
    stationId: string;
    startAt: Date;
    endAt: Date;
    excludeReservationId?: string;
  },
): Promise<void> { /* SELECT ... FOR UPDATE on chronoReservation WHERE stationId = ...
     AND status IN ('confirmed','checked_in') AND id != excludeReservationId,
     then overlap-check each row in JS */ }
```

`createReservation`, `updateReservation`, `checkIn`, `cancel`, `markNoShow` are thin
wrappers in `routes.ts` calling this guard plus a plain insert/update — no separate
`service.ts` orchestration complexity is needed beyond the overlap lock (unlike `pos`'s
multi-step checkout), so this plan keeps the guard function in `service.ts` and the
CRUD bodies directly in `routes.ts`, matching `branch`'s/`station`'s simpler shape rather
than `wallet`'s/`pos`'s heavier `service.ts` split.

### Routes — `apps/chrono-api/src/modules/reservation/routes.ts`

A Hono factory `reservationRoutes()` typed on `TenantVars`, composed into
`apps/chrono-api/src/routes/rpc.ts` via `.route("/reservations", reservationRoutes())`:

- `GET /` — `reservation:read`. `reservationListQuerySchema` (filterable by
  `branchId`/`stationId`/`status`/`memberId`/`from`/`to` for the board view), `withTenant`,
  joined with `base.tenantMember` (nullable) for display, `{ items, meta }`.
- `GET /:id` — `reservation:read`. 404 cross-tenant.
- `POST /` — `reservation:manage`. Validates `createReservationSchema`; looks up
  `branchId`/`stationId`/`memberId` (if present) inside `withTenant` first (404 if
  foreign/missing, 400 if the station's `branchId` doesn't match); calls
  `assertNoOverlap`; inserts; `recordStaffAudit("chronoReservation.created", ...)`.
- `PATCH /:id` — `reservation:manage`. Validates `updateReservationSchema`. 404
  cross-tenant. 409 if status is not `confirmed` (a checked-in/cancelled/completed/no-show
  reservation cannot be edited — its window is locked in). Re-runs `assertNoOverlap` when
  `stationId`/`startAt`/`endAt` changes. `recordStaffAudit("chronoReservation.updated", ...)`.
- `POST /:id/check-in` — `reservation:manage`. 404 cross-tenant. 409 if status isn't
  `confirmed`. Sets `status: "checked_in"`, `checkedInAt: now()`.
  `recordStaffAudit("chronoReservation.checkedIn", ...)`.
- `POST /:id/cancel` — `reservation:manage`. `cancelReservationSchema`. 404 cross-tenant.
  409 if status is already terminal (`cancelled`/`no_show`/`completed`). Sets
  `status: "cancelled"`, `cancelledAt: now()`, `cancelReason`.
  `recordStaffAudit("chronoReservation.cancelled", ...)`.
- `POST /:id/no-show` — `reservation:manage`. 404 cross-tenant. 409 if status isn't
  `confirmed` (a no-show can only be marked against a booking nobody checked into — not
  against one already checked in). Sets `status: "no_show"`, `noShowAt: now()`.
  `recordStaffAudit("chronoReservation.noShow", ...)`.

No `DELETE` — a reservation is cancelled or marked no-show, never deleted, matching
`shift`'s/`pos`'s "immutable audit trail" precedent. No separate `completed` transition
route in this pass — nothing currently marks a reservation `completed` (it would naturally
follow from a `sessions` check-out once `sessions` exists, out of scope here; see Open
Question 6).

### Permission vocabulary

**Superseded 2026-09-01**: the "add directly to `packages/agora/src/auth/permissions.ts`"
precedent this plan originally cited has been retired — see
`.ai/plans/agora/active/permission-extension-seam/README.md` and
`.ai/rules/business-app.md`, "Permissions: the per-app extension seam." `reservation`
must be added to `apps/chrono-api/src/auth/permissions.ts` (alongside
`branch`/`station`/`shift`) instead, following that file's existing pattern:

```ts
// apps/chrono-api/src/auth/permissions.ts
export const CHRONO_PERMISSION_STATEMENTS = {
  ...
  reservation: ["read", "manage"],
} satisfies Record<string, string[]>;
```

Add `reservation: ["read", "manage"]` to both `CHRONO_STAFF_GRANTS` and
`CHRONO_ADMIN_GRANTS` in that same file — no code changes needed elsewhere;
`registerChronoPermissions()` already registers whatever this file defines. Route files
under `apps/chrono-api/src/modules/reservation/` should import `requirePermission` from
`apps/chrono-api/src/auth/require-permission.ts` (the typed wrapper), not `agora/auth`
directly, so `reservation:*` calls keep compile-time key/action checking — same as
`branch`/`station`/`shift`'s route files already do.

- `staffRole` grant — `reservation: ["read", "manage"]` (booking/check-in/cancel is
  routine front-desk work, the same tier `pos`'s `sell` action and `wallet`'s
  `credit`/`debit` actions already established for staff-run counter operations — not a
  config or financial-correction action that would warrant an admin+ split).
- `adminRole` grant — inherits `reservation: ["read", "manage"]` too (every tier gets the
  same actions in this pass — no staff/admin split for reservations, unlike `pos`'s
  `sell` vs `manageProducts`/`void`). `ownerRole` needs no explicit grant — it
  automatically receives every registered app resource in full. **Open Question 7**
  flags this for confirmation: if the developer wants cancellation or a bulk/override
  action restricted to admin+ (e.g. preventing a staff member from quietly cancelling a
  VIP's booking), split a `reservation:cancel` action out — this plan's default keeps it
  simple because nothing about cancelling a reservation is financially or
  configurationally sensitive the way `pos:void`/`wallet:adjust` are.

### CRUD & Feedback Contract

| Action | Method | Permission | Notes |
|---|---|---|---|
| List | `GET /rpc/reservations` | `reservation:read` | paginated, filterable by branch/station/status/member/date-range (board view) |
| Detail | `GET /rpc/reservations/:id` | `reservation:read` | 404 cross-tenant |
| Create | `POST /rpc/reservations` | `reservation:manage` | 409 on station/time overlap; 400 on invalid window; 404 on foreign branch/station/member |
| Update | `PATCH /rpc/reservations/:id` | `reservation:manage` | 409 if not `confirmed`; re-checks overlap when time/station changes |
| Check in | `POST /rpc/reservations/:id/check-in` | `reservation:manage` | 409 if not `confirmed` |
| Cancel | `POST /rpc/reservations/:id/cancel` | `reservation:manage` | 409 if already terminal |
| Mark no-show | `POST /rpc/reservations/:id/no-show` | `reservation:manage` | 409 if not `confirmed` |
| Delete | — | — | not built — cancel/no-show are the only "removal", matches `shift`/`pos` |

Feedback: `toast.success`/`toast.error` at the point of the API call, matching every prior
module's inline-message convention (surfacing the 409 overlap message verbatim, same as
`pos`'s 409 stock/shift handling).

Audit linkage: `recordStaffAudit` on every mutation, each entry capturing the station and
time window, not just the action name — same principle `wallet`/`pos` established.

### Web UI

- **`apps/chrono-web/src/app/dashboard/reservations/page.tsx` (new)**: a day/branch board
  view — a branch `Select`, a date picker (defaults to today), and a list/grid of that
  day's reservations per station (`DataTable`/`DataTableGrid` from `agora/ui`, or a simple
  per-station timeline if the implementor judges it clearer — implementor's call, no
  existing Chrono module has a timeline UI to mirror, so a plain filtered `DataTable`
  grouped/sorted by `startAt` is the safe default matching `pos`'s own list-first
  approach). Row actions: **Check In**, **Cancel**, **No Show** (visible per status —
  `confirmed` rows can be checked in/cancelled/no-showed; others show status only).
- A create/edit `Dialog`: branch `Select`, station `Select` (filtered to the chosen
  branch, from `api.rpc.stations.$get({ query: { branchId } })`), member search/walk-in
  toggle (mirrors `pos`'s and `wallet`'s own member-picker pattern), start/end
  date-time inputs, notes `Textarea`. Submits via `api.rpc.reservations.$post`/`$patch`.
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add a `Reservations` entry to
  `BASE_NAV` (a `CalendarClock`-style `lucide-react` icon) and
  `"/dashboard/reservations": "Reservations"` to `TITLES`, mirroring every prior module's
  nav entries.
- No module-registry feature-flag gate — matching every prior module's default reasoning
  (confirm with the developer if a kill-switch is wanted, since not every tenant may want
  bookable stations — same caveat `pos`'s plan flagged for itself).

### Out of Scope (this plan)

- **A customer-facing self-service booking portal** — see Open Question 1. Reservations
  in this pass are staff-created only.
- **Starting or linking a `sessions` row on check-in** — check-in only flips the
  reservation's own status; it does not create, start, or reference a `ChronoSessions` row
  (that module doesn't exist yet, per the handover's Wave-1 status — `sessions`' plan is
  committed but not implemented). A future amendment could add an optional `sessionId`
  reference once `sessions` lands and the developer wants that linkage — see Open
  Question 6.
- **oikos's live member self-service queue/hold system** (`reserveStation`/
  `confirmHold`/`promoteNextInQueue`/`extendTopUpGrace`/`leaveTopUpGrace`), its
  `MemberReservationRestriction` ban system, its per-tenant/branch `ReservationPolicy`
  settings surface, and its two scheduled jobs (`reservation-grace.ts`/
  `reservation-blackout.ts`) — see "Critical scope finding" in Pass 2 and Open Questions
  8–11. All of it is real, working oikos functionality, not dead code being dropped for
  being weak — it's deferred purely because it needs `devices`/`sessions`, neither of
  which exists in Chrono-on-Agora yet.
- **Deposits/prepayment or recurring bookings** — absent from oikos's own path-1 code
  too; not invented here.
- **A Postgres GiST exclusion constraint as a DB-level double-booking backstop** — the
  app-level row-lock guard is this plan's primary mechanism; the exclusion constraint is
  offered as an explicit opt-in Phase 1b, not silently included or silently dropped (Open
  Question 5).
- **"Any station in a group" / branch-level (unassigned-station) bookings** — a
  reservation always targets one specific station (Open Question 4).
- **SMS/email reminder notifications** — trivial follow-up once a notification-channel
  module exists; not required to ship this module, matching every prior module's stance.
- **The `/rpc-admin` platform-admin cross-tenant view** — no
  `PLATFORM_PERMISSION_STATEMENTS` resource exists for this today, same reasoning as
  every prior module.
- A `chronoReservation.*` webhook event — trivial follow-up, not required to ship this
  module.
- Module-registry (`modules.reservation`) feature-flag gating of the nav entry.
- Any `pos`/`devices`/`sessions` code — separate, unrelated plans.

---

## Phase 1 — Schema, RLS, `APP_TENANT_TABLES`

**Files to update**

- `apps/chrono-api/src/modules/reservation/schema.ts` (new) — `chronoReservation` table
  (Pass 2).
- `apps/chrono-api/src/db/schema.ts` — import + re-export `chronoReservation`, add
  `"ChronoReservations"` to `APP_TENANT_TABLES`.

**Step-by-step tasks**

1. Verify `apps/chrono-api/src/modules/branch/schema.ts` and
   `apps/chrono-api/src/modules/station/schema.ts` exist (they do, as of this writing) —
   this module's FKs import `chronoBranch`/`chronoStation` from them.
2. Create `apps/chrono-api/src/modules/reservation/` and write `schema.ts` exactly as
   specified in Pass 2 (one table, all six indexes, no unique index — the overlap
   guarantee is enforced in application code per Phase 3, not at the schema layer, unless
   Open Question 5 is resolved toward building Phase 1b).
3. In `apps/chrono-api/src/db/schema.ts`, add the import/re-export and append
   `"ChronoReservations"` to `APP_TENANT_TABLES` (check the file's current state first —
   don't clobber a concurrently-landed `pos` entry; both modules are landing in the same
   Wave 2 window per the handover).
4. `pnpm --filter @agora/chrono-api db:generate --name add_chrono_reservations` (never
   `db:push`). Review the generated SQL: expect a single `CREATE TABLE
   "ChronoReservations"` plus its six indexes and two FKs (`branchId`, `stationId`), no
   destructive statements.
5. `pnpm --filter @agora/chrono-api db:migrate` against `DATABASE_URL_ADMIN`.
6. **If the developer has resolved Open Question 5 toward building the GiST exclusion
   constraint (Phase 1b, optional)**: enable `btree_gist`, add the generated `timeRange`
   column and `EXCLUDE` constraint via a second, explicitly-reviewed raw-SQL migration
   (mirroring `.ai/rules/database.md`'s non-idempotent-`CREATE TYPE` wrapping pattern for
   a one-time `CREATE EXTENSION IF NOT EXISTS`). Do this as its own migration, not folded
   into step 4, so it can be reviewed/rolled back independently.

**Acceptance criteria**

- `ChronoReservations` exists in the target database with `FORCE ROW LEVEL SECURITY` on.
- `"ChronoReservations"` is present in `APP_TENANT_TABLES` in
  `apps/chrono-api/src/db/schema.ts`.
- The migration file is reviewed and contains no destructive/unexpected statements.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof` → must print `RLS PROOF: PASS ✅`.

**Out of scope:** contracts, service, routes, UI — later phases.

**Execution start point:** create `apps/chrono-api/src/modules/reservation/schema.ts`,
after confirming `branch`'s and `station`'s schema files exist to import from.

---

## Phase 2 — Contracts

**Files to update**

- `apps/chrono-api/src/modules/reservation/contracts.ts` (new) — Zod schemas (Pass 2).

**Step-by-step tasks**

1. Write `reservationStatusSchema`, `createReservationSchema`, `updateReservationSchema`,
   `cancelReservationSchema`, `reservationListQuerySchema`, and their `z.infer` types
   exactly as specified in Pass 2, including the `MAX_WINDOW_HOURS` cap resolved per Open
   Question 2.
2. No changes to `packages/agora/src/contracts` — per `business-app.md`, this module's
   contracts stay local unless a second business app needs them.

**Acceptance criteria**

- All listed types compile and are importable from `../modules/reservation/contracts`.
- `createReservationSchema` rejects `endAt <= startAt`, rejects a window over the cap, and
  rejects a payload with neither `memberId` nor `customerName`.
- `updateReservationSchema` accepts a partial payload (station-only change, time-only
  change, or notes-only change).

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`

**Out of scope:** routes, UI.

**Execution start point:** create
`apps/chrono-api/src/modules/reservation/contracts.ts`.

---

## Phase 3 — Service + routes + permission gates

**Files to update**

- `packages/agora/src/auth/permissions.ts` — add `reservation: ["read", "manage"]` to
  `PERMISSION_STATEMENTS`, `staffRole`, `adminRole` (owner inherits automatically) —
  resolve Open Question 7 first (see Pass 2).
- `apps/chrono-api/src/modules/reservation/service.ts` (new) — `assertNoOverlap`.
- `apps/chrono-api/src/modules/reservation/routes.ts` (new) — `reservationRoutes()`
  factory.
- `apps/chrono-api/src/routes/rpc.ts` — `.route("/reservations", reservationRoutes())`.
- `apps/chrono-api/src/e2e/permissions.test.ts` — add a `reservation` gate case.
- `apps/chrono-api/src/modules/reservation/overlap.test.ts` (new) — the concurrency test
  (Pass 2's "N concurrent creates for the same station/window → exactly 1 succeeds").

**Step-by-step tasks**

1. Add `reservation: ["read", "manage"]` to `PERMISSION_STATEMENTS` in
   `packages/agora/src/auth/permissions.ts`, and to `staffRole`'s and `adminRole`'s
   composed statement objects (owner inherits automatically).
2. Write `apps/chrono-api/src/modules/reservation/service.ts`: `assertNoOverlap(tx, {
   tenantId, stationId, startAt, endAt, excludeReservationId? })` per Pass 2 — row-locks
   every other active reservation on the station, checks overlap in application code,
   throws `HttpError(409, ...)` on a hit.
3. Write `apps/chrono-api/src/modules/reservation/routes.ts`: `GET /` (paginated via
   `reservationListQuerySchema`), `GET /:id`, `POST /`, `PATCH /:id`, `POST
   /:id/check-in`, `POST /:id/cancel`, `POST /:id/no-show` — each per the exact behavior
   specified in Pass 2's Routes section, all gated `requirePermission(...,
   { reservation: [...] })`, all mutations inside `withTenant` + `recordStaffAudit`.
   Follow the structural conventions of `apps/chrono-api/src/modules/branch/routes.ts` /
   `station/routes.ts` (import style, `HttpError`, pagination meta shape).
4. Compose into `apps/chrono-api/src/routes/rpc.ts` via
   `.route("/reservations", reservationRoutes())`.
5. Add a `reservation` case to `apps/chrono-api/src/e2e/permissions.test.ts`: assert
   `hasPermission("staff", { reservation: ["manage"] }) === true`,
   `hasPermission("admin", { reservation: ["manage"] }) === true`,
   `hasPermission("owner", { reservation: ["manage"] }) === true` (and `"read"`
   analogously) — a gate test proving the vocabulary is wired, even though this pass
   grants every tier the same actions (a gate test must still fail if the permission is
   removed from a role, per `.ai/rules/testing.md`).
6. Write the concurrency test: seed one station with an empty schedule, fire `N`
   concurrent `POST /` requests for the identical `[startAt, endAt)` window, assert
   exactly one `201` and `N-1` `409`s, and that exactly one row exists in
   `ChronoReservations` for that station/window afterward.

**Acceptance criteria**

- `GET /rpc/reservations` returns `{ items, meta }`, filterable by branch/station/status/
  member/date-range.
- `POST /rpc/reservations` succeeds for a non-overlapping window; the second of two
  concurrent overlapping requests for the same station returns 409.
- `PATCH /rpc/reservations/:id` on a `checked_in`/`cancelled`/`no_show`/`completed`
  reservation → 409; on another tenant's reservation id → 404.
- `POST /rpc/reservations/:id/check-in` → 409 unless status is `confirmed`.
- `POST /rpc/reservations/:id/cancel` and `.../no-show` → 409 on an already-terminal
  status.
- `pnpm --filter @agora/chrono-api test:permissions` passes with the new `reservation`
  cases included.
- The concurrency test passes deterministically (not flaky) across repeated runs.

**Verification commands**

- `pnpm --filter @agora/chrono-api typecheck`
- `pnpm --filter @agora/chrono-api rls:proof`
- `pnpm --filter @agora/chrono-api test:permissions`
- `pnpm --filter @agora/chrono-api test` (or the project's equivalent runner for
  `overlap.test.ts` — match whatever command runs `pos`'s own concurrency test, for
  consistency)

**Out of scope:** UI, e2e browser spec (Phase 5).

**Execution start point:** edit `packages/agora/src/auth/permissions.ts` first (the
routes file imports `requirePermission` against the new resource, so the vocabulary must
exist before the route file typechecks).

---

## Phase 4 — Web UI

**Files to update**

- `apps/chrono-web/src/app/dashboard/reservations/page.tsx` (new).
- `apps/chrono-web/src/app/dashboard/layout.tsx` — add nav entry + title.
- `packages/agora/src/ui/*` — only if a genuinely missing primitive is needed (a date-time
  picker may not exist yet in `agora/ui` — check `packages/agora/src/ui/components/ui/`
  first; if missing, add it there per `ai-agent.md`, do not invent a local wrapper in
  `apps/chrono-web`).

**Step-by-step tasks**

1. Build `page.tsx`: branch `Select`, date picker, `DataTable`/`DataTableGrid` of that
   day's reservations across the branch's stations (`useListQuery()` for URL-driven
   state), row actions gated on status (`Check In`/`Cancel`/`No Show`), per Pass 2's Web
   UI section.
2. Add a create/edit `Dialog`: branch `Select`, station `Select` (filtered by branch),
   member search/walk-in toggle, start/end date-time inputs, notes `Textarea` — all via
   `agora/ui` primitives only (`.ai/rules/component-first-ui.md`).
3. Wire `toast.success`/`toast.error` on every mutation, surfacing the 409 overlap message
   verbatim, matching `pos`'s inline-error convention.
4. Add `{ type: "item", name: "Reservations", href: "/reservations", icon: <pick an
   appropriate lucide-react icon, e.g. CalendarClock> }` to `BASE_NAV` in
   `apps/chrono-web/src/app/dashboard/layout.tsx`, and `"/dashboard/reservations":
   "Reservations"` to `TITLES`.

**Acceptance criteria**

- `/dashboard/reservations` renders the board for a selected branch/date, and
  search/sort/paginate/view-toggle (if applicable) update the URL.
- Create/edit dialogs submit successfully and the board refreshes.
- Attempting to create an overlapping reservation surfaces the 409 message as a toast, no
  row is added.
- No raw HTML chrome introduced in `apps/chrono-web` (component-first-ui.md check).

**Verification commands**

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web build`

**Out of scope:** e2e spec (Phase 5), customer-facing portal booking (Open Question 1),
module-registry gating.

**Execution start point:** create
`apps/chrono-web/src/app/dashboard/reservations/page.tsx`.

---

## Phase 5 — E2E spec

**Files to update**

- `apps/chrono-web/e2e/tests/reservations/reservations.spec.ts` (new).

**Step-by-step tasks**

1. Write a Playwright spec mirroring `branches`'/`pos`'s own e2e structure and the
   `signUp()` helper, covering the three required cases per `.ai/rules/e2e-testing.md`:
   - **Happy path**: sign up a tenant, create a branch and a station (reusing those
     modules' own creation flows or seed helpers), navigate to
     `/dashboard/reservations`, create a reservation (walk-in, no member), check it in,
     confirm the status updates; create a second reservation, cancel it, confirm the
     status updates.
   - **Role gate**: since this pass grants staff and admin the same `reservation:manage`
     actions (Pass 2's Permission vocabulary), the role-gate case instead proves the
     **tenant-membership gate** — an unauthenticated/non-member request to
     `/rpc/reservations` is refused — mirroring how `branches`' own spec frames its gate
     test around the boundary that actually exists in this module. If Open Question 7 is
     resolved toward splitting out an admin-only `reservation:cancel` action before this
     phase executes, this spec must be updated to test that split instead (staff blocked
     from cancel, admin/owner allowed).
   - **Tenant isolation**: tenant A creates a reservation for "Acme Only Station"; tenant
     B's reservations board (for its own, differently-tenanted station) never shows it,
     and a direct `GET /rpc/reservations/:id` using tenant A's id from tenant B's session
     returns 404.
2. Use `@faker-js/faker` (`apps/chrono-web/e2e/utils/faker.ts`) for names/emails/phone
   numbers, not hand-rolled `Date.now()` strings, per `.ai/rules/e2e-testing.md`.

**Acceptance criteria**

- All three test cases pass locally against `pnpm dev` (manual/headed suite, no
  `webServer` in the Playwright config, per `.ai/rules/rbac.md`'s "Testing" section).
- No `.env` present in `apps/chrono-api` while running (the spec drives the real dev
  server, not the in-process PGlite harness).

**Verification commands**

- `pnpm --filter @agora/chrono-web exec playwright test e2e/tests/reservations/reservations.spec.ts`
  (with `pnpm dev` already running).

**Out of scope:** platform-admin e2e coverage (no platform-admin routes exist for
reservations in this pass); a concurrency/overlap e2e assertion (already covered by
Phase 3's backend concurrency test — an e2e spec is the wrong layer to prove a race
condition).

**Execution start point:** create
`apps/chrono-web/e2e/tests/reservations/reservations.spec.ts`.

---

## Open Questions (developer to confirm/override)

1. **Self-service customer booking portal** — not built in this pass; reservations are
   staff-created only. If wanted, it's a new `apps/chrono-web/src/app/portal/` surface
   (the first Chrono-specific one — no module has built one yet), a separate follow-up
   plan, not a phase folded into this one.
2. **Maximum reservation window** — this plan proposes a 12-hour cap
   (`MAX_WINDOW_HOURS`) to guard against a fat-fingered multi-day booking. Confirm the
   number, or drop the cap entirely if unbounded bookings are actually wanted.
3. **Read-permission tier for the list/detail routes** — oikos's own `GET /` is gated
   `requireAuth + requireBranch` only (no role check), deliberately, so a read-only
   platform-role viewer isn't blocked (see its routes.ts comment). This plan's Pass 2
   grants `reservation:read` to every tenant tier identically (staff/admin/owner), which
   has the same practical effect within a tenant; flagging only because oikos's own
   comment explains a real reason (a distinct read-only viewer concept) that doesn't have
   a direct Agora equivalent today — confirm this is fine as-is, no action expected.
4. **Station-specific vs. group/branch-level booking** — this plan books a specific
   `chronoStation` only. An "any station in this group, assign at check-in" mode is a
   materially different feature (a queue/allocation step) and is out of scope unless
   confirmed wanted.
5. **DB-level double-booking backstop** — this plan's primary guarantee is an app-level
   row-lock-and-check inside the transaction (proven by a concurrency test). A genuine
   Postgres `EXCLUDE USING gist` range-overlap constraint (Phase 1b, needs `btree_gist`)
   is offered as an opt-in strengthening, not shipped by default. Confirm whether to build
   it now, matching `shifts`'/`pos`'s own precedent of adding a DB-level backstop for
   their load-bearing invariants.
6. **`sessions` linkage on check-in** — check-in in this pass only flips the
   reservation's own status; it does not start a `ChronoSessions` row (that module isn't
   implemented yet). Once `sessions` lands, decide whether check-in should optionally
   start a session automatically, and whether a `sessionId` FK should be added to
   `ChronoReservations` to close that loop — a follow-up amendment, not this plan's scope.
7. **Permission tier** — this plan grants `staff`/`admin`/`owner` the identical
   `reservation: ["read", "manage"]` set (no split), reasoning that booking/cancel/no-show
   is routine front-desk work, not a financial or configuration action. If the developer
   wants cancellation restricted to admin+ (e.g. protecting VIP bookings from casual
   staff cancellation), split out a `reservation:cancel` action before Phase 3 — a
   one-line change in `PERMISSION_STATEMENTS`/`staffRole`, same shape as every prior
   module's equivalent open question.
8. **Member self-service live queue/hold system (oikos's `reserveStation`/
   `confirmHold`/`promoteNextInQueue`)** — genuinely deferred, not dropped. This is
   oikos's actual headline reservations feature (reserve a busy PC, get auto-promoted
   when it frees up, claim it within a grace window) and it fundamentally needs
   `devices`/`sessions` to answer "is this station free right now" and to fire a
   promotion on session-end. Plan this as its own follow-up once both land — it will
   likely add fields to `ChronoReservations` (`fromQueue`, `availableAt`,
   `graceExpiresAt`) rather than replace this plan's table, mirroring how `pos` added
   columns `shifts` had left null instead of reshaping `ChronoShifts`.
9. **No-show/late-cancel penalties (oikos's `MemberReservationRestriction` — temporary
   `RESERVATION_BAN`/`QUEUE_BAN`)** — deferred alongside Open Question 8, since it's
   gating logic for the live queue/hold system this plan doesn't build. This plan's own
   staff-driven `no-show` status (Pass 1) is a passive record only — it does not create
   any restriction/ban row or block the customer's future bookings. Confirm this is
   acceptable for the MVP, or flag it as wanted sooner (it could theoretically apply to
   path 1's staff-created bookings independent of the queue system, but oikos itself only
   ever wires it to path 2).
10. **Per-tenant/per-branch `ReservationPolicy`** (grace minutes, ban durations, max-
    active-reservations cap, queue-eligibility flags, blackout window, auto-start-on-
    expiry) — oikos exposes this as its own settings surface
    (`GET/PATCH/DELETE /reservations/policy`). Every one of its fields governs path 2
    (the live queue/hold system) except the blackout window, which could apply to path 1
    too ("no staff bookings between 2am–6am"). This plan does not build any policy
    surface in this pass — confirm whether a narrow blackout-window-only policy is wanted
    now, or whether the whole thing waits for Open Question 8's follow-up.
11. **Scheduled jobs (`reservation-grace.ts`, `reservation-blackout.ts`)** — both operate
    exclusively on path 2 state (`graceExpiresAt`, the blackout policy) and are deferred
    alongside it. This plan's path-1-only design needs no background job — a scheduled
    booking simply sits `confirmed` until staff act on it (check-in/cancel/no-show), with
    no auto-expiry. Confirm this is acceptable, or specify an auto-expire-if-not-checked-
    in-by-X rule if a lapsed booking should free the station automatically instead of
    staying `confirmed` forever until touched.

---

## After Implementation

Move this plan from `.ai/plans/chrono/active/reservations/` to
`.ai/plans/chrono/archive/reservations/` once all five phases are verified and committed
separately. Update `.ai/handover/chrono-migration.md`'s Plan status table and its Wave 2
addendum to record `reservations` as planned/implemented, mirroring how the `pos` plan's
own landing was recorded there.
