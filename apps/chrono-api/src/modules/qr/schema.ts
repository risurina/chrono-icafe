import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoStation } from "../station/schema";

export const chronoQrTokenUse = pgTable(
  "ChronoQrTokenUses",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    stationId: text("stationId")
      .notNull()
      .references(() => chronoStation.id, { onDelete: "cascade" }),
    // SHA-256 of the token's nonce — never the raw token (defense in depth:
    // even a DB read of this table can't replay a token from it).
    nonceHash: text("nonceHash").notNull(),
    // Nullable — set once the token is consumed by an authenticated action
    // (session start, once `sessions` exists); null while only "validated"
    // (read-only resolve) has happened. See Divergence 3.
    consumedByMemberId: text("consumedByMemberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    consumedAt: timestamp("consumedAt"),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_qr_token_use_tenant_idx").on(t.tenantId),
    index("chrono_qr_token_use_station_idx").on(t.stationId),
    uniqueIndex("chrono_qr_token_use_nonce_idx").on(t.nonceHash),
    index("chrono_qr_token_use_expires_idx").on(t.expiresAt),
  ],
);

export type NewChronoQrTokenUse = typeof chronoQrTokenUse.$inferInsert;
export type ChronoQrTokenUseRow = typeof chronoQrTokenUse.$inferSelect;
