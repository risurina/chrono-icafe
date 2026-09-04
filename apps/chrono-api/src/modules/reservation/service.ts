import { and, eq, gt, inArray, isNull, sql, withTenant, type TenantTx } from "agora/db";
import * as base from "agora/db/schema";
import { HttpError } from "agora/server";
import { createId } from "agora";
import { chronoStation } from "../station/schema";
import { chronoReservation, type ChronoReservationRow } from "./schema";
import { chronoReservationPolicy, type ChronoReservationPolicyRow } from "./policy-schema";
import { chronoMemberReservationRestriction } from "./restriction-schema";

/** Statuses that occupy a station and therefore participate in the overlap check. */
const ACTIVE_STATUSES = ["confirmed", "checked_in", "hold"] as const;

export const OVERLAP_MESSAGE = "This station is already booked for the requested time.";

function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23P01"
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

const HARDCODED_POLICY_DEFAULTS: Omit<
  ChronoReservationPolicyRow,
  "id" | "tenantId" | "branchId" | "createdAt" | "updatedAt"
> = {
  enabled: true,
  reservationAdvanceWindowMinutes: 60,
  maxActiveReservationsPerMember: 1,
  lateCancellationWindowMinutes: 30,
  cancellationFeeEnabled: true,
  cancellationFeeAmount: "20",
  reservationBanDurationHours: 24,
  noShowBanDurationHours: 24,
  holdPeriodMinutes: 30,
  queueFailureLimit: 1,
  queueBanDurationHours: 24,
  allowQueueForReservedPc: true,
  allowQueueForInUsePc: true,
};

export type ResolvedReservationPolicy = typeof HARDCODED_POLICY_DEFAULTS;

/**
 * Resolution order: a branch row (if one exists) is used IN FULL; otherwise
 * the tenant-default row (branchId IS NULL) is used in full; otherwise the
 * hardcoded defaults above apply. Whole-row override, not per-field — see the
 * plan's "Decisions made #3".
 */
export async function resolveReservationPolicy(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
): Promise<ResolvedReservationPolicy> {
  const [branchRow] = await tx
    .select()
    .from(chronoReservationPolicy)
    .where(
      and(eq(chronoReservationPolicy.tenantId, tenantId), eq(chronoReservationPolicy.branchId, branchId)),
    )
    .limit(1);
  if (branchRow) return branchRow;

  const [tenantRow] = await tx
    .select()
    .from(chronoReservationPolicy)
    .where(
      and(eq(chronoReservationPolicy.tenantId, tenantId), isNull(chronoReservationPolicy.branchId)),
    )
    .limit(1);
  if (tenantRow) return tenantRow;

  return HARDCODED_POLICY_DEFAULTS;
}

/**
 * Reads ChronoMemberReservationRestrictions for an unexpired, unlifted ban of
 * the given type — branch-scoped (a ban earned at branch A must not silently
 * block branch B, matching the per-branch policy surface). Never matches
 * type "queue_failure" (a history record, not a ban).
 */
export async function assertNotBanned(
  tx: TenantTx,
  tenantId: string,
  memberId: string,
  branchId: string,
  type: "reservation_ban" | "queue_ban",
): Promise<void> {
  const [row] = await tx
    .select({ expiresAt: chronoMemberReservationRestriction.expiresAt })
    .from(chronoMemberReservationRestriction)
    .where(
      and(
        eq(chronoMemberReservationRestriction.tenantId, tenantId),
        eq(chronoMemberReservationRestriction.memberId, memberId),
        eq(chronoMemberReservationRestriction.branchId, branchId),
        eq(chronoMemberReservationRestriction.type, type),
        sql`${chronoMemberReservationRestriction.expiresAt} > now()`,
        isNull(chronoMemberReservationRestriction.liftedAt),
      ),
    )
    .limit(1);
  if (row) {
    // HttpError carries only (status, message) — no structured body (see
    // app.ts's onError: `c.json({ error: err.message }, err.status)`). This
    // repo's existing precedent for a client-matchable error is a distinct,
    // parseable message string (host.ts's WORKSPACE_SUSPENDED); mirrored here
    // as `<CODE>:<ISO expiresAt>` so the member UI can render the exact
    // unban date/time without a second lookup.
    const code = type === "reservation_ban" ? "RESERVATION_BANNED" : "QUEUE_BANNED";
    throw new HttpError(403, `${code}:${row.expiresAt!.toISOString()}`);
  }
}

/**
 * Locks every OTHER active (confirmed/checked_in/hold) reservation row for
 * this station, then checks the requested [startAt, endAt) window against
 * each locked row's window in application code. Throws 409 on any overlap.
 * Mirrors routes.ts's own assertNoOverlap (path 1) — kept as a separate copy
 * here rather than importing from routes.ts, since routes.ts is the staff
 * surface and this module must not depend on it.
 */
async function assertNoOverlap(
  tx: TenantTx,
  args: { tenantId: string; stationId: string; startAt: Date; endAt: Date; excludeReservationId?: string },
): Promise<void> {
  const { tenantId, stationId, startAt, endAt, excludeReservationId } = args;
  const locked = await tx
    .select({ id: chronoReservation.id, startAt: chronoReservation.startAt, endAt: chronoReservation.endAt })
    .from(chronoReservation)
    .where(
      and(
        eq(chronoReservation.tenantId, tenantId),
        eq(chronoReservation.stationId, stationId),
        inArray(chronoReservation.status, [...ACTIVE_STATUSES]),
        sql`${chronoReservation.startAt} is not null`,
      ),
    )
    .for("update");

  for (const row of locked) {
    if (excludeReservationId && row.id === excludeReservationId) continue;
    if (!row.startAt || !row.endAt) continue;
    if (startAt < row.endAt && endAt > row.startAt) {
      throw new HttpError(409, OVERLAP_MESSAGE);
    }
  }
}

async function assertOneActiveReservation(
  tx: TenantTx,
  tenantId: string,
  memberId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: chronoReservation.id })
    .from(chronoReservation)
    .where(
      and(
        eq(chronoReservation.tenantId, tenantId),
        eq(chronoReservation.memberId, memberId),
        inArray(chronoReservation.status, ["confirmed", "hold", "checked_in", "pending"]),
        isNull(chronoReservation.createdByUserId),
      ),
    )
    .limit(1);
  if (existing) {
    throw new HttpError(409, "RESERVATION_ALREADY_ACTIVE");
  }
}

async function requireBookableStation(tx: TenantTx, tenantId: string, stationId: string) {
  const [station] = await tx
    .select({ id: chronoStation.id, branchId: chronoStation.branchId, status: chronoStation.status })
    .from(chronoStation)
    .where(and(eq(chronoStation.id, stationId), eq(chronoStation.tenantId, tenantId)))
    .limit(1);
  if (!station) throw new HttpError(404, "Station not found.");
  if (station.status === "maintenance" || station.status === "offline") {
    throw new HttpError(403, "This station is not bookable right now.");
  }
  return station;
}

/**
 * Flow 1 — direct reservation. Does NOT gate on chronoStation.status reading
 * "available": a future-dated booking on a station someone is playing on RIGHT
 * NOW is the single most common real reservation, and the EXCLUDE constraint
 * (now covering "hold") is the real double-booking guarantee — the station's
 * CURRENT occupant is irrelevant to a FUTURE slot. Only maintenance/offline
 * blocks (requireBookableStation).
 */
export async function createDirectReservation(args: {
  tenantId: string;
  memberId: string;
  stationId: string;
  startAt: Date;
  durationMinutes: number;
}): Promise<ChronoReservationRow> {
  const { tenantId, memberId, stationId, startAt, durationMinutes } = args;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  const row = await withTenant(tenantId, async (tx) => {
    const station = await requireBookableStation(tx, tenantId, stationId);
    const policy = await resolveReservationPolicy(tx, tenantId, station.branchId);
    if (!policy.enabled) throw new HttpError(403, "RESERVATIONS_DISABLED");

    const now = new Date();
    const maxStart = new Date(now.getTime() + policy.reservationAdvanceWindowMinutes * 60_000);
    if (!(startAt > now && startAt <= maxStart)) {
      throw new HttpError(
        400,
        `A reservation may only be made for a start time within ${policy.reservationAdvanceWindowMinutes} minutes from now.`,
      );
    }

    await assertNotBanned(tx, tenantId, memberId, station.branchId, "reservation_ban");
    await assertOneActiveReservation(tx, tenantId, memberId);

    try {
      await assertNoOverlap(tx, { tenantId, stationId, startAt, endAt });
      const [created] = await tx
        .insert(chronoReservation)
        .values({
          id: createId(),
          tenantId,
          branchId: station.branchId,
          stationId,
          memberId,
          startAt,
          endAt,
          status: "confirmed",
          fromQueue: false,
        })
        .returning();
      return created!;
    } catch (err) {
      if (isExclusionViolation(err)) throw new HttpError(409, OVERLAP_MESSAGE);
      if (isUniqueViolation(err)) throw new HttpError(409, "RESERVATION_ALREADY_ACTIVE");
      throw err;
    }
  });
  return row;
}

/**
 * Flow 2 — join the queue. Gates on the station's CURRENT state being
 * occupied, or having a live hold/checked_in reservation covering now — not a
 * plain "available" state with nothing to queue behind (that's a direct
 * reservation instead).
 */
export async function joinQueue(args: {
  tenantId: string;
  memberId: string;
  stationId: string;
  durationMinutes: number;
}): Promise<ChronoReservationRow> {
  const { tenantId, memberId, stationId, durationMinutes } = args;

  const row = await withTenant(tenantId, async (tx) => {
    const station = await requireBookableStation(tx, tenantId, stationId);
    const policy = await resolveReservationPolicy(tx, tenantId, station.branchId);
    if (!policy.enabled) throw new HttpError(403, "RESERVATIONS_DISABLED");

    const now = new Date();
    const [activeRow] = await tx
      .select({ status: chronoReservation.status })
      .from(chronoReservation)
      .where(
        and(
          eq(chronoReservation.tenantId, tenantId),
          eq(chronoReservation.stationId, stationId),
          inArray(chronoReservation.status, ["hold", "checked_in"]),
        ),
      )
      .limit(1);

    const isOccupied = station.status === "occupied";
    const hasLiveHold = !!activeRow;
    if (!isOccupied && !hasLiveHold) {
      throw new HttpError(
        400,
        "This station is available now — reserve it directly instead of joining a queue.",
      );
    }
    if (isOccupied && !policy.allowQueueForInUsePc) {
      throw new HttpError(403, "QUEUE_NOT_ALLOWED");
    }
    if (hasLiveHold && !isOccupied && !policy.allowQueueForReservedPc) {
      throw new HttpError(403, "QUEUE_NOT_ALLOWED");
    }

    await assertNotBanned(tx, tenantId, memberId, station.branchId, "queue_ban");
    await assertOneActiveReservation(tx, tenantId, memberId);

    try {
      const [created] = await tx
        .insert(chronoReservation)
        .values({
          id: createId(),
          tenantId,
          branchId: station.branchId,
          stationId,
          memberId,
          status: "pending",
          fromQueue: true,
          requestedDurationMinutes: durationMinutes,
        })
        .returning();
      return created!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "RESERVATION_ALREADY_ACTIVE");
      throw err;
    }
  });
  return row;
}

/** Flow 2 Option B — schedule from a live hold (does not start play). */
export async function confirmHold(args: {
  tenantId: string;
  memberId: string;
  reservationId: string;
}): Promise<ChronoReservationRow> {
  const { tenantId, memberId, reservationId } = args;
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(chronoReservation)
      .where(
        and(eq(chronoReservation.id, reservationId), eq(chronoReservation.tenantId, tenantId)),
      )
      .limit(1);
    if (!existing || existing.memberId !== memberId) {
      throw new HttpError(404, "Reservation not found.");
    }
    if (existing.status !== "hold" || !existing.holdExpiresAt || existing.holdExpiresAt <= new Date()) {
      throw new HttpError(409, "This hold is no longer active.");
    }
    const [updated] = await tx
      .update(chronoReservation)
      .set({ status: "checked_in", checkedInAt: new Date(), updatedAt: new Date() })
      .where(eq(chronoReservation.id, reservationId))
      .returning();
    return updated!;
  });
}

export type CancelOutcome = {
  reservation: ChronoReservationRow;
  isLate: boolean;
  feeAmount: string | null;
};

/**
 * On-time vs late per lateCancellationWindowMinutes/startAt for a SCHEDULED
 * (fromQueue: false) reservation only; a queue entry is always free to
 * cancel, no ban, regardless of timing. Late = at/after
 * (startAt - lateCancellationWindowMinutes), which also covers cancelling
 * at/after the scheduled start itself.
 */
export async function cancelReservation(args: {
  tenantId: string;
  memberId: string;
  reservationId: string;
  reason?: string;
}): Promise<CancelOutcome> {
  const { tenantId, memberId, reservationId, reason } = args;

  const result = await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(chronoReservation)
      .where(
        and(eq(chronoReservation.id, reservationId), eq(chronoReservation.tenantId, tenantId)),
      )
      .limit(1);
    if (!existing || existing.memberId !== memberId) {
      throw new HttpError(404, "Reservation not found.");
    }
    if (!["confirmed", "hold", "pending"].includes(existing.status)) {
      throw new HttpError(409, "This reservation can no longer be cancelled.");
    }

    const now = new Date();
    let isLate = false;
    let feeAmount: string | null = null;

    if (!existing.fromQueue && existing.startAt) {
      const policy = await resolveReservationPolicy(tx, tenantId, existing.branchId);
      const lateThreshold = new Date(
        existing.startAt.getTime() - policy.lateCancellationWindowMinutes * 60_000,
      );
      isLate = now >= lateThreshold;
      if (isLate && policy.cancellationFeeEnabled) {
        feeAmount = policy.cancellationFeeAmount;
      }
    }

    const [updated] = await tx
      .update(chronoReservation)
      .set({
        status: isLate ? "cancelled_late" : "cancelled",
        cancelledAt: now,
        cancelReason: reason ?? null,
        cancelledLateFeeAmount: feeAmount,
        updatedAt: now,
      })
      .where(eq(chronoReservation.id, reservationId))
      .returning();

    if (isLate) {
      const policy = await resolveReservationPolicy(tx, tenantId, existing.branchId);
      const isAtOrAfterStart = existing.startAt ? now >= existing.startAt : false;
      await tx.insert(chronoMemberReservationRestriction).values({
        id: createId(),
        tenantId,
        branchId: existing.branchId,
        memberId,
        type: "reservation_ban",
        reason: isAtOrAfterStart ? "scheduled_time_cancellation" : "late_cancellation",
        reservationId,
        stationId: existing.stationId,
        expiresAt: new Date(now.getTime() + policy.reservationBanDurationHours * 3_600_000),
      });
    }

    return { reservation: updated!, isLate, feeAmount };
  });

  // Promote the next queue member — after this function's own withTenant
  // transaction commits (promoteNextInQueue opens its own transaction +
  // advisory lock; nesting would be a deadlock surface). A no-op unless the
  // cancelled row was actually occupying the station (a "hold") and a
  // "pending" row exists behind it — safe to call unconditionally.
  await promoteNextInQueue(tenantId, result.reservation.stationId);

  return result;
}

/**
 * Promotes the oldest `pending` queue row for a station to `hold`, clamping
 * the promoted window against the next conflicting active reservation on that
 * station so a promotion can never violate the EXCLUDE constraint (which now
 * covers "hold"). Opens its OWN withTenant + advisory lock — called from
 * three different already-committed contexts (session-end call sites, the
 * sweep's queue-expiry branch, and this file's own cancel path), so it must
 * not assume an open transaction.
 *
 * If the clamped window would be under 15 minutes (joinQueueSchema's own
 * floor), the promotion is skipped for this tick — the row stays `pending`
 * and is reconsidered on the next free/tick — rather than losing the queue
 * member's place or throwing.
 */
export async function promoteNextInQueue(tenantId: string, stationId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"chrono_reservation_station_" + stationId}))`,
    );

    const candidates = await tx
      .select()
      .from(chronoReservation)
      .where(
        and(
          eq(chronoReservation.tenantId, tenantId),
          eq(chronoReservation.stationId, stationId),
          eq(chronoReservation.status, "pending"),
        ),
      )
      .orderBy(chronoReservation.createdAt)
      .for("update");

    const next = candidates[0];
    if (!next || !next.requestedDurationMinutes) return;

    const now = new Date();
    let endAt = new Date(now.getTime() + next.requestedDurationMinutes * 60_000);

    const [conflict] = await tx
      .select({ startAt: chronoReservation.startAt })
      .from(chronoReservation)
      .where(
        and(
          eq(chronoReservation.tenantId, tenantId),
          eq(chronoReservation.stationId, stationId),
          inArray(chronoReservation.status, [...ACTIVE_STATUSES]),
          sql`${chronoReservation.startAt} is not null`,
          gt(chronoReservation.startAt, now),
        ),
      )
      .orderBy(chronoReservation.startAt)
      .limit(1);
    if (conflict?.startAt && conflict.startAt < endAt) {
      endAt = conflict.startAt;
    }

    const MIN_HOLD_MINUTES = 15;
    if (endAt.getTime() - now.getTime() < MIN_HOLD_MINUTES * 60_000) {
      // Clamped window too small to be useful — leave pending, try again later.
      return;
    }

    const policy = await resolveReservationPolicy(tx, tenantId, next.branchId);
    await tx
      .update(chronoReservation)
      .set({
        status: "hold",
        startAt: now,
        endAt,
        holdExpiresAt: new Date(now.getTime() + policy.holdPeriodMinutes * 60_000),
        updatedAt: now,
      })
      .where(eq(chronoReservation.id, next.id));
  });
}
