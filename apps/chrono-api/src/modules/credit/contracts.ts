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

export const creditPurchaseListQuerySchema = listQuerySchema(["createdAt"]).extend({
  memberId: z.string().min(1).optional(),
});

export type CreateCreditProductInput = z.infer<typeof createCreditProductSchema>;
export type UpdateCreditProductInput = z.infer<typeof updateCreditProductSchema>;
export type PurchaseCreditProductInput = z.infer<typeof purchaseCreditProductSchema>;
export type GrantCreditsInput = z.infer<typeof grantCreditsSchema>;
export type AdjustCreditGrantInput = z.infer<typeof adjustCreditGrantSchema>;
export type ConsumeCreditsInput = z.infer<typeof consumeCreditsSchema>;
export type CreditProductStatus = z.infer<typeof creditProductStatusSchema>;
export type CreditPolicy = z.infer<typeof creditPolicySchema>;
export type CreditGrantStatus = z.infer<typeof creditGrantStatusSchema>;

// --- Member portal DTOs (Phase C) ---------------------------------------

/**
 * The request body itself carries no idempotency key — it travels as an
 * optional `Idempotency-Key` header instead (member-wallet-operation-hardening
 * plan), read directly off `c.req.header(...)` in the route, not through this
 * Zod schema. Double-submit protection is now: the header (if sent) matched
 * against `chronoCreditPurchase.idempotencyKey`'s partial unique index, plus
 * the pre-existing 10/15min member rate limiter and client-side button
 * disabling.
 */
export const portalPurchaseCreditProductSchema = z.object({
  productId: z.string().min(1),
});
export type PortalPurchaseCreditProductInput = z.infer<typeof portalPurchaseCreditProductSchema>;

export const portalCreditProductDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  quantityMinutes: z.number().int(),
  priceAmount: z.string(),
  validityDays: z.number().int().nullable(),
});
export type PortalCreditProductDto = z.infer<typeof portalCreditProductDtoSchema>;

export const portalCreditGrantDtoSchema = z.object({
  id: z.string(),
  productId: z.string().nullable(),
  status: creditGrantStatusSchema,
  originalQuantity: z.number().int(),
  remainingQuantity: z.number().int(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  stationGroupId: z.string().nullable(),
  stationGroupName: z.string().nullable(),
});
export type PortalCreditGrantDto = z.infer<typeof portalCreditGrantDtoSchema>;

export const portalCreditLedgerEntryDtoSchema = z.object({
  id: z.string(),
  grantId: z.string(),
  type: z.string(),
  quantityDelta: z.number().int(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type PortalCreditLedgerEntryDto = z.infer<typeof portalCreditLedgerEntryDtoSchema>;

type CreditGrantRow = {
  id: string;
  productId: string | null;
  status: string;
  originalQuantity: number;
  remainingQuantity: number;
  expiresAt: Date | null;
  createdAt: Date;
  stationGroupId: string | null;
};

/**
 * Pure mapping — no DB query here. `stationGroupName` is resolved by the
 * caller (a route handler) from an `id -> name` lookup built once per
 * request, since a grant row only carries the id. `null` in either field
 * means "any_station" (unscoped) — never fabricated as "Any station" text
 * here; that's a frontend rendering concern.
 */
export function toPortalCreditGrantDto(
  row: CreditGrantRow,
  stationGroupName: string | null = null,
): PortalCreditGrantDto {
  return {
    id: row.id,
    productId: row.productId,
    status: row.status as CreditGrantStatus,
    originalQuantity: row.originalQuantity,
    remainingQuantity: row.remainingQuantity,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    stationGroupId: row.stationGroupId,
    stationGroupName: row.stationGroupId ? stationGroupName : null,
  };
}

type CreditLedgerEntryRow = {
  id: string;
  grantId: string;
  type: string;
  quantityDelta: number;
  reason: string | null;
  createdAt: Date;
};

export function toPortalCreditLedgerEntryDto(row: CreditLedgerEntryRow): PortalCreditLedgerEntryDto {
  return {
    id: row.id,
    grantId: row.grantId,
    type: row.type,
    quantityDelta: row.quantityDelta,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
