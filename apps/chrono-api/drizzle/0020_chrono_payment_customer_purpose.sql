ALTER TABLE "ChronoPayments" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD COLUMN "creditProductId" text;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD COLUMN "fulfilledAt" timestamp;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD COLUMN "fulfilmentNote" text;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD CONSTRAINT "ChronoPayments_creditProductId_ChronoCreditProducts_id_fk" FOREIGN KEY ("creditProductId") REFERENCES "public"."ChronoCreditProducts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_payment_purpose_idx" ON "ChronoPayments" USING btree ("purpose");