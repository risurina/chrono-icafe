import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

export const chronoInquiry = pgTable(
  "ChronoInquiries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    // Nullable — an anonymous public submission. See Decision 1.
    tenantMemberId: text("tenantMemberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    // Captured for both anonymous AND identified submitters (denormalized
    // snapshot even when tenantMemberId is set, so a later profile-name
    // change never rewrites historical inquiry rows — same reasoning as
    // ChronoReservations.customerName / TenantNotifications.actorName).
    submitterName: text("submitterName").notNull(),
    submitterEmail: text("submitterEmail").notNull(),
    submitterPhone: text("submitterPhone"),
    // See Decision 1's category split; Zod enforces which categories are
    // reachable from the public (unauthenticated) endpoint.
    category: text("category").notNull(),
    subject: text("subject").notNull(),
    // "new" | "assigned" | "in_progress" | "resolved" | "closed"
    // "resolved" vs "closed": resolved = staff believes it's handled but
    // leaves it open a beat for the customer to confirm/reply; closed = done,
    // reopens automatically on a new customer message (Open Question 1).
    status: text("status").notNull().default("new"),
    assignedToUserId: text("assignedToUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_inquiry_tenant_idx").on(t.tenantId),
    index("chrono_inquiry_tenant_member_idx").on(t.tenantMemberId),
    index("chrono_inquiry_status_idx").on(t.status),
    index("chrono_inquiry_assigned_idx").on(t.assignedToUserId),
    index("chrono_inquiry_created_idx").on(t.createdAt),
  ],
);

export const chronoInquiryMessage = pgTable(
  "ChronoInquiryMessages",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    inquiryId: text("inquiryId")
      .notNull()
      .references(() => chronoInquiry.id, { onDelete: "cascade" }),
    // "customer" | "staff" — who authored this message.
    authorType: text("authorType").notNull(),
    // Set only when authorType === "staff"; restrict, matching every other
    // "who did this" FK in the codebase.
    authorUserId: text("authorUserId").references(() => base.user.id, {
      onDelete: "restrict",
    }),
    // Set only when authorType === "customer" AND the submitter was
    // identified (tenantMemberId on the parent was non-null).
    authorMemberId: text("authorMemberId").references(() => base.tenantMember.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_inquiry_message_tenant_idx").on(t.tenantId),
    index("chrono_inquiry_message_inquiry_idx").on(t.inquiryId),
    index("chrono_inquiry_message_created_idx").on(t.createdAt),
  ],
);

export type NewChronoInquiry = typeof chronoInquiry.$inferInsert;
export type ChronoInquiryRow = typeof chronoInquiry.$inferSelect;
export type NewChronoInquiryMessage = typeof chronoInquiryMessage.$inferInsert;
export type ChronoInquiryMessageRow = typeof chronoInquiryMessage.$inferSelect;
