import { pgTable, text, timestamp, index, uniqueIndex, integer, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoDevice } from "../device/schema";
import { chronoSession } from "../session/schema";

export const chronoAppUsageEvent = pgTable(
  "ChronoAppUsageEvents",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Denormalized from the device at ingestion, matches session.branchId's
    // own denormalization precedent.
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    // From device.stationId; ingestion 409s if the authenticated device has
    // no station. set null: history survives the station being decommissioned.
    stationId: text("stationId").references(() => chronoStation.id, { onDelete: "set null" }),
    // The authenticated device; set null so history survives device decommission.
    deviceId: text("deviceId").references(() => chronoDevice.id, { onDelete: "set null" }),
    // Best-effort: the active/paused session on stationId at the moment the
    // launched event is written, frozen at write time — never re-resolved on
    // the closed update.
    sessionId: text("sessionId").references(() => chronoSession.id, { onDelete: "set null" }),
    // Device-generated stable id per process instance (Divergence #1) — the
    // upsert key alongside deviceId, so a retried event is never double-counted.
    runId: text("runId").notNull(),
    // "app" | "game" — free text at the DB layer + Zod .enum() at the contract
    // layer, matching the dominant convention (status-shaped columns elsewhere).
    category: text("category").notNull(),
    appName: text("appName").notNull(),
    executablePath: text("executablePath"),
    // Device-reported process-start time (domain time, distinct from createdAt).
    startedAt: timestamp("startedAt").notNull(),
    // null = still running; set by the matching closed event (device-reported)
    // or the stale-run sweep (device's own lastSeenAt).
    endedAt: timestamp("endedAt"),
    // Frozen once endedAt is set (endedAt - startedAt, clamped >= 0, capped at
    // 604800), matches session.actualBillableSeconds's own freeze-at-close precedent.
    durationSeconds: integer("durationSeconds"),
    // "device_closed" | "stale_device" — lets the UI/report distinguish an
    // honest close from an inferred one.
    closedReason: text("closedReason"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_app_usage_tenant_idx").on(t.tenantId),
    index("chrono_app_usage_tenant_branch_idx").on(t.tenantId, t.branchId),
    index("chrono_app_usage_tenant_station_idx").on(t.tenantId, t.stationId),
    // Partial — serves GET /current directly.
    index("chrono_app_usage_current_idx")
      .on(t.tenantId, t.stationId)
      .where(sql`${t.endedAt} is null`),
    index("chrono_app_usage_tenant_category_idx").on(t.tenantId, t.category),
    // Not a bare appName index: every query already carries RLS's implicit
    // tenantId predicate, so a single-column index on appName alone is nearly
    // useless for the report grouping it exists to serve.
    index("chrono_app_usage_tenant_app_name_idx").on(t.tenantId, t.appName),
    // Backs the report's date-range filter — filters startedAt (domain time),
    // not createdAt.
    index("chrono_app_usage_tenant_started_idx").on(t.tenantId, t.startedAt),
    // Plain index for the retention sweep's cutoff scan — that sweep runs
    // cross-tenant via withAdmin, matching pruneAuditForPlan's own equivalent
    // index shape in packages/agora/src/core/server/retention.ts.
    index("chrono_app_usage_created_idx").on(t.createdAt),
    uniqueIndex("chrono_app_usage_device_run_uq").on(t.deviceId, t.runId),
  ],
);

export type NewChronoAppUsageEvent = typeof chronoAppUsageEvent.$inferInsert;
export type ChronoAppUsageEventRow = typeof chronoAppUsageEvent.$inferSelect;
