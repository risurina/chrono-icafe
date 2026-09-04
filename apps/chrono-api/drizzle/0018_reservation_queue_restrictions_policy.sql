CREATE TABLE "ChronoMemberReservationRestrictions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"memberId" text NOT NULL,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"reservationId" text,
	"stationId" text,
	"startsAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp,
	"liftedAt" timestamp,
	"liftedByUserId" text,
	"metadataJson" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoReservationPolicies" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"reservationAdvanceWindowMinutes" integer DEFAULT 60 NOT NULL,
	"maxActiveReservationsPerMember" integer DEFAULT 1 NOT NULL,
	"lateCancellationWindowMinutes" integer DEFAULT 30 NOT NULL,
	"cancellationFeeEnabled" boolean DEFAULT true NOT NULL,
	"cancellationFeeAmount" numeric(12, 2) DEFAULT '20' NOT NULL,
	"reservationBanDurationHours" integer DEFAULT 24 NOT NULL,
	"noShowBanDurationHours" integer DEFAULT 24 NOT NULL,
	"holdPeriodMinutes" integer DEFAULT 30 NOT NULL,
	"queueFailureLimit" integer DEFAULT 1 NOT NULL,
	"queueBanDurationHours" integer DEFAULT 24 NOT NULL,
	"allowQueueForReservedPc" boolean DEFAULT true NOT NULL,
	"allowQueueForInUsePc" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoReservations" ALTER COLUMN "startAt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ALTER COLUMN "endAt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ALTER COLUMN "createdByUserId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD COLUMN "fromQueue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD COLUMN "requestedDurationMinutes" integer;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD COLUMN "holdExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD COLUMN "claimedAt" timestamp;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD COLUMN "sessionId" text;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD COLUMN "cancelledLateFeeAmount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "ChronoMemberReservationRestrictions" ADD CONSTRAINT "ChronoMemberReservationRestrictions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoMemberReservationRestrictions" ADD CONSTRAINT "ChronoMemberReservationRestrictions_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoMemberReservationRestrictions" ADD CONSTRAINT "ChronoMemberReservationRestrictions_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoMemberReservationRestrictions" ADD CONSTRAINT "ChronoMemberReservationRestrictions_reservationId_ChronoReservations_id_fk" FOREIGN KEY ("reservationId") REFERENCES "public"."ChronoReservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoMemberReservationRestrictions" ADD CONSTRAINT "ChronoMemberReservationRestrictions_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoMemberReservationRestrictions" ADD CONSTRAINT "ChronoMemberReservationRestrictions_liftedByUserId_Users_id_fk" FOREIGN KEY ("liftedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoReservationPolicies" ADD CONSTRAINT "ChronoReservationPolicies_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoReservationPolicies" ADD CONSTRAINT "ChronoReservationPolicies_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_reservation_restriction_tenant_idx" ON "ChronoMemberReservationRestrictions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_reservation_restriction_member_idx" ON "ChronoMemberReservationRestrictions" USING btree ("tenantId","memberId");--> statement-breakpoint
CREATE INDEX "chrono_reservation_restriction_active_idx" ON "ChronoMemberReservationRestrictions" USING btree ("tenantId","memberId","branchId","type","expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_reservation_restriction_no_dup_uq" ON "ChronoMemberReservationRestrictions" USING btree ("tenantId","reservationId","reason","type") WHERE "ChronoMemberReservationRestrictions"."reservationId" is not null;--> statement-breakpoint
CREATE INDEX "chrono_reservation_policy_tenant_idx" ON "ChronoReservationPolicies" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_reservation_policy_tenant_branch_uq" ON "ChronoReservationPolicies" USING btree ("tenantId","branchId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_reservation_policy_one_default_uq" ON "ChronoReservationPolicies" USING btree ("tenantId") WHERE "ChronoReservationPolicies"."branchId" is null;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "ChronoReservations_sessionId_ChronoSessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."ChronoSessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_reservation_one_active_per_member_uq" ON "ChronoReservations" USING btree ("tenantId","memberId") WHERE status in ('confirmed','hold','checked_in','pending') and "memberId" is not null and "createdByUserId" is null;--> statement-breakpoint
-- reservations-queue-and-self-service plan: a queue row (fromQueue=true,
-- status='pending') has no scheduled window until promoted, and must capture
-- requestedDurationMinutes at join time or promotion has nothing to compute
-- endAt from. Hand-written — Drizzle has no CHECK constraint API.
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_pending_window_check"
  CHECK (
    (status = 'pending' AND "startAt" IS NULL AND "endAt" IS NULL
      AND ("fromQueue" = false OR "requestedDurationMinutes" IS NOT NULL))
    OR ("startAt" IS NOT NULL AND "endAt" IS NOT NULL)
  );--> statement-breakpoint
-- Rewrite the existing double-booking exclusion constraint (originally added in
-- 0011_add_reservation_overlap_exclusion.sql, WHERE (status IN ('confirmed',
-- 'checked_in'))) to also cover "hold" — a live, station-locking claim window
-- created once a direct reservation activates at startAt, or a queued member is
-- promoted. Without this, a "hold" row is invisible to the double-booking
-- guarantee for the entire holdPeriodMinutes window. An exclusion constraint's
-- WHERE clause cannot be ALTERed in place, so this drops and re-adds it.
-- "startAt" IS NOT NULL is required in the predicate, not optional: Postgres
-- treats tsrange(NULL, NULL) as an UNBOUNDED range (,), not "no range" — so a
-- NULL-windowed row that ever reached one of these statuses (it never should,
-- per the CHECK constraint above, but this predicate must not depend on that
-- alone) would otherwise block every other booking on the station.
ALTER TABLE "ChronoReservations" DROP CONSTRAINT "chrono_reservation_no_overlap";--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "chrono_reservation_no_overlap"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "stationId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  ) WHERE (status IN ('confirmed', 'checked_in', 'hold') AND "startAt" IS NOT NULL);