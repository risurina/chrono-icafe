import { pgTable, text, timestamp, boolean, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createId } from "agora";
import { organization } from "agora/db/schema";

/**
 * Persisted inbound provider webhooks — the centralized ingress's audit trail
 * and idempotency ledger (`.ai/plans/chrono/in-progress/centralized-webhook-architecture.md`,
 * Phase 1).
 *
 * PLATFORM-GLOBAL, deliberately NOT tenant-scoped: an inbound webhook's tenant
 * is sometimes unknown until the resolver runs (`scope: "unresolved"`), which
 * forced RLS cannot express (RLS needs `tenant_id` set on the connection
 * *before* a row can even be written). This table therefore has **no RLS** and
 * must **never** appear in `APP_TENANT_TABLES` — same treatment as
 * `chronoBusinessLead` / the foundation's `platformCollectedPayment`.
 *
 * `payloadHash` (sha256 of the raw body) exists for audit/debugging only — the
 * idempotency key is the DB-enforced unique constraint on
 * `(provider, providerEventId)`, not an application-level check. Raw
 * headers/body are deliberately never stored (headers can carry
 * secrets/signing tokens).
 */
export const chronoWebhookEvent = pgTable(
  "ChronoWebhookEvents",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    provider: text("provider").notNull(),
    providerEventId: text("providerEventId").notNull(),
    providerAccountId: text("providerAccountId"),
    scope: text("scope", { enum: ["platform", "tenant", "unresolved"] }).notNull(),
    tenantId: text("tenantId").references(() => organization.id, { onDelete: "cascade" }),
    integrationId: text("integrationId"),
    eventType: text("eventType").notNull(),
    resourceType: text("resourceType"),
    resourceId: text("resourceId"),
    signatureVerified: boolean("signatureVerified").notNull().default(false),
    processingStatus: text("processingStatus", {
      enum: ["received", "processing", "processed", "failed", "needs_resolution", "ignored"],
    })
      .notNull()
      .default("received"),
    attemptCount: integer("attemptCount").notNull().default(0),
    firstReceivedAt: timestamp("firstReceivedAt").notNull().defaultNow(),
    lastReceivedAt: timestamp("lastReceivedAt").notNull().defaultNow(),
    processedAt: timestamp("processedAt"),
    lastError: text("lastError"),
    payloadHash: text("payloadHash").notNull(),
    rawPayloadRef: text("rawPayloadRef"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => ({
    providerEventUq: uniqueIndex("chrono_webhook_event_provider_event_uq").on(
      t.provider,
      t.providerEventId,
    ),
    tenantIdx: index("chrono_webhook_event_tenant_idx").on(t.tenantId),
  }),
);

export type NewChronoWebhookEvent = typeof chronoWebhookEvent.$inferInsert;
export type ChronoWebhookEventRow = typeof chronoWebhookEvent.$inferSelect;
