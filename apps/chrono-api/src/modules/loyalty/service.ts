import { eq, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoLoyaltyAccount, chronoLoyaltyTransaction } from "./schema";
import type { ChronoLoyaltyAccountRow } from "./schema";
import { MAX_POINTS_BALANCE } from "./contracts";
import { LOYALTY_TIERS, tierFor } from "./level";

// Re-exported for backward compatibility — the curve and its lookup now live
// in level.ts so the read path (computeLevel) and this write path share one
// definition and can never drift. See level.ts.
export { LOYALTY_TIERS, tierFor };

/**
 * A code constant for this pass — applied by whichever caller invokes
 * `earnLoyaltyPoints` with a spend amount (Phase 4). See Open Question 3.
 */
export const LOYALTY_POINTS_PER_CURRENCY_UNIT = 1;

/**
 * Reads (creating on first use) the loyalty account row for a member — never
 * under a row lock, since callers that need to mutate the row go through
 * `applyPointsDelta`'s own `SELECT ... FOR UPDATE`, mirroring
 * `wallet/service.ts`'s `lockWalletForUpdate` shape but without the lock for
 * a plain read path.
 */
export async function getOrCreateAccount(
  tx: TenantTx,
  tenantId: string,
  memberId: string,
): Promise<ChronoLoyaltyAccountRow> {
  const [existing] = await tx
    .select()
    .from(chronoLoyaltyAccount)
    .where(eq(chronoLoyaltyAccount.memberId, memberId))
    .limit(1);
  if (existing) return existing;

  await tx
    .insert(chronoLoyaltyAccount)
    .values({ tenantId, memberId, pointsBalance: 0, lifetimePoints: 0, tier: "bronze" })
    .onConflictDoNothing({ target: chronoLoyaltyAccount.memberId });

  const [created] = await tx
    .select()
    .from(chronoLoyaltyAccount)
    .where(eq(chronoLoyaltyAccount.memberId, memberId))
    .limit(1);
  return created!; // present: either it existed, or the insert (ours or a racing one) won
}

/**
 * Locks the account row for the duration of the caller's transaction,
 * creating it on first use — the single choke point every balance mutation
 * in this module funnels through, mirroring wallet's own
 * `lockWalletForUpdate`/`applyWalletDelta` discipline. This is the fix for
 * oikos's TOCTOU race (see the plan's "diverges from oikos" #2): the row is
 * locked BEFORE the balance is read and validated, not after.
 */
async function lockAccountForUpdate(
  tx: TenantTx,
  tenantId: string,
  memberId: string,
): Promise<ChronoLoyaltyAccountRow> {
  const [existing] = await tx
    .select()
    .from(chronoLoyaltyAccount)
    .where(eq(chronoLoyaltyAccount.memberId, memberId))
    .for("update");
  if (existing) return existing;

  await tx
    .insert(chronoLoyaltyAccount)
    .values({ tenantId, memberId, pointsBalance: 0, lifetimePoints: 0, tier: "bronze" })
    .onConflictDoNothing({ target: chronoLoyaltyAccount.memberId });

  const [created] = await tx
    .select()
    .from(chronoLoyaltyAccount)
    .where(eq(chronoLoyaltyAccount.memberId, memberId))
    .for("update");
  return created!; // present: either it existed, or the insert (ours or a racing one) won
}

/**
 * Applies a signed points delta under the account row lock, recomputes tier
 * from the new lifetimePoints (earn only — redeem/negative-adjustment never
 * changes lifetimePoints, so redeeming points never demotes a customer's
 * tier), writes the ledger row, and returns the updated account. Throws
 * HttpError(409, ...) if a redeem/negative-adjustment would take
 * pointsBalance below zero.
 */
export async function applyPointsDelta(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    type: "earn" | "redeem" | "adjustment";
    points: number; // signed delta; positive = increase, negative = decrease
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
): Promise<{ account: ChronoLoyaltyAccountRow; transaction: typeof chronoLoyaltyTransaction.$inferSelect }> {
  const account = await lockAccountForUpdate(tx, args.tenantId, args.memberId);
  const balanceAfter = account.pointsBalance + args.points;
  if (balanceAfter < 0) {
    throw new HttpError(409, "Insufficient loyalty points balance");
  }
  if (balanceAfter > MAX_POINTS_BALANCE || balanceAfter < -MAX_POINTS_BALANCE) {
    throw new HttpError(409, `Loyalty points balance limit exceeded (max ${MAX_POINTS_BALANCE})`);
  }

  const lifetimePointsAfter =
    args.points > 0 ? account.lifetimePoints + args.points : account.lifetimePoints;
  if (lifetimePointsAfter > MAX_POINTS_BALANCE) {
    throw new HttpError(
      409,
      `Loyalty lifetime points limit exceeded (max ${MAX_POINTS_BALANCE})`,
    );
  }
  const tierAfter = tierFor(lifetimePointsAfter);

  const [updatedAccount] = await tx
    .update(chronoLoyaltyAccount)
    .set({
      pointsBalance: balanceAfter,
      lifetimePoints: lifetimePointsAfter,
      tier: tierAfter,
      updatedAt: new Date(),
    })
    .where(eq(chronoLoyaltyAccount.id, account.id))
    .returning();

  const [transaction] = await tx
    .insert(chronoLoyaltyTransaction)
    .values({
      tenantId: args.tenantId,
      accountId: account.id,
      memberId: args.memberId,
      type: args.type,
      points: args.points,
      balanceBefore: account.pointsBalance,
      balanceAfter,
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      performedByUserId: args.performedByUserId,
    })
    .returning();

  return { account: updatedAccount!, transaction: transaction! };
}

/**
 * The Phase-4 integration point — called from inside wallet's/pos's own
 * transaction once those modules' routes exist to call it from. Written now
 * per the plan; no caller until Phase 4 lands. `spendAmount` is a decimal
 * string (matching wallet's money convention); points = floor(spendAmount *
 * LOYALTY_POINTS_PER_CURRENCY_UNIT), rounded down to a whole point.
 */
export async function earnLoyaltyPoints(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    spendAmount: string;
    referenceType: "wallet_transaction" | "pos_sale";
    referenceId: string;
  },
): Promise<void> {
  const points = Math.floor(Number(args.spendAmount) * LOYALTY_POINTS_PER_CURRENCY_UNIT);
  if (points <= 0) return;
  await applyPointsDelta(tx, {
    tenantId: args.tenantId,
    memberId: args.memberId,
    type: "earn",
    points,
    reason: `Earned from ${args.referenceType.replace("_", " ")}`,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
  });
}
