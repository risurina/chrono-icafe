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
