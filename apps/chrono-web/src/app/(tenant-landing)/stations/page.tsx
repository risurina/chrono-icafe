import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PageShell, Main, Section, Stack, SectionHeading } from "agora/ui";
import { getRequestTenant } from "@/lib/tenant";
import { getPublicBranding } from "@/lib/branding";
import { getTenantLanding } from "@/lib/landing";
import { tenantPageMetadata } from "@/lib/seo";
import { TenantHeader, TenantFooter } from "@/components/landing/marketing-chrome";
import { StationAvailabilityPoller } from "./client";

export async function generateMetadata(): Promise<Metadata> {
  return tenantPageMetadata("/stations", (venueName) => ({
    title: `${venueName} — Live station availability`,
    description: `See which stations are free at ${venueName} right now.`,
  }));
}

export default async function PublicStationsPage() {
  const tenant = await getRequestTenant();

  if (!tenant.slug && !tenant.host) {
    notFound();
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
  const headers: Record<string, string> = {};
  if (tenant.slug) headers["x-tenant-slug"] = tenant.slug;
  else if (tenant.host) headers["x-tenant-host"] = tenant.host;

  // Initial data is fetched server-side; the client then polls.
  // Tenant resolution and the terminal-status guard both live in the API — a
  // suspended, cancelled, archived or unknown tenant answers 404 there, which
  // is why that status maps straight to `notFound()` and nothing else does.
  const res = await fetch(`${apiUrl}/public/stations`, {
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    if (res.status === 404) notFound();
    throw new Error(`Failed to fetch public stations: ${res.statusText}`);
  }

  const initialData = await res.json();

  // Branding + venue name for the shared tenant chrome. Both are cache()d and
  // already fetched by this tenant's other public surfaces.
  const [branding, landing] = await Promise.all([
    getPublicBranding(),
    getTenantLanding(),
  ]);
  const venueName =
    branding?.displayName?.trim() || landing?.venueName || "this venue";
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
        <Section maxWidth="full" className="py-12">
          <Stack gap={8}>
            <SectionHeading
              eyebrow="Live now"
              title={`${venueName} — Live PC availability`}
              description="Updated every 15 seconds. Available means the station is free to take right now; in use means someone is playing on it."
            />
            <StationAvailabilityPoller
              initialData={initialData}
              venueName={venueName}
            />
          </Stack>
        </Section>
      </Main>

      <TenantFooter
        year={currentYear}
        tenantName={venueName}
        tagline={branding?.tagline}
      />
    </PageShell>
  );
}
