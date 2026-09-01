CREATE TABLE "Customers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"passwordHash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Customers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "CustomerSessions" (
	"id" text PRIMARY KEY NOT NULL,
	"customerId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "CustomerTokens" (
	"id" text PRIMARY KEY NOT NULL,
	"customerId" text,
	"email" text NOT NULL,
	"purpose" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TenantMembers" ADD COLUMN "customerId" text;--> statement-breakpoint
ALTER TABLE "CustomerSessions" ADD CONSTRAINT "CustomerSessions_customerId_Customers_id_fk" FOREIGN KEY ("customerId") REFERENCES "public"."Customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CustomerTokens" ADD CONSTRAINT "CustomerTokens_customerId_Customers_id_fk" FOREIGN KEY ("customerId") REFERENCES "public"."Customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_session_token_uq" ON "CustomerSessions" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "customer_session_customer_idx" ON "CustomerSessions" USING btree ("customerId");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_token_token_uq" ON "CustomerTokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "customer_token_customer_idx" ON "CustomerTokens" USING btree ("customerId");--> statement-breakpoint
ALTER TABLE "TenantMembers" ADD CONSTRAINT "TenantMembers_customerId_Customers_id_fk" FOREIGN KEY ("customerId") REFERENCES "public"."Customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_member_customer_idx" ON "TenantMembers" USING btree ("customerId");