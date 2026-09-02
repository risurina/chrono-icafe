import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoLandingPage = pgTable(
  "ChronoLandingPages",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" })
      .unique(), // one row per tenant
    heroTagline: text("heroTagline"),
    aboutBody: text("aboutBody"),
    amenitiesBody: text("amenitiesBody"),
    contactOverride: text("contactOverride"), // null = fall back to branch/org contact
    ctaLabel: text("ctaLabel"),
    ctaHref: text("ctaHref"),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    updatedByUserId: text("updatedByUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("chrono_landing_page_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_landing_page_tenant_unique_idx").on(t.tenantId),
  ],
);
