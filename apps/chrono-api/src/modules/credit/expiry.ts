import { and, eq, isNotNull, lt, withAdmin, withTenant } from "agora/db";
import { logger } from "agora/server";
import { chronoCreditGrant } from "./schema";
import { applyGrantDelta } from "./service";

export async function runCreditExpirySweepOnce(): Promise<{ expired: number }> {
  const due = await withAdmin((tx) =>
    tx
      .select({ id: chronoCreditGrant.id, tenantId: chronoCreditGrant.tenantId })
      .from(chronoCreditGrant)
      .where(
        and(
          eq(chronoCreditGrant.status, "granted"),
          isNotNull(chronoCreditGrant.expiresAt),
          lt(chronoCreditGrant.expiresAt, new Date()),
        ),
      )
      .limit(200), // same batch cap sessions' own sweep uses
  );
  let expired = 0;
  for (const row of due) {
    await withTenant(row.tenantId, async (tx) => {
      const [grant] = await tx
        .select()
        .from(chronoCreditGrant)
        .where(eq(chronoCreditGrant.id, row.id))
        .for("update");
      // Re-check under the lock — a concurrent consume/void may have already
      // moved it since the admin-scoped scan above.
      if (
        grant &&
        grant.status === "granted" &&
        grant.expiresAt &&
        grant.expiresAt < new Date()
      ) {
        await applyGrantDelta(tx, grant, {
          tenantId: row.tenantId,
          delta: -grant.remainingQuantity,
          type: "expired",
        });
        expired++;
      }
    });
  }
  return { expired };
}

const CREDIT_EXPIRY_SWEEP_INTERVAL_MS =
  Number(process.env.CREDIT_EXPIRY_SWEEP_INTERVAL_MS) || 300_000; // 5 min — a
// lot's expiry is far less time-sensitive than a live session, so this
// sweep runs less often than sessions' own 60s cadence.

export function startCreditExpiryWorker(): () => void {
  const timer = setInterval(() => {
    runCreditExpirySweepOnce().catch((err) => {
      logger.error({ msg: "credit expiry sweep failed", error: String(err) });
    });
  }, CREDIT_EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
