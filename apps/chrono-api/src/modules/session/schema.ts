import { pgTable, text, timestamp, integer, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation, chronoStationGroup } from "../station/schema";
import { chronoWalletTransaction } from "../wallet/schema";

export const chronoSession = pgTable(
  "ChronoSessions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Denormalized from the station at start, for query/filter convenience —
    // mirrors oikos's own DeviceSessions.branchId. Immutable after start.
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // restrict, not cascade: a station with ANY session history (even ended)
    // must not be deletable out from under its own billing records. See Open
    // Question 4 — stations' own DELETE route needs a follow-up to catch this.
    stationId: text("stationId")
      .notNull()
      .references(() => chronoStation.id, { onDelete: "restrict" }),
    // cascade: matches wallet's own ChronoWalletTransactions choice — deleting
    // a customer (DSAR) also removes their session history, the same
    // trade-off wallet already accepted for financial ledger rows.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    startedByUserId: text("startedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"), // "active" | "paused" | "ended"
    startedAt: timestamp("startedAt").notNull().defaultNow(),
    // Null = open-ended, closed only by an explicit end (never touched by the
    // expiry sweep).
    scheduledEndAt: timestamp("scheduledEndAt"),
    pausedAt: timestamp("pausedAt"),
    pausedDurationSeconds: integer("pausedDurationSeconds").notNull().default(0),
    endedAt: timestamp("endedAt"),
    actualBillableSeconds: integer("actualBillableSeconds"),
    // Frozen at start — immune to a later edit of the group's rate.
    rateSnapshot: numeric("rateSnapshot", { precision: 12, scale: 2 }).notNull(),
    rateSource: text("rateSource").notNull(), // "group_hourly" | "group_member"
    currency: text("currency").notNull().default("PHP"),
    // Snapshot of the station's pricing group at start (mirrors rateSnapshot/
    // rateSource/branchId's own freeze-at-start precedent) — scopes which
    // ChronoCreditGrants are eligible to pay for THIS session at close, immune
    // to a later station/group reassignment mid-session. Nullable only
    // because rows created before this column existed have none; a null value
    // just means a strict_group_only lot won't be drawn from for that
    // pre-migration session (any_station lots are unaffected).
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    // Minutes drawn from the member's ChronoCreditGrants at close, consumed
    // BEFORE any money is billed (credit-session-billing plan). finalAmount/
    // amountCharged below price only the remaining time NOT covered by
    // credits — they are no longer "full cost of the whole session" once
    // credits are in play, only "cost of the money-billed portion."
    creditMinutesConsumed: integer("creditMinutesConsumed").notNull().default(0),
    finalAmount: numeric("finalAmount", { precision: 12, scale: 2 }),
    amountCharged: numeric("amountCharged", { precision: 12, scale: 2 }),
    walletTransactionId: text("walletTransactionId").references(
      () => chronoWalletTransaction.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_session_tenant_idx").on(t.tenantId),
    index("chrono_session_branch_idx").on(t.branchId),
    index("chrono_session_station_idx").on(t.stationId),
    index("chrono_session_member_idx").on(t.memberId),
    index("chrono_session_status_idx").on(t.status),
    index("chrono_session_scheduled_end_idx").on(t.scheduledEndAt),
    // One non-ended session per station at the DB level — mirrors oikos's own
    // partial unique index, extended to cover PAUSED (a paused session still
    // owns its station; oikos's own station.status already read "occupied"
    // through a pause too).
    uniqueIndex("chrono_session_active_per_station_uq")
      .on(t.tenantId, t.stationId)
      .where(sql`${t.status} in ('active','paused')`),
  ],
);

export type NewChronoSession = typeof chronoSession.$inferInsert;
export type ChronoSessionRow = typeof chronoSession.$inferSelect;
