import {
  hasPermission as baseHasPermission,
  requirePermission as baseRequirePermission,
  PERMISSION_STATEMENTS as FOUNDATION_PERMISSION_STATEMENTS,
  type PermissionRequest as FoundationPermissionRequest,
} from "agora/auth";
import { CHRONO_PERMISSION_STATEMENTS } from "./permissions";

/**
 * `agora/auth`'s own `PermissionRequest` type only covers foundation
 * resources — a business app's resources aren't known at packages/agora's
 * build time (see `permission-registry.ts`). This module re-types
 * `requirePermission`/`hasPermission` over the FOUNDATION + Chrono resource
 * vocabulary so Chrono's own route files get full compile-time key/action
 * checking. The underlying runtime function is identical — this is a
 * type-only wrapper, not a second gate.
 */
type ChronoStatements = typeof FOUNDATION_PERMISSION_STATEMENTS &
  typeof CHRONO_PERMISSION_STATEMENTS;
export type ChronoPermissionRequest = {
  [K in keyof ChronoStatements]?: ChronoStatements[K][number][];
};

export function requirePermission(
  actor: string | Record<string, string[]> | null | undefined,
  request: ChronoPermissionRequest,
): void {
  baseRequirePermission(actor, request as FoundationPermissionRequest);
}

export function hasPermission(
  actor: string | Record<string, string[]> | null | undefined,
  request: ChronoPermissionRequest,
): boolean {
  return baseHasPermission(actor, request as FoundationPermissionRequest);
}
