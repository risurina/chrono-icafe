/**
 * Chrono's merged feature-flag and module registries — the injection seam
 * for `agora/server`'s `featureFlagRoutes()`/`moduleRoutes()` (and their
 * underlying `getTenantFlag`/`resolveTenantModules` functions). See
 * `.ai/rules/business-app.md`, "Extension seams," for why this is a plain
 * merge (not a mutable registry like the permission seam): both subsystems
 * are read from server and web bundles alike, with no controlled "first
 * import" to freeze a global registration on.
 *
 * `chrono.autoApproveMembers` is Chrono's first own flag (customer-onboarding
 * Phase 1, `.ai/plans/chrono/active/customer-onboarding/README.md`, Decision
 * 1) — default `false` (self-service portal signup stays `pending`, matching
 * oikos's own vetting behavior); a tenant that wants instant access flips it
 * on. Never edit `packages/agora/src/contracts/feature-flags.ts` or
 * `module-registry.ts` to add Chrono-specific data — this file is the seam.
 */
import {
  buildFeatureFlagRegistry,
  buildModuleRegistry,
  type FeatureFlagKey,
  type FeatureFlagRegistry,
} from "agora";
import { getTenantFlag as baseGetTenantFlag } from "agora/server";

export const CHRONO_FEATURE_FLAGS = buildFeatureFlagRegistry({
  "chrono.autoApproveMembers": {
    default: false,
    label: "Auto-approve members",
    description:
      "Skip staff review — a self-service portal signup is instantly approved.",
    category: "Customers",
  },
});
export const CHRONO_MODULES = buildModuleRegistry({});

/**
 * `agora/server`'s `getTenantFlag` types `key` as the FOUNDATION-only
 * `FeatureFlagKey` literal union, so passing a Chrono-owned key is a type
 * error — the same type-only-layer trade-off `auth/require-permission.ts`
 * makes for permissions (`.ai/rules/business-app.md`, "Extension seams").
 * This re-types it over the merged registry's keys; the underlying runtime
 * function and its `registry` argument are unchanged.
 */
export type ChronoFeatureFlagKey = keyof typeof CHRONO_FEATURE_FLAGS.flags;

export function getChronoTenantFlag(
  tenantId: string,
  key: ChronoFeatureFlagKey,
  registry: FeatureFlagRegistry = CHRONO_FEATURE_FLAGS,
): Promise<boolean> {
  return baseGetTenantFlag(tenantId, key as FeatureFlagKey, registry);
}
