/**
 * Chrono's merged feature-flag and module registries — the injection seam
 * for `agora/server`'s `featureFlagRoutes()`/`moduleRoutes()` (and their
 * underlying `getTenantFlag`/`resolveTenantModules` functions). See
 * `.ai/rules/business-app.md`, "Extension seams," for why this is a plain
 * merge (not a mutable registry like the permission seam): both subsystems
 * are read from server and web bundles alike, with no controlled "first
 * import" to freeze a global registration on.
 *
 * Empty today — Chrono has no flag or module of its own yet. Add entries
 * here when it does; never edit `packages/agora/src/contracts/feature-flags.ts`
 * or `module-registry.ts` to add Chrono-specific data.
 */
import {
  buildFeatureFlagRegistry,
  buildModuleRegistry,
} from "agora";

export const CHRONO_FEATURE_FLAGS = buildFeatureFlagRegistry({});
export const CHRONO_MODULES = buildModuleRegistry({});
