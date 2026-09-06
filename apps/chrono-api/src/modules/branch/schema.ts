import { pgTable, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoBranch = pgTable(
  "ChronoBranches",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    status: text("status").notNull().default("active"), // "active" | "disabled"
    address: text("address"),
    contactNumber: text("contactNumber"),
    email: text("email"),
    timezone: text("timezone").notNull().default("Asia/Manila"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    operatingHours: text("operatingHours"),
    googleMapsUrl: text("googleMapsUrl"),
    socialLinks: jsonb("socialLinks").$type<{
      facebook?: string | null;
      messenger?: string | null;
      instagram?: string | null;
      tiktok?: string | null;
      discord?: string | null;
    } | null>(),
    // Structured day-of-week open/close hours, parseable by `computeOpenStatus`
    // (./hours.ts). Nullable — absent means "no structured hours configured
    // yet", so the public page falls back to the plain-text `operatingHours`
    // display with no fabricated status. `operatingHours` itself is kept
    // permanently as a tenant-editable supplementary note, never deprecated.
    hoursConfig: jsonb("hoursConfig").$type<import("./hours").HoursConfig | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_branch_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_branch_tenant_code_idx").on(t.tenantId, t.code),
  ],
);
