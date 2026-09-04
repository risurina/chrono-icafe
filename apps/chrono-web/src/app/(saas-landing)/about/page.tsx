import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PageShell, Main } from "agora/ui";
import { getPublicBranding } from "@/lib/branding";
import { getTenantLanding } from "@/lib/landing";
import { LandingSections } from "@/components/landing/render";
import { TenantHeader, TenantFooter } from "@/components/landing/marketing-chrome";

/**
 * A tenant's public landing page.
 *
 * Registry-driven: this file names no section. Which sections render, and in
 * what order, comes from the tenant's published config resolved against
 * `CHRONO_LANDING_SECTIONS` — so re-ordering or hiding a section is a settings
 * change, not a code change.
 *
 * Previously this page hand-rolled raw `div`/`main` chrome with no shared
 * header or footer, which `.ai/rules/component-first-ui.md` prohibits; it now
 * uses the same shell as every other surface.
 */

export async function generateMetadata(): Promise<Metadata> {
  // Shares one request with the page body via the cache()d resolver.
  const landing = await getTenantLanding();
  if (!landing) return {};
  const { resolved, venueName } = landing;
  return {
    title: resolved.seo.title ?? venueName,
    description: resolved.seo.description ?? resolved.hero.subtitle ?? undefined,
  };
}

export default async function AboutPage() {
  const landing = await getTenantLanding();
  if (!landing) notFound();

  const branding = await getPublicBranding();
  const { resolved, sections, venueName, tenantSlug } = landing;
  const currentYear = new Date().getFullYear();

  return (
    <PageShell>
      <TenantHeader
        tenantName={venueName}
        displayName={branding?.displayName}
        logoUrl={branding?.logoUrl}
        logoDarkUrl={branding?.logoDarkUrl}
      />

      <Main>
        <LandingSections
          surface="tenant"
          sections={sections}
          resolved={resolved}
          context={{ tenantName: venueName, tenantSlug }}
        />
      </Main>

      <TenantFooter
        year={currentYear}
        tenantName={venueName}
        tagline={branding?.tagline}
      />
    </PageShell>
  );
}
