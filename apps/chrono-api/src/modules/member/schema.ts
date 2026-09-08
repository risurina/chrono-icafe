import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoMemberProfile = pgTable(
  "ChronoMemberProfiles",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // One profile per tenantMember — enforced by the unique index below.
    memberId: text("memberId")
      .notNull()
      .references(() => base.tenantMember.id, { onDelete: "cascade" }),
    phone: text("phone"),
    // Venue-membership approval workflow — orthogonal to tenantMember.status
    // ("active"/"suspended", the foundation's login-gate flag). A "pending"
    // profile can still sign in and see their own status; this field carries
    // no enforcement yet (see the module plan's "Enforcement note").
    applicationStatus: text("applicationStatus").notNull().default("pending"), // "visitor" | "pending" | "approved" | "rejected"
    // Staff-facing member code, generated once on first approval
    // (`generateMemberCode()` in `service.ts`). Null until approved; never
    // reused/reassigned after that (see the member-code plan's Out of Scope).
    memberCode: text("memberCode"),
    appliedAt: timestamp("appliedAt").notNull().defaultNow(),
    approvedAt: timestamp("approvedAt"),
    rejectedAt: timestamp("rejectedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_member_profile_tenant_idx").on(t.tenantId),
    uniqueIndex("chrono_member_profile_member_uq").on(t.memberId),
    // Per-tenant uniqueness — Postgres unique indexes permit multiple NULLs,
    // so never-approved members (memberCode: null) never collide with each
    // other, and the same-looking code can exist independently in two tenants.
    uniqueIndex("chrono_member_profile_code_uq").on(t.tenantId, t.memberCode),
  ],
);
