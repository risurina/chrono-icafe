import { cache } from "react";
import {
  landingSnapshotSchema,
  resolveLandingConfig,
  type LandingConfig,
  type ResolvedLandingConfig,
  type SectionsConfig,
} from "agora";
import { getRequestTenant } from "@/lib/tenant";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/** The six legacy flat columns, still returned by `/public/landing-page`. */
type LegacyContent = {
  heroTagline: string | null;
  aboutBody: string | null;
  amenitiesBody: string | null;
  contactOverride: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
};

type BranchSummary = {
  contactNumber: string | null;
  email: string | null;
  address: string | null;
  operatingHours: string | null;
};

export type TenantLanding = {
  resolved: ResolvedLandingConfig;
  sections: SectionsConfig | null;
  themePreset: string | null;
  venueName: string;
  tenantSlug: string | null;
  hasStations: boolean;
};

/**
 * Map the legacy flat columns into the foundation's nested config shape, so a
 * tenant who configured their page before this feature landed still sees their
 * content. This is the lower-precedence layer of the cascade — anything they
 * set in the new editor wins.
 */
function legacyLayer(
  content: LegacyContent | null,
  branch: BranchSummary | undefined,
): LandingConfig {
  const contactLine =
    content?.contactOverride ??
    [branch?.contactNumber, branch?.email].filter(Boolean).join(" · ") ??
    null;

  return {
    hero: {
      title: content?.heroTagline ?? undefined,
      primaryCta:
        content?.ctaLabel && content?.ctaHref
          ? { label: content.ctaLabel, href: content.ctaHref }
          : undefined,
    },
    about: { body: content?.aboutBody ?? undefined },
    contact: {
      phone: contactLine ?? undefined,
      address: branch?.address ?? undefined,
      operatingHours: branch?.operatingHours ?? undefined,
    },
  };
}

/**
 * Resolve the current host tenant's landing page.
 *
 * `cache()`-wrapped so `generateMetadata` and the page body share one request.
 * Returns `null` only when there is no tenant to render at all — the apex, or a
 * host that resolves to no workspace.
 *
 * **A landing-page fetch failure is NOT null.** `resolveLandingConfig` is total
 * and every section carries defaults, so a tenant whose config is missing,
 * unpublished, or briefly unreachable still gets a complete page built from
 * defaults. Collapsing that into `null` used to 404 a live public host on a
 * transient API error — the failure mode this split exists to prevent.
 *
 * Note the published snapshot is the *first* cascade layer and the legacy
 * columns the second, so the new editor always wins over pre-existing content.
 */
export const getTenantLanding = cache(async (): Promise<TenantLanding | null> => {
  const t = await getRequestTenant();
  if (!t.slug && !t.host) return null;

  const headers: Record<string, string> = {};
  if (t.slug) headers["x-tenant-slug"] = t.slug;
  else if (t.host) headers["x-tenant-host"] = t.host;

  const [landingRes, tenantRes] = await Promise.allSettled([
    fetch(`${API_URL}/public/landing-page`, { headers, cache: "no-store" }),
    fetch(`${API_URL}/public/tenant`, { headers, cache: "no-store" }),
  ]);

  // The tenant must exist; everything else degrades to defaults.
  const tenantInfo = await readJson<{ tenant: { name: string; slug: string } | null }>(
    tenantRes,
  );
  if (!tenantInfo?.tenant) return null;

  const body = await readJson<{
    landingPage: {
      content: LegacyContent | null;
      branches: BranchSummary[];
      hasStations: boolean;
    } | null;
    published: { snapshot: unknown } | null;
  }>(landingRes);

  // Re-validate at the boundary rather than trusting a wire shape this side
  // never checked itself.
  const parsed = landingSnapshotSchema.safeParse(body?.published?.snapshot ?? {});
  const snapshot = parsed.success ? parsed.data : {};

  return {
    resolved: resolveLandingConfig([
      snapshot.config,
      legacyLayer(body?.landingPage?.content ?? null, body?.landingPage?.branches[0]),
    ]),
    sections: snapshot.sections ?? null,
    themePreset: snapshot.themePreset ?? null,
    venueName: tenantInfo.tenant.name,
    tenantSlug: t.slug ?? tenantInfo.tenant.slug,
    hasStations: body?.landingPage?.hasStations ?? false,
  };
});

/** Body of a settled, ok response — or `null` for anything else. */
async function readJson<T>(
  settled: PromiseSettledResult<Response>,
): Promise<T | null> {
  if (settled.status !== "fulfilled" || !settled.value.ok) return null;
  try {
    return (await settled.value.json()) as T;
  } catch {
    return null;
  }
}
