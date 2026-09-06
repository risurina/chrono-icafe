import type { MetadataRoute } from "next";
import { getRequestTenant } from "@/lib/tenant";
import { APP_DOMAIN, protocolFor } from "@/lib/app-domain";

/**
 * `robots.txt` — Next.js file-convention route, shared by every host this app
 * serves (apex, tenant subdomains, verified custom domains all resolve to this
 * same file; there is no per-host routing table).
 *
 * The allow/disallow rules are identical on every host on purpose: `/admin`
 * exists both on the apex (platform admin, `(saas-admin)/admin/*`) and, via
 * `next.config.ts`'s host-based rewrite, on every tenant host (the tenant
 * back office); `/dashboard` is that same tenant surface's underlying physical
 * path; `/portal` is both the apex's global-customer portal and each tenant's
 * own member portal. None of the three is ever meant to be indexed, on any
 * host, so there is nothing host-specific to branch on for the rules
 * themselves.
 *
 * What IS host-aware is the `Sitemap` directive: it always points at the
 * REQUESTING host's own `/sitemap.xml`, not a hardcoded apex URL — so a crawler
 * reading `venue.example.com/robots.txt` is pointed at
 * `venue.example.com/sitemap.xml` (that tenant's own self-scoped sitemap, see
 * `sitemap.ts`), never at the apex's cross-tenant one, and vice versa.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const t = await getRequestTenant();
  const host = t.host ?? (t.slug ? `${t.slug}.${APP_DOMAIN}` : APP_DOMAIN);
  const base = `${protocolFor(host)}://${host}`;

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/portal", "/admin"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
