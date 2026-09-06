import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";

/**
 * A player's request for a gaming business that is NOT on Chrono yet — the
 * cold-start half of the two-sided growth loop. Captured from the public
 * `/discover` page when a search finds nothing.
 *
 * PLATFORM-GLOBAL, deliberately NOT tenant-scoped: at insert time the business
 * being asked for has no tenant, so there is no `tenantId` to carry. This table
 * therefore has **no RLS** and must **never** appear in `APP_TENANT_TABLES` —
 * same treatment as the foundation's `supportTicket`/`platformAuditEvent`.
 *
 * A lead is matched to a tenant LAZILY, at read time: `GET /rpc/growth/demand`
 * normalizes the caller's OWN organization name (resolved from
 * `c.var.tenant.tenantId`, never client input) and counts rows whose
 * `businessNameNormalized` equals it. There is deliberately no `matchedTenantId`
 * / `matchedAt` / `status` column: the only thing that could have written them
 * is an organization-create hook, which lives in the foundation
 * (`organizationHooks.afterCreateOrganization`) and is out of bounds for a
 * business app. Read-time matching also self-heals when an organization is
 * renamed, where a frozen match column would go stale.
 *
 * Because there is no RLS here, the explicit normalized-name predicate in that
 * route is the ONLY isolation on it — exactly the stance the foundation takes
 * for `readPublishedLandingPage`. `rls:proof` does not cover it; the
 * cross-tenant e2e case is its proof.
 */
export const chronoBusinessLead = pgTable(
  "ChronoBusinessLeads",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    // As typed by the player — preserved verbatim for display if a triage
    // console is ever built.
    businessName: text("businessName").notNull(),
    // Lowercased, trimmed, internal whitespace collapsed. Written at insert by
    // `normalizeBusinessName()` (this module's contracts), which is also what
    // the demand read applies to the organization name — one implementation, so
    // the two can never drift apart. This column exists so that match is a
    // single indexed equality rather than a scan.
    businessNameNormalized: text("businessNameNormalized").notNull(),
    // Free text. There is no structured geography anywhere in Chrono today
    // (`ChronoBranches` has address/lat/long but no city column).
    city: text("city"),
    message: text("message"),
    // The global customer who asked, IF one was signed in at submit time.
    // Submission is anonymous (matching `modules/company-inquiry`'s pattern) —
    // a player is never required to have or create a global customer account
    // just to invite a business. `null` means an anonymous submission; the
    // cascade remains the erasure path when a linked customer account is
    // deleted.
    requesterCustomerId: text("requesterCustomerId").references(() => base.customer.id, {
      onDelete: "cascade",
    }),
    // Set once this lead's requester has been emailed that the business they
    // asked for has published its landing page (the "we'll notify you"
    // follow-up). Null for an anonymous lead (nothing to notify) and for any
    // lead not yet matched to a published business. Guards a republish from
    // re-emailing the same player twice.
    notifiedAt: timestamp("notifiedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    // Serves the demand count's normalized-equality lookup.
    index("chrono_business_lead_name_normalized_idx").on(t.businessNameNormalized),
    // Serves the per-customer rate-limit lookup and the FK cascade.
    index("chrono_business_lead_requester_idx").on(t.requesterCustomerId),
  ],
);

export type NewChronoBusinessLead = typeof chronoBusinessLead.$inferInsert;
export type ChronoBusinessLeadRow = typeof chronoBusinessLead.$inferSelect;
