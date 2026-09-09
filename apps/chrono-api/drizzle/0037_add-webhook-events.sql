CREATE TABLE "WebhookEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"providerEventId" text NOT NULL,
	"providerAccountId" text,
	"scope" text NOT NULL,
	"tenantId" text,
	"integrationId" text,
	"eventType" text NOT NULL,
	"resourceType" text,
	"resourceId" text,
	"signatureVerified" boolean DEFAULT false NOT NULL,
	"processingStatus" text DEFAULT 'received' NOT NULL,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"firstReceivedAt" timestamp DEFAULT now() NOT NULL,
	"lastReceivedAt" timestamp DEFAULT now() NOT NULL,
	"processedAt" timestamp,
	"lastError" text,
	"payloadHash" text NOT NULL,
	"rawPayloadRef" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "WebhookEvents" ADD CONSTRAINT "WebhookEvents_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_provider_event_uq" ON "WebhookEvents" USING btree ("provider","providerEventId");--> statement-breakpoint
CREATE INDEX "webhook_event_tenant_idx" ON "WebhookEvents" USING btree ("tenantId");