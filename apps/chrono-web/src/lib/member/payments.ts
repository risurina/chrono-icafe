import { api, unwrap, type Result } from "./client";

/**
 * Typed client for the member-initiated online checkout surface
 * (`/portal/payments/*`, apps/chrono-api/src/modules/payment/portal-routes.ts) —
 * mirrors `lib/member/wallet.ts` / `lib/member/credits.ts`'s wrapper pattern.
 * `.ai/plans/chrono/active/member-credit-purchase/README.md`, Phase C5.
 */

export type PaymentGatewayStatus = {
  available: boolean;
  currency: string;
  /** Which account a checkout would use — informational only, the UI doesn't branch on it. */
  scope?: "tenant" | "platform";
};

export type PortalPaymentStatus = "pending" | "paid" | "voided" | "refunded";
export type PaymentPurpose = "credit_purchase" | "wallet_topup";

export type PortalPayment = {
  id: string;
  status: PortalPaymentStatus;
  purpose: PaymentPurpose | null;
  amount: string;
  currency: string;
  fulfilledAt: string | null;
  createdAt: string;
};

export type CreateCheckoutInput =
  | { purpose: "credit_purchase"; productId: string }
  | { purpose: "wallet_topup"; amount: string };

export type CheckoutResult = { paymentId: string; checkoutUrl: string };

/** `{ available, currency }` — never a broken buy button when the tenant has
 * no `customerPayment` integration configured; callers disable online-buy
 * and show "Ask staff at the counter to add credits." instead. */
export function getPaymentGateway(): Promise<Result<PaymentGatewayStatus>> {
  return api.portal.payments.gateway.$get().then((res) => unwrap(res, (json) => json as PaymentGatewayStatus));
}

/**
 * Creates a pending payment + PSP checkout session. Redirect the browser to
 * `checkoutUrl` — never treat this call itself as a completed purchase.
 *
 * `idempotencyKey` (member-wallet-operation-hardening plan): pass the SAME
 * key on a retry of the same user-initiated attempt (a double-click, or the
 * caller retrying after a timed-out-but-uncertain response) to get the
 * original `{paymentId, checkoutUrl}` back instead of a second pending
 * payment row and a second PSP session. Omit it for a genuinely new attempt.
 * `x-member-action` forces the CORS preflight the server now requires on
 * this route (CSRF defense-in-depth).
 */
export function createCheckout(
  input: CreateCheckoutInput,
  idempotencyKey?: string,
): Promise<Result<CheckoutResult>> {
  return api.portal.payments.checkout
    .$post(
      { json: input },
      {
        headers: {
          "x-member-action": "1",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
      },
    )
    .then((res) => unwrap(res, (json) => json as CheckoutResult));
}

/** The caller's OWN payment only — a foreign member's id 404s server-side. */
export function getPayment(id: string): Promise<Result<PortalPayment>> {
  return api.portal.payments[":id"]
    .$get({ param: { id } })
    .then((res) => unwrap(res, (json) => json as PortalPayment));
}
