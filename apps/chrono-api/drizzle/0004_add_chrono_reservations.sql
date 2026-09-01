CREATE TABLE "ChronoReservations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"stationId" text NOT NULL,
	"memberId" text,
	"customerName" text,
	"customerPhone" text,
	"startAt" timestamp NOT NULL,
	"endAt" timestamp NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"notes" text,
	"createdByUserId" text NOT NULL,
	"checkedInAt" timestamp,
	"cancelledAt" timestamp,
	"cancelReason" text,
	"noShowAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "ChronoReservations_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "ChronoReservations_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "ChronoReservations_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "ChronoReservations_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoReservations" ADD CONSTRAINT "ChronoReservations_createdByUserId_Users_id_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_reservation_tenant_idx" ON "ChronoReservations" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_reservation_tenant_branch_idx" ON "ChronoReservations" USING btree ("tenantId","branchId");--> statement-breakpoint
CREATE INDEX "chrono_reservation_station_idx" ON "ChronoReservations" USING btree ("stationId");--> statement-breakpoint
CREATE INDEX "chrono_reservation_member_idx" ON "ChronoReservations" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_reservation_status_idx" ON "ChronoReservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_reservation_start_idx" ON "ChronoReservations" USING btree ("startAt");