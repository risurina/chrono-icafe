import { z } from "zod";
import { listQuerySchema } from "agora";

/**
 * Ceiling for the resulting `pointsBalance`/`lifetimePoints`, matching the
 * `integer` (`int4`) columns' capacity. The contract layer bounds each
 * individual delta; this bounds the running total, which a series of
 * individually-valid adjustments could otherwise overflow. Mirrors
 * `wallet/contracts.ts`'s `MAX_BALANCE` / `wallet/service.ts`'s
 * `MAX_BALANCE_CENTS` pattern.
 */
export const MAX_POINTS_BALANCE = 1_000_000_000;

export const loyaltyTierSchema = z.enum(["bronze", "silver", "gold", "platinum"]);

export const loyaltyAccountSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  memberId: z.string(),
  pointsBalance: z.number().int(),
  lifetimePoints: z.number().int(),
  tier: loyaltyTierSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const loyaltyTransactionTypeSchema = z.enum(["earn", "redeem", "adjustment"]);

export const loyaltyTransactionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  accountId: z.string(),
  memberId: z.string(),
  type: loyaltyTransactionTypeSchema,
  points: z.number().int(),
  balanceBefore: z.number().int(),
  balanceAfter: z.number().int(),
  reason: z.string(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  performedByUserId: z.string().nullable(),
  createdAt: z.string(),
});

export const earnPointsSchema = z.object({
  points: z.number().int().positive().max(1_000_000),
  reason: z.string().min(1).max(255),
});

export const redeemPointsSchema = z.object({
  points: z.number().int().positive().max(1_000_000),
  reason: z.string().min(1).max(255),
});

export const adjustPointsSchema = z.object({
  delta: z
    .number()
    .int()
    .min(-MAX_POINTS_BALANCE)
    .max(MAX_POINTS_BALANCE)
    .refine((v) => v !== 0, "Delta must not be zero"),
  reason: z.string().min(1).max(255),
});

export const loyaltyAccountListQuerySchema = listQuerySchema([
  "pointsBalance",
  "createdAt",
]).extend({
  tier: loyaltyTierSchema.optional(),
  search: z.string().optional(),
});

export type LoyaltyTier = z.infer<typeof loyaltyTierSchema>;
export type LoyaltyAccount = z.infer<typeof loyaltyAccountSchema>;
export type LoyaltyTransactionType = z.infer<typeof loyaltyTransactionTypeSchema>;
export type LoyaltyTransaction = z.infer<typeof loyaltyTransactionSchema>;
export type EarnPointsInput = z.infer<typeof earnPointsSchema>;
export type RedeemPointsInput = z.infer<typeof redeemPointsSchema>;
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>;
export type LoyaltyAccountListQuery = z.infer<typeof loyaltyAccountListQuerySchema>;

type LoyaltyAccountRow = {
  id: string;
  tenantId: string;
  memberId: string;
  pointsBalance: number;
  lifetimePoints: number;
  tier: string;
  createdAt: Date;
  updatedAt: Date;
};

export function toLoyaltyAccountDto(row: LoyaltyAccountRow): LoyaltyAccount {
  return {
    id: row.id,
    tenantId: row.tenantId,
    memberId: row.memberId,
    pointsBalance: row.pointsBalance,
    lifetimePoints: row.lifetimePoints,
    tier: row.tier as LoyaltyTier,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type LoyaltyTransactionRow = {
  id: string;
  tenantId: string;
  accountId: string;
  memberId: string;
  type: string;
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  performedByUserId: string | null;
  createdAt: Date;
};

export function toLoyaltyTransactionDto(row: LoyaltyTransactionRow): LoyaltyTransaction {
  return {
    id: row.id,
    tenantId: row.tenantId,
    accountId: row.accountId,
    memberId: row.memberId,
    type: row.type as LoyaltyTransactionType,
    points: row.points,
    balanceBefore: row.balanceBefore,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    performedByUserId: row.performedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}
