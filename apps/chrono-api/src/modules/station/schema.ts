import { pgTable, text, timestamp, index, uniqueIndex, jsonb, numeric } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../branch/schema";

export const chronoStationGroup = pgTable(
  "ChronoStationGroups",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    // Flat baseline rate — NOT the full oikos `PricingRule` engine (day/time
    // windows, promos, packages). See stations plan Pass 2 "Deliberately narrowed".
    hourlyRate: numeric("hourlyRate", { precision: 12, scale: 2 }).notNull().default("0"),
    memberRate: numeric("memberRate", { precision: 12, scale: 2 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_station_group_tenant_idx").on(t.tenantId),
    index("chrono_station_group_branch_idx").on(t.branchId),
    uniqueIndex("chrono_station_group_branch_code_idx").on(t.branchId, t.code),
  ],
);

export const chronoStation = pgTable(
  "ChronoStations",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    branchId: text("branchId")
      .notNull()
      .references(() => chronoBranch.id, { onDelete: "cascade" }),
    stationGroupId: text("stationGroupId").references(() => chronoStationGroup.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    stationNumber: text("stationNumber").notNull(),
    // Free-text physical category (e.g. "pc", "console", "vip"), not a pg enum —
    // matches the dominant agora convention (see branches' own `status`).
    stationType: text("stationType").notNull().default("pc"),
    // "available" | "maintenance" | "offline" are admin-settable this pass;
    // "occupied" is a reserved 4th value `sessions`/`devices` will set later —
    // see stations plan Pass 2 "Deliberately narrowed" + Open Question 2.
    status: text("status").notNull().default("available"),
    locationZone: text("locationZone"),
    specs: jsonb("specs").$type<{
      cpu?: string | null;
      gpu?: string | null;
      ram?: string | null;
      monitorHz?: number | null;
    } | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_station_tenant_idx").on(t.tenantId),
    index("chrono_station_branch_idx").on(t.branchId),
    index("chrono_station_group_idx").on(t.stationGroupId),
    uniqueIndex("chrono_station_branch_number_idx").on(t.branchId, t.stationNumber),
  ],
);
