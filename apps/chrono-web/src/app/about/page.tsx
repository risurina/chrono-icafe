import { notFound } from "next/navigation";
import { getRequestTenant } from "agora/next";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, buttonVariants } from "agora/ui";
import { cn } from "agora/ui/cn";
import Link from "next/link";

type BranchSummary = {
  id: string;
  name: string;
  address: string | null;
  operatingHours: string | null;
  contactNumber: string | null;
  email: string | null;
};

type LandingPageContent = {
  heroTagline: string | null;
  aboutBody: string | null;
  amenitiesBody: string | null;
  contactOverride: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

type PublicLandingPage = {
  content: LandingPageContent | null;
  branches: BranchSummary[];
  hasStations: boolean;
};

export default async function AboutPage() {
  const tenant = await getRequestTenant();

  if (!tenant.slug && !tenant.host) {
    notFound();
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
  const headers: Record<string, string> = {};
  if (tenant.slug) headers["x-tenant-slug"] = tenant.slug;
  else if (tenant.host) headers["x-tenant-host"] = tenant.host;

  const [landingRes, tenantRes] = await Promise.all([
    fetch(`${apiUrl}/public/landing-page`, { headers, cache: "no-store" }),
    fetch(`${apiUrl}/public/tenant`, { headers, cache: "no-store" }),
  ]);

  if (!landingRes.ok) {
    if (landingRes.status === 404) notFound();
    throw new Error(`Failed to fetch landing page: ${landingRes.statusText}`);
  }

  const { landingPage } = (await landingRes.json()) as { landingPage: PublicLandingPage | null };
  if (!landingPage) notFound();

  const tenantInfo = tenantRes.ok
    ? ((await tenantRes.json()) as { tenant: { name: string; slug: string } | null }).tenant
    : null;
  const venueName = tenantInfo?.name ?? "This business";

  const { content, branches, hasStations } = landingPage;

  // contactOverride blank -> fall back to the first branch's own contact info.
  const fallbackBranch = branches[0];
  const contact =
    content?.contactOverride ??
    [fallbackBranch?.contactNumber, fallbackBranch?.email].filter(Boolean).join(" · ") ??
    null;

  const ctaHref = content?.ctaHref ?? (hasStations ? "/stations" : null);
  const ctaLabel = content?.ctaLabel ?? (hasStations ? "See live station availability" : null);

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto max-w-3xl space-y-8 p-4 md:p-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{venueName}</h1>
          {content?.heroTagline ? (
            <p className="mt-2 text-lg text-muted-foreground">{content.heroTagline}</p>
          ) : null}
        </div>

        {content?.aboutBody ? (
          <Card>
            <CardHeader>
              <CardTitle>About</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm">{content.aboutBody}</p>
            </CardContent>
          </Card>
        ) : null}

        {content?.amenitiesBody ? (
          <Card>
            <CardHeader>
              <CardTitle>Amenities</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm">{content.amenitiesBody}</p>
            </CardContent>
          </Card>
        ) : null}

        {branches.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Locations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {branches.map((b) => (
                <div key={b.id} className="space-y-1">
                  <p className="font-medium">{b.name}</p>
                  {b.address ? (
                    <p className="text-sm text-muted-foreground">{b.address}</p>
                  ) : null}
                  {b.operatingHours ? (
                    <p className="text-sm text-muted-foreground">{b.operatingHours}</p>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {contact ? (
          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
              <CardDescription>{contact}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {ctaHref && ctaLabel ? (
          <Link href={ctaHref} className={cn(buttonVariants({ variant: "default" }))}>
            {ctaLabel}
          </Link>
        ) : null}
      </main>
    </div>
  );
}
