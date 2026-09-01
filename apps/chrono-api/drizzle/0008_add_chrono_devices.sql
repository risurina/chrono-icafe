CREATE TABLE "ChronoDevices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"stationId" text,
	"deviceFingerprint" text NOT NULL,
	"tokenHash" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"connectivityStatus" text DEFAULT 'offline' NOT NULL,
	"hostname" text,
	"ipAddress" text,
	"clientVersion" text,
	"osVersion" text,
	"lastSeenAt" timestamp,
	"approvedByUserId" text,
	"approvedAt" timestamp,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoDeviceProvisioningTokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"name" text NOT NULL,
	"pairingCode" text,
	"pairingCodeExpiresAt" timestamp,
	"tokenHash" text,
	"tokenExpiresAt" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"maxUses" integer,
	"useCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoDevices" ADD CONSTRAINT "ChronoDevices_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDevices" ADD CONSTRAINT "ChronoDevices_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDevices" ADD CONSTRAINT "ChronoDevices_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDevices" ADD CONSTRAINT "ChronoDevices_approvedByUserId_Users_id_fk" FOREIGN KEY ("approvedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDeviceProvisioningTokens" ADD CONSTRAINT "ChronoDeviceProvisioningTokens_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDeviceProvisioningTokens" ADD CONSTRAINT "ChronoDeviceProvisioningTokens_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_device_tenant_idx" ON "ChronoDevices" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_device_branch_idx" ON "ChronoDevices" USING btree ("branchId");--> statement-breakpoint
CREATE INDEX "chrono_device_station_idx" ON "ChronoDevices" USING btree ("stationId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_device_tenant_fingerprint_idx" ON "ChronoDevices" USING btree ("tenantId","deviceFingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_device_token_hash_idx" ON "ChronoDevices" USING btree ("tokenHash");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_device_station_approved_idx" ON "ChronoDevices" USING btree ("stationId") WHERE "ChronoDevices"."stationId" is not null and "ChronoDevices"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "chrono_device_prov_token_tenant_idx" ON "ChronoDeviceProvisioningTokens" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_device_prov_token_branch_idx" ON "ChronoDeviceProvisioningTokens" USING btree ("branchId");--> statement-breakpoint
CREATE INDEX "chrono_device_prov_token_pairing_code_idx" ON "ChronoDeviceProvisioningTokens" USING btree ("pairingCode");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_device_prov_token_hash_idx" ON "ChronoDeviceProvisioningTokens" USING btree ("tokenHash");