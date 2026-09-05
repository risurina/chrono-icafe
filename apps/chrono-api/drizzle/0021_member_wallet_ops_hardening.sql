ALTER TABLE "ChronoCreditPurchases" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD COLUMN "checkoutUrl" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_credit_purchase_idempotency_uq" ON "ChronoCreditPurchases" USING btree ("tenantId","memberId","idempotencyKey") WHERE "idempotencyKey" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_payment_client_idempotency_uq" ON "ChronoPayments" USING btree ("tenantId","memberId","idempotencyKey") WHERE "idempotencyKey" is not null;