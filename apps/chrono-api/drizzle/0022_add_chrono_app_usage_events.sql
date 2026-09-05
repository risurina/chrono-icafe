CREATE TABLE "ChronoAppUsageEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"stationId" text,
	"deviceId" text,
	"sessionId" text,
	"runId" text NOT NULL,
	"category" text NOT NULL,
	"appName" text NOT NULL,
	"executablePath" text,
	"startedAt" timestamp NOT NULL,
	"endedAt" timestamp,
	"durationSeconds" integer,
	"closedReason" text,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoAppUsageEvents" ADD CONSTRAINT "ChronoAppUsageEvents_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoAppUsageEvents" ADD CONSTRAINT "ChronoAppUsageEvents_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoAppUsageEvents" ADD CONSTRAINT "ChronoAppUsageEvents_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoAppUsageEvents" ADD CONSTRAINT "ChronoAppUsageEvents_deviceId_ChronoDevices_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."ChronoDevices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoAppUsageEvents" ADD CONSTRAINT "ChronoAppUsageEvents_sessionId_ChronoSessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."ChronoSessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_app_usage_tenant_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_app_usage_tenant_branch_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId","branchId");--> statement-breakpoint
CREATE INDEX "chrono_app_usage_tenant_station_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId","stationId");--> statement-breakpoint
CREATE INDEX "chrono_app_usage_current_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId","stationId") WHERE "ChronoAppUsageEvents"."endedAt" is null;--> statement-breakpoint
CREATE INDEX "chrono_app_usage_tenant_category_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId","category");--> statement-breakpoint
CREATE INDEX "chrono_app_usage_tenant_app_name_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId","appName");--> statement-breakpoint
CREATE INDEX "chrono_app_usage_tenant_started_idx" ON "ChronoAppUsageEvents" USING btree ("tenantId","startedAt");--> statement-breakpoint
CREATE INDEX "chrono_app_usage_created_idx" ON "ChronoAppUsageEvents" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_app_usage_device_run_uq" ON "ChronoAppUsageEvents" USING btree ("deviceId","runId");