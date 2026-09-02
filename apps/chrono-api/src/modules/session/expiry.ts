/**
 * Background expiry sweep for open sessions past their `scheduledEndAt` —
 * architecturally identical to agora's own `retention.ts` (a recurring
 * table-scan sweep), not a new pattern. `ChronoSessions` is RLS-forced, so
 * the due-row scan reads via `withAdmin` (RLS-bypassing, read-only) and
 * closes each row via `withTenant(row.tenantId, tx => closeSession(...))` —
 * one RLS-scoped transaction per session, reusing the exact same
 * `closeSession` the manual `POST /:id/end` route calls, so a sweep-closed
 * session is byte-for-byte the same billing outcome as a staff-closed one.
 * An open-ended session (`scheduledEndAt: null`) is never touched — a null
 * never satisfies `< now()`.
 */
import { withAdmin, withTenant, and, inArray, isNotNull, lt } from "agora/db";
import { logger } from "agora/server";
import { chronoSession } from "./schema";
import { closeSession } from "./service";

export async function runSessionExpirySweepOnce(): Promise<{ closed: number }> {
  const due = await withAdmin((tx) =>
    tx
      .select({ id: chronoSession.id, tenantId: chronoSession.tenantId })
      .from(chronoSession)
      .where(
        and(
          inArray(chronoSession.status, ["active", "paused"]),
          isNotNull(chronoSession.scheduledEndAt),
          lt(chronoSession.scheduledEndAt, new Date()),
        ),
      )
      .limit(200), // same batch cap oikos itself used
  );

  let closed = 0;
  for (const row of due) {
    await withTenant(row.tenantId, (tx) =>
      closeSession(tx, { tenantId: row.tenantId, sessionId: row.id, performedByUserId: null }),
    );
    closed++;
  }
  return { closed };
}

const SESSION_EXPIRY_SWEEP_INTERVAL_MS =
  Number(process.env.SESSION_EXPIRY_SWEEP_INTERVAL_MS) || 60_000; // matches oikos's 60s cadence

export function startSessionExpiryWorker(): () => void {
  const timer = setInterval(() => {
    runSessionExpirySweepOnce().catch((err) => {
      logger.error({ msg: "session expiry sweep failed", error: String(err) });
    });
  }, SESSION_EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
