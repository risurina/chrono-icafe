import { and, asc, eq, inArray, sql, schema as base } from "agora/db";
import type { TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import { debitWallet, creditWallet } from "../wallet/service";
import { addMoney, multiplyMoney, subtractMoney, compareMoney } from "../wallet/money";
import { chronoShift } from "../shift/schema";
import {
  chronoProduct,
  chronoSale,
  chronoSaleItem,
  chronoSalePayment,
  type ChronoProductRow,
  type ChronoSaleRow,
  type ChronoSaleItemRow,
  type ChronoSalePaymentRow,
} from "./schema";
import type { CheckoutInput } from "./contracts";

export type CheckoutResult = {
  sale: ChronoSaleRow;
  items: ChronoSaleItemRow[];
  payments: ChronoSalePaymentRow[];
};

export async function findSaleByIdempotencyKey(
  tx: TenantTx,
  tenantId: string,
  idempotencyKey: string,
): Promise<CheckoutResult | null> {
  const [sale] = await tx
    .select()
    .from(chronoSale)
    .where(and(eq(chronoSale.tenantId, tenantId), eq(chronoSale.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (!sale) return null;

  const [items, payments] = await Promise.all([
    tx.select().from(chronoSaleItem).where(eq(chronoSaleItem.saleId, sale.id)),
    tx.select().from(chronoSalePayment).where(eq(chronoSalePayment.saleId, sale.id)),
  ]);
  return { sale, items, payments };
}

/**
 * Locks every referenced trackStock product row, in ascending id order (lock-
 * ordering discipline — prevents deadlocks between two concurrent multi-item
 * checkouts sharing products in different cart order), checks availability,
 * and returns the locked rows keyed by id. Throws 404 for a missing/foreign
 * product, 409 for a disabled product or insufficient stock.
 */
async function lockAndValidateProducts(
  tx: TenantTx,
  tenantId: string,
  requests: Array<{ productId: string; quantity: number }>,
): Promise<Map<string, ChronoProductRow>> {
  if (requests.length === 0) return new Map();

  const ids = [...new Set(requests.map((r) => r.productId))].sort();
  const rows = await tx
    .select()
    .from(chronoProduct)
    .where(and(eq(chronoProduct.tenantId, tenantId), inArray(chronoProduct.id, ids)))
    .orderBy(asc(chronoProduct.id))
    .for("update");

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      throw new HttpError(404, `Product ${id} not found.`);
    }
    if (row.status === "disabled") {
      throw new HttpError(409, `Product "${row.name}" is disabled.`);
    }
  }

  // Sum requested quantity per product (a cart may reference the same
  // product across multiple lines) before checking stock.
  const requestedByProduct = new Map<string, number>();
  for (const r of requests) {
    requestedByProduct.set(r.productId, (requestedByProduct.get(r.productId) ?? 0) + r.quantity);
  }
  for (const [id, requested] of requestedByProduct) {
    const row = byId.get(id)!;
    if (row.trackStock && row.stockQuantity < requested) {
      throw new HttpError(409, `Insufficient stock for "${row.name}".`);
    }
  }

  return byId;
}

/** Throws 409 if no open shift exists for the caller at this branch. Only
 * called when the checkout has a CASH tender. */
async function requireOpenShiftForCash(
  tx: TenantTx,
  args: { tenantId: string; branchId: string; cashierUserId: string },
): Promise<string> {
  const [shift] = await tx
    .select({ id: chronoShift.id })
    .from(chronoShift)
    .where(
      and(
        eq(chronoShift.tenantId, args.tenantId),
        eq(chronoShift.branchId, args.branchId),
        eq(chronoShift.staffUserId, args.cashierUserId),
        eq(chronoShift.status, "open"),
      ),
    )
    .orderBy(asc(chronoShift.openedAt))
    .limit(1);
  if (!shift) {
    throw new HttpError(409, "No open shift for this branch — open a shift before a cash sale.");
  }
  return shift.id;
}

/**
 * The checkout orchestration: prices every line (server-side authority for
 * catalog lines, trusted client amount for ad-hoc lines), decrements stock,
 * inserts the sale + items + payment rows, and debits any wallet tender.
 * Idempotent on (tenantId, idempotencyKey) — returns the existing sale
 * unchanged on a repeat call instead of erroring.
 */
export async function checkout(
  tx: TenantTx,
  args: { tenantId: string; branchId: string; cashierUserId: string; input: CheckoutInput },
): Promise<CheckoutResult> {
  const { tenantId, branchId, cashierUserId, input } = args;

  const existing = await findSaleByIdempotencyKey(tx, tenantId, input.idempotencyKey);
  if (existing) return existing;

  const productLines = input.items.filter((l) => l.productId);
  const products = await lockAndValidateProducts(
    tx,
    tenantId,
    productLines.map((l) => ({ productId: l.productId!, quantity: l.quantity })),
  );

  const hasCashTender = input.payments.some((p) => p.method === "cash");
  const shiftId = hasCashTender
    ? await requireOpenShiftForCash(tx, { tenantId, branchId, cashierUserId })
    : null;

  // Price every line server-side (catalog lines from the locked product row —
  // never a client-supplied price; ad-hoc lines use the trusted client
  // amount, since there's no catalog entry to price from).
  let totalAmount = "0.00";
  const lineSnapshots: Array<{
    productId: string | null;
    name: string;
    sku: string | null;
    unitPrice: string;
    quantity: number;
    lineTotal: string;
  }> = [];
  for (const line of input.items) {
    const product = line.productId ? products.get(line.productId)! : null;
    const unitPrice = product ? product.price : line.unitPrice!;
    const lineTotal = multiplyMoney(unitPrice, line.quantity);
    totalAmount = addMoney(totalAmount, lineTotal);
    lineSnapshots.push({
      productId: product?.id ?? null,
      name: product?.name ?? line.name!,
      sku: product?.sku ?? null,
      unitPrice,
      quantity: line.quantity,
      lineTotal,
    });
  }

  const amountTendered = input.payments.reduce((sum, p) => addMoney(sum, p.amount), "0.00");
  if (compareMoney(amountTendered, totalAmount) < 0) {
    throw new HttpError(400, "Payment total is less than the sale total.");
  }
  const changeAmount = subtractMoney(amountTendered, totalAmount);

  // memberId ownership check (if provided) — 404 before any wallet/stock
  // touch, closing the same isolation hole wallet's Pass 1 mandated.
  if (input.memberId) {
    const [member] = await tx
      .select({ id: base.tenantMember.id })
      .from(base.tenantMember)
      .where(eq(base.tenantMember.id, input.memberId))
      .limit(1);
    if (!member) {
      throw new HttpError(404, "Member not found.");
    }
  }

  const [sale] = await tx
    .insert(chronoSale)
    .values({
      tenantId,
      branchId,
      shiftId,
      memberId: input.memberId ?? null,
      customerName: input.customerName ?? null,
      cashierUserId,
      status: "completed",
      totalAmount,
      amountTendered,
      changeAmount,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();

  const items = await tx
    .insert(chronoSaleItem)
    .values(
      lineSnapshots.map((l) => ({
        tenantId,
        saleId: sale!.id,
        productId: l.productId,
        name: l.name,
        sku: l.sku,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
      })),
    )
    .returning();

  for (const [productId, product] of products) {
    if (!product.trackStock) continue;
    const requested = productLines
      .filter((l) => l.productId === productId)
      .reduce((sum, l) => sum + l.quantity, 0);
    await tx
      .update(chronoProduct)
      .set({ stockQuantity: product.stockQuantity - requested, updatedAt: new Date() })
      .where(eq(chronoProduct.id, productId));
  }

  const payments: ChronoSalePaymentRow[] = [];
  for (const tender of input.payments) {
    let walletTransactionId: string | null = null;
    if (tender.method === "wallet") {
      if (!input.memberId) {
        throw new HttpError(400, "A wallet tender requires memberId.");
      }
      const { transaction } = await debitWallet(tx, {
        tenantId,
        memberId: input.memberId,
        amount: tender.amount,
        reason: "POS sale",
        referenceType: "pos_sale",
        referenceId: sale!.id,
        performedByUserId: cashierUserId,
      });
      walletTransactionId = transaction.id;
    }
    const [payment] = await tx
      .insert(chronoSalePayment)
      .values({
        tenantId,
        saleId: sale!.id,
        method: tender.method,
        amount: tender.amount,
        referenceNumber: tender.referenceNumber ?? null,
        walletTransactionId,
      })
      .returning();
    payments.push(payment!);
  }

  return { sale: sale!, items, payments };
}

/**
 * Whole-sale refund: reverses only the wallet-tendered payment rows via
 * creditWallet(), restores stock for trackStock lines, flips status. Cash/
 * card portions are recorded, not auto-reversed — a deliberate simplification
 * (see the plan's "Refund reversal is partial by design").
 */
export async function refundSale(
  tx: TenantTx,
  args: { tenantId: string; saleId: string; reason: string; performedByUserId: string },
): Promise<ChronoSaleRow> {
  // Locked FIRST, and the status re-checked while the lock is held: without
  // this, two concurrent refunds both read "completed", both credit the wallet,
  // and the sale is refunded twice — money created from nothing. The sale row
  // always exists, so unlike an overlap check this lock genuinely serializes
  // contenders (same discipline as wallet/service.ts's lockWalletForUpdate).
  const [sale] = await tx
    .select()
    .from(chronoSale)
    .where(and(eq(chronoSale.tenantId, args.tenantId), eq(chronoSale.id, args.saleId)))
    .limit(1)
    .for("update");
  if (!sale) {
    throw new HttpError(404, "Sale not found.");
  }
  if (sale.status === "refunded") {
    throw new HttpError(409, "This sale has already been refunded.");
  }

  const [items, payments] = await Promise.all([
    tx.select().from(chronoSaleItem).where(eq(chronoSaleItem.saleId, sale.id)),
    tx.select().from(chronoSalePayment).where(eq(chronoSalePayment.saleId, sale.id)),
  ]);

  // Stock is restored BEFORE the wallet credit, per the wallet module's
  // lock-ordering rule (.ai/plans/chrono/active/wallet/README.md): acquire the
  // wallet lock last, after every other row lock this transaction needs.
  // In-place `stockQuantity + n` rather than read-then-write, so a concurrent
  // checkout holding the product lock cannot have its decrement lost.
  for (const item of items) {
    if (!item.productId) continue;
    await tx
      .update(chronoProduct)
      .set({
        stockQuantity: sql`${chronoProduct.stockQuantity} + ${item.quantity}`,
        updatedAt: new Date(),
      })
      .where(and(eq(chronoProduct.id, item.productId), eq(chronoProduct.trackStock, true)));
  }

  for (const payment of payments) {
    if (payment.method !== "wallet" || !sale.memberId) continue;
    await creditWallet(tx, {
      tenantId: args.tenantId,
      memberId: sale.memberId,
      amount: payment.amount,
      reason: "POS refund",
      referenceType: "pos_refund",
      referenceId: sale.id,
      performedByUserId: args.performedByUserId,
    });
  }

  const [updated] = await tx
    .update(chronoSale)
    .set({
      status: "refunded",
      refundedAt: new Date(),
      refundedByUserId: args.performedByUserId,
      refundReason: args.reason,
      updatedAt: new Date(),
    })
    .where(eq(chronoSale.id, sale.id))
    .returning();

  return updated!;
}
