import { z } from "zod";

/**
 * `numeric(12, 2)` holds at most 10 integer digits (precision 12 − scale 2), so the
 * largest value the balance/amount columns can represent is 9999999999.99. Bounding
 * the integer part in the schemas below turns an out-of-range amount into a readable
 * 422 instead of a Postgres numeric-overflow 500. The service applies the same ceiling
 * to the *resulting* balance, since a series of individually-valid credits can still
 * overflow cumulatively.
 */
export const MAX_BALANCE = "9999999999.99";

const moneyAmountSchema = z
  .string()
  .regex(
    /^\d{1,10}(\.\d{1,2})?$/,
    `Amount must be a positive decimal with up to 2 decimal places, at most ${MAX_BALANCE}`,
  )
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

const signedMoneyAmountSchema = z
  .string()
  .regex(
    /^-?\d{1,10}(\.\d{1,2})?$/,
    `Amount must be a decimal with up to 2 decimal places, magnitude at most ${MAX_BALANCE}`,
  )
  .refine((v) => Number(v) !== 0, "Adjustment amount must not be zero");

export const walletTransactionTypeSchema = z.enum(["credit", "debit", "adjustment"]);

export const creditWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().min(1).max(255).optional(), // defaults to "Manual top-up" in the route
  referenceType: z.string().max(50).optional(),
  cashTendered: z.boolean().default(false).optional(),
});

export const debitWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().min(1).max(255),
  referenceType: z.string().max(50).optional(),
  cashTendered: z.boolean().default(false).optional(),
});

export const adjustWalletSchema = z.object({
  delta: signedMoneyAmountSchema,
  reason: z.string().min(1).max(255),
});

export type WalletTransactionType = z.infer<typeof walletTransactionTypeSchema>;
export type CreditWalletInput = z.infer<typeof creditWalletSchema>;
export type DebitWalletInput = z.infer<typeof debitWalletSchema>;
export type AdjustWalletInput = z.infer<typeof adjustWalletSchema>;
