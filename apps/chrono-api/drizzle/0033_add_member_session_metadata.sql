ALTER TABLE "Customers" ALTER COLUMN "passwordHash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "TenantMemberSessions" ADD COLUMN "ipAddress" text;--> statement-breakpoint
ALTER TABLE "TenantMemberSessions" ADD COLUMN "userAgent" text;--> statement-breakpoint
ALTER TABLE "TenantMemberSessions" ADD COLUMN "lastSeenAt" timestamp;--> statement-breakpoint
CREATE INDEX "tenant_member_session_member_idx" ON "TenantMemberSessions" USING btree ("memberId");