import { pgTable, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoDevice } from "../device/schema";

export const chronoSecurityAlert = pgTable(
  "ChronoSecurityAlerts",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    stationId: text("stationId").references(() => chronoStation.id, {
      onDelete: "set null",
    }),
    // Nullable — only set when raisedBy === "device" (Phase 5). Real FK,
    // set null on device deletion so a historical alert survives the
    // reporting kiosk being decommissioned (matches stationId's own
    // onDelete: "set null" for the same "history outlives the hardware
    // record" reasoning).
    deviceId: text("deviceId").references(() => chronoDevice.id, { onDelete: "set null" }),
    // "device" | "staff" — who/what created the row. Not a pg enum (matches
    // convention); Zod-validated at the contract layer instead.
    raisedBy: text("raisedBy").notNull(),
    // Set only when raisedBy === "staff" and no signed-in device context
    // exists yet; restrict, not cascade/set null — an incident report must
    // survive the reporting staff account being deleted later (matches
    // ChronoShifts.staffUserId / ChronoReservations.createdByUserId).
    reportedByUserId: text("reportedByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    // "low" | "medium" | "high" | "critical"
    severity: text("severity").notNull(),
    // Starter taxonomy, see Contracts — free text at the DB layer, Zod-enum
    // constrained at the contract layer with an "other" escape hatch.
    type: text("type").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    // "open" | "acknowledged" | "resolved"
    status: text("status").notNull().default("open"),
    acknowledgedByUserId: text("acknowledgedByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    acknowledgedAt: timestamp("acknowledgedAt"),
    resolvedByUserId: text("resolvedByUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolvedAt"),
    resolutionNote: text("resolutionNote"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_security_alert_tenant_idx").on(t.tenantId),
    index("chrono_security_alert_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_security_alert_station_idx").on(t.stationId),
    index("chrono_security_alert_status_idx").on(t.status),
    index("chrono_security_alert_severity_idx").on(t.severity),
    index("chrono_security_alert_created_idx").on(t.createdAt),
  ],
);

export type NewChronoSecurityAlert = typeof chronoSecurityAlert.$inferInsert;
export type ChronoSecurityAlertRow = typeof chronoSecurityAlert.$inferSelect;
