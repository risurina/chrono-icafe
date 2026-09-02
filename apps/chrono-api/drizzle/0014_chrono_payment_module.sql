CREATE TABLE "ChronoPayments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text,
	"sessionId" text,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"providerReference" text,
	"paidAt" timestamp,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoPaymentEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"paymentId" text NOT NULL,
	"eventType" text NOT NULL,
	"idempotencyKey" text,
	"payloadJson" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD CONSTRAINT "ChronoPayments_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD CONSTRAINT "ChronoPayments_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPayments" ADD CONSTRAINT "ChronoPayments_sessionId_ChronoSessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."ChronoSessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPaymentEvents" ADD CONSTRAINT "ChronoPaymentEvents_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPaymentEvents" ADD CONSTRAINT "ChronoPaymentEvents_paymentId_ChronoPayments_id_fk" FOREIGN KEY ("paymentId") REFERENCES "public"."ChronoPayments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_payment_tenant_idx" ON "ChronoPayments" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_payment_member_idx" ON "ChronoPayments" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_payment_session_idx" ON "ChronoPayments" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "chrono_payment_status_idx" ON "ChronoPayments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_payment_event_tenant_idx" ON "ChronoPaymentEvents" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_payment_event_payment_idx" ON "ChronoPaymentEvents" USING btree ("paymentId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_payment_event_idempotency_uq" ON "ChronoPaymentEvents" USING btree ("tenantId","idempotencyKey") WHERE "idempotencyKey" is not null;