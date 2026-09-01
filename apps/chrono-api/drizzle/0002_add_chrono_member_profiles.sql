CREATE TABLE "ChronoMemberProfiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"phone" text,
	"applicationStatus" text DEFAULT 'pending' NOT NULL,
	"appliedAt" timestamp DEFAULT now() NOT NULL,
	"approvedAt" timestamp,
	"rejectedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoMemberProfiles" ADD CONSTRAINT "ChronoMemberProfiles_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoMemberProfiles" ADD CONSTRAINT "ChronoMemberProfiles_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_member_profile_tenant_idx" ON "ChronoMemberProfiles" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_member_profile_member_uq" ON "ChronoMemberProfiles" USING btree ("memberId");