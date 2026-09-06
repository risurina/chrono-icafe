import { z } from "zod";

/**
 * The ONE normalizer for business-name matching.
 *
 * Applied at two places that must agree exactly or the growth loop silently
 * stops matching: when a lead is inserted (persisted into
 * `chronoBusinessLead.businessNameNormalized`) and when
 * `GET /rpc/growth/demand` normalizes the caller's own organization name to
 * count against it. Exported rather than inlined precisely so those two can
 * never drift apart.
 *
 * Normalized-exact only — no fuzzy/approximate matching (no Levenshtein, no
 * trigram). A stricter rule is the safe one to ship first: there is no triage
 * console in this MVP, so a wrong match has nothing to correct it.
 */
export function normalizeBusinessName(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Body of `POST /public/discover/business-leads`. */
export const createBusinessLeadSchema = z.object({
  businessName: z.string().trim().min(1).max(200),
  city: z.string().trim().max(200).optional(),
  message: z.string().trim().max(1000).optional(),
});
export type CreateBusinessLeadInput = z.infer<typeof createBusinessLeadSchema>;

/** Query of `GET /public/discover/businesses`. */
export const discoverBusinessesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  city: z.string().trim().max(200).optional(),
});
export type DiscoverBusinessesQuery = z.infer<typeof discoverBusinessesQuerySchema>;

/**
 * One row of the public directory. An explicit allowlist — never a raw
 * `$inferSelect` row, and never anything a tenant has not affirmatively
 * published.
 *
 * `liveAvailability` is `null` (not `{available: 0, total: 0}`) when the
 * business has no stations, so the UI can omit the line entirely rather than
 * render a misleading "0 of 0 available".
 */
export const businessDirectoryResultSchema = z.object({
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  locationText: z.string().nullable(),
  liveAvailability: z
    .object({
      available: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type BusinessDirectoryResult = z.infer<typeof businessDirectoryResultSchema>;

/**
 * Response of `GET /rpc/growth/demand`. A bare count — deliberately carries no
 * lead field and no requester identity, so this route can never become a
 * back-door lead read.
 */
export const growthDemandResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type GrowthDemandResponse = z.infer<typeof growthDemandResponseSchema>;

/**
 * One row of `GET /rpc/growth/leads` (the lead-detail console, admin+
 * `growth:read`). Deliberately still carries NO requester identity —
 * `requesterCustomerId` is never selected here, matching the no-PII
 * precedent `GET /rpc/growth/demand` already set. `businessName`/`city`/
 * `message` are exactly what a player typed; there is no other identifying
 * field on `chronoBusinessLead` to leak.
 */
export const businessLeadListItemSchema = z.object({
  businessName: z.string(),
  city: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
});
export type BusinessLeadListItem = z.infer<typeof businessLeadListItemSchema>;

/** Hard cap on the public directory read — see the plan's assumption 13. */
export const DISCOVER_RESULT_LIMIT = 20;

/**
 * At most this many businesses (highest demand first) get pulled to the
 * front of `GET /public/discover/businesses` (growth-loop-hardening Phase
 * 10). Deliberately NOT "sort the whole page by demand" — that would let one
 * popular business's demand crowd out the rest of a small directory. The
 * remainder of the page keeps its original alphabetical relative order.
 */
export const DISCOVERY_DEMAND_BOOST_SLOTS = 3;

/**
 * Ranks an already-bounded, already-alphabetical directory page by
 * pre-signup demand: at most `DISCOVERY_DEMAND_BOOST_SLOTS` businesses with
 * `demand > 0` move to the front (highest demand first, alphabetical
 * tiebreak — same normalizer as `GET /rpc/growth/demand`); every other
 * business — including any demand-having business beyond the boost cap —
 * keeps its original relative order. A page with zero demand across every
 * listed business is therefore identical, entry for entry, to the plain
 * alphabetical order it replaces.
 *
 * Pure function (no DB) so it is unit-testable with fixture data alone — see
 * `business-lead/ranking.test.ts`.
 */
export function rankBusinessesByDemand<T extends { name: string }>(
  orgs: readonly T[],
  demandByNormalizedName: ReadonlyMap<string, number>,
): T[] {
  const boosted = orgs
    .map((org) => ({
      org,
      demand: demandByNormalizedName.get(normalizeBusinessName(org.name)) ?? 0,
    }))
    .filter((entry) => entry.demand > 0)
    .sort((a, b) => b.demand - a.demand || a.org.name.localeCompare(b.org.name))
    .slice(0, DISCOVERY_DEMAND_BOOST_SLOTS)
    .map((entry) => entry.org);

  const boostedSet = new Set<T>(boosted);
  const rest = orgs.filter((org) => !boostedSet.has(org));
  return [...boosted, ...rest];
}
