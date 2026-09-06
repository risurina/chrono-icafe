CREATE TABLE "TenantMemberPasskeys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"credentialId" text NOT NULL,
	"publicKey" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"deviceType" text NOT NULL,
	"backedUp" boolean DEFAULT false NOT NULL,
	"transports" text,
	"name" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TenantMemberPasskeys" ADD CONSTRAINT "TenantMemberPasskeys_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberPasskeys" ADD CONSTRAINT "TenantMemberPasskeys_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_member_passkey_credential_id_uq" ON "TenantMemberPasskeys" USING btree ("credentialId");--> statement-breakpoint
CREATE INDEX "tenant_member_passkey_tenant_idx" ON "TenantMemberPasskeys" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_member_passkey_member_idx" ON "TenantMemberPasskeys" USING btree ("memberId");
