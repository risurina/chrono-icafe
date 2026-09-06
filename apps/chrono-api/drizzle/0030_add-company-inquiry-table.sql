CREATE TABLE "ChronoCompanyInquiries" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"businessName" text,
	"requestType" text NOT NULL,
	"message" text NOT NULL,
	"numberOfPcs" integer,
	"numberOfBranches" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chrono_company_inquiry_created_idx" ON "ChronoCompanyInquiries" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "chrono_company_inquiry_source_idx" ON "ChronoCompanyInquiries" USING btree ("source");