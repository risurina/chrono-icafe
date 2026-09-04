import { eq, and, type TenantTx } from "agora/db";
import { HttpError } from "agora/server";
import type { ParsedCustomerPayment } from "agora/customer-payments";
import { chronoPayment } from "./schema";
import { creditWallet } from "../wallet/service";
import { toCents } from "../wallet/money";
import { purchaseCreditProduct } from "../credit/service";

/**
 * Webhook-driven fulfilment for a member-initiated online payment
 * (member-credit-purchase plan, Phase C3). This is the ONLY place a
 * `ChronoPayments` row created by `/portal/payments/checkout` is ever
 * marked `paid` — the success redirect the customer's browser lands on
 * never grants anything itself. Callers open the transaction
 * (`withTenant(tenantId, tx => fulfilCustomerPayment(tx, ...))`); on
 * `outcome !== "fulfilled" | "amount_mismatch"` nothing was written beyond
 * what's described below, and on a rethrown (non-`HttpError`) failure the
 * whole transaction rolls back so the webhook can safely retry.
 *
 * Deliberately does NOT call `recordAudit` itself — `recordAudit` opens its
 * own `withTenant` transaction (best-effort, fire-and-forget by design) and
 * must never run nested inside this function's own transaction. The caller
 * (the webhook route) audits AFTER this transaction commits, using the
 * returned outcome.
 */

export type FulfilmentOutcome =
  | { outcome: "missing" }
  | { outcome: "already_paid"; paymentId: string }
  | {
      outcome: "amount_mismatch";
      paymentId: string;
      tenantId: string;
      expectedAmount: string;
      expectedCurrency: string;
      gotAmountMinorUnits: number;
      gotCurrency: string;
    }
  | {
      outcome: "fulfilled";
      paymentId: string;
      tenantId: string;
      memberId: string;
      purpose: string | null;
      /** true when the credit-purchase step was skipped (product archived/repriced) and only the wallet was credited. */
      degraded: boolean;
      fulfilmentNote: string | null;
    };

/** Compares a decimal-string amount against provider-reported integer minor units. */
function amountsMatch(rowAmount: string, gotMinorUnits: number): boolean {
  return toCents(rowAmount) === BigInt(Math.trunc(gotMinorUnits));
}

export async function fulfilCustomerPayment(
  tx: TenantTx,
  args: { tenantId: string; parsed: ParsedCustomerPayment },
  // Test-only injection seam — every real caller uses the default, exactly
  // like `agora/server`'s own `__setCustomerPaymentGateway` test seams
  // elsewhere in this codebase. Lets fulfilment.test.ts force a genuine
  // "infrastructure error" (as opposed to a domain HttpError) out of the
  // credit step, to prove it rethrows and rolls back rather than degrading.
  deps: {
    purchaseCreditProduct: typeof purchaseCreditProduct;
    creditWallet: typeof creditWallet;
  } = { purchaseCreditProduct, creditWallet },
): Promise<FulfilmentOutcome> {
  const { tenantId, parsed } = args;
  if (!parsed.referenceId) return { outcome: "missing" };

  const [row] = await tx
    .select()
    .from(chronoPayment)
    .where(and(eq(chronoPayment.id, parsed.referenceId), eq(chronoPayment.tenantId, tenantId)))
    .for("update");

  if (!row) return { outcome: "missing" };
  if (row.status === "paid") return { outcome: "already_paid", paymentId: row.id };
  if (row.status !== "pending") return { outcome: "missing" };
  if (!row.memberId) return { outcome: "missing" };

  const amountOk = amountsMatch(row.amount, parsed.amountMinorUnits);
  const currencyOk = row.currency.toUpperCase() === parsed.currency.toUpperCase();
  if (!amountOk || !currencyOk) {
    const note = `Amount/currency mismatch at fulfilment: expected ${row.amount} ${row.currency}, provider reported ${parsed.amountMinorUnits} (minor units) ${parsed.currency}.`;
    await tx
      .update(chronoPayment)
      .set({ status: "voided", fulfilmentNote: note, updatedAt: new Date() })
      .where(eq(chronoPayment.id, row.id));
    return {
      outcome: "amount_mismatch",
      paymentId: row.id,
      tenantId,
      expectedAmount: row.amount,
      expectedCurrency: row.currency,
      gotAmountMinorUnits: parsed.amountMinorUnits,
      gotCurrency: parsed.currency,
    };
  }

  // Wallet credited FIRST — this is what the customer actually paid for,
  // and it must land even if the credit-purchase step below degrades.
  await deps.creditWallet(tx, {
    tenantId,
    memberId: row.memberId,
    amount: row.amount,
    reason: "Online payment",
    referenceType: "online_payment",
    referenceId: row.id,
  });

  let degraded = false;
  let fulfilmentNote: string | null = null;

  if (row.purpose === "credit_purchase" && row.creditProductId) {
    try {
      await deps.purchaseCreditProduct(tx, {
        tenantId,
        memberId: row.memberId,
        productId: row.creditProductId,
        chargeAmount: row.amount,
      });
    } catch (err) {
      // A domain refusal (404 product gone / 409 no longer sellable) — the
      // wallet credit above already committed within this same transaction,
      // so degrade gracefully to a plain top-up rather than rolling back a
      // payment that was genuinely received. Any OTHER error (a DB outage,
      // a bug) must still roll back the whole transaction so the webhook
      // retries — swallowing it here would silently eat a paid-but-
      // unfulfilled payment.
      if (err instanceof HttpError) {
        degraded = true;
        fulfilmentNote = `Credit product unavailable at fulfilment time (${err.message}) — wallet credited as a top-up instead.`;
      } else {
        throw err;
      }
    }
  }

  await tx
    .update(chronoPayment)
    .set({
      status: "paid",
      paidAt: parsed.occurredAt,
      fulfilledAt: new Date(),
      providerReference: parsed.providerRef,
      method: parsed.method ?? row.method,
      fulfilmentNote,
      updatedAt: new Date(),
    })
    .where(eq(chronoPayment.id, row.id));

  return {
    outcome: "fulfilled",
    paymentId: row.id,
    tenantId,
    memberId: row.memberId,
    purpose: row.purpose,
    degraded,
    fulfilmentNote,
  };
}
