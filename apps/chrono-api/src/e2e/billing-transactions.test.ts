/**
 * Unit tests for the transaction event parsers + money-unit helpers (Phase 2).
 * Standalone tsx script (`pnpm --filter @agora/api test:billing-transactions`) —
 * the repo has no unit-test runner, so this mirrors the inline assertion style
 * of `sigv4.test.ts`. No DB, no network: every parser is pure and each money
 * helper is validated against a known vector (partial-refund round-trip proves
 * the string↔minor-unit path never loses precision to a float).
 */
process.env.DB_DRIVER = "pglite";

import {
  parseChargeEvent,
  parseRefundEvent,
  parseInvoiceEvent,
  parseStripeTransactionEvent,
  parseXenditTransactionEvent,
  parsePaymongoCheckoutEvent,
  parsePaymongoTransactionEvent,
  parsePaymongoRefundEvent,
  verifyPaymongoSignature,
} from "agora/billing";
import { createHmac } from "node:crypto";
import {
  parseMinorUnits,
  isMinorUnitString,
  formatMinorUnits,
  formatMoney,
} from "agora";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── charge.succeeded → charge/succeeded ──
const chargeEvent = {
  id: "evt_1",
  type: "charge.succeeded",
  data: {
    object: {
      id: "ch_123",
      customer: "cus_9",
      invoice: "in_5",
      amount: 4999,
      amount_refunded: 0,
      currency: "usd",
      status: "succeeded",
      description: "Pro plan",
      created: 1_700_000_000,
      payment_method_details: { card: { brand: "visa", last4: "4242" } },
      metadata: { tenantId: "tnt_acme" },
    },
  },
};
const charge = parseChargeEvent(chargeEvent);
check("charge.succeeded parses to a charge txn", charge?.kind === "charge");
check("charge status is succeeded", charge?.status === "succeeded");
check("charge amount is minor-unit string 4999", charge?.amount === "4999");
check("charge tenant resolved from metadata", charge?.tenantId === "tnt_acme");
check("charge method is card:visa:4242", charge?.method === "card:visa:4242");
check("charge providerObjectId is the charge id", charge?.providerObjectId === "ch_123");
check("charge.succeeded is NOT a refund event", parseRefundEvent(chargeEvent) === null);
check("charge.succeeded is NOT an invoice event", parseInvoiceEvent(chargeEvent) === null);

// ── charge.failed → charge/failed (payment attempt) ──
const failedCharge = parseChargeEvent({
  id: "evt_f",
  type: "charge.failed",
  data: { object: { id: "ch_f", amount: 4999, currency: "usd", status: "failed" } },
});
check("charge.failed parses to failed charge", failedCharge?.status === "failed");

// ── charge.refunded (partial) → partially_refunded, same object id ──
const partialRefund = parseRefundEvent({
  id: "evt_r",
  type: "charge.refunded",
  data: {
    object: {
      id: "ch_123",
      customer: "cus_9",
      amount: 4999,
      amount_refunded: 2000,
      refunded: true,
      currency: "usd",
    },
  },
});
check("charge.refunded finalizes the SAME charge row", partialRefund?.providerObjectId === "ch_123");
check("partial refund → partially_refunded", partialRefund?.status === "partially_refunded");
check("partial refund refundedAmount is 2000", partialRefund?.refundedAmount === "2000");

// ── charge.refunded (full) → refunded ──
const fullRefund = parseRefundEvent({
  id: "evt_r2",
  type: "charge.refunded",
  data: { object: { id: "ch_9", amount: 4999, amount_refunded: 4999, currency: "usd" } },
});
check("full refund → refunded", fullRefund?.status === "refunded");

// ── invoice.paid / invoice.payment_failed ──
const invoicePaid = parseInvoiceEvent({
  id: "evt_i",
  type: "invoice.paid",
  data: { object: { id: "in_5", customer: "cus_9", amount_paid: 4999, currency: "usd", number: "A-1" } },
});
check("invoice.paid → invoice/succeeded", invoicePaid?.kind === "invoice" && invoicePaid?.status === "succeeded");
check("invoice.paid links providerInvoiceId", invoicePaid?.providerInvoiceId === "in_5");
const invoiceFailed = parseInvoiceEvent({
  id: "evt_if",
  type: "invoice.payment_failed",
  data: { object: { id: "in_6", amount_due: 4999, currency: "usd" } },
});
check("invoice.payment_failed → invoice/failed", invoiceFailed?.status === "failed");

// ── dispatch + ignore ──
check("dispatch routes charge.succeeded", parseStripeTransactionEvent(chargeEvent)?.kind === "charge");
check(
  "unrelated event → null",
  parseStripeTransactionEvent({ id: "e", type: "customer.subscription.updated", data: { object: {} } }) === null,
);

// ── Xendit PAID → invoice/succeeded ──
const xendit = parseXenditTransactionEvent({
  id: "xnd_1",
  status: "PAID",
  amount: 150000,
  currency: "IDR",
  external_id: "tnt_acme",
});
check("Xendit PAID → succeeded invoice txn", xendit?.status === "succeeded" && xendit?.kind === "invoice");
check("Xendit tenant from external_id", xendit?.tenantId === "tnt_acme");
check(
  "Xendit non-terminal → null",
  parseXenditTransactionEvent({ id: "x", status: "PENDING", amount: 1 }) === null,
);

// ── PayMongo: checkout_session.payment.paid / payment.paid / payment.failed ──
// Envelope shape mirrors what was empirically captured against a real PayMongo
// test-mode webhook delivery (see .ai/plans/active/paymongo-billing-driver/README.md,
// Precondition A) — NOT guessed from docs.
function paymongoCheckoutPaidEvent(overrides?: { tenantId?: string; plan?: string }) {
  return {
    data: {
      id: "evt_pm_1",
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        livemode: false,
        data: {
          id: "cs_1",
          type: "checkout_session",
          attributes: {
            metadata: {
              tenantId: overrides?.tenantId ?? "tnt_pm",
              plan: overrides?.plan ?? "pro",
            },
          },
        },
      },
    },
  };
}
const pmCheckout = parsePaymongoCheckoutEvent(paymongoCheckoutPaidEvent());
check("PayMongo checkout_session.payment.paid → active", pmCheckout?.status === "active");
check("PayMongo checkout tenant resolved from metadata", pmCheckout?.tenantId === "tnt_pm");
check("PayMongo checkout plan resolved from metadata", pmCheckout?.plan === "pro");
check(
  "PayMongo checkout event ignores unrelated types",
  parsePaymongoCheckoutEvent({
    data: { id: "e", type: "event", attributes: { type: "payment.paid", data: {} } },
  }) === null,
);

function paymongoPaymentEvent(type: "payment.paid" | "payment.failed") {
  return {
    data: {
      id: "evt_pm_2",
      type: "event",
      attributes: {
        type,
        livemode: false,
        data: {
          id: "pay_1",
          type: "payment",
          attributes: {
            amount: 10000,
            currency: "PHP",
            status: type === "payment.paid" ? "paid" : "failed",
            metadata: { tenantId: "tnt_pm", plan: "pro" },
            source: { type: "card", brand: "visa", last4: "4345" },
            created_at: 1_700_000_000,
          },
        },
      },
    },
  };
}
const pmPaid = parsePaymongoTransactionEvent(paymongoPaymentEvent("payment.paid"));
check("PayMongo payment.paid parses to a charge txn (not invoice)", pmPaid?.kind === "charge");
check("PayMongo payment.paid status is succeeded", pmPaid?.status === "succeeded");
check("PayMongo payment.paid amount is minor-unit string 10000", pmPaid?.amount === "10000");
check("PayMongo payment.paid tenant from metadata", pmPaid?.tenantId === "tnt_pm");
check("PayMongo payment.paid method is card:visa:4345", pmPaid?.method === "card:visa:4345");
check(
  "PayMongo payment.failed parses to failed charge",
  parsePaymongoTransactionEvent(paymongoPaymentEvent("payment.failed"))?.status === "failed",
);

// ── PayMongo refund event (UNVERIFIED mapping — see parsePaymongoRefundEvent's
// own doc comment; this test only pins the mapping's current behavior, it does
// not certify the mapping is correct against a real PayMongo refund delivery) ──
const pmRefund = parsePaymongoRefundEvent({
  data: {
    id: "evt_pm_3",
    type: "event",
    attributes: {
      type: "payment.refunded",
      livemode: false,
      data: {
        id: "pay_1",
        type: "payment",
        attributes: {
          amount: 10000,
          currency: "PHP",
          refunded_amount: 10000,
          metadata: { tenantId: "tnt_pm" },
        },
      },
    },
  },
});
check("PayMongo refund finalizes the SAME payment id", pmRefund?.providerObjectId === "pay_1");
check("PayMongo full refund → refunded", pmRefund?.status === "refunded");
check("PayMongo refund is kind:charge (refundable)", pmRefund?.kind === "charge");

// ── PayMongo webhook signature verification ──
// Real header format confirmed live: t=<unix>,te=<hex>,li=<hex> — HMAC-SHA256 over
// "{t}.{rawBody}", identical construction to Stripe's, just a different field name.
const pmSecret = "whsk_test_secret";
const pmPayload = JSON.stringify({ hello: "world" });
const pmTs = Math.floor(Date.now() / 1000);
const pmSig = createHmac("sha256", pmSecret).update(`${pmTs}.${pmPayload}`, "utf8").digest("hex");
check(
  "verifyPaymongoSignature accepts a valid te= signature",
  verifyPaymongoSignature({
    payload: pmPayload,
    header: `t=${pmTs},te=${pmSig},li=`,
    secret: pmSecret,
  }),
);
check(
  "verifyPaymongoSignature accepts a valid li= signature",
  verifyPaymongoSignature({
    payload: pmPayload,
    header: `t=${pmTs},te=,li=${pmSig}`,
    secret: pmSecret,
  }),
);
check(
  "verifyPaymongoSignature rejects a tampered payload",
  !verifyPaymongoSignature({
    payload: pmPayload + "tampered",
    header: `t=${pmTs},te=${pmSig},li=`,
    secret: pmSecret,
  }),
);
check(
  "verifyPaymongoSignature rejects a wrong secret",
  !verifyPaymongoSignature({
    payload: pmPayload,
    header: `t=${pmTs},te=${pmSig},li=`,
    secret: "wrong_secret",
  }),
);
check(
  "verifyPaymongoSignature rejects a missing header",
  !verifyPaymongoSignature({ payload: pmPayload, header: null, secret: pmSecret }),
);

// ── money-unit helpers: partial-refund round-trip WITHOUT float loss ──
check("parseMinorUnits('2000') === 2000", parseMinorUnits("2000") === 2000);
check("isMinorUnitString rejects decimals", !isMinorUnitString("19.99"));
check("isMinorUnitString accepts integer", isMinorUnitString("1999"));
// The classic float-loss vector: 0.1 + 0.2 !== 0.3 in float. Minor-unit math avoids it.
const a = parseMinorUnits("10"); // $0.10
const b = parseMinorUnits("20"); // $0.20
check("10 + 20 minor units === 30 (no float drift)", a + b === 30);
check("format 4999 usd → 49.99", formatMinorUnits("4999", "usd") === "49.99");
check("format 5 usd → 0.05 (padding)", formatMinorUnits("5", "usd") === "0.05");
check("format 1500 jpy → 1500 (zero-decimal)", formatMinorUnits("1500", "jpy") === "1500");
check("formatMoney 1999 usd → '19.99 USD'", formatMoney("1999", "usd") === "19.99 USD");
// A partial refund string round-trips: parse → integer → re-format → same value.
const refundStr = "2000";
const refundMinor = parseMinorUnits(refundStr);
check(
  "refund string ↔ minor units round-trips losslessly",
  String(refundMinor) === refundStr && formatMinorUnits(String(refundMinor), "usd") === "20.00",
);
let threw = false;
try {
  parseMinorUnits("19.99");
} catch {
  threw = true;
}
check("parseMinorUnits rejects a non-integer string", threw);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("BILLING-TXN TESTS: FAIL ❌");
  process.exit(1);
}
console.log("BILLING-TXN TESTS: PASS ✅");
