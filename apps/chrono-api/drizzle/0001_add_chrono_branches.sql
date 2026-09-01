CREATE TABLE "ChronoBranches" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"address" text,
	"contactNumber" text,
	"email" text,
	"timezone" text DEFAULT 'Asia/Manila' NOT NULL,
	"latitude" text,
	"longitude" text,
	"operatingHours" text,
	"googleMapsUrl" text,
	"socialLinks" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoBranches" ADD CONSTRAINT "ChronoBranches_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_branch_tenant_idx" ON "ChronoBranches" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_branch_tenant_code_idx" ON "ChronoBranches" USING btree ("tenantId","code");