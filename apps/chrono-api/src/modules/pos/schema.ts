import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoShift } from "../shift/schema";

export const chronoProduct = pgTable(
  "ChronoProducts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Auto-generated from name if omitted, mirrors branch's `code` generator.
    sku: text("sku").notNull(),
    // Free-text, Zod-validated at the contract layer — "snack" | "drink" |
    // "peripheral" | "other" — not a pg enum, matching every prior Chrono
    // plan's convention.
    category: text("category").notNull().default("other"),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    status: text("status").notNull().default("active"), // "active" | "disabled"
    // Stock tracking is opt-in per product (a peripheral you have 3 of; a
    // fountain drink you never count). When false, stockQuantity is
    // meaningless and never checked/decremented.
    trackStock: boolean("trackStock").notNull().default(false),
    stockQuantity: integer("stockQuantity").notNull().default(0),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_product_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_product_tenant_sku_idx").on(t.tenantId, t.sku),
    index("chrono_product_status_idx").on(t.status),
  ],
);

export const chronoSale = pgTable(
  "ChronoSales",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // Set only when at least one CASH tender is present on the sale — null
    // for an all-card/all-wallet sale, exactly mirroring oikos's own
    // Payment.shiftId semantics (see "Shift linkage" in the plan).
    shiftId: text("shiftId").references(() => chronoShift.id, { onDelete: "set null" }),
    // Nullable — a walk-in sale. See "Walk-ins are genuinely nullable" in the plan.
    memberId: text("memberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // Freeform label for a walk-in's receipt when memberId is null. Ignored
    // when memberId is set (the member's own name is used instead).
    customerName: text("customerName"),
    // Who rang the sale up. restrict, not cascade/set null: a sale's history
    // must survive even if the staff account is later deleted — identical
    // reasoning to ChronoShifts.staffUserId.
    cashierUserId: text("cashierUserId")
      .notNull()
      .references(() => base.user.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("completed"), // "completed" | "refunded"
    totalAmount: numeric("totalAmount", { precision: 12, scale: 2 }).notNull(),
    amountTendered: numeric("amountTendered", { precision: 12, scale: 2 }).notNull(),
    changeAmount: numeric("changeAmount", { precision: 12, scale: 2 }).notNull(),
    // Client-generated, required — the double-submit guard (see Contracts).
    idempotencyKey: text("idempotencyKey").notNull(),
    refundedAt: timestamp("refundedAt"),
    refundedByUserId: text("refundedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    refundReason: text("refundReason"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_sale_tenant_idx").on(t.tenantId),
    index("chrono_sale_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_sale_shift_idx").on(t.shiftId),
    index("chrono_sale_member_idx").on(t.memberId),
    index("chrono_sale_status_idx").on(t.status),
    index("chrono_sale_created_idx").on(t.createdAt),
    uniqueIndex("chrono_sale_tenant_idempotency_idx").on(t.tenantId, t.idempotencyKey),
  ],
);

export const chronoSaleItem = pgTable(
  "ChronoSaleItems",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    saleId: text("saleId")
      .notNull()
      .references(() => chronoSale.id, { onDelete: "cascade" }),
    // Null for an ad-hoc misc line (no catalog entry). restrict when set: a
    // sale's line-item history must always show what it sold — mirrors
    // credits' own ChronoCreditPurchases.productId restrict reasoning.
    productId: text("productId").references(() => chronoProduct.id, { onDelete: "restrict" }),
    // Snapshots — immutable even if the product is later renamed/repriced,
    // same principle as every other module's "snapshot at time of action"
    // columns (credits' grant fields, wallet's balanceBefore/After).
    name: text("name").notNull(),
    sku: text("sku"),
    unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull(),
    lineTotal: numeric("lineTotal", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_sale_item_tenant_idx").on(t.tenantId),
    index("chrono_sale_item_sale_idx").on(t.saleId),
    index("chrono_sale_item_product_idx").on(t.productId),
  ],
);

export const chronoSalePayment = pgTable(
  "ChronoSalePayments",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    saleId: text("saleId")
      .notNull()
      .references(() => chronoSale.id, { onDelete: "cascade" }),
    method: text("method").notNull(), // "cash" | "card" | "wallet"
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    // Card-terminal reference, if the cashier records one. Never processed
    // by this system — no payment-gateway integration in this pass.
    referenceNumber: text("referenceNumber"),
    // Set only for method: "wallet" — the ledger row debitWallet() produced,
    // so a refund can be traced back to the exact wallet mutation it
    // reverses. Bare text, no FK yet — apps/chrono-api/src/modules/wallet/schema.ts
    // does not exist on disk as of this writing (wallet's Phase 1 hasn't
    // landed). set null (not restrict) is the intended semantics once the FK
    // is added: the sale-payment record must survive even if the wallet
    // transaction row it points at is ever hard-deleted.
    // TODO: FK once wallet/schema.ts lands — .references(() => chronoWalletTransaction.id, { onDelete: "set null" })
    walletTransactionId: text("walletTransactionId"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_sale_payment_tenant_idx").on(t.tenantId),
    index("chrono_sale_payment_sale_idx").on(t.saleId),
    index("chrono_sale_payment_method_idx").on(t.method),
  ],
);

export type NewChronoProduct = typeof chronoProduct.$inferInsert;
export type ChronoProductRow = typeof chronoProduct.$inferSelect;
export type NewChronoSale = typeof chronoSale.$inferInsert;
export type ChronoSaleRow = typeof chronoSale.$inferSelect;
export type NewChronoSaleItem = typeof chronoSaleItem.$inferInsert;
export type ChronoSaleItemRow = typeof chronoSaleItem.$inferSelect;
export type NewChronoSalePayment = typeof chronoSalePayment.$inferInsert;
export type ChronoSalePaymentRow = typeof chronoSalePayment.$inferSelect;
