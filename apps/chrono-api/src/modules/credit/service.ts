import { eq, and, isNull, or, type TenantTx } from "agora/db";
import { gt } from "drizzle-orm";
import { HttpError } from "agora/server";
import {
  chronoCreditProduct,
  chronoCreditGrant,
  chronoCreditPurchase,
  chronoCreditGrantLedgerEntry,
} from "./schema";
import { debitWallet, creditWallet } from "../wallet/service";

type ChronoCreditGrantRow = typeof chronoCreditGrant.$inferSelect;

/**
 * Scores a candidate grant's eligibility to pay for a spend at
 * `targetStationGroupId`. Lower is better; 99 means ineligible (skipped
 * entirely). Ported from oikos's deterministic scorer, trimmed to the two
 * policies this pass supports (`strict_group_only` / `any_station`) — see
 * .ai/plans/chrono/active/credits/README.md, "Consumption algorithm".
 */
export function scoreGrantEligibility(
  grant: { creditPolicy: string; stationGroupId: string | null },
  targetStationGroupId: string | null,
): number {
  if (grant.creditPolicy === "strict_group_only") {
    return targetStationGroupId && grant.stationGroupId === targetStationGroupId
      ? 1
      : 99;
  }
  // "any_station" — always eligible regardless of target.
  return 2;
}

/**
 * Applies a signed minute delta to an already-locked grant row and writes the
 * matching ledger entry in the same transaction — the single choke point
 * every balance mutation in this module funnels through, mirroring wallet's
 * own `applyWalletDelta`. Throws 422 only when the delta would drive the
 * grant negative; a consumption shortfall is handled by the caller
 * (`consumeCredits`) by simply not drawing more than `remainingQuantity`.
 */
export async function applyGrantDelta(
  tx: TenantTx,
  grant: ChronoCreditGrantRow,
  args: {
    tenantId: string;
    delta: number;
    type: "granted" | "consumed" | "expired" | "voided" | "adjusted";
    reason?: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
): Promise<ChronoCreditGrantRow> {
  const quantityAfter = grant.remainingQuantity + args.delta;
  if (quantityAfter < 0) {
    throw new HttpError(422, "Adjustment exceeds remaining balance.");
  }
  const nextStatus =
    quantityAfter === 0 && args.delta < 0
      ? args.type === "voided"
        ? "voided"
        : args.type === "expired"
          ? "expired"
          : "depleted"
      : grant.status;

  const [updated] = await tx
    .update(chronoCreditGrant)
    .set({ remainingQuantity: quantityAfter, status: nextStatus, updatedAt: new Date() })
    .where(eq(chronoCreditGrant.id, grant.id))
    .returning();

  await tx.insert(chronoCreditGrantLedgerEntry).values({
    tenantId: args.tenantId,
    grantId: grant.id,
    memberId: grant.memberId,
    type: args.type,
    quantityDelta: args.delta,
    quantityBefore: grant.remainingQuantity,
    quantityAfter,
    reason: args.reason,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    performedByUserId: args.performedByUserId,
  });

  return updated!;
}

/**
 * Consumes `quantityMinutes` from a member's eligible lots, in deterministic
 * priority order — eligibility score, then `priority` ascending, then
 * `expiresAt` ascending (soonest-expiring first, never-expiring last), then
 * `createdAt` ascending. Locks every candidate row with `SELECT ... FOR
 * UPDATE` up front so concurrent consumes against the same member never lose
 * an update. A shortfall is REPORTED, never thrown — matching wallet's own
 * partial-fill precedent.
 */
export async function consumeCredits(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    quantityMinutes: number;
    stationGroupId?: string | null;
    reason: string;
    referenceType?: string;
    referenceId?: string;
    performedByUserId?: string;
  },
): Promise<{
  consumed: number;
  shortfall: number;
  applications: Array<{ grantId: string; minutes: number }>;
}> {
  const candidates = await tx
    .select()
    .from(chronoCreditGrant)
    .where(
      and(
        eq(chronoCreditGrant.tenantId, args.tenantId),
        eq(chronoCreditGrant.memberId, args.memberId),
        eq(chronoCreditGrant.status, "granted"),
        gt(chronoCreditGrant.remainingQuantity, 0),
        or(isNull(chronoCreditGrant.expiresAt), gt(chronoCreditGrant.expiresAt, new Date())),
      ),
    )
    .for("update");

  const eligible = candidates
    .map((g) => ({ grant: g, score: scoreGrantEligibility(g, args.stationGroupId ?? null) }))
    .filter((c) => c.score < 99)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.grant.priority !== b.grant.priority) return a.grant.priority - b.grant.priority;
      const aExpires = a.grant.expiresAt?.getTime() ?? Infinity;
      const bExpires = b.grant.expiresAt?.getTime() ?? Infinity;
      if (aExpires !== bExpires) return aExpires - bExpires;
      return a.grant.createdAt.getTime() - b.grant.createdAt.getTime();
    });

  let remaining = args.quantityMinutes;
  const applications: Array<{ grantId: string; minutes: number }> = [];
  for (const { grant } of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, grant.remainingQuantity);
    await applyGrantDelta(tx, grant, {
      tenantId: args.tenantId,
      delta: -take,
      type: "consumed",
      reason: args.reason,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      performedByUserId: args.performedByUserId,
    });
    applications.push({ grantId: grant.id, minutes: take });
    remaining -= take;
  }

  return {
    consumed: args.quantityMinutes - remaining,
    shortfall: remaining,
    applications,
  };
}

/**
 * Sells an active credit product to a member: charges their wallet
 * (composes wallet's own `debitWallet`, whose 422-on-insufficient-balance
 * guard is reused verbatim), then issues the lot (grant row created FIRST,
 * purchase row referencing it SECOND — see schema's "Avoiding the circular
 * FK"). All in the caller's already-open transaction — a wallet-debit
 * rollback on 422 leaves no grant/purchase row behind.
 */
export async function purchaseCreditProduct(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    productId: string;
    performedByUserId?: string;
  },
) {
  const [product] = await tx
    .select()
    .from(chronoCreditProduct)
    .where(
      and(
        eq(chronoCreditProduct.id, args.productId),
        eq(chronoCreditProduct.tenantId, args.tenantId),
      ),
    );
  if (!product) throw new HttpError(404, "Credit product not found.");
  if (product.status !== "active") {
    throw new HttpError(409, "This product is not available for sale.");
  }

  // Cash side first — reuses wallet's own guard rather than re-deriving it.
  const { transaction } = await debitWallet(tx, {
    tenantId: args.tenantId,
    memberId: args.memberId,
    amount: product.priceAmount,
    reason: `Credit purchase: ${product.name}`,
    referenceType: "credit_purchase",
    performedByUserId: args.performedByUserId,
  });

  const expiresAt = product.validityDays
    ? new Date(Date.now() + product.validityDays * 86_400_000)
    : null;

  const [grant] = await tx
    .insert(chronoCreditGrant)
    .values({
      tenantId: args.tenantId,
      memberId: args.memberId,
      productId: product.id,
      stationGroupId: product.stationGroupId,
      creditPolicy: product.creditPolicy,
      unit: product.unit,
      originalQuantity: product.quantityMinutes,
      remainingQuantity: product.quantityMinutes,
      expiresAt,
      performedByUserId: args.performedByUserId,
    })
    .returning();

  await tx.insert(chronoCreditGrantLedgerEntry).values({
    tenantId: args.tenantId,
    grantId: grant!.id,
    memberId: args.memberId,
    type: "granted",
    quantityDelta: product.quantityMinutes,
    quantityBefore: 0,
    quantityAfter: product.quantityMinutes,
    referenceType: "purchase",
    performedByUserId: args.performedByUserId,
  });

  const [purchase] = await tx
    .insert(chronoCreditPurchase)
    .values({
      tenantId: args.tenantId,
      memberId: args.memberId,
      productId: product.id,
      grantId: grant!.id,
      quantityMinutes: product.quantityMinutes,
      priceAmount: product.priceAmount,
      currency: product.currency,
      walletTransactionId: transaction.id,
    })
    .returning();

  return { purchase: purchase!, grant: grant! };
}

/** Free minutes with no charge — a comp. Same insert shape as the grant half
 * of `purchaseCreditProduct`, minus the wallet debit and the purchase row. */
export async function grantCreditsManually(
  tx: TenantTx,
  args: {
    tenantId: string;
    memberId: string;
    quantityMinutes: number;
    stationGroupId?: string | null;
    creditPolicy?: "strict_group_only" | "any_station";
    expiresAt?: Date | null;
    reason: string;
    performedByUserId?: string;
  },
) {
  const [grant] = await tx
    .insert(chronoCreditGrant)
    .values({
      tenantId: args.tenantId,
      memberId: args.memberId,
      productId: null,
      stationGroupId: args.stationGroupId ?? null,
      creditPolicy: args.creditPolicy ?? "any_station",
      originalQuantity: args.quantityMinutes,
      remainingQuantity: args.quantityMinutes,
      expiresAt: args.expiresAt ?? null,
      reason: args.reason,
      performedByUserId: args.performedByUserId,
    })
    .returning();

  await tx.insert(chronoCreditGrantLedgerEntry).values({
    tenantId: args.tenantId,
    grantId: grant!.id,
    memberId: args.memberId,
    type: "granted",
    quantityDelta: args.quantityMinutes,
    quantityBefore: 0,
    quantityAfter: args.quantityMinutes,
    reason: args.reason,
    referenceType: "manual",
    performedByUserId: args.performedByUserId,
  });

  return { grant: grant! };
}

/** A raw, signed correction: subtracts `deltaMinutes` from a grant's
 * remaining balance. 422 if it would go negative (`applyGrantDelta`'s own
 * guard). Caller must have already locked `grant` with `SELECT ... FOR UPDATE`. */
export async function adjustCreditGrant(
  tx: TenantTx,
  grant: ChronoCreditGrantRow,
  args: {
    tenantId: string;
    deltaMinutes: number;
    reason: string;
    performedByUserId?: string;
  },
) {
  return applyGrantDelta(tx, grant, {
    tenantId: args.tenantId,
    delta: -args.deltaMinutes,
    type: "adjusted",
    reason: args.reason,
    performedByUserId: args.performedByUserId,
  });
}

/** Zeroes a grant's remaining balance — a correction, no wallet refund.
 * Caller must have already locked `grant` with `SELECT ... FOR UPDATE`. */
export async function voidCreditGrant(
  tx: TenantTx,
  grant: ChronoCreditGrantRow,
  args: { tenantId: string; reason?: string; performedByUserId?: string },
) {
  return applyGrantDelta(tx, grant, {
    tenantId: args.tenantId,
    delta: -grant.remainingQuantity,
    type: "voided",
    reason: args.reason,
    performedByUserId: args.performedByUserId,
  });
}

/**
 * Voids a purchase — only while its lot is entirely unused
 * (`remainingQuantity === originalQuantity`), otherwise 409 (see the plan's
 * "Void semantics"). Zeroes the grant, marks the purchase voided, and
 * refunds the wallet in full via `creditWallet`. Caller must have already
 * locked both `purchase` and `grant` with `SELECT ... FOR UPDATE`.
 */
export async function voidCreditPurchase(
  tx: TenantTx,
  purchase: typeof chronoCreditPurchase.$inferSelect,
  grant: ChronoCreditGrantRow,
  args: { tenantId: string; performedByUserId?: string },
) {
  if (grant.remainingQuantity !== grant.originalQuantity) {
    throw new HttpError(
      409,
      "This purchase has already been partially used and cannot be voided — void the remaining balance on the grant instead.",
    );
  }

  await applyGrantDelta(tx, grant, {
    tenantId: args.tenantId,
    delta: -grant.remainingQuantity,
    type: "voided",
    reason: "Purchase voided",
    referenceType: "credit_purchase_void",
    referenceId: purchase.id,
    performedByUserId: args.performedByUserId,
  });

  const [updatedPurchase] = await tx
    .update(chronoCreditPurchase)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedByUserId: args.performedByUserId,
      updatedAt: new Date(),
    })
    .where(eq(chronoCreditPurchase.id, purchase.id))
    .returning();

  const { transaction } = await creditWallet(tx, {
    tenantId: args.tenantId,
    memberId: purchase.memberId,
    amount: purchase.priceAmount,
    reason: "Credit purchase voided",
    referenceType: "credit_purchase_void",
    referenceId: purchase.id,
    performedByUserId: args.performedByUserId,
  });

  return { purchase: updatedPurchase!, walletTransaction: transaction };
}
