import type { Metadata } from "next";
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
export async function tenantPageMetadata(path = "/"): Promise<Metadata> {
  const [landing, branding, url] = await Promise.all([
    getTenantLanding(),
    getPublicBranding(),
    getTenantCanonicalUrl(path),
  ]);
  if (!landing) return {};

  const { resolved, venueName } = landing;
  const title = resolved.seo.title ?? venueName;
  const description =
    resolved.seo.description ?? resolved.hero.subtitle ?? undefined;

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
