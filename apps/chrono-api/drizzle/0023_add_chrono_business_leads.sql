CREATE TABLE "ChronoBusinessLeads" (
	"id" text PRIMARY KEY NOT NULL,
	"businessName" text NOT NULL,
	"businessNameNormalized" text NOT NULL,
	"city" text,
	"message" text,
	"requesterCustomerId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoBusinessLeads" ADD CONSTRAINT "ChronoBusinessLeads_requesterCustomerId_Customers_id_fk" FOREIGN KEY ("requesterCustomerId") REFERENCES "public"."Customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_business_lead_name_normalized_idx" ON "ChronoBusinessLeads" USING btree ("businessNameNormalized");--> statement-breakpoint
CREATE INDEX "chrono_business_lead_requester_idx" ON "ChronoBusinessLeads" USING btree ("requesterCustomerId");