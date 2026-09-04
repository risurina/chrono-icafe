import { pgTable, text, timestamp, boolean, integer, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoSession } from "../session/schema";

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
    // Nullable (reservations-queue-and-self-service plan) — a queue entry
    // (fromQueue: true, status: "pending") has no scheduled window until it is
    // promoted, at which point promoteNextInQueue sets both concrete. Enforced by
    // the hand-written CHECK constraint in the migration (Drizzle has no CHECK
    // constraint API), not by the type system.
    startAt: timestamp("startAt"),
    endAt: timestamp("endAt"),
    status: text("status").notNull().default("confirmed"),
    // "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show" |
    // "pending" | "hold" | "cancelled_late" | "queue_expired"
    // Deliberate divergence from oikos's ReservationStatusEnum (pgEnum:
    // PENDING/CONFIRMED/CANCELLED/CHECKED_IN/EXPIRED): free-text, not a pg
    // enum (matches every other Chrono module's convention, sidesteps
    // non-idempotent CREATE TYPE ceremony). "pending"/"hold"/"cancelled_late"/
    // "queue_expired" were added by the reservations-queue-and-self-service plan
    // — see that plan for the full state machine.
    notes: text("notes"),
    // Who took the booking (staff-created, path 1). Nullable (was NOT NULL) —
    // a member-portal self-service row (this plan) has no staff user.id; the
    // actor is a tenantMember instead. Invariant: every row has EITHER
    // createdByUserId (staff-created) OR memberId (member self-service) — never
    // neither. Mirrors the existing nullable ChronoSessions.startedByUserId
    // precedent (the QR flow already passes null there).
    createdByUserId: text("createdByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    checkedInAt: timestamp("checkedInAt"),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: text("cancelReason"),
    noShowAt: timestamp("noShowAt"),
    // --- reservations-queue-and-self-service additions below ---
    fromQueue: boolean("fromQueue").notNull().default(false),
    // Captured at queue-join time (a queue entry has no startAt yet to derive a
    // duration from). NULL for a Flow-1 direct reservation. Required whenever
    // fromQueue=true — enforced by the CHECK constraint in the migration.
    requestedDurationMinutes: integer("requestedDurationMinutes"),
    holdExpiresAt: timestamp("holdExpiresAt"),
    claimedAt: timestamp("claimedAt"), // set when the QR-scan claim consumes the hold
    sessionId: text("sessionId").references(() => chronoSession.id, { onDelete: "set null" }),
    // Snapshot of the fee actually applied at cancel time (policy may change
    // later; this row must keep what was charged).
    cancelledLateFeeAmount: numeric("cancelledLateFeeAmount", { precision: 12, scale: 2 }),
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
    // Real double-booking guarantee (audit-remediation Phase 2 — the
    // `SELECT ... FOR UPDATE` pre-check in routes.ts's assertNoOverlap cannot
    // serialize against a row that does not exist yet, so it is a
    // fail-fast optimization only, not the guarantee). Drizzle has no
    // first-class EXCLUDE constraint API, so this is hand-written directly
    // in the generated migration SQL (see the migration file for the actual
    // `CREATE EXTENSION IF NOT EXISTS btree_gist;` + `ADD CONSTRAINT ...
    // EXCLUDE USING gist (...)` statements) — this comment exists so the
    // constraint is documented at the table definition, not just buried in a
    // migration file, even though Drizzle cannot express or track it here.
    // reservations-queue-and-self-service plan rewrote this constraint's WHERE
    // to also cover "hold" (a live, station-locking claim window) and to
    // require startAt IS NOT NULL (Postgres treats tsrange(NULL,NULL) as an
    // UNBOUNDED range, not "no range" — omitting that guard would let a
    // NULL-windowed row block every other booking on the station).
    //
    // One active reservation/queue-entry per MEMBER-ORIGINATED row — scoped to
    // createdByUserId IS NULL so a staff booking made on a member's behalf
    // (path 1, memberId optional) never collides with this cap; a front-desk
    // clerk taking a second phone booking for the same regular member at a
    // different time must keep working exactly as it does today.
    uniqueIndex("chrono_reservation_one_active_per_member_uq")
      .on(t.tenantId, t.memberId)
      .where(
        sql`status in ('confirmed','hold','checked_in','pending') and "memberId" is not null and "createdByUserId" is null`,
      ),
  ],
);

export type NewChronoReservation = typeof chronoReservation.$inferInsert;
export type ChronoReservationRow = typeof chronoReservation.$inferSelect;
