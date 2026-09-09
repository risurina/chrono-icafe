/**
 * Registers Chrono's fulfilment handler for platform-scope PayMongo
 * customer-payment events. Originally consumed by `packages/agora`'s shared
 * `platformCustomerPaymentWebhookRoutes()` (which could not call into a
 * business app's own fulfilment function directly — `packages/agora` is
 * business-domain-neutral, `.ai/rules/architecture.md`); that route was
 * deleted in the centralized-webhook-architecture plan's Phase 6, and the
 * platform-scope branch of `apps/chrono-api/src/modules/webhook/adapters/
 * paymongo.ts`'s `dispatch()` (the new ingress) is now the sole caller of
 * `getCustomerPaymentFulfilment("chrono_payment")`. See
 * `agora/customer-payments`'s `registerCustomerPaymentFulfilment()` and
 * `.ai/plans/agora/archive/platform-paymongo-customer-payment-fallback/README.md`,
 * Phase 4.
 *
 * Unlike `auth-bootstrap.ts`, this registry freezes on first CALL to
 * `getCustomerPaymentFulfilment` (the first real webhook delivery), not at
 * import time — there is no eager-build step to race here the way
 * `agora/auth` eagerly builds Better Auth's `ac`/roles. Importing this module
 * anywhere before the server starts accepting traffic is sufficient; it is
 * imported from `src/index.ts` for the same "before traffic" reason
 * `auth-bootstrap.ts` is imported first.
 *
 * `registerCustomerPaymentFulfilment`'s `FulfilmentHandler` type resolves to
 * `Promise<FulfilmentResult>` (`{ applied: true } | { applied: false; reason }`);
 * the existing `fulfilCustomerPayment` resolves to a `FulfilmentOutcome` union
 * used by the per-tenant webhook route to decide what to audit. This thin
 * adapter maps that outcome to the shared route's narrower `applied` signal
 * instead of discarding it: `"fulfilled"` and `"already_paid"` both mean the
 * payment IS in a paid state (this delivery just credited it, or a PSP
 * redelivery found it already credited), so the platform receivable ledger
 * legitimately owes the tenant for it — `"missing"` (stale/unknown/non-pending
 * row) and `"amount_mismatch"` (voided by `fulfilCustomerPayment`, see that
 * file) never moved money, so the shared webhook route must not record a
 * receivable for them. Any other error still propagates unchanged — letting
 * the transaction throw and roll back exactly as `fulfilCustomerPayment`
 * already does.
 */
import { registerCustomerPaymentFulfilment } from "agora/customer-payments";
import { fulfilCustomerPayment } from "./modules/payment/fulfilment";
import { registerWebhookProvider } from "agora/webhooks/inbound";
import { paymongoWebhookAdapter } from "./modules/webhook/adapters/paymongo";
import { registerActiveBillingWebhookProvider } from "agora/billing/server";

registerCustomerPaymentFulfilment("chrono_payment", async (tx, args) => {
  const result = await fulfilCustomerPayment(tx, args);
  if (result.outcome === "fulfilled" || result.outcome === "already_paid") {
    return { applied: true };
  }
  return { applied: false, reason: result.outcome };
});

registerWebhookProvider("paymongo", paymongoWebhookAdapter);

registerActiveBillingWebhookProvider();
