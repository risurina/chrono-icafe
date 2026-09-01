import { z } from "zod";
import { listQuerySchema } from "agora";

export const voucherStatusSchema = z.enum(["active", "redeemed", "cancelled"]);
export const discountTypeSchema = z.enum(["percentage", "fixed_amount"]);

// Decimal-string money, matching oikos's own wire format
const moneyStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Invalid amount format");

export const issueVoucherSchema = z
  .object({
    promoId: z.string().min(1).optional(),
    discountType: discountTypeSchema,
    discountValue: z.union([z.number().positive(), moneyStringSchema]),
    memberId: z.string().min(1).optional(), // omit for a generic, anyone-redeemable code
    code: z.string().min(4).max(50).optional(), // auto-generated if omitted
    expiresAt: z.string().datetime().optional(),
  })
  .refine(
    (v) => {
      if (v.discountType === "percentage") {
        return typeof v.discountValue === "number" && v.discountValue <= 100;
      }
      if (v.discountType === "fixed_amount") {
        return typeof v.discountValue === "string";
      }
      return false;
    },
    { message: "Invalid discount value for the specified discount type.", path: ["discountValue"] }
  );

export const cancelVoucherSchema = z.object({ reason: z.string().max(255).optional() });

export const validateVoucherSchema = z.object({
  code: z.string().min(1),
  memberId: z.string().min(1).optional(), // the sale's own member, if any
  subtotal: moneyStringSchema, // used to compute the discount amount
});

export const redeemVoucherSchema = z.object({
  code: z.string().min(1),
  memberId: z.string().min(1).optional(),
  redeemedAgainstSaleId: z.string().min(1),
});

export const voucherListQuerySchema = listQuerySchema(["createdAt", "expiresAt"]).extend({
  status: voucherStatusSchema.optional(),
  memberId: z.string().optional(),
  code: z.string().optional(),
});

export type IssueVoucherInput = z.infer<typeof issueVoucherSchema>;
export type CancelVoucherInput = z.infer<typeof cancelVoucherSchema>;
export type ValidateVoucherInput = z.infer<typeof validateVoucherSchema>;
export type RedeemVoucherInput = z.infer<typeof redeemVoucherSchema>;
export type VoucherStatus = z.infer<typeof voucherStatusSchema>;
export type DiscountType = z.infer<typeof discountTypeSchema>;
