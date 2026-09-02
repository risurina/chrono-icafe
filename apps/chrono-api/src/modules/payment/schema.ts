import { pgTable, text, timestamp, index, uniqueIndex, numeric, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoSession } from "../session/schema";

export const chronoPayment = pgTable(
  "ChronoPayments",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    memberId: text("memberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    sessionId: text("sessionId").references(() => chronoSession.id, {
      onDelete: "set null",
    }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("PHP"),
    // Free-text, Zod-validated at the contract layer — matches the dominant
    // agora convention (chronoWalletTransaction.type, chronoSalePayment.method).
    method: text("method").notNull(),
    // Two distinct terminal states, not one shared "cancelled" — a
    // cash-drawer/tax reconciliation needs to distinguish a mistaken-entry
    // void from a genuine customer refund.
    status: text("status").notNull().default("pending"), // "pending" | "paid" | "voided" | "refunded"
    providerReference: text("providerReference"),
    paidAt: timestamp("paidAt"),
    expiresAt: timestamp("expiresAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_payment_tenant_idx").on(t.tenantId),
    index("chrono_payment_member_idx").on(t.memberId),
    index("chrono_payment_session_idx").on(t.sessionId),
    index("chrono_payment_status_idx").on(t.status),
  ],
);

export const chronoPaymentEvent = pgTable(
  "ChronoPaymentEvents",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    paymentId: text("paymentId")
      .notNull()
      .references(() => chronoPayment.id, { onDelete: "cascade" }),
    eventType: text("eventType").notNull(), // "received" | "cancelled" | "voided" | "refunded"
    // Forward-provisioning for a future provider-webhook replay — no writer
    // sets this yet (the row-lock + status check in markAsPaid already makes
    // a same-request double-completion impossible on its own). See
    // .ai/plans/chrono/active/payments/README.md, Pass 2.
    idempotencyKey: text("idempotencyKey"),
    payloadJson: jsonb("payloadJson"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_payment_event_tenant_idx").on(t.tenantId),
    index("chrono_payment_event_payment_idx").on(t.paymentId),
    uniqueIndex("chrono_payment_event_idempotency_uq")
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`"idempotencyKey" is not null`),
  ],
);
