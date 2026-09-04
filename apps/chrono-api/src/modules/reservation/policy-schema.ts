import { pgTable, text, timestamp, boolean, integer, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";

/**
 * Per-tenant/per-branch reservation policy. Resolution order at read time
 * (resolveReservationPolicy): a branch row (if one exists) is used IN FULL;
 * otherwise the tenant-default row (branchId IS NULL) is used in full;
 * otherwise the hardcoded defaults below apply. Whole-row override, not
 * per-field — a branch either fully overrides all fields or uses the tenant
 * default in full.
 *
 * Existing tenants: no row for a tenant/branch = hardcoded defaults apply
 * exactly (the resolver returns code defaults when neither row exists) — zero
 * migration/backfill needed.
 */
export const chronoReservationPolicy = pgTable(
  "ChronoReservationPolicies",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // NULL branchId = tenant-wide default row. Non-null = a specific branch's override.
    branchId: text("branchId").references(() => chronoBranch.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    reservationAdvanceWindowMinutes: integer("reservationAdvanceWindowMinutes")
      .notNull()
      .default(60),
    maxActiveReservationsPerMember: integer("maxActiveReservationsPerMember")
      .notNull()
      .default(1),
    lateCancellationWindowMinutes: integer("lateCancellationWindowMinutes")
      .notNull()
      .default(30),
    cancellationFeeEnabled: boolean("cancellationFeeEnabled").notNull().default(true),
    cancellationFeeAmount: numeric("cancellationFeeAmount", { precision: 12, scale: 2 })
      .notNull()
      .default("20"),
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
    // Postgres unique treats NULL as distinct per-row, so the index above does NOT
    // enforce "only one tenant-default row" by itself — this partial index does.
    uniqueIndex("chrono_reservation_policy_one_default_uq")
      .on(t.tenantId)
      .where(sql`${t.branchId} is null`),
  ],
);

export type NewChronoReservationPolicy = typeof chronoReservationPolicy.$inferInsert;
export type ChronoReservationPolicyRow = typeof chronoReservationPolicy.$inferSelect;
