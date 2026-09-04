CREATE TABLE "TenantLandingPages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published" jsonb,
	"publishedAt" timestamp,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedByUserId" text,
	CONSTRAINT "tenant_landing_page_draft_size_ck" CHECK (octet_length("TenantLandingPages"."draft"::text) <= 262144),
	CONSTRAINT "tenant_landing_page_published_size_ck" CHECK ("TenantLandingPages"."published" IS NULL OR octet_length("TenantLandingPages"."published"::text) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "TenantMemberOAuthAccounts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"email" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TenantMembers" ALTER COLUMN "passwordHash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "TenantLandingPages" ADD CONSTRAINT "TenantLandingPages_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantLandingPages" ADD CONSTRAINT "TenantLandingPages_updatedByUserId_Users_id_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberOAuthAccounts" ADD CONSTRAINT "TenantMemberOAuthAccounts_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberOAuthAccounts" ADD CONSTRAINT "TenantMemberOAuthAccounts_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_landing_page_tenant_uq" ON "TenantLandingPages" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_landing_page_tenant_idx" ON "TenantLandingPages" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_member_oauth_provider_account_uq" ON "TenantMemberOAuthAccounts" USING btree ("tenantId","provider","providerAccountId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_member_oauth_member_provider_uq" ON "TenantMemberOAuthAccounts" USING btree ("tenantId","memberId","provider");--> statement-breakpoint
CREATE INDEX "tenant_member_oauth_account_tenant_idx" ON "TenantMemberOAuthAccounts" USING btree ("tenantId");