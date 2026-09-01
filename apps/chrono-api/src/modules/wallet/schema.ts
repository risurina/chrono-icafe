import { pgTable, text, timestamp, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoWallet = pgTable(
  "ChronoWallets",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // One wallet per tenantMember — enforced by the unique index below.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
    currency: text("currency").notNull().default("PHP"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_wallet_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_wallet_member_uq").on(t.memberId),
  ],
);

export const chronoWalletTransaction = pgTable(
  "ChronoWalletTransactions",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    walletId: text("walletId")
      .notNull()
      .references(() => chronoWallet.id, { onDelete: "cascade" }),
    // Denormalized alongside walletId (mirrors oikos's WalletTransactions.userId) so
    // a member's own transaction history reads without a join.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // Free-text, Zod-validated at the contract layer, not a Postgres enum — matches
    // the dominant agora convention (see branches/members precedent) and avoids the
    // non-idempotent CREATE TYPE migration ceremony for a 3-value field.
    type: text("type").notNull(), // "credit" | "debit" | "adjustment"
    // Signed decimal delta: positive = balance increased, negative = decreased.
    // balanceAfter = balanceBefore + amount, always — this invariant is what makes
    // the ledger self-checking (a corrupted balanceAfter can be caught by replay).
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    balanceBefore: numeric("balanceBefore", { precision: 12, scale: 2 }).notNull(),
    balanceAfter: numeric("balanceAfter", { precision: 12, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    // Free-text categorization of what triggered this row, e.g. "manual_topup" |
    // "manual_debit" | "manual_adjustment" | "session" (future, unenforced today —
    // sessions can start writing this value with zero migration once it lands).
    referenceType: text("referenceType"),
    // Id of the causing entity (e.g. a future sessionId). Deliberately NOT a real FK
    // — it's polymorphic depending on referenceType, and most of its future
    // referents (session) don't exist as tables yet. Mirrors how oikos itself needed
    // several separate nullable FK columns (paymentId, sessionId) for this same
    // "what caused this" concept; a single untyped reference column is the right
    // shape here since Chrono doesn't have those tables yet to FK against.
    referenceId: text("referenceId"),
    // The staff actor who performed a manual mutation. Null for anything triggered
    // without a staff actor (there is none in this pass — every mutation in this
    // plan is staff-initiated — but sessions' future auto-debit will also leave this
    // null, so it's nullable from day one).
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Immutable ledger row — no updatedAt, it is never updated after insert.
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_wallet_transaction_tenant_idx").on(t.tenantId),
    index("chrono_wallet_transaction_wallet_idx").on(t.walletId),
    index("chrono_wallet_transaction_member_idx").on(t.memberId),
    index("chrono_wallet_transaction_type_idx").on(t.type),
    index("chrono_wallet_transaction_created_idx").on(t.createdAt),
  ],
);
