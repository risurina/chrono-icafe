import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoReservation } from "./schema";

/**
 * Immutable ban/failure history for the member self-service reservation flow —
 * the audit source of truth (never chronoReservation.status alone). Branch-scoped:
 * a ban earned at branch A must not silently block branch B, matching the
 * per-branch reservation policy surface.
 *
 * "Active" for a ban = type IN ('reservation_ban','queue_ban') AND
 * expiresAt IS NOT NULL AND expiresAt > now() AND liftedAt IS NULL — computed at
 * query time, never a stored boolean.
 */
export const chronoMemberReservationRestriction = pgTable(
  "ChronoMemberReservationRestrictions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // "reservation_ban" | "queue_ban" | "queue_failure"
    // "queue_failure" is a pure history record (not a ban) for a single missed
    // queue hold — assertNotBanned filters type IN ('reservation_ban','queue_ban')
    // only, never 'queue_failure'. Recording failures separately from bans lets
    // queueFailureLimit > 1 work: failure #1 and #2 don't block the member,
    // only the queue_ban row inserted once the limit is reached does.
    type: text("type").notNull(),
    // "queue_hold_expired" | "late_cancellation" | "no_show" |
    // "scheduled_time_cancellation" | "admin_manual" | "queue_failure_limit"
    reason: text("reason").notNull(),
    reservationId: text("reservationId").references(() => chronoReservation.id, {
      onDelete: "set null",
    }),
    stationId: text("stationId").references(() => chronoStation.id, { onDelete: "set null" }),
    startsAt: timestamp("startsAt").notNull().defaultNow(),
    // Nullable — a "queue_failure" row has no expiry of its own (only the
    // failure COUNT matters); a ban row always sets this.
    expiresAt: timestamp("expiresAt"),
    // Staff lift path (never a delete — history stays immutable).
    liftedAt: timestamp("liftedAt"),
    liftedByUserId: text("liftedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    metadataJson: jsonb("metadataJson").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_reservation_restriction_tenant_idx").on(t.tenantId),
    index("chrono_reservation_restriction_member_idx").on(t.tenantId, t.memberId),
    // Branch-scoped: assertNotBanned and the queue-failure counter both query
    // this exact column order.
    index("chrono_reservation_restriction_active_idx").on(
      t.tenantId,
      t.memberId,
      t.branchId,
      t.type,
      t.expiresAt,
    ),
    // Dedupe backstop for duplicate sweep runs — insert and swallow the 23505
    // conflict rather than pre-checking with a SELECT. `type` is included so a
    // threshold ban (queue_ban) never collides with the queue_failure row that
    // triggered it (they share a reservationId but have distinct reason+type).
    uniqueIndex("chrono_reservation_restriction_no_dup_uq")
      .on(t.tenantId, t.reservationId, t.reason, t.type)
      .where(sql`${t.reservationId} is not null`),
  ],
);

export type NewChronoMemberReservationRestriction =
  typeof chronoMemberReservationRestriction.$inferInsert;
export type ChronoMemberReservationRestrictionRow =
  typeof chronoMemberReservationRestriction.$inferSelect;
