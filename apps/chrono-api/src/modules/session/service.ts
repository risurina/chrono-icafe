import { and, eq, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { debitWallet } from "../wallet/service";
import { chronoWallet } from "../wallet/schema";
import { chronoStation } from "../station/schema";
import { chronoSession, type ChronoSessionRow } from "./schema";
import { computeMeteredCharge, capMoney } from "./money";

/**
 * The ONLY code path that transitions a session to "ended" — called by both
 * the manual POST /:id/end route and the background expiry sweep (Phase 4),
 * so there is exactly one implementation of the billing-closure logic.
 *
 * Row-locks the session for the duration of the caller's transaction (same
 * discipline as wallet's own lockWalletForUpdate) so a racing caller (manual
 * end vs. the expiry sweep) blocks until the winner commits, then sees the
 * row already `ended` and returns alreadyClosed: true — never a double-close
 * or a double wallet debit, since billing is only ever computed AFTER the
 * lock is held.
 */
export async function closeSession(
  tx: TenantTx,
  args: { tenantId: string; sessionId: string; performedByUserId: string | null },
): Promise<{ session: ChronoSessionRow; alreadyClosed: boolean }> {
  const now = new Date();

  const [locked] = await tx
    .select()
    .from(chronoSession)
    .where(and(eq(chronoSession.id, args.sessionId), eq(chronoSession.tenantId, args.tenantId)))
    .for("update");
  if (!locked) {
    throw new HttpError(404, "Session not found.");
  }
  if (!["active", "paused"].includes(locked.status)) {
    return { session: locked, alreadyClosed: true };
  }

  // Billable seconds = wall-clock elapsed since start, minus accumulated
  // paused time, minus the still-open pause segment if closing while paused.
  const pausedNow =
    locked.status === "paused" && locked.pausedAt
      ? Math.floor((now.getTime() - locked.pausedAt.getTime()) / 1000)
      : 0;
  const billableSeconds = Math.max(
    0,
    Math.floor((now.getTime() - locked.startedAt.getTime()) / 1000) -
      locked.pausedDurationSeconds -
      pausedNow,
  );
  const finalAmount = computeMeteredCharge(billableSeconds, locked.rateSnapshot);

  const [wallet] = await tx
    .select({ balance: chronoWallet.balance })
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, locked.memberId));
  const walletBalance = wallet?.balance ?? "0.00";
  const amountCharged = capMoney(finalAmount, walletBalance);

  let walletTransactionId: string | null = null;
  if (Number(amountCharged) > 0) {
    const { transaction } = await debitWallet(tx, {
      tenantId: args.tenantId,
      memberId: locked.memberId,
      amount: amountCharged,
      reason: `Session ${locked.id}`,
      referenceType: "session",
      referenceId: locked.id,
      performedByUserId: args.performedByUserId ?? undefined,
    });
    walletTransactionId = transaction.id;
  }

  const [session] = await tx
    .update(chronoSession)
    .set({
      status: "ended",
      endedAt: now,
      actualBillableSeconds: billableSeconds,
      finalAmount,
      amountCharged,
      walletTransactionId,
      updatedAt: now,
    })
    .where(eq(chronoSession.id, locked.id))
    .returning();

  await tx
    .update(chronoStation)
    .set({ status: "available", updatedAt: now })
    .where(eq(chronoStation.id, locked.stationId));

  return { session: session!, alreadyClosed: false };
}
