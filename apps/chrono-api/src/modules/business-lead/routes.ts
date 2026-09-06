import { Hono } from "hono";
import {
  withAdmin,
  adminDb,
  schema as base,
  eq,
  and,
  or,
  asc,
  count,
  ilike,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "agora/db";
import {
  type TenantVars,
  HttpError,
  zValidator,
  createRateLimiter,
  clientIp,
  TERMINAL_TENANT_STATUSES,
} from "agora/server";
import { getCustomerContext, type CustomerContext } from "agora/customer-auth";
import { requirePermission } from "../../auth/require-permission";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoBusinessLead } from "./schema";
import {
  createBusinessLeadSchema,
  discoverBusinessesQuerySchema,
  normalizeBusinessName,
  DISCOVER_RESULT_LIMIT,
  type BusinessDirectoryResult,
} from "./contracts";

/**
 * Public-read throttle. 60/min per IP — the same ceiling as `app.ts`'s
 * `landingPageIpLimiter`, the closest public-read analogue.
 */
const discoverReadLimiter = createRateLimiter(60, 60 * 1000, "discover-read-ip");

/**
 * Lead-write throttle. Anonymous submission (no auth required — see the
 * handler below), so this mirrors `modules/company-inquiry/public-routes.ts`'s
 * `companyInquiryPublicLimiter` exactly: 10/hour per IP, the only signal an
 * anonymous caller carries. The per-customer limiter below is an *additional*
 * ceiling that only applies when a global customer happens to be signed in.
 */
const leadWriteIpLimiter = createRateLimiter(10, 60 * 60 * 1000, "business-lead-ip");
const leadWriteCustomerLimiter = createRateLimiter(
  10,
  60 * 60 * 1000,
  "business-lead-customer",
);

/**
 * Best-effort, non-throwing session read. Submission never requires a global
 * customer account (see the handler below); when one happens to be signed in,
 * its id is captured on the lead. Any auth failure (missing/expired session)
 * is treated as a plain anonymous submission, never a 401.
 */
async function tryGetCustomerContext(
  c: Parameters<typeof getCustomerContext>[0],
): Promise<CustomerContext | null> {
  try {
    return await getCustomerContext(c);
  } catch {
    return null;
  }
}

/** Short response cache, keyed on the normalized query — see the plan's assumption 13. */
const discoverCache = new Map<string, { at: number; data: BusinessDirectoryResult[] }>();
const DISCOVER_CACHE_TTL_MS = 15_000;

/**
 * The public, cross-tenant business directory + the cold-start lead capture.
 *
 * Mounted on `app` at `/public/discover`, OUTSIDE `/rpc` — there is no single
 * tenant to resolve here (this reads across every listed tenant at once), and
 * `/rpc` would 401 an anonymous caller before the handler ran. See
 * `apps/chrono-api/AGENTS.md`, "Unauthenticated routes".
 */
export function businessLeadPublicRoutes() {
  return new Hono()
    /**
     * Cross-tenant directory search.
     *
     * Uses `withAdmin`, so **RLS is bypassed on this path** — the explicit
     * predicates below are the only thing scoping it. Same bypass class as the
     * foundation's `readPublishedLandingPage`, generalized from one tenant to
     * many. `rls:proof` does not cover this route; the cross-tenant e2e case is
     * its proof.
     *
     * A tenant appears here if and only if it has AFFIRMATIVELY published a
     * landing page (`tenantLandingPage.published IS NOT NULL`). Publishing is
     * the consent signal for being listed; unpublishing is a complete, immediate
     * opt-out. Chrono's own legacy `ChronoLandingPages` content columns
     * deliberately do NOT qualify — they predate this surface and were never a
     * decision to be listed platform-wide.
     */
    .get("/businesses", zValidator("query", discoverBusinessesQuerySchema), async (c) => {
      const ip = clientIp(c);
      const retryAfter = await discoverReadLimiter.blockedFor(ip);
      if (retryAfter !== null) {
        return c.json({ error: "Too many requests. Try again shortly." }, 429, {
          "Retry-After": String(retryAfter),
        });
      }
      await discoverReadLimiter.record(ip);

      const { q, city } = c.req.valid("query");
      const cacheKey = `${normalizeBusinessName(q)}|${city ? normalizeBusinessName(city) : ""}`;
      const now = Date.now();
      const cached = discoverCache.get(cacheKey);
      if (cached && now - cached.at < DISCOVER_CACHE_TTL_MS) {
        return c.json(cached.data);
      }

      const pattern = `%${q}%`;
      const cityPattern = city ? `%${city}%` : null;

      const results = await withAdmin(async (tx) => {
        // 1. Eligible organizations, BOUNDED. Every predicate is in SQL and
        //    therefore applied before the LIMIT — a JS-side filter after the
        //    limit would silently under-return while eligible tenants sat just
        //    past the cut.
        const orgs = await tx
          .select({
            organizationId: base.organization.id,
            name: base.organization.name,
            slug: base.organization.slug,
            orgLogo: base.organization.logo,
            brandingLogo: base.tenantBranding.logoUrl,
          })
          .from(base.organization)
          // INNER join: no published landing page, no listing.
          .innerJoin(
            base.tenantLandingPage,
            and(
              eq(base.tenantLandingPage.tenantId, base.organization.id),
              isNotNull(base.tenantLandingPage.published),
            ),
          )
          .leftJoin(
            base.tenantBranding,
            eq(base.tenantBranding.tenantId, base.organization.id),
          )
          .where(
            and(
              // Terminal statuses only — `trial` and `pending` are live states,
              // and a business that just signed up because a player invited them
              // is exactly the tenant this loop must not hide.
              notInArray(base.organization.status, [...TERMINAL_TENANT_STATUSES]),
              or(ilike(base.organization.name, pattern), ilike(base.organization.slug, pattern)),
              cityPattern
                ? sql`exists (select 1 from ${chronoBranch} b where b."tenantId" = ${base.organization.id} and b."status" = 'active' and b."address" ilike ${cityPattern})`
                : undefined,
            ),
          )
          .orderBy(asc(base.organization.name))
          .limit(DISCOVER_RESULT_LIMIT);

        if (orgs.length === 0) return [] as BusinessDirectoryResult[];
        const orgIds = orgs.map((o) => o.organizationId);

        // 2. One query for every matched org's active branches — not a per-org
        //    loop. `locationText` is the earliest-created active branch's
        //    address; a disabled branch is never advertised.
        const branches = await tx
          .select({
            tenantId: chronoBranch.tenantId,
            address: chronoBranch.address,
          })
          .from(chronoBranch)
          .where(and(inArray(chronoBranch.tenantId, orgIds), eq(chronoBranch.status, "active")))
          .orderBy(asc(chronoBranch.tenantId), asc(chronoBranch.createdAt));

        const firstAddress = new Map<string, string | null>();
        for (const b of branches) {
          if (!firstAddress.has(b.tenantId)) firstAddress.set(b.tenantId, b.address);
        }

        // 3. One grouped aggregate for live availability, restricted to
        //    stations under active branches so it matches what the tenant's own
        //    public /stations page shows.
        const availability = await tx
          .select({
            tenantId: chronoStation.tenantId,
            total: count(),
            available: sql<number>`count(*) filter (where ${chronoStation.status} = 'available')`,
          })
          .from(chronoStation)
          .innerJoin(
            chronoBranch,
            and(eq(chronoBranch.id, chronoStation.branchId), eq(chronoBranch.status, "active")),
          )
          .where(inArray(chronoStation.tenantId, orgIds))
          .groupBy(chronoStation.tenantId);

        const availabilityByTenant = new Map(
          availability.map((a) => [
            a.tenantId,
            { available: Number(a.available), total: Number(a.total) },
          ]),
        );

        return orgs.map<BusinessDirectoryResult>((o) => ({
          organizationId: o.organizationId,
          name: o.name,
          slug: o.slug,
          logoUrl: o.brandingLogo ?? o.orgLogo ?? null,
          locationText: firstAddress.get(o.organizationId) ?? null,
          // null, never {0,0} — a business with no stations must render no
          // availability line rather than a misleading "0 of 0 available".
          liveAvailability: availabilityByTenant.get(o.organizationId) ?? null,
        }));
      });

      discoverCache.set(cacheKey, { at: now, data: results });
      // Zero matches is a normal 200 with an empty array, never a 404 — the
      // empty state is a UI concern (it offers the invite form), not an error.
      return c.json(results);
    })

    /**
     * Cold-start lead capture: "this business isn't here, bring them in".
     *
     * Anonymous — no session required, matching
     * `modules/company-inquiry/public-routes.ts`'s pattern. When a global
     * customer happens to be signed in, their id is captured on the row (an
     * extra, additive per-customer throttle applies in that case); otherwise
     * the lead is recorded with no requester identity at all. Nothing about
     * the submitted lead is echoed back — the response is the new row's id
     * and nothing else.
     */
    .post("/business-leads", zValidator("json", createBusinessLeadSchema), async (c) => {
      const ip = clientIp(c);
      const ipRetryAfter = await leadWriteIpLimiter.blockedFor(ip);
      if (ipRetryAfter !== null) {
        return c.json({ error: "Too many requests. Try again later." }, 429, {
          "Retry-After": String(ipRetryAfter),
        });
      }

      // Never throws — a missing/expired session just means an anonymous
      // submission, not a 401.
      const customer = await tryGetCustomerContext(c);

      if (customer) {
        const customerRetryAfter = await leadWriteCustomerLimiter.blockedFor(customer.customerId);
        if (customerRetryAfter !== null) {
          return c.json({ error: "Too many requests. Try again later." }, 429, {
            "Retry-After": String(customerRetryAfter),
          });
        }
      }

      const { businessName, city, message } = c.req.valid("json");

      const [row] = await adminDb
        .insert(chronoBusinessLead)
        .values({
          businessName,
          // Same normalizer the demand read applies to the organization name.
          businessNameNormalized: normalizeBusinessName(businessName),
          city: city ?? null,
          message: message ?? null,
          requesterCustomerId: customer?.customerId ?? null,
        })
        .returning({ id: chronoBusinessLead.id });

      if (!row) throw new HttpError(400, "Could not record the request.");

      await leadWriteIpLimiter.record(ip);
      if (customer) await leadWriteCustomerLimiter.record(customer.customerId);

      return c.json({ id: row.id }, 201);
    });
}

/**
 * Tenant-scoped demand read — how many players asked for THIS business before
 * it joined.
 *
 * `ChronoBusinessLeads` is not under RLS, so the normalized-name predicate
 * below is the ONLY isolation on this route. The name it matches against is
 * read from the caller's own organization row via `c.var.tenant.tenantId` and
 * is never accepted from client input. `rls:proof` does not cover this; the
 * cross-tenant e2e case is its proof — the same stance the foundation takes for
 * `readPublishedLandingPage`.
 *
 * Returns a bare count. It never returns a lead field or a requester identity,
 * so it cannot become a back-door lead read.
 */
export function growthRoutes() {
  return new Hono<{ Variables: TenantVars }>().get("/demand", async (c) => {
    requirePermission(c.var.tenant.permissions, { growth: ["read"] });

    const { tenantId } = c.var.tenant;

    // `organization` is not RLS-scoped (it is not in BASE_TENANT_TABLES), so it
    // is read via adminDb with an explicit id filter — the same treatment
    // `member`/`invitation` get.
    const [org] = await adminDb
      .select({ name: base.organization.name })
      .from(base.organization)
      .where(eq(base.organization.id, tenantId))
      .limit(1);

    if (!org) throw new HttpError(404, "Tenant not found.");

    const [row] = await adminDb
      .select({ value: count() })
      .from(chronoBusinessLead)
      .where(
        eq(chronoBusinessLead.businessNameNormalized, normalizeBusinessName(org.name)),
      );

    return c.json({ count: Number(row?.value ?? 0) });
  });
}
