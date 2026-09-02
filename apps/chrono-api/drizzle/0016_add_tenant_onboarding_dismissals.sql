CREATE TABLE "TenantOnboardingDismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"userId" text NOT NULL,
	"dismissedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TenantOnboardingDismissals" ADD CONSTRAINT "TenantOnboardingDismissals_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantOnboardingDismissals" ADD CONSTRAINT "TenantOnboardingDismissals_userId_Users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_onboarding_dismissal_tenant_user_uq" ON "TenantOnboardingDismissals" USING btree ("tenantId","userId");--> statement-breakpoint
CREATE INDEX "tenant_onboarding_dismissal_tenant_idx" ON "TenantOnboardingDismissals" USING btree ("tenantId");