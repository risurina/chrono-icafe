import { eq, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoPayment, chronoPaymentEvent } from "./schema";
import { creditWallet, debitWallet, type WalletLowSignal } from "../wallet/service";

type ChronoPaymentRow = typeof chronoPayment.$inferSelect;

async function lockPaymentForUpdate(
  tx: TenantTx,
  tenantId: string,
  paymentId: string,
): Promise<ChronoPaymentRow> {
  const [row] = await tx
    .select()
    .from(chronoPayment)
    .where(eq(chronoPayment.id, paymentId))
    .for("update");
  if (!row || row.tenantId !== tenantId) {
    throw new HttpError(404, "Payment not found.");
  }
  return row;
}

export async function createPayment(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId?: string;
    sessionId?: string;
    amount: string;
    currency?: string;
    method: string;
    providerReference?: string;
    expiresAt?: Date;
  },
): Promise<ChronoPaymentRow> {
  const [payment] = await tx
    .insert(chronoPayment)
    .values({
      tenantId: args.tenantId,
      memberId: args.memberId,
      sessionId: args.sessionId,
      amount: args.amount,
      currency: args.currency ?? "PHP",
      method: args.method,
      status: "pending",
      providerReference: args.providerReference,
      expiresAt: args.expiresAt,
    })
    .returning();
  return payment!;
}

/**
 * Settles a pending payment. Idempotent on an already-`paid` payment (returns
 * the existing row, no double-credit) — the row lock below is what makes a
 * same-request double-completion impossible; a concurrent second caller
 * simply observes the already-`paid` status after acquiring the lock.
 */
export async function markAsPaid(
  tx: TenantTx,
  args: {
    tenantId: string;
    paymentId: string;
    providerReference?: string;
    performedByUserId?: string;
  },
): Promise<{ payment: ChronoPaymentRow; alreadyPaid: boolean; walletLow: WalletLowSignal }> {
  const payment = await lockPaymentForUpdate(tx, args.tenantId, args.paymentId);
  if (payment.status === "paid") {
    return { payment, alreadyPaid: true, walletLow: null };
  }
  if (payment.status !== "pending") {
    throw new HttpError(409, `Payment is ${payment.status}, cannot be paid.`);
  }

  const [updated] = await tx
    .update(chronoPayment)
    .set({
      status: "paid",
      paidAt: new Date(),
      providerReference: args.providerReference ?? payment.providerReference,
      updatedAt: new Date(),
    })
    .where(eq(chronoPayment.id, payment.id))
    .returning();

  await tx.insert(chronoPaymentEvent).values({
    tenantId: args.tenantId,
    paymentId: payment.id,
    eventType: "received",
  });

  // A standalone payment with no sessionId funds a wallet top-up.
  let walletLow: WalletLowSignal = null;
  if (payment.memberId && !payment.sessionId) {
    ({ walletLow } = await creditWallet(tx, {
      tenantId: args.tenantId,
      memberId: payment.memberId,
      amount: payment.amount,
      reason: "Wallet top-up settled",
      referenceType: "payment",
      referenceId: payment.id,
      performedByUserId: args.performedByUserId,
    }));
  }

  return { payment: updated!, alreadyPaid: false, walletLow };
}

/**
 * Reverses whatever a settled payment funded. Only the standalone
 * wallet-top-up case is reversed here — a payment funding a
 * `ChronoCreditPurchase` has no linking column yet (deferred, see
 * .ai/plans/chrono/active/payments/README.md, "Deliberate differences from
 * oikos" — reservation-deposit/credit-purchase linkage is out of scope for
 * this pass). If the payment funded nothing, this is a no-op.
 */
async function reverseSideEffects(
  tx: TenantTx,
  payment: ChronoPaymentRow,
  args: { tenantId: string; kind: "payment_void" | "payment_refund"; performedByUserId?: string },
): Promise<WalletLowSignal> {
  if (payment.memberId && !payment.sessionId) {
    const { walletLow } = await debitWallet(tx, {
      tenantId: args.tenantId,
      memberId: payment.memberId,
      amount: payment.amount,
      reason: `Wallet top-up ${args.kind === "payment_void" ? "voided" : "refunded"}`,
      referenceType: args.kind,
      referenceId: payment.id,
      performedByUserId: args.performedByUserId,
    });
    return walletLow;
  }
  return null;
}

async function terminatePayment(
  tx: TenantTx,
  args: {
    tenantId: string;
    paymentId: string;
    toStatus: "voided" | "refunded";
    performedByUserId?: string;
  },
): Promise<{ payment: ChronoPaymentRow; walletLow: WalletLowSignal }> {
  const payment = await lockPaymentForUpdate(tx, args.tenantId, args.paymentId);
  // Includes a second void/refund attempt on an already-voided/refunded
  // payment — there is no no-op path; a concurrent second caller loses the
  // row lock race and then hits this same 409.
  if (payment.status !== "paid") {
    throw new HttpError(409, `Payment is ${payment.status}, cannot be ${args.toStatus}.`);
  }

  const [updated] = await tx
    .update(chronoPayment)
    .set({ status: args.toStatus, updatedAt: new Date() })
    .where(eq(chronoPayment.id, payment.id))
    .returning();

  await tx.insert(chronoPaymentEvent).values({
    tenantId: args.tenantId,
    paymentId: payment.id,
    eventType: args.toStatus,
  });

  const walletLow = await reverseSideEffects(tx, payment, {
    tenantId: args.tenantId,
    kind: args.toStatus === "voided" ? "payment_void" : "payment_refund",
    performedByUserId: args.performedByUserId,
  });

  return { payment: updated!, walletLow };
}

export function voidPayment(
  tx: TenantTx,
  args: { tenantId: string; paymentId: string; performedByUserId?: string },
) {
  return terminatePayment(tx, { ...args, toStatus: "voided" });
}

export function refundPayment(
  tx: TenantTx,
  args: { tenantId: string; paymentId: string; performedByUserId?: string },
) {
  return terminatePayment(tx, { ...args, toStatus: "refunded" });
}
