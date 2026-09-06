import type { MetadataRoute } from "next";
import { searchBusinesses } from "@/lib/discover-client";
import { getRequestTenant } from "@/lib/tenant";
import { getPublicTenant } from "agora/next";
import { APP_DOMAIN, protocolFor, apexUrl } from "@/lib/app-domain";

/**
 * `sitemap.xml` — Next.js file-convention route, shared by every host this
 * app serves (see `robots.ts`'s own header comment for why there is only one
 * such file). Content is host-aware:
 *
 * - **A tenant host** (subdomain or verified custom domain) gets a minimal,
 *   SELF-scoped sitemap: just its own two public pages, `/` and `/about`
 *   (`.ai/plans/chrono/archive/tenant-landing`). It deliberately does NOT
 *   repeat the apex's marketing routes or any other tenant's URL — a crawler
 *   reading `venue.example.com/sitemap.xml` has no reason to be told about
 *   `chrono.example.com/pricing` or a *different* venue's subdomain, and
 *   doing so would misattribute those URLs' authority to the wrong host.
 * - **The apex** gets the full listing the plan asks for: its own marketing
 *   routes, plus one entry per tenant with a PUBLISHED landing page.
 *
 * Revalidated hourly rather than computed on every crawl hit — this ties
 * directly into the tenant-listing limitation below (avoids repeatedly
 * hammering the discover endpoint's own rate limiter for a page that changes
 * at most a few times a day).
 */
export const revalidate = 3600;

/**
 * The apex's own marketing content pages — everything under
 * `(apex-marketing)/*` plus the homepage and `/discover`. Deliberately
 * excludes auth/transactional pages (`/login`, `/sign-up`, `/new-business`,
 * the tenant-only `/contact`) — not marketing content, not what a search
 * engine should rank.
 */
const APEX_MARKETING_PATHS = [
  "/",
  "/pricing",
  "/discover",
  "/company/about",
  "/company/contact",
  "/download",
  "/support",
  "/privacy",
  "/terms",
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const t = await getRequestTenant();
  const now = new Date();

  if (t.kind !== "apex") {
    const host = t.host ?? (t.slug ? `${t.slug}.${APP_DOMAIN}` : null);
    if (!host) return [];
    // A subdomain/custom-domain host parse is a pure string parse — it does
    // not confirm a tenant actually exists there. `/` and `/about` 404 an
    // unresolvable tenant (see `getTenantLanding()`), so this must too, rather
    // than publishing a sitemap for two pages that don't render.
    const tenant = await getPublicTenant();
    if (!tenant) return [];
    const base = `${protocolFor(host)}://${host}`;
    return [
      { url: `${base}/`, lastModified: now },
      { url: `${base}/about`, lastModified: now },
    ];
  }

  const entries: MetadataRoute.Sitemap = APEX_MARKETING_PATHS.map((path) => ({
    url: apexUrl(path),
    lastModified: now,
  }));

  /**
   * Every tenant with a published landing page, reusing the EXACT predicate
   * `GET /public/discover/businesses` already enforces (foundation
   * `tenantLandingPage.published IS NOT NULL` + org status outside
   * `TERMINAL_TENANT_STATUSES`) — see
   * `apps/chrono-api/src/modules/business-lead/routes.ts`. This phase is
   * locked to adding new `chrono-web` files only (no `chrono-api` route
   * changes), so the tenant list is sourced by calling that SAME existing
   * endpoint rather than adding a new one.
   *
   * KNOWN LIMITATION (disclosed, not silent): that endpoint is a human search
   * box, not an enumeration API — its query schema requires a non-empty `q`
   * and it hard-caps results at `DISCOVER_RESULT_LIMIT` (20,
   * `business-lead/contracts.ts`). `q: "%"` is a SQL ILIKE wildcard that
   * matches every business name (the route builds `%${q}%`, so this becomes
   * `%%%`, matching any string) — it reuses the identical predicate and code
   * path with zero API changes, but on a deployment with more than 20
   * published tenants, this sitemap will not list all of them. Under-
   * inclusion (a real tenant simply missing from the sitemap) is the correct
   * failure direction here — the same "render less, never more" stance this
   * codebase already takes for unknown landing-section keys — but a
   * dedicated, unbounded, sitemap-only listing endpoint would remove this cap
   * if that's ever needed; flagged for the developer rather than built here,
   * since adding one is a `chrono-api` change outside this phase's locked
   * scope.
   */
  const result = await searchBusinesses({ q: "%" });
  if (result.ok) {
    for (const business of result.businesses) {
      const host = `${business.slug}.${APP_DOMAIN}`;
      const base = `${protocolFor(host)}://${host}`;
      entries.push({ url: `${base}/`, lastModified: now });
    }
  }

  return entries;
}
