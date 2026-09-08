CREATE TABLE "ChronoDeviceCommands" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"deviceId" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"issuedByUserId" text,
	"issuedAt" timestamp DEFAULT now() NOT NULL,
	"deliveredAt" timestamp,
	"ackedAt" timestamp,
	"expiresAt" timestamp NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "ChronoDeviceCommands" ADD CONSTRAINT "ChronoDeviceCommands_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDeviceCommands" ADD CONSTRAINT "ChronoDeviceCommands_deviceId_ChronoDevices_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."ChronoDevices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoDeviceCommands" ADD CONSTRAINT "ChronoDeviceCommands_issuedByUserId_Users_id_fk" FOREIGN KEY ("issuedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_device_command_tenant_idx" ON "ChronoDeviceCommands" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_device_command_device_idx" ON "ChronoDeviceCommands" USING btree ("deviceId");