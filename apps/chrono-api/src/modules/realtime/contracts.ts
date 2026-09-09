/**
 * Chrono's realtime vocabulary — event contracts + scope grammar for the
 * foundation's `createRealtimeRoute` staff mount (`agora/realtime`,
 * `.ai/plans/agora/archive/websocket-foundation/README.md`).
 *
 * This module owns no table and no service, only contracts — the same
 * "no entity of its own" shape as `reconciliation`
 * (`apps/chrono-api/src/modules/reconciliation/`).
 *
 * Client-safe: every export here is a pure Zod schema, type, or string-only
 * function, and this file must stay free of `agora/db`/server-only imports —
 * it crosses the browser boundary via the package's `./realtime` and
 * `./station` subpath exports (`.ai/rules/dto.md`), and `chrono-web` pages
 * import it purely for these schemas/types at build (static-generation) time,
 * with no `DATABASE_URL` available. The DB-touching `ValidateScopes`
 * implementations that used to live here have moved to `./scope-validators`
 * (server-only, imported only from `apps/chrono-api`'s own route/mount code).
 *
 * See `.ai/plans/chrono/active/realtime-updates/README.md`, "Staff dashboard
 * wiring" and Phase 1.
 */

import { z } from "zod";

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

export type ChronoStationStatus = z.infer<typeof chronoStationStatusSchema>;

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

/** Published on a wallet balance crossing below the low-balance threshold
 * (pc-client-tauri-api-integration plan, Phase 4), to the affected member's
 * active session's station's approved device private channel only — never
 * broadcast tenant/branch-wide, since a wallet balance is one member's own
 * data. */
export const walletLowEventSchema = z.object({
  balance: z.string(),
});
export type WalletLowEvent = z.infer<typeof walletLowEventSchema>;

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

/**
 * Parse a well-formed Chrono scope string into its kind + referenced branch
 * id, or null. Pure string parsing, no DB — exported for `./scope-validators`
 * (and its own test) to reuse rather than re-implementing the pattern.
 */
export function parseChronoScope(
  scope: string,
): { kind: ChronoRealtimeScopeKind; branchId: string } | null {
  const match = CHRONO_SCOPE_PATTERN.exec(scope);
  if (!match) return null;
  const [, kind, branchId] = match;
  const parsedKind = chronoRealtimeScopeKindSchema.safeParse(kind);
  if (!parsedKind.success || !branchId) return null;
  return { kind: parsedKind.data, branchId };
}

// ---------------------------------------------------------------------------
// Device scope grammar (realtime-updates Phase 3) — the device mount's own
// scope vocabulary, disjoint from the staff scope grammar above. A device
// connects requesting its OWN private channel via `?scope=device:{deviceId}`
// (its own id, per `resolveDeviceActor`'s `actorKey`) — this is the only
// mechanism `createRealtimeRoute` exposes for a mount to grant a per-actor
// channel, so the device client's connect call is expected to always send
// this scope. A request naming any OTHER device's id is a well-formed scope
// that is simply never granted (never included in the accepted subset) —
// the same "malformed fails the upgrade, well-formed-but-rejected just gets
// no channel" split `agora/realtime`'s own `ValidateScopes` doc describes,
// applied here as the actor-isolation boundary (a device can never subscribe
// to another device's private channel, no matter what it asks for). The
// matching `validateChronoDeviceScopes` implementation lives in
// `./scope-validators`.
// ---------------------------------------------------------------------------

export const chronoDeviceScopeSchema = z
  .string()
  .regex(/^device:([A-Za-z0-9_-]{1,64})$/);
