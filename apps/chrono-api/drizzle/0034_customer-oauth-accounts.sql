CREATE TABLE "CustomerOAuthAccounts" (
	"id" text PRIMARY KEY NOT NULL,
	"customerId" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"email" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "CustomerOAuthAccounts" ADD CONSTRAINT "CustomerOAuthAccounts_customerId_Customers_id_fk" FOREIGN KEY ("customerId") REFERENCES "public"."Customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_oauth_provider_account_uq" ON "CustomerOAuthAccounts" USING btree ("provider","providerAccountId");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_oauth_customer_provider_uq" ON "CustomerOAuthAccounts" USING btree ("customerId","provider");