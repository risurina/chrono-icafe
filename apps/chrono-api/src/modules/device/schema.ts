import { pgTable, text, timestamp, index, uniqueIndex, integer, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";

export const chronoDeviceProvisioningToken = pgTable(
  "ChronoDeviceProvisioningTokens",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Short, human-typed-at-the-PC code (staff-generated, short TTL). Cleared
    // to null once expired is NOT required — expiry is checked at lookup time
    // (pairingCodeExpiresAt), matching the tokenHash side below.
    pairingCode: text("pairingCode"),
    pairingCodeExpiresAt: timestamp("pairingCodeExpiresAt"),
    // Minted by /pair the first time pairingCode is redeemed; the device's own
    // /auth call presents this. Reusable across multiple PCs cloned from the
    // same golden image (maxUses/useCount), matching oikos's diskless-clone
    // provisioning path — see Pass 1.
    tokenHash: text("tokenHash"),
    tokenExpiresAt: timestamp("tokenExpiresAt"),
    status: text("status").notNull().default("active"), // "active" | "revoked"
    maxUses: integer("maxUses"),
    useCount: integer("useCount").notNull().default(0),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_device_prov_token_tenant_idx").on(t.tenantId),
    index("chrono_device_prov_token_branch_idx").on(t.branchId),
    // Plain index for the cross-tenant lookup (Open Question 1, step 2) so it
    // stays an index scan, not a table scan.
    index("chrono_device_prov_token_pairing_code_idx").on(t.pairingCode),
    // security-hardening Phase 1: at most one ACTIVE row may hold a given
    // pairing code at a time — closes the cross-tenant collision where two
    // tenants' concurrently active codes could match and a device pairs into
    // the wrong tenant. Partial (status = 'active') so revoked/expired rows
    // never block reuse of a code once it's no longer live.
    uniqueIndex("chrono_device_prov_token_pairing_code_active_idx")
      .on(t.pairingCode)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("chrono_device_prov_token_hash_idx").on(t.tokenHash),
  ],
);

export const chronoDevice = pgTable(
  "ChronoDevices",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // Nullable — a brand-new pending_approval device may not have a station
    // yet; devices' own approve step assigns/creates one. onDelete: "set null"
    // matches stations' own forward-reference (deleting a station un-pairs its
    // device rather than orphaning device history).
    stationId: text("stationId").references(() => chronoStation.id, { onDelete: "set null" }),
    deviceFingerprint: text("deviceFingerprint").notNull(),
    // SHA-256 hex of the device's own permanent bearer token. Never store the
    // raw token — .ai/rules/database.md.
    tokenHash: text("tokenHash").notNull(),
    // "pending_approval" | "approved" | "revoked" — free text per the
    // dominant agora convention (branches'/stations' own `status` columns),
    // not a pg enum.
    status: text("status").notNull().default("pending_approval"),
    connectivityStatus: text("connectivityStatus").notNull().default("offline"), // "online" | "offline"
    hostname: text("hostname"),
    ipAddress: text("ipAddress"),
    clientVersion: text("clientVersion"),
    osVersion: text("osVersion"),
    lastSeenAt: timestamp("lastSeenAt"),
    approvedByUserId: text("approvedByUserId").references(() => base.user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approvedAt"),
    // Free-form heartbeat telemetry (lockState/runtimeStatus/uptime/etc.) —
    // genuinely dynamic, mirrors oikos's own metadataJson catch-all.
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_device_tenant_idx").on(t.tenantId),
    index("chrono_device_branch_idx").on(t.branchId),
    index("chrono_device_station_idx").on(t.stationId),
    uniqueIndex("chrono_device_tenant_fingerprint_idx").on(t.tenantId, t.deviceFingerprint),
    uniqueIndex("chrono_device_token_hash_idx").on(t.tokenHash),
    // Mirrors oikos's uq_Devices_stationId_approved_pc_client: at most one
    // APPROVED device may be linked to a given station at a time. Enforced at
    // the DB level so a race between two concurrent approvals can't both win.
    uniqueIndex("chrono_device_station_approved_idx")
      .on(t.stationId)
      .where(sql`${t.stationId} is not null and ${t.status} = 'approved'`),
  ],
);

/**
 * Remote command queue for a device (lock/unlock/reboot/force_logout) —
 * Phase 3 of `.ai/plans/chrono/in-progress/pc-client-tauri-api-integration/README.md`.
 * The row is the source of truth; the realtime push
 * (`routes.ts`'s `POST /:id/commands`) is latency-avoidance only. `status`
 * transitions pending -> delivered -> acked (or a lazily-computed "expired"
 * once `expiresAt` has passed with no ack — see `command-status.ts`'s
 * `getEffectiveCommandStatus`, never written back eagerly by a background
 * sweep in this first version).
 */
export const chronoDeviceCommand = pgTable(
  "ChronoDeviceCommands",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    deviceId: text("deviceId")
      .notNull()
      .references(() => chronoDevice.id, { onDelete: "cascade" }),
    // "lock" | "unlock" | "reboot" | "force_logout" — free text per the
    // dominant agora convention (this file's own device/token `status`
    // columns), not a pg enum.
    type: text("type").notNull(),
    // "pending" | "delivered" | "acked" | "expired" — the STORED value; a
    // reader must call `getEffectiveCommandStatus()` rather than trust this
    // column alone, since "expired" is never written back eagerly.
    status: text("status").notNull().default("pending"),
    // Nullable + "set null", mirroring `chronoDevice.approvedByUserId` —
    // the command row must outlive the issuing staff account being removed.
    issuedByUserId: text("issuedByUserId").references(() => base.user.id, { onDelete: "set null" }),
    issuedAt: timestamp("issuedAt").notNull().defaultNow(),
    deliveredAt: timestamp("deliveredAt"),
    ackedAt: timestamp("ackedAt"),
    expiresAt: timestamp("expiresAt").notNull(),
    // Free-form ack payload the device reports back — genuinely dynamic,
    // mirrors `chronoDevice.metadata`'s own catch-all.
    result: jsonb("result").$type<Record<string, unknown> | null>(),
  },
  (t) => [
    index("chrono_device_command_tenant_idx").on(t.tenantId),
    index("chrono_device_command_device_idx").on(t.deviceId),
  ],
);
