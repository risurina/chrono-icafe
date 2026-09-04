import { z } from "zod";

/** Mirrors wallet/contracts.ts's positive-decimal bound — same numeric(12,2) columns. */
export const MAX_AMOUNT = "9999999999.99";

const moneyAmountSchema = z
  .string()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    `Amount must be a positive decimal with up to 2 decimal places, at most ${MAX_AMOUNT}`,
  )
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

export const paymentStatusSchema = z.enum(["pending", "paid", "voided", "refunded"]);
export const paymentEventTypeSchema = z.enum([
  "received",
  "cancelled",
  "voided",
  "refunded",
]);

export const createPaymentSchema = z.object({
  memberId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  amount: moneyAmountSchema,
  currency: z.string().length(3).optional(),
  method: z.string().min(1).max(50),
  providerReference: z.string().max(255).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const payPaymentSchema = z.object({
  providerReference: z.string().max(255).optional(),
});

export const voidPaymentSchema = z.object({
  reason: z.string().min(1).max(255).optional(),
});

export const refundPaymentSchema = z.object({
  reason: z.string().min(1).max(255).optional(),
});

export const paymentDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  memberId: z.string().nullable(),
  sessionId: z.string().nullable(),
  amount: z.string(),
  currency: z.string(),
  method: z.string(),
  status: paymentStatusSchema,
  providerReference: z.string().nullable(),
  paidAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type PaymentEventType = z.infer<typeof paymentEventTypeSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type PayPaymentInput = z.infer<typeof payPaymentSchema>;
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
export type PaymentDto = z.infer<typeof paymentDtoSchema>;

// --- Member-initiated online checkout (member-credit-purchase plan) -----
// `.ai/plans/chrono/active/member-credit-purchase/README.md`, Phase C2.

export const paymentPurposeSchema = z.enum(["credit_purchase", "wallet_topup"]);

/** Bounds on a member-supplied wallet top-up amount — ₱20 to ₱10,000. */
export const MIN_WALLET_TOPUP_AMOUNT = "20.00";
export const MAX_WALLET_TOPUP_AMOUNT = "10000.00";

const walletTopupAmountSchema = moneyAmountSchema.refine(
  (v) => Number(v) >= Number(MIN_WALLET_TOPUP_AMOUNT) && Number(v) <= Number(MAX_WALLET_TOPUP_AMOUNT),
  `Amount must be between ${MIN_WALLET_TOPUP_AMOUNT} and ${MAX_WALLET_TOPUP_AMOUNT}`,
);

/**
 * `memberId`/`tenantId` never appear here — they come from `c.var.member` at
 * the route layer, never client input. `productId` is required iff
 * `purpose === "credit_purchase"`; `amount` is required iff
 * `purpose === "wallet_topup"` (and is client-supplied only because a
 * top-up has no server-side price to read — it is bounded here AND
 * re-verified against the PSP-reported amount at fulfilment).
 */
export const createCheckoutSchema = z
  .object({
    purpose: paymentPurposeSchema,
    productId: z.string().min(1).optional(),
    amount: walletTopupAmountSchema.optional(),
  })
  .refine((v) => (v.purpose === "credit_purchase" ? !!v.productId : true), {
    message: "productId is required for a credit_purchase checkout.",
    path: ["productId"],
  })
  .refine((v) => (v.purpose === "credit_purchase" ? v.amount === undefined : true), {
    message: "amount is not accepted for a credit_purchase checkout.",
    path: ["amount"],
  })
  .refine((v) => (v.purpose === "wallet_topup" ? !!v.amount : true), {
    message: "amount is required for a wallet_topup checkout.",
    path: ["amount"],
  })
  .refine((v) => (v.purpose === "wallet_topup" ? v.productId === undefined : true), {
    message: "productId is not accepted for a wallet_topup checkout.",
    path: ["productId"],
  });

export const checkoutResponseSchema = z.object({
  paymentId: z.string(),
  checkoutUrl: z.string(),
});

/** Narrowed self-service DTO — the caller's OWN payment only, never a raw row. */
export const portalPaymentDtoSchema = z.object({
  id: z.string(),
  status: paymentStatusSchema,
  purpose: paymentPurposeSchema.nullable(),
  amount: z.string(),
  currency: z.string(),
  fulfilledAt: z.string().nullable(),
  createdAt: z.string(),
});

export const paymentGatewayStatusSchema = z.object({
  available: z.boolean(),
  currency: z.string(),
});

export type PaymentPurpose = z.infer<typeof paymentPurposeSchema>;
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
export type PortalPaymentDto = z.infer<typeof portalPaymentDtoSchema>;
export type PaymentGatewayStatus = z.infer<typeof paymentGatewayStatusSchema>;
