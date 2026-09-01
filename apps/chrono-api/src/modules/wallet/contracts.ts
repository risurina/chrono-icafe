import { z } from "zod";

const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

const signedMoneyAmountSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, "Amount must be a decimal with up to 2 decimal places")
  .refine((v) => Number(v) !== 0, "Adjustment amount must not be zero");

export const walletTransactionTypeSchema = z.enum(["credit", "debit", "adjustment"]);

export const creditWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().min(1).max(255).optional(), // defaults to "Manual top-up" in the route
  referenceType: z.string().max(50).optional(),
});

export const debitWalletSchema = z.object({
  amount: moneyAmountSchema,
  reason: z.string().min(1).max(255),
  referenceType: z.string().max(50).optional(),
});

export const adjustWalletSchema = z.object({
  delta: signedMoneyAmountSchema,
  reason: z.string().min(1).max(255),
});

export type WalletTransactionType = z.infer<typeof walletTransactionTypeSchema>;
export type CreditWalletInput = z.infer<typeof creditWalletSchema>;
export type DebitWalletInput = z.infer<typeof debitWalletSchema>;
export type AdjustWalletInput = z.infer<typeof adjustWalletSchema>;
