/**
 * Chrono's realtime vocabulary — event contracts + scope grammar for the
 * foundation's `createRealtimeRoute` staff mount (`agora/realtime`,
 * `.ai/plans/agora/archive/websocket-foundation/README.md`).
 *
 * This module owns no table and no service, only contracts + the
 * `validateScopes` function the staff mount is configured with — the same
 * "no entity of its own" shape as `reconciliation`
 * (`apps/chrono-api/src/modules/reconciliation/`).
 *
 * See `.ai/plans/chrono/active/realtime-updates/README.md`, "Staff dashboard
 * wiring" and Phase 1.
 */

import { z } from "zod";
import { withTenant, inArray } from "agora/db";
import type { ResolvedActor, ValidateScopes } from "agora/realtime";
import { chronoBranch } from "../branch/schema";

// ---------------------------------------------------------------------------
// Event contracts (server -> staff browser, published on tenant/branch/
// branch-summary/device channels). Client-safe Zod schemas per .ai/rules/dto.md
// — these cross the browser boundary via the "./realtime" package export.
// ---------------------------------------------------------------------------

/** Station status is free text, not a pg enum — see station/schema.ts's own column comment. */
export const chronoStationStatusSchema = z.enum([
  "available",
  "occupied",
  "maintenance",
  "offline",
]);

/** Session status — see session/schema.ts's own column comment. */
export const chronoSessionStatusSchema = z.enum(["active", "paused", "ended"]);

/** Published whenever a station's status transitions (create/update, or a
 * session/device action that changes it). */
export const stationStatusEventSchema = z.object({
  stationId: z.string(),
  branchId: z.string(),
  status: chronoStationStatusSchema,
});
export type StationStatusEvent = z.infer<typeof stationStatusEventSchema>;

/** Aggregate per-status station counts for one branch — the multi-branch
 * overview's payload; never per-station detail (see the plan's "the provider
 * is channel-keyed with no per-event filter" reasoning for why this is a
 * separate scope/channel from `station.status`, not a filtered view of it). */
export const branchSummaryEventSchema = z.object({
  branchId: z.string(),
  counts: z.object({
    available: z.number().int().nonnegative(),
    occupied: z.number().int().nonnegative(),
    maintenance: z.number().int().nonnegative(),
    offline: z.number().int().nonnegative(),
  }),
  total: z.number().int().nonnegative(),
});
export type BranchSummaryEvent = z.infer<typeof branchSummaryEventSchema>;

/** Published on session start/pause/resume/extend/end, to the branch channel
 * and (Phase 3) the affected station's device private channel. */
export const sessionStateEventSchema = z.object({
  sessionId: z.string(),
  stationId: z.string(),
  status: chronoSessionStatusSchema,
});
export type SessionStateEvent = z.infer<typeof sessionStateEventSchema>;

// ---------------------------------------------------------------------------
// Scope grammar (client -> server, via ?scope= on the upgrade request).
// ---------------------------------------------------------------------------

/**
 * The two scope kinds this plan defines, per the "Scope vocabulary" table:
 * `branch:{id}` -> tenant:{t}:branch:{id}, carries per-station station.status;
 * `branch-summary:{id}` -> tenant:{t}:branch-summary:{id}, carries only
 * branch.summary counts. Both validate identically (the branch exists and
 * belongs to the caller's tenant) — the split exists purely so a
 * multi-branch overview never receives the higher-volume per-station stream.
 */
export const chronoRealtimeScopeKindSchema = z.enum(["branch", "branch-summary"]);

const CHRONO_SCOPE_PATTERN = /^(branch|branch-summary):([A-Za-z0-9_-]{1,64})$/;

export const chronoRealtimeScopeSchema = z.string().regex(CHRONO_SCOPE_PATTERN);

export type ChronoRealtimeScopeKind = z.infer<typeof chronoRealtimeScopeKindSchema>;

/** Parse a well-formed Chrono scope string into its kind + referenced branch id, or null. */
function parseChronoScope(
  scope: string,
): { kind: ChronoRealtimeScopeKind; branchId: string } | null {
  const match = CHRONO_SCOPE_PATTERN.exec(scope);
  if (!match) return null;
  const [, kind, branchId] = match;
  const parsedKind = chronoRealtimeScopeKindSchema.safeParse(kind);
  if (!parsedKind.success || !branchId) return null;
  return { kind: parsedKind.data, branchId };
}

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
