import { z } from "zod";
import { listQuerySchema } from "agora";

// Decimal-string money, matching oikos's own wire format (precision-safe,
// database.md: numeric/decimal, never floating point).
const moneyStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Invalid amount format");

export const promoStatusSchema = z.enum(["active", "paused", "archived"]);
export const promoDiscountTypeSchema = z.enum(["percentage", "fixed_amount"]);

const promoFieldsSchema = z.object({
  branchId: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  code: z.string().min(3).max(50).optional(), // omit for auto-apply mode
  description: z.string().max(1000).optional(),
  discountType: promoDiscountTypeSchema,
  discountValue: moneyStringSchema,
  minSpend: moneyStringSchema.optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime(),
  maxRedemptions: z.number().int().positive().optional(),
  maxRedemptionsPerMember: z.number().int().positive().optional(), // default 1 at the DB layer
});

// .partial() cannot be used on a schema with .refine() already chained onto
// it (zod), so updatePromoSchema is derived from the unrefined field shape —
// createPromoSchema layers the refinements on top for the create path only.
export const createPromoSchema = promoFieldsSchema
  .refine((v) => (v.discountType === "percentage" ? Number(v.discountValue) <= 100 : true), {
    message: "A percentage discount cannot exceed 100.",
    path: ["discountValue"],
  })
  .refine((v) => !v.startsAt || new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt.",
    path: ["endsAt"],
  });

export const updatePromoSchema = promoFieldsSchema.partial();

export const promoStatusUpdateSchema = z.object({
  status: z.enum(["active", "paused", "archived"]),
});

export const validatePromoSchema = z.object({
  code: z.string().optional(), // omit to check for an auto-applying promo
  branchId: z.string().min(1),
  memberId: z.string().min(1).optional(),
  subtotal: moneyStringSchema,
});

export const promoListQuerySchema = listQuerySchema(["name", "startsAt", "endsAt", "createdAt"]).extend({
  status: promoStatusSchema.optional(),
  branchId: z.string().optional(),
});

export type CreatePromoInput = z.infer<typeof createPromoSchema>;
export type UpdatePromoInput = z.infer<typeof updatePromoSchema>;
export type ValidatePromoInput = z.infer<typeof validatePromoSchema>;
export type PromoStatus = z.infer<typeof promoStatusSchema>;
export type PromoDiscountType = z.infer<typeof promoDiscountTypeSchema>;

// --- Member portal DTO (Phase D) ----------------------------------------
// Safe fields only — never counts, ids beyond the promo's own, or anything
// that would let a member infer another promo's usage.

export const portalPromoDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  discountType: promoDiscountTypeSchema,
  discountValue: z.string(),
  minSpend: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string(),
  branchName: z.string().nullable(),
});

export type PortalPromoDto = z.infer<typeof portalPromoDtoSchema>;
