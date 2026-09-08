/**
 * Registers Chrono's fulfilment handler for the shared platform
 * customer-payment webhook route (`packages/agora`'s
 * `platformCustomerPaymentWebhookRoutes()`), which cannot call into a
 * business app's own fulfilment function directly — `packages/agora` is
 * business-domain-neutral (`.ai/rules/architecture.md`). See
 * `agora/customer-payments`'s `registerCustomerPaymentFulfilment()` and
 * `.ai/plans/agora/in-progress/platform-paymongo-customer-payment-fallback/README.md`,
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
 * `Promise<void>`; the existing `fulfilCustomerPayment` resolves to a
 * `FulfilmentOutcome` union used by the per-tenant webhook route to decide
 * what to audit. This thin adapter discards that outcome — the shared
 * platform webhook route has no equivalent per-outcome audit step (see its
 * own file doc comment), so there is nothing for this handler to do with it
 * beyond letting the transaction commit or throw exactly as
 * `fulfilCustomerPayment` already does.
 */
import { registerCustomerPaymentFulfilment } from "agora/customer-payments";
import { fulfilCustomerPayment } from "./modules/payment/fulfilment";

registerCustomerPaymentFulfilment("chrono_payment", async (tx, args) => {
  await fulfilCustomerPayment(tx, args);
});
