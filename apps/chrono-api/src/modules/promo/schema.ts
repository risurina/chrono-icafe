import { pgTable, text, integer, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoSale } from "../pos/schema";

export const chronoPromo = pgTable(
  "ChronoPromos",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Nullable — tenant-wide when unset, matching branch's own optional-scope
    // precedent elsewhere in this codebase.
    branchId: text("branchId").references(() => chronoBranch.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    // Nullable — present means "coupon mode" (a customer/staff must enter it
    // at checkout); absent means "auto-apply mode" (checkout finds and
    // applies the best matching active promo with no code). See the promos
    // plan's "diverges from oikos" #6. Unique per tenant only when set — see
    // the partial unique index below.
    code: text("code"),
    description: text("description"),
    // "active" | "paused" | "archived" — no stored "expired"; see the promos
    // plan's "diverges from oikos" #5. A promo past its endsAt is treated as
    // inactive at validation time regardless of this column's value.
    status: text("status").notNull().default("active"),
    discountType: text("discountType").notNull(), // "percentage" | "fixed_amount"
    discountValue: numeric("discountValue", { precision: 12, scale: 2 }).notNull(),
    minSpend: numeric("minSpend", { precision: 12, scale: 2 }),
    // Nullable — "active immediately" when unset.
    startsAt: timestamp("startsAt"),
    // NOT nullable — a promo is, by this task's own framing, "time-bounded."
    // Forcing a real end date is a deliberate improvement over oikos's fully
    // optional expiresAt (see the promos plan's "diverges from oikos" #2: an
    // unenforced, sometimes-absent expiry is how a promo silently runs
    // forever).
    endsAt: timestamp("endsAt").notNull(),
    maxRedemptions: integer("maxRedemptions"),
    maxRedemptionsPerMember: integer("maxRedemptionsPerMember").default(1),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_promo_tenant_idx").on(t.tenantId),
    // Partial unique index — only enforces uniqueness among rows that
    // actually have a code (auto-apply promos with code: null never
    // collide with each other). Mirrors shifts' own partial-unique-index
    // convention (`.where(sql...)`).
    uniqueIndex("chrono_promo_tenant_code_uq")
      .on(t.tenantId, t.code)
      .where(sql`"code" IS NOT NULL`),
    index("chrono_promo_status_idx").on(t.status),
    index("chrono_promo_branch_idx").on(t.branchId),
    index("chrono_promo_window_idx").on(t.startsAt, t.endsAt),
  ],
);

export const chronoPromoRedemption = pgTable(
  "ChronoPromoRedemptions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // restrict, not cascade — a promo's usage history must survive even if
    // the campaign is later archived (archived, not hard-deleted, is the
    // only lifecycle end-state a promo has in this plan — see Routes).
    promoId: text("promoId")
      .notNull()
      .references(() => chronoPromo.id, { onDelete: "restrict" }),
    memberId: text("memberId").references(() => base.tenantMember.id, { onDelete: "set null" }),
    // set null: a sale is never hard-deleted in this codebase's convention,
    // but this stays defensive rather than assuming that forever.
    saleId: text("saleId").references(() => chronoSale.id, { onDelete: "set null" }),
    // Snapshot of the amount actually discounted on that sale — immutable,
    // same "snapshot at time of action" principle as pos's ChronoSaleItem
    // name/sku/unitPrice columns.
    discountAmount: numeric("discountAmount", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_promo_redemption_tenant_idx").on(t.tenantId),
    index("chrono_promo_redemption_promo_idx").on(t.promoId),
    index("chrono_promo_redemption_member_idx").on(t.memberId),
  ],
);

export type NewChronoPromo = typeof chronoPromo.$inferInsert;
export type ChronoPromoRow = typeof chronoPromo.$inferSelect;
export type NewChronoPromoRedemption = typeof chronoPromoRedemption.$inferInsert;
export type ChronoPromoRedemptionRow = typeof chronoPromoRedemption.$inferSelect;
