/**
 * Server-only `ValidateScopes` implementations for Chrono's realtime mounts.
 *
 * Split out of `./contracts` (which is re-exported to the browser via the
 * package's `./realtime` and, transitively, `./station` subpaths — see
 * `.ai/rules/dto.md`) because these two functions are the only pieces here
 * that touch the database. Keeping them in the same file as the client-safe
 * Zod schemas pulled `agora/db` (and thus a `DATABASE_URL` requirement) into
 * every web-app import of the pure contracts, which broke `chrono-web`'s
 * production build (static generation for pages like `/about` that import
 * `@agora/chrono-api/station` for its schemas alone).
 */

import { withTenant, inArray } from "agora/db";
import type { ResolvedActor, ValidateScopes } from "agora/realtime";
import { chronoBranch } from "../branch/schema";
import { type ChronoRealtimeScopeKind, parseChronoScope } from "./contracts";

/**
 * Chrono's `ValidateScopes` for the staff realtime mount. Receives the
 * transport's already lowercased/deduped/capped well-formed scope set
 * (per `agora/realtime`'s `realtimeScopeSetSchema` pipeline) and the resolved
 * actor, and returns only the subset naming a branch that actually belongs to
 * the caller's tenant — ONE batched `chronoBranch` query for the whole set,
 * never one query per scope (see `ValidateScopes`'s own doc comment on why a
 * per-scope callback would be a self-inflicted amplification vector).
 */
export const validateChronoScopes: ValidateScopes = async (
  scopes: string[],
  actor: ResolvedActor,
): Promise<string[]> => {
  const parsed = scopes
    .map((scope) => ({ scope, parsed: parseChronoScope(scope) }))
    .filter(
      (entry): entry is { scope: string; parsed: { kind: ChronoRealtimeScopeKind; branchId: string } } =>
        entry.parsed !== null,
    );
  if (parsed.length === 0) return [];

  const branchIds = [...new Set(parsed.map((entry) => entry.parsed.branchId))];

  const ownedBranchIds = await withTenant(actor.tenantId, (tx) =>
    tx
      .select({ id: chronoBranch.id })
      .from(chronoBranch)
      .where(inArray(chronoBranch.id, branchIds)),
  ).then((rows) => new Set(rows.map((row) => row.id)));

  return parsed
    .filter((entry) => ownedBranchIds.has(entry.parsed.branchId))
    .map((entry) => entry.scope);
};

/**
 * Chrono's `ValidateScopes` for the device realtime mount. No DB query
 * needed — the only fact that matters is already on the resolved actor
 * (`actor.actorKey` IS the device's own id), so this is a pure string
 * comparison, not a batched lookup like the staff validator above. Lives
 * here (not `./contracts`) purely so both mounts' validators stay together;
 * it has no actual database dependency itself.
 */
export const validateChronoDeviceScopes: ValidateScopes = async (
  scopes: string[],
  actor: ResolvedActor,
): Promise<string[]> => {
  return scopes.filter((scope) => {
    const match = CHRONO_DEVICE_SCOPE_PATTERN.exec(scope);
    return match !== null && match[1] === actor.actorKey;
  });
};

const CHRONO_DEVICE_SCOPE_PATTERN = /^device:([A-Za-z0-9_-]{1,64})$/;
