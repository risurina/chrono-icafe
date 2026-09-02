import { eq, and, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { chronoVoucher } from "./schema";
import type { ChronoVoucherRow, NewChronoVoucher } from "./schema";
import type { DiscountType } from "./contracts";

/**
 * Pure function — no DB access. Computes the discount amount as a decimal
 * string. Percentage: subtotal * value/100. Fixed amount: min(value,
 * subtotal) — a discount can never take the sale below zero.
 */
export function computeDiscount(
  discountType: DiscountType,
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
 * Locks the voucher row (SELECT ... FOR UPDATE), validates it is active, not
 * expired, and — if `memberId` is set on the voucher — matches the sale's own
 * `memberId`. Does NOT mutate the row: callers decide when to actually commit
 * the redemption (see `redeemVoucher`), so a checkout preview/quote can call
 * this without side effects. Throws `HttpError(400, ...)`/`HttpError(404,
 * ...)` on any failure — mirrors reservation's `assertNoOverlap` row-lock-
 * then-validate discipline.
 */
export async function lockAndValidateVoucher(
  tx: TenantTx,
  args: { tenantId: string; code: string; memberId?: string },
): Promise<ChronoVoucherRow> {
  const { tenantId, code, memberId } = args;

  const [voucher] = await tx
    .select()
    .from(chronoVoucher)
    .where(and(eq(chronoVoucher.tenantId, tenantId), eq(chronoVoucher.code, code)))
    .for("update");

  if (!voucher) {
    throw new HttpError(400, "Invalid voucher code.");
  }
  if (voucher.status !== "active") {
    throw new HttpError(400, `This voucher is already ${voucher.status}.`);
  }
  if (voucher.expiresAt && voucher.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, "This voucher has expired.");
  }
  if (voucher.memberId && voucher.memberId !== memberId) {
    throw new HttpError(400, "This voucher is not valid for this customer.");
  }

  return voucher;
}

/**
 * Called from inside pos's checkout transaction once a sale row exists (Phase
 * 4 — no caller yet). Locks and validates the voucher, computes the discount
 * against `subtotal`, then flips it to `redeemed` and links it to the sale.
 */
export async function redeemVoucher(
  tx: TenantTx,
  args: { tenantId: string; code: string; memberId?: string; saleId: string; subtotal: string },
): Promise<{ voucher: ChronoVoucherRow; discountAmount: string }> {
  const { tenantId, code, memberId, saleId, subtotal } = args;
  const voucher = await lockAndValidateVoucher(tx, { tenantId, code, memberId });
  const discountAmount = computeDiscount(voucher.discountType as DiscountType, voucher.discountValue, subtotal);

  const [updated] = await tx
    .update(chronoVoucher)
    .set({
      status: "redeemed",
      redeemedAt: new Date(),
      redeemedAgainstSaleId: saleId,
      updatedAt: new Date(),
    })
    .where(and(eq(chronoVoucher.tenantId, tenantId), eq(chronoVoucher.id, voucher.id)))
    .returning();

  return { voucher: updated!, discountAmount };
}

/**
 * Called from a sale-refund flow (once `pos` has one) to reverse a
 * redemption: finds the voucher redeemed against `saleId` and flips it back
 * to `active`, clearing `redeemedAt`/`redeemedAgainstSaleId`. A no-op (never
 * throws) when no voucher was redeemed against that sale.
 */
export async function reverseVoucherRedemption(
  tx: TenantTx,
  args: { tenantId: string; saleId: string },
): Promise<void> {
  const { tenantId, saleId } = args;

  const [voucher] = await tx
    .select({ id: chronoVoucher.id })
    .from(chronoVoucher)
    .where(
      and(eq(chronoVoucher.tenantId, tenantId), eq(chronoVoucher.redeemedAgainstSaleId, saleId)),
    )
    .for("update");

  if (!voucher) return;

  await tx
    .update(chronoVoucher)
    .set({
      status: "active",
      redeemedAt: null,
      redeemedAgainstSaleId: null,
      updatedAt: new Date(),
    })
    .where(and(eq(chronoVoucher.tenantId, tenantId), eq(chronoVoucher.id, voucher.id)));
}

export type { NewChronoVoucher };
