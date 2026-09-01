import { pgTable, text, timestamp, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";

export const chronoShift = pgTable(
  "ChronoShifts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // The Better Auth foundation user who worked this shift — NEVER a
    // tenantMember id. `onDelete: "restrict"` (not "cascade"/"set null"): a
    // shift's cash-accountability history must not silently disappear or
    // orphan if a staff account is later deleted.
    staffUserId: text("staffUserId")
      .notNull()
      .references(() => base.user.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("open"), // "open" | "closed"
    openingCashAmount: numeric("openingCashAmount", { precision: 12, scale: 2 }).notNull(),
    openedAt: timestamp("openedAt").notNull().defaultNow(),
    closedAt: timestamp("closedAt"),
    actualCashAmount: numeric("actualCashAmount", { precision: 12, scale: 2 }),
    // Populated by a future pos/reconciliation module once Payment rows exist
    // to sum — always null in this pass. See the shifts plan's Open Question 2.
    expectedCashAmount: numeric("expectedCashAmount", { precision: 12, scale: 2 }),
    differenceAmount: numeric("differenceAmount", { precision: 12, scale: 2 }),
    openNotes: text("openNotes"),
    closeNotes: text("closeNotes"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_shift_tenant_idx").on(t.tenantId),
    index("chrono_shift_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_shift_staff_idx").on(t.staffUserId),
    index("chrono_shift_status_idx").on(t.status),
    // DB-level backstop for the "already have an open shift in this branch"
    // rule — the app-level check in the open route is the primary guard;
    // this partial unique index closes the race window between two rapid
    // double-submits (a correctness guarantee the oikos app-only check
    // didn't have), mirroring branch's own "composite unique index, not
    // just an RLS/app-level guarantee" reasoning.
    uniqueIndex("chrono_shift_one_open_per_staff_idx")
      .on(t.tenantId, t.branchId, t.staffUserId)
      .where(sql`"status" = 'open'`),
  ],
);

export type NewChronoShift = typeof chronoShift.$inferInsert;
export type ChronoShiftRow = typeof chronoShift.$inferSelect;
