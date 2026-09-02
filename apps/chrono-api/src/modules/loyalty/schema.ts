import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoLoyaltyAccount = pgTable(
  "ChronoLoyaltyAccounts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // One loyalty account per tenantMember — enforced by the unique index below,
    // identical shape to ChronoWallets.memberId.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    pointsBalance: integer("pointsBalance").notNull().default(0),
    // Never decreases on redemption — the tier is computed off lifetime earnings,
    // not current balance, so redeeming points never demotes a customer's tier.
    // (oikos has no lifetime/tier persistence at all — see Pass 2's diverges list.)
    lifetimePoints: integer("lifetimePoints").notNull().default(0),
    // "bronze" | "silver" | "gold" | "platinum" — recomputed from lifetimePoints on
    // every earn inside the same transaction (service.ts), never client-set.
    tier: text("tier").notNull().default("bronze"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_loyalty_account_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_loyalty_account_member_uq").on(t.memberId),
    index("chrono_loyalty_account_tier_idx").on(t.tier),
  ],
);

export const chronoLoyaltyTransaction = pgTable(
  "ChronoLoyaltyTransactions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    accountId: text("accountId")
      .notNull()
      .references(() => chronoLoyaltyAccount.id, { onDelete: "cascade" }),
    // Denormalized alongside accountId (mirrors ChronoWalletTransactions.memberId)
    // so a member's history reads without a join.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // "earn" | "redeem" | "adjustment"
    // Signed delta: positive = balance increased, negative = decreased.
    points: integer("points").notNull(),
    balanceBefore: integer("balanceBefore").notNull(),
    balanceAfter: integer("balanceAfter").notNull(),
    reason: text("reason").notNull(),
    // "wallet_transaction" | "pos_sale" | "manual" — set once Phase 4 wires the
    // auto-earn hooks; "manual" for every row this plan's own Phase 3 can produce.
    referenceType: text("referenceType"),
    // Polymorphic, deliberately not a real FK — the identical reasoning
    // ChronoWalletTransactions.referenceId already uses (the referent's table
    // varies by referenceType and some of them, e.g. a future pos sale id, are
    // typed elsewhere already).
    referenceId: text("referenceId"),
    // Null for an automatic earn (no staff actor). Non-null for every manual
    // earn/redeem/adjustment this plan's Phase 3 routes produce.
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Immutable ledger row — no updatedAt, mirrors ChronoWalletTransactions exactly.
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_loyalty_transaction_tenant_idx").on(t.tenantId),
    index("chrono_loyalty_transaction_account_idx").on(t.accountId),
    index("chrono_loyalty_transaction_member_idx").on(t.memberId),
    index("chrono_loyalty_transaction_type_idx").on(t.type),
    index("chrono_loyalty_transaction_created_idx").on(t.createdAt),
  ],
);

export type NewChronoLoyaltyAccount = typeof chronoLoyaltyAccount.$inferInsert;
export type ChronoLoyaltyAccountRow = typeof chronoLoyaltyAccount.$inferSelect;
export type NewChronoLoyaltyTransaction = typeof chronoLoyaltyTransaction.$inferInsert;
export type ChronoLoyaltyTransactionRow = typeof chronoLoyaltyTransaction.$inferSelect;
