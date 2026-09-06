// Tenant public branding helpers are foundation server logic and live in
// `agora/next`; re-exported here so existing app call sites keep importing from
// `@/lib/branding`.
import { getPublicBranding as getPublicBrandingBase, type PublicBranding } from "agora/next";

export { brandingCss, hexToHslChannels, type PublicBranding } from "agora/next";

/**
 * Chrono's own extension of the foundation's `PublicBranding` shape:
 * `hidePlatformBranding` lives on the foundation's `TenantBrandings` row
 * (`packages/agora/src/core/db/schema/tenant.ts`) but is not part of the
 * foundation's business-neutral `PublicBranding` transport type — the
 * foundation stays silent on what "platform branding" even means. Chrono's
 * own `GET /public/branding` (`apps/chrono-api/src/app.ts`) puts the real
 * value on the wire regardless; this just gives it a type on this side too
 * (see growth-loop-hardening Phase 3).
 */
export type ChronoPublicBranding = PublicBranding & {
  hidePlatformBranding: boolean;
};

/**
 * Same request-scoped `cache()`d fetch as the foundation's `getPublicBranding()`
 * (root `layout.tsx`'s `generateMetadata` and body share the one call) — just
 * re-typed to include Chrono's own `hidePlatformBranding` field, which is
 * already present in the JSON `apps/chrono-api/src/app.ts` returns.
 */
export async function getPublicBranding(): Promise<ChronoPublicBranding | null> {
  const branding = await getPublicBrandingBase();
  return branding as ChronoPublicBranding | null;
}
