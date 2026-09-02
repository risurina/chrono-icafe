import { eq, and, isNull, or, desc, count, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoPromo, chronoPromoRedemption } from "./schema";
import type { ChronoPromoRow } from "./schema";
import type { PromoDiscountType } from "./contracts";

/**
 * Pure function — no DB access. A promo is active only when its `status`
 * column says "active" AND the current time falls inside its window
 * (`startsAt`, if set, through `endsAt`). A promo past its `endsAt` is
 * treated as inactive regardless of the stored status — see the promos
 * plan's "diverges from oikos" #5 (no stored "expired" state).
 */
export function isWithinWindow(promo: ChronoPromoRow, now: Date): boolean {
  if (promo.status !== "active") return false;
  if (promo.startsAt && now.getTime() < promo.startsAt.getTime()) return false;
  if (now.getTime() >= promo.endsAt.getTime()) return false;
  return true;
}

/**
 * Pure function — no DB access. Computes the discount amount as a decimal
 * string. Percentage: subtotal * value/100. Fixed amount: min(value,
 * subtotal) — a discount can never take the sale below zero. Identical
 * shape to voucher's own computeDiscount.
 */
export function computeDiscount(
  discountType: PromoDiscountType,
  discountValue: string,
  subtotal: string,
): string {
  const value = Number(discountValue);
  const sub = Number(subtotal);
  let discount: number;
  if (discountType === "percentage") {
    discount = (sub * value) / 100;
  } else {
    discount = Math.min(value, sub);
  }
  discount = Math.max(0, discount);
  return discount.toFixed(2);
}

/**
 * Finds the best-matching promo for a checkout: an explicit code lookup
 * (coupon mode) or, when no code is given, the highest-discountValue active
 * auto-apply promo (code: null) matching branch/minSpend/window. Locks the
 * candidate row (SELECT ... FOR UPDATE) and, if maxRedemptions/
 * maxRedemptionsPerMember apply, COUNTs ChronoPromoRedemptions inside the
 * same transaction before accepting it — the load-bearing correctness
 * mechanism, same discipline pos's stock-lock and voucher's redemption-lock
 * use for their own double-spend problem.
 *
 * Throws HttpError(400, ...) for an explicit code that fails validation;
 * returns null (not an error) when no code is given and no auto-apply promo
 * matches.
 */
export async function lockAndValidatePromo(
  tx: TenantTx,
  args: { tenantId: string; code?: string; branchId: string; memberId?: string; subtotal: string },
): Promise<ChronoPromoRow | null> {
  const { tenantId, code, branchId, memberId, subtotal } = args;
  const now = new Date();

  let promo: ChronoPromoRow | undefined;

  if (code) {
    const [row] = await tx
      .select()
      .from(chronoPromo)
      .where(and(eq(chronoPromo.tenantId, tenantId), eq(chronoPromo.code, code)))
      .for("update");
    if (!row) {
      throw new HttpError(400, "Invalid promo code.");
    }
    promo = row;

    if (promo.status === "archived") {
      throw new HttpError(400, "This promo has been archived.");
    }
    if (promo.status === "paused") {
      throw new HttpError(400, "This promo is currently paused.");
    }
    if (!isWithinWindow(promo, now)) {
      throw new HttpError(400, "This promo is not currently active.");
    }
    if (promo.branchId && promo.branchId !== branchId) {
      throw new HttpError(400, "This promo is not valid for this branch.");
    }
    if (promo.minSpend && Number(subtotal) < Number(promo.minSpend)) {
      throw new HttpError(400, `A minimum spend of ${promo.minSpend} is required for this promo.`);
    }
  } else {
    // Auto-apply mode: find the highest-discountValue active, code-less
    // promo matching branch/minSpend/window. Row-lock every candidate row
    // touched so a concurrent redemption against the same promo still
    // serializes correctly.
    const candidates = await tx
      .select()
      .from(chronoPromo)
      .where(
        and(
          eq(chronoPromo.tenantId, tenantId),
          isNull(chronoPromo.code),
          eq(chronoPromo.status, "active"),
          or(eq(chronoPromo.branchId, branchId), isNull(chronoPromo.branchId)),
        ),
      )
      .orderBy(desc(chronoPromo.discountValue))
      .for("update");

    promo = candidates.find(
      (c) =>
        isWithinWindow(c, now) &&
        (!c.minSpend || Number(subtotal) >= Number(c.minSpend)),
    );
    if (!promo) {
      return null;
    }
  }

  // Redemption-cap checks, COUNT-inside-the-same-transaction (load-bearing
  // under `for("update")`'s row lock above).
  if (promo.maxRedemptions != null) {
    const totalRows = await tx
      .select({ value: count() })
      .from(chronoPromoRedemption)
      .where(and(eq(chronoPromoRedemption.tenantId, tenantId), eq(chronoPromoRedemption.promoId, promo.id)));
    const totalCount = totalRows[0]?.value ?? 0;
    if (totalCount >= promo.maxRedemptions) {
      throw new HttpError(400, "This promo has reached its redemption limit.");
    }
  }
  if (promo.maxRedemptionsPerMember != null && memberId) {
    const memberRows = await tx
      .select({ value: count() })
      .from(chronoPromoRedemption)
      .where(
        and(
          eq(chronoPromoRedemption.tenantId, tenantId),
          eq(chronoPromoRedemption.promoId, promo.id),
          eq(chronoPromoRedemption.memberId, memberId),
        ),
      );
    const memberCount = memberRows[0]?.value ?? 0;
    if (memberCount >= promo.maxRedemptionsPerMember) {
      throw new HttpError(400, "You have already used this promo the maximum number of times.");
    }
  }

  return promo;
}

/**
 * Called from inside pos's checkout transaction once a sale row exists
 * (Phase 4 — no caller yet). Inserts the immutable redemption ledger row.
 * Callers are responsible for having already validated the promo via
 * `lockAndValidatePromo` inside the SAME transaction, so the lock/count
 * check and this insert are atomic together.
 */
export async function redeemPromo(
  tx: TenantTx,
  args: { tenantId: string; promoId: string; memberId?: string; saleId: string; discountAmount: string },
): Promise<void> {
  const { tenantId, promoId, memberId, saleId, discountAmount } = args;
  await tx.insert(chronoPromoRedemption).values({
    tenantId,
    promoId,
    memberId,
    saleId,
    discountAmount,
  });
}
