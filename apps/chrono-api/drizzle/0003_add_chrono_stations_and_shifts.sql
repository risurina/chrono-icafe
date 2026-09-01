CREATE TABLE "ChronoShifts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"staffUserId" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"openingCashAmount" numeric(12, 2) NOT NULL,
	"openedAt" timestamp DEFAULT now() NOT NULL,
	"closedAt" timestamp,
	"actualCashAmount" numeric(12, 2),
	"expectedCashAmount" numeric(12, 2),
	"differenceAmount" numeric(12, 2),
	"openNotes" text,
	"closeNotes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoStations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"stationGroupId" text,
	"name" text NOT NULL,
	"stationNumber" text NOT NULL,
	"stationType" text DEFAULT 'pc' NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"locationZone" text,
	"specs" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoStationGroups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"hourlyRate" numeric(12, 2) DEFAULT '0' NOT NULL,
	"memberRate" numeric(12, 2),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoShifts" ADD CONSTRAINT "ChronoShifts_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoShifts" ADD CONSTRAINT "ChronoShifts_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoShifts" ADD CONSTRAINT "ChronoShifts_staffUserId_Users_id_fk" FOREIGN KEY ("staffUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoStations" ADD CONSTRAINT "ChronoStations_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoStations" ADD CONSTRAINT "ChronoStations_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoStations" ADD CONSTRAINT "ChronoStations_stationGroupId_ChronoStationGroups_id_fk" FOREIGN KEY ("stationGroupId") REFERENCES "public"."ChronoStationGroups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoStationGroups" ADD CONSTRAINT "ChronoStationGroups_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoStationGroups" ADD CONSTRAINT "ChronoStationGroups_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_shift_tenant_idx" ON "ChronoShifts" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_shift_tenant_branch_idx" ON "ChronoShifts" USING btree ("tenantId","branchId");--> statement-breakpoint
CREATE INDEX "chrono_shift_staff_idx" ON "ChronoShifts" USING btree ("staffUserId");--> statement-breakpoint
CREATE INDEX "chrono_shift_status_idx" ON "ChronoShifts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_shift_one_open_per_staff_idx" ON "ChronoShifts" USING btree ("tenantId","branchId","staffUserId") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "chrono_station_tenant_idx" ON "ChronoStations" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_station_branch_idx" ON "ChronoStations" USING btree ("branchId");--> statement-breakpoint
CREATE INDEX "chrono_station_group_idx" ON "ChronoStations" USING btree ("stationGroupId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_station_branch_number_idx" ON "ChronoStations" USING btree ("branchId","stationNumber");--> statement-breakpoint
CREATE INDEX "chrono_station_group_tenant_idx" ON "ChronoStationGroups" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_station_group_branch_idx" ON "ChronoStationGroups" USING btree ("branchId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_station_group_branch_code_idx" ON "ChronoStationGroups" USING btree ("branchId","code");