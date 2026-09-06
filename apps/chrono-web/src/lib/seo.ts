import type { Metadata } from "next";
import type { PublicBranding } from "agora/next";
import type { PublicVenueInfoResponse } from "@/lib/venue";
import { getPublicBranding } from "@/lib/branding";
import { getTenantLanding } from "@/lib/landing";
import { getTenantCanonicalUrl } from "@/lib/tenant";

/**
 * Metadata for a public tenant surface (`/`, `/about`).
 *
 * `generateMetadata` is a file-level export with no "tenant branch", so an apex
 * render must opt out by returning `{}` — the root layout's own tenant-aware
 * title/description then still applies, unchanged. That is what a `null`
 * landing resolves to here.
 *
 * Open Graph is the real gap this fills: neither public page emitted any OG
 * tags, so a shared link rendered as a bare URL. `og:image` uses the tenant's
 * own logo when it has one and is omitted entirely otherwise — no hero/OG image
 * field exists, and a placeholder would be a fabricated brand asset.
 */
export async function tenantPageMetadata(
  path = "/",
  /**
   * Copy for a tenant surface that is not the landing page itself (e.g.
   * `/stations`), where the tenant's own SEO title would describe the wrong
   * page. Omit it and the landing config's SEO fields are used.
   */
  copy?: (venueName: string) => { title: string; description: string },
): Promise<Metadata> {
  const [landing, branding, url] = await Promise.all([
    getTenantLanding(),
    getPublicBranding(),
    getTenantCanonicalUrl(path),
  ]);
  if (!landing) return {};

  const { resolved, venueName } = landing;
  const displayName = branding?.displayName?.trim() || venueName;
  const override = copy?.(displayName);
  const title = override?.title ?? resolved.seo.title ?? venueName;
  const description =
    override?.description ??
    resolved.seo.description ??
    resolved.hero.subtitle ??
    undefined;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      ...(url ? { url } : {}),
      ...(branding?.logoUrl ? { images: [{ url: branding.logoUrl }] } : {}),
    },
  };
}

/** Minimal identity fields a caller must supply alongside `venue`/`branding`. */
export type TenantStructuredDataSeo = {
  /** The tenant's display name (falls back to its org name upstream). */
  name: string;
  /** Absolute canonical URL for this tenant's page, from `getTenantCanonicalUrl()`. */
  url: string | null;
  /** Page description — the same copy used for `<meta name="description">`. */
  description: string | null;
};

const SCHEMA_DAY_OF_WEEK: Record<string, string> = {
  sunday: "https://schema.org/Sunday",
  monday: "https://schema.org/Monday",
  tuesday: "https://schema.org/Tuesday",
  wednesday: "https://schema.org/Wednesday",
  thursday: "https://schema.org/Thursday",
  friday: "https://schema.org/Friday",
  saturday: "https://schema.org/Saturday",
};

/**
 * `schema.org/EntertainmentBusiness` JSON-LD for a tenant's public page.
 *
 * `EntertainmentBusiness` (a `LocalBusiness` subtype) is the closer fit over
 * bare `LocalBusiness`: a gaming café / iCafe is a venue people visit for
 * entertainment, not a generic storefront, and schema.org's own hierarchy
 * offers no more specific "internet café" or "gaming lounge" type.
 *
 * Every field is sourced from data the caller already fetched for the page
 * (`getTenantVenueInfo()`, `getPublicBranding()`, `getTenantLanding()` +
 * `getTenantCanonicalUrl()`) — no new API calls. Any field with no real value
 * is omitted entirely, never emitted as an empty string or placeholder, so a
 * tenant with minimal setup still gets valid, non-spammy structured data.
 *
 * Returns `null` only when there is nothing at all to say beyond a bare name
 * (never happens in practice, since `name` is always present for a rendered
 * tenant page) — kept for symmetry with the other `get*`/`null`-returning
 * helpers in this app rather than forcing every field to be optional at the
 * call site.
 */
export function tenantStructuredData(
  venue: PublicVenueInfoResponse | null,
  branding: PublicBranding | null,
  seo: TenantStructuredDataSeo,
): Record<string, unknown> | null {
  if (!seo.name) return null;

  const branch = venue?.branch ?? null;

  const sameAs = branch?.socialLinks
    ? Object.values(branch.socialLinks).filter(
        (href): href is string => typeof href === "string" && href.length > 0,
      )
    : [];

  const openingHoursSpecification = branch?.hoursConfig
    ? Object.entries(branch.hoursConfig)
        .map(([day, hours]) => {
          if (!hours || hours === "closed") return null;
          const [opens, closes] =
            hours === "24h" ? ["00:00", "23:59"] : [hours.open, hours.close];
          return {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: SCHEMA_DAY_OF_WEEK[day],
            opens,
            closes,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  return {
    "@context": "https://schema.org",
    "@type": "EntertainmentBusiness",
    name: seo.name,
    ...(seo.description ? { description: seo.description } : {}),
    ...(seo.url ? { url: seo.url } : {}),
    ...(branding?.logoUrl ? { image: branding.logoUrl } : {}),
    ...(branch?.contactNumber ? { telephone: branch.contactNumber } : {}),
    ...(branch?.email ? { email: branch.email } : {}),
    ...(branch?.address
      ? { address: { "@type": "PostalAddress", streetAddress: branch.address } }
      : {}),
    ...(branch?.googleMapsUrl ? { hasMap: branch.googleMapsUrl } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(openingHoursSpecification.length > 0 ? { openingHoursSpecification } : {}),
  };
}
