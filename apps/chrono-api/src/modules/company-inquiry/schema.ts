import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createId } from "agora";

/**
 * A durable record of every `POST /public/company-inquiries` submission —
 * IZUR's own anonymous, pre-tenant-context lead-capture form (`support` and
 * `contact` sources). Added in growth-loop-hardening Phase 8 to close the
 * narrower real gap the plan identified: the route already THROWS (a
 * caller-visible error) on a missing inbox config or a failed send — it does
 * not silently discard a submission — but on a SUCCESSFUL send, no row was
 * ever written, so there was no queryable record, no dedup, and no future
 * admin-UI possibility.
 *
 * PLATFORM-GLOBAL, deliberately NOT tenant-scoped — this form has no tenant
 * context at all (it's about IZUR itself, not a business's Chrono tenant).
 * Same treatment as `ChronoBusinessLeads`/the foundation's `supportTicket`:
 * NOT RLS-scoped, and must never appear in `APP_TENANT_TABLES`.
 */
export const chronoCompanyInquiry = pgTable(
  "ChronoCompanyInquiries",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    // "support" | "contact" — see contracts.ts's companyInquirySourceSchema.
    source: text("source").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    businessName: text("businessName"),
    requestType: text("requestType").notNull(),
    message: text("message").notNull(),
    numberOfPcs: integer("numberOfPcs"),
    numberOfBranches: integer("numberOfBranches"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("chrono_company_inquiry_created_idx").on(t.createdAt),
    index("chrono_company_inquiry_source_idx").on(t.source),
  ],
);

export type NewChronoCompanyInquiry = typeof chronoCompanyInquiry.$inferInsert;
export type ChronoCompanyInquiryRow = typeof chronoCompanyInquiry.$inferSelect;
