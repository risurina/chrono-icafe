/**
 * Background sweep for the member self-service reservation/queue flow —
 * architecturally the same shape as `session/expiry.ts`'s own sweep (a
 * recurring, batched, `withAdmin`-scan-then-`withTenant`-per-row pattern),
 * extended with per-row error isolation: unlike a session close,
 * this sweep's own promotion step can throw (an EXCLUDE-constraint
 * violation when a clamp still doesn't fit — see `promoteNextInQueue`'s own
 * clamp logic), so one bad/conflicting row must never stall the rest of a
 * batch, forever, every tick.
 *
 * Three responsibilities, in order:
 * 1. Activation — a `confirmed` direct reservation whose `startAt` has
 *    arrived flips to `hold`, opening its `holdPeriodMinutes` claim window.
 * 2. Hold-expiry — an unclaimed `hold` becomes `no_show` (direct) or
 *    `queue_expired` (from a queue promotion), records a restriction, and
 *    (for a queue failure) evaluates the ban threshold.
 * 3. Promotion — a station a hold-expiry just freed gets its next `pending`
 *    queue member promoted (`promoteNextInQueue`, defined in `service.ts`
 *    since it's also called from `cancelReservation` and the two
 *    session-end call sites).
 */
import { and, eq, lt, sql, withAdmin, withTenant } from "agora/db";
import { logger } from "agora/server";
import { recordAudit } from "agora/audit";
import { chronoReservation } from "./schema";
import { chronoMemberReservationRestriction } from "./restriction-schema";
import { resolveReservationPolicy, promoteNextInQueue } from "./service";

const BATCH_LIMIT = 200; // matches session/expiry.ts's own batch cap

/** 5.1 — flips `confirmed` rows past their `startAt` to `hold`. */
async function runActivationOnce(): Promise<{ activated: number }> {
  const due = await withAdmin((tx) =>
    tx
      .select({ id: chronoReservation.id, tenantId: chronoReservation.tenantId })
      .from(chronoReservation)
      .where(
        and(
          eq(chronoReservation.status, "confirmed"),
          lt(chronoReservation.startAt, new Date()),
        ),
      )
      .limit(BATCH_LIMIT),
  );

  let activated = 0;
  for (const row of due) {
    try {
      await withTenant(row.tenantId, async (tx) => {
        const [locked] = await tx
          .select()
          .from(chronoReservation)
          .where(eq(chronoReservation.id, row.id))
          .for("update");
        if (!locked || locked.status !== "confirmed") return; // already handled

        const policy = await resolveReservationPolicy(tx, row.tenantId, locked.branchId);
        const now = new Date();
        await tx
          .update(chronoReservation)
          .set({
            status: "hold",
            holdExpiresAt: new Date(now.getTime() + policy.holdPeriodMinutes * 60_000),
            updatedAt: now,
          })
          .where(eq(chronoReservation.id, row.id));
      });
      await recordAudit({
        tenantId: row.tenantId,
        actorType: "system",
        actorId: null,
        action: "chronoReservation.activated",
        targetType: "reservation",
        targetId: row.id,
      });
      activated++;
    } catch (err) {
      logger.error({ msg: "reservation sweep: activation row failed", reservationId: row.id, error: String(err) });
    }
  }
  return { activated };
}

/** 5.2 — expires unclaimed holds into no_show / queue_expired + failure/ban records. */
async function runHoldExpiryOnce(): Promise<{ expired: number }> {
  const due = await withAdmin((tx) =>
    tx
      .select({ id: chronoReservation.id, tenantId: chronoReservation.tenantId })
      .from(chronoReservation)
      .where(
        and(eq(chronoReservation.status, "hold"), lt(chronoReservation.holdExpiresAt, new Date())),
      )
      .limit(BATCH_LIMIT),
  );

  let expired = 0;
  for (const row of due) {
    let stationToPromote: string | null = null;
    try {
      await withTenant(row.tenantId, async (tx) => {
        const [locked] = await tx
          .select()
          .from(chronoReservation)
          .where(eq(chronoReservation.id, row.id))
          .for("update");
        if (!locked || locked.status !== "hold") return; // already claimed/cancelled

        const now = new Date();
        const policy = await resolveReservationPolicy(tx, row.tenantId, locked.branchId);

        if (!locked.fromQueue) {
          await tx
            .update(chronoReservation)
            .set({ status: "no_show", noShowAt: now, updatedAt: now })
            .where(eq(chronoReservation.id, row.id));
          if (locked.memberId) {
            await tx
              .insert(chronoMemberReservationRestriction)
              .values({
                tenantId: row.tenantId,
                branchId: locked.branchId,
                memberId: locked.memberId,
                type: "reservation_ban",
                reason: "no_show",
                reservationId: row.id,
                stationId: locked.stationId,
                expiresAt: new Date(now.getTime() + policy.noShowBanDurationHours * 3_600_000),
              })
              .onConflictDoNothing();
          }
        } else {
          await tx
            .update(chronoReservation)
            .set({ status: "queue_expired", updatedAt: now })
            .where(eq(chronoReservation.id, row.id));
          if (locked.memberId) {
            await tx
              .insert(chronoMemberReservationRestriction)
              .values({
                tenantId: row.tenantId,
                branchId: locked.branchId,
                memberId: locked.memberId,
                type: "queue_failure",
                reason: "queue_hold_expired",
                reservationId: row.id,
                stationId: locked.stationId,
                expiresAt: null,
              })
              .onConflictDoNothing();

            // Cumulative-forever failure count against queueFailureLimit
            // (Decisions made #1) — every queue_failure ever recorded for
            // this member at this branch.
            const [failureCountRow] = await tx
              .select({ value: sql<number>`count(*)::int` })
              .from(chronoMemberReservationRestriction)
              .where(
                and(
                  eq(chronoMemberReservationRestriction.tenantId, row.tenantId),
                  eq(chronoMemberReservationRestriction.memberId, locked.memberId),
                  eq(chronoMemberReservationRestriction.branchId, locked.branchId),
                  eq(chronoMemberReservationRestriction.type, "queue_failure"),
                ),
              );
            if ((failureCountRow?.value ?? 0) >= policy.queueFailureLimit) {
              await tx
                .insert(chronoMemberReservationRestriction)
                .values({
                  tenantId: row.tenantId,
                  branchId: locked.branchId,
                  memberId: locked.memberId,
                  type: "queue_ban",
                  reason: "queue_failure_limit",
                  reservationId: row.id,
                  stationId: locked.stationId,
                  expiresAt: new Date(now.getTime() + policy.queueBanDurationHours * 3_600_000),
                })
                .onConflictDoNothing();
            }
          }
        }
        stationToPromote = locked.stationId;
      });

      await recordAudit({
        tenantId: row.tenantId,
        actorType: "system",
        actorId: null,
        action: "chronoReservation.holdExpired",
        targetType: "reservation",
        targetId: row.id,
      });
      expired++;

      // Promotion runs AFTER this row's own withTenant commits — it opens its
      // own transaction + advisory lock; nesting it under the row lock above
      // would be a deadlock surface.
      if (stationToPromote) {
        await promoteNextInQueue(row.tenantId, stationToPromote);
      }
    } catch (err) {
      logger.error({ msg: "reservation sweep: hold-expiry row failed", reservationId: row.id, error: String(err) });
    }
  }
  return { expired };
}

export async function runReservationSweepOnce(): Promise<{ activated: number; expired: number }> {
  const { activated } = await runActivationOnce();
  const { expired } = await runHoldExpiryOnce();
  return { activated, expired };
}

const RESERVATION_SWEEP_INTERVAL_MS =
  Number(process.env.RESERVATION_SWEEP_INTERVAL_MS) || 60_000;

export function startReservationSweepWorker(): () => void {
  const timer = setInterval(() => {
    runReservationSweepOnce().catch((err) => {
      logger.error({ msg: "reservation sweep failed", error: String(err) });
    });
  }, RESERVATION_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
