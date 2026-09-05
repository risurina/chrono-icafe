import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoStationGroup } from "../station/schema";
import { chronoWalletTransaction } from "../wallet/schema";

// ---- ChronoCreditProducts — the sellable pack definition -------------------

export const chronoCreditProduct = pgTable(
  "ChronoCreditProducts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    // "draft" | "active" | "archived" — free-text, not a pg enum, matching
    // every prior Chrono plan's convention (see branches' own precedent).
    status: text("status").notNull().default("draft"),
    // Reserved for future PHP/POINT support (oikos's CreditUnit); this pass's
    // Zod contract restricts it to "minute" only — see "Minutes are integers".
    unit: text("unit").notNull().default("minute"),
    quantityMinutes: integer("quantityMinutes").notNull(),
    priceAmount: numeric("priceAmount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("PHP"),
    // Null = spendable at any station (creditPolicy "any_station"). Required
    // when creditPolicy is "strict_group_only" — enforced at the Zod layer
    // (see Contracts), matching this codebase's existing convention of
    // cross-field invariants living in the route/service layer, not a DB
    // CHECK constraint (same choice `stations`' branch/code uniqueness and
    // `wallet`'s balance-non-negative invariant both made).
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    // "strict_group_only" | "any_station" — "convert_by_value" is reserved,
    // not yet implemented (see "Deliberately narrowed").
    creditPolicy: text("creditPolicy").notNull().default("any_station"),
    // Days after issue a lot from this product expires; null = never expires.
    validityDays: integer("validityDays"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_product_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_credit_product_tenant_code_idx").on(t.tenantId, t.code),
  ],
);

// ---- ChronoCreditGrants — the actual lot (the balance) ----------------------

export const chronoCreditGrant = pgTable(
  "ChronoCreditGrants",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // Null for a manual admin grant (no purchase). Set null (not restrict) if
    // the product is later archived — a lot outlives its product definition.
    productId: text("productId").references(() => chronoCreditProduct.id, {
      onDelete: "set null",
    }),
    // Copied from the product at issue time — a snapshot, immune to a later
    // product edit, matching sessions' own "rate frozen at start" precedent.
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    creditPolicy: text("creditPolicy").notNull().default("any_station"),
    unit: text("unit").notNull().default("minute"),
    originalQuantity: integer("originalQuantity").notNull(),
    remainingQuantity: integer("remainingQuantity").notNull(),
    // Lower = spent first among equally-eligible lots. Default matches
    // oikos's own default.
    priority: integer("priority").notNull().default(100),
    expiresAt: timestamp("expiresAt"),
    // "granted" | "depleted" | "expired" | "voided" — trimmed from oikos's
    // six-value enum; "pending"/"refunded" were never produced anywhere in
    // oikos's own service code (see "Known oikos weaknesses").
    status: text("status").notNull().default("granted"),
    // Populated only for a manual grant/adjustment — why this lot exists
    // outside a purchase.
    reason: text("reason"),
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_grant_tenant_idx").on(t.tenantId),
    index("chrono_credit_grant_member_idx").on(t.memberId),
    index("chrono_credit_grant_station_group_idx").on(t.stationGroupId),
    index("chrono_credit_grant_status_idx").on(t.status),
    index("chrono_credit_grant_expires_idx").on(t.expiresAt),
  ],
);

// ---- ChronoCreditPurchases — one row per sale -------------------------------

export const chronoCreditPurchase = pgTable(
  "ChronoCreditPurchases",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // restrict: a purchase record must always show what it bought — a
    // product is archived, never deleted, in this pass anyway (no DELETE
    // route on ChronoCreditProducts), so this is a defensive floor, not a
    // live concern.
    productId: text("productId")
      .notNull()
      .references(() => chronoCreditProduct.id, { onDelete: "restrict" }),
    // The lot this purchase produced. Populated at insert time — the grant
    // row is always created FIRST inside the same transaction, so this is
    // never circular (see "Avoiding the circular FK" below). set null rather
    // than restrict/cascade: the purchase record survives even if the grant
    // it produced is later hard-deleted by some future maintenance path
    // (none exists today — defensive only).
    grantId: text("grantId").references(() => chronoCreditGrant.id, {
      onDelete: "set null",
    }),
    // Snapshots — immutable even if the product is edited afterward.
    quantityMinutes: integer("quantityMinutes").notNull(),
    priceAmount: numeric("priceAmount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("PHP"),
    // "completed" | "voided" — trimmed from oikos's five-value enum; this
    // pass has no PENDING/PAID intermediate state (a sale completes
    // atomically with its wallet debit, matching wallet's own "no retried-
    // external-request problem yet" reasoning for skipping an idempotency
    // key — there is no async payment step here to be pending about).
    status: text("status").notNull().default("completed"),
    walletTransactionId: text("walletTransactionId").references(
      () => chronoWalletTransaction.id,
      { onDelete: "set null" },
    ),
    voidedAt: timestamp("voidedAt"),
    voidedByUserId: text("voidedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Client-supplied `Idempotency-Key` header on `POST /portal/credits/purchase`
    // (member-wallet-operation-hardening plan) — a double-click or a retry of
    // a timed-out-but-succeeded request replays the same key and gets this
    // row back unchanged instead of a second debit. Null for every purchase
    // made without the header (unprotected, matches Stripe's own opt-in
    // convention) and for staff-initiated grants (no member header at all).
    idempotencyKey: text("idempotencyKey"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_purchase_tenant_idx").on(t.tenantId),
    index("chrono_credit_purchase_member_idx").on(t.memberId),
    index("chrono_credit_purchase_product_idx").on(t.productId),
    index("chrono_credit_purchase_status_idx").on(t.status),
    uniqueIndex("chrono_credit_purchase_idempotency_uq")
      .on(t.tenantId, t.memberId, t.idempotencyKey)
      .where(sql`"idempotencyKey" is not null`),
  ],
);

// ---- ChronoCreditGrantLedgerEntries — immutable audit trail -----------------

export const chronoCreditGrantLedgerEntry = pgTable(
  "ChronoCreditGrantLedgerEntries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    grantId: text("grantId")
      .notNull()
      .references(() => chronoCreditGrant.id, { onDelete: "cascade" }),
    // Denormalized alongside grantId (mirrors wallet's own
    // ChronoWalletTransactions.memberId denormalization) so a member's own
    // ledger reads without a join through every grant.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    // "granted" | "consumed" | "expired" | "voided" | "adjusted" — trimmed
    // from oikos's seven-value enum; "reversed" was never produced anywhere
    // in oikos's own service code (see "Known oikos weaknesses").
    type: text("type").notNull(),
    // Signed: positive = balance increased (granted/restored), negative =
    // decreased (consumed/expired/voided/adjusted-down). This invariant —
    // quantityAfter = quantityBefore + quantityDelta, always — is what makes
    // the ledger self-checking, same principle wallet's own ledger uses.
    quantityDelta: integer("quantityDelta").notNull(),
    quantityBefore: integer("quantityBefore").notNull(),
    quantityAfter: integer("quantityAfter").notNull(),
    reason: text("reason"),
    // Free-text categorization of what caused this entry: "purchase" |
    // "manual" | "session" (future, unenforced today — the deferred
    // sessions amendment can start writing this value with zero migration).
    referenceType: text("referenceType"),
    referenceId: text("referenceId"),
    performedByUserId: text("performedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    // Immutable — no updatedAt, never updated after insert.
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_credit_ledger_tenant_idx").on(t.tenantId),
    index("chrono_credit_ledger_grant_idx").on(t.grantId),
    index("chrono_credit_ledger_member_idx").on(t.memberId),
    index("chrono_credit_ledger_type_idx").on(t.type),
    index("chrono_credit_ledger_created_idx").on(t.createdAt),
  ],
);
