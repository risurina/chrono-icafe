import { z } from "zod";
import { listQuerySchema } from "agora";

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

// --- Member portal DTOs (Phase E) ---------------------------------------

/**
 * Adds an optional `type` filter on top of the base list query — the
 * dashboard's "last top-up" is `GET /portal/wallet/history?type=credit&
 * pageSize=1`, no new endpoint needed.
 */
export const walletHistoryQuerySchema = listQuerySchema(["createdAt"]).extend({
  type: walletTransactionTypeSchema.optional(),
});
export type WalletHistoryQuery = z.infer<typeof walletHistoryQuerySchema>;

export const portalWalletTransactionSchema = z.object({
  id: z.string(),
  type: walletTransactionTypeSchema,
  amount: z.string(),
  balanceBefore: z.string(),
  balanceAfter: z.string(),
  reason: z.string(),
  createdAt: z.string(),
});
export type PortalWalletTransaction = z.infer<typeof portalWalletTransactionSchema>;

type WalletTransactionRow = {
  id: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  reason: string;
  createdAt: Date;
};

// Narrows away walletId/memberId/tenantId/referenceType/referenceId/
// performedByUserId/shiftId — never leaked to the member's own browser.
export function toPortalWalletTransactionDto(row: WalletTransactionRow): PortalWalletTransaction {
  return {
    id: row.id,
    type: row.type as WalletTransactionType,
    amount: row.amount,
    balanceBefore: row.balanceBefore,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
