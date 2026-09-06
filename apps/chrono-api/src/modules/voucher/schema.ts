import { pgTable, text, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoSale } from "../pos/schema";
import { chronoPromo } from "../promo/schema";

export const chronoVoucher = pgTable(
  "ChronoVouchers",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Nullable — set only when this voucher was minted as part of a promos
    // campaign (see the sibling `promos` plan). A staff-issued one-off gift
    // voucher has no promo behind it. restrict: a promo's issued vouchers
    // must survive even if the campaign is later archived (mirrors
    // ChronoPromoRedemptions.promoId's own restrict reasoning).
    promoId: text("promoId").references(() => chronoPromo.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    // "percentage" | "fixed_amount" — see the vouchers plan's "diverges from
    // oikos" #2.
    discountType: text("discountType").notNull(),
    discountValue: numeric("discountValue", { precision: 12, scale: 2 }).notNull(),
    // Nullable — a customer-locked voucher (issued to a specific member) vs a
    // generic redeemable-by-anyone code. See the plan's "diverges from
    // oikos" #3 for why this must be representable independent of promoId.
    memberId: text("memberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // "active" | "redeemed" | "cancelled" — deliberately no stored "expired"
    // state (see the plan's "diverges from oikos" #5's naming fix plus this:
    // expiry is computed from expiresAt at validation time, not a status a
    // sweep job has to keep in sync).
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expiresAt"),
    redeemedAt: timestamp("redeemedAt"),
    // Real FK — chronoSale already exists on disk, unlike wallet's own
    // forward-reference TODO in pos/schema.ts. Traceability of what a
    // voucher was redeemed against, so a refund can look up and reverse the
    // exact voucher it consumed (Phase 4).
    redeemedAgainstSaleId: text("redeemedAgainstSaleId").references(() => chronoSale.id, {
      onDelete: "set null",
    }),
    cancelledAt: timestamp("cancelledAt"),
    cancelReason: text("cancelReason"),
    issuedByUserId: text("issuedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_voucher_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_voucher_tenant_code_uq").on(t.tenantId, t.code),
    index("chrono_voucher_member_idx").on(t.memberId),
    index("chrono_voucher_promo_idx").on(t.promoId),
    index("chrono_voucher_status_idx").on(t.status),
  ],
);

export type NewChronoVoucher = typeof chronoVoucher.$inferInsert;
export type ChronoVoucherRow = typeof chronoVoucher.$inferSelect;
