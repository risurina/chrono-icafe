import { z } from "zod";
import { listQuerySchema } from "agora";

export const creditProductStatusSchema = z.enum(["draft", "active", "archived"]);
export const creditPolicySchema = z.enum(["strict_group_only", "any_station"]);
export const creditUnitSchema = z.enum(["minute"]); // reserved: more units later
export const creditGrantStatusSchema = z.enum([
  "granted",
  "depleted",
  "expired",
  "voided",
]);

const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

export const createCreditProductSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50),
    quantityMinutes: z.number().int().positive().max(100_000),
    priceAmount: moneyAmountSchema,
    stationGroupId: z.string().min(1).optional(),
    creditPolicy: creditPolicySchema.optional(), // defaults to "any_station"
    validityDays: z.number().int().positive().max(3650).optional(),
    unit: creditUnitSchema.optional(), // defaults to "minute"
  })
  .refine(
    (v) => v.creditPolicy !== "strict_group_only" || !!v.stationGroupId,
    { message: "A strict-group product must specify a stationGroupId.", path: ["stationGroupId"] },
  );

export const updateCreditProductSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    priceAmount: moneyAmountSchema.optional(),
    stationGroupId: z.string().min(1).optional(),
    creditPolicy: creditPolicySchema.optional(),
    validityDays: z.number().int().positive().max(3650).optional(),
    status: creditProductStatusSchema.optional(),
    // quantityMinutes/code/unit are immutable after creation — a running
    // product's promised quantity must not shift under existing purchasers'
    // expectations; a new SKU is a new product.
  })
  .refine(
    (v) => v.creditPolicy !== "strict_group_only" || !!v.stationGroupId,
    { message: "A strict-group product must specify a stationGroupId.", path: ["stationGroupId"] },
  );

export const purchaseCreditProductSchema = z.object({
  productId: z.string().min(1),
});

export const grantCreditsSchema = z.object({
  quantityMinutes: z.number().int().positive().max(100_000),
  stationGroupId: z.string().min(1).optional(),
  creditPolicy: creditPolicySchema.optional(), // defaults to "any_station"
  expiresAt: z.string().datetime().optional(),
  reason: z.string().min(1).max(255),
});

export const adjustCreditGrantSchema = z.object({
  deltaMinutes: z.number().int().positive().max(100_000), // amount subtracted
  reason: z.string().min(1).max(255),
});

export const consumeCreditsSchema = z.object({
  quantityMinutes: z.number().int().positive().max(1440),
  stationGroupId: z.string().min(1).optional(),
  reason: z.string().min(1).max(255),
});

export const creditProductListQuerySchema = listQuerySchema([
  "name",
  "code",
  "createdAt",
]).extend({
  status: creditProductStatusSchema.optional(),
});

export const creditGrantListQuerySchema = listQuerySchema([
  "createdAt",
  "expiresAt",
]).extend({
  status: creditGrantStatusSchema.optional(),
});

export const creditLedgerListQuerySchema = listQuerySchema(["createdAt"]);

export type CreateCreditProductInput = z.infer<typeof createCreditProductSchema>;
export type UpdateCreditProductInput = z.infer<typeof updateCreditProductSchema>;
export type PurchaseCreditProductInput = z.infer<typeof purchaseCreditProductSchema>;
export type GrantCreditsInput = z.infer<typeof grantCreditsSchema>;
export type AdjustCreditGrantInput = z.infer<typeof adjustCreditGrantSchema>;
export type ConsumeCreditsInput = z.infer<typeof consumeCreditsSchema>;
export type CreditProductStatus = z.infer<typeof creditProductStatusSchema>;
export type CreditPolicy = z.infer<typeof creditPolicySchema>;
export type CreditGrantStatus = z.infer<typeof creditGrantStatusSchema>;
