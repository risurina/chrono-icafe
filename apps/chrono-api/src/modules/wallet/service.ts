import { eq, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoWallet, chronoWalletTransaction } from "./schema";
import { addMoney, negateMoney, isNegativeMoney } from "./money";

/**
 * Locks the member's wallet row for the duration of the caller's transaction,
 * creating it on first use. Every balance mutation in this module funnels
 * through here so the row lock is the single choke point — never a stale
 * pre-transaction read. See .ai/plans/chrono/active/wallet/README.md,
 * "Transaction integrity mechanism."
 */
async function lockWalletForUpdate(tx: TenantTx, tenantId: string, memberId: string) {
  const [existing] = await tx
    .select()
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, memberId))
    .for("update");
  if (existing) return existing;

  await tx
    .insert(chronoWallet)
    .values({ tenantId, memberId, balance: "0" })
    .onConflictDoNothing({ target: chronoWallet.memberId });

  const [created] = await tx
    .select()
    .from(chronoWallet)
    .where(eq(chronoWallet.memberId, memberId))
    .for("update");
  return created!; // present: either it existed, or the insert (ours or a racing one) won
}

async function applyWalletDelta(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    delta: string; // signed decimal string; positive = increase, negative = decrease
    type: "credit" | "debit" | "adjustment";
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
    allowNegative?: boolean; // debit guard escape hatch — only "adjustment" sets this
  },
) {
  const wallet = await lockWalletForUpdate(tx, args.tenantId, args.memberId);
  const balanceAfter = addMoney(wallet.balance, args.delta);
  if (!args.allowNegative && isNegativeMoney(balanceAfter)) {
    throw new HttpError(422, "Insufficient wallet balance");
  }

  const [updatedWallet] = await tx
    .update(chronoWallet)
    .set({ balance: balanceAfter, updatedAt: new Date() })
    .where(eq(chronoWallet.id, wallet.id))
    .returning();

  const [transaction] = await tx
    .insert(chronoWalletTransaction)
    .values({
      tenantId: args.tenantId,
      walletId: wallet.id,
      memberId: args.memberId,
      type: args.type,
      amount: args.delta,
      balanceBefore: wallet.balance,
      balanceAfter,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      performedByUserId: args.performedByUserId,
    })
    .returning();

  return { wallet: updatedWallet!, transaction: transaction! };
}

/**
 * All three take an already-open `tx`, never opening their own transaction —
 * this is what lets a calling module (e.g. `sessions`) compose a debit into
 * its own atomic operation, per the plan's own "shared surface" note.
 */
export function creditWallet(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    amount: string;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
) {
  return applyWalletDelta(tx, { ...args, delta: args.amount, type: "credit" });
}

export function debitWallet(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    amount: string;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
) {
  return applyWalletDelta(tx, {
    ...args,
    delta: negateMoney(args.amount),
    type: "debit",
  });
}

export function adjustWalletBalance(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    delta: string;
    reason: string;
    performedByUserId?: string;
  },
) {
  return applyWalletDelta(tx, { ...args, type: "adjustment", allowNegative: true });
}
