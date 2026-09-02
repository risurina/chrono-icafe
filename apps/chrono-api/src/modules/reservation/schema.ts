import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
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
    // state — path 2, deferred, see reservations plan's Critical scope
    // finding); no EXPIRED (oikos's grace-lapse outcome — also path 2/the
    // grace job, deferred); adds "completed" and "no_show" (oikos's path 1
    // never modeled either). This plan's status set is the informed superset
    // path 1 actually needs for the staff workflow, not a port of the enum.
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
  ],
);

export type NewChronoReservation = typeof chronoReservation.$inferInsert;
export type ChronoReservationRow = typeof chronoReservation.$inferSelect;
