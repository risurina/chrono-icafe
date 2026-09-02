import { z } from "zod";
import { listQuerySchema } from "agora";

export const productStatusSchema = z.enum(["active", "disabled"]);
export const productCategorySchema = z.enum(["snack", "drink", "peripheral", "other"]);
export const saleStatusSchema = z.enum(["completed", "refunded"]);
export const saleTenderMethodSchema = z.enum(["cash", "card", "wallet"]);

const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

export const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  sku: z.string().min(1).max(50).optional(), // auto-generated from name if omitted
  category: productCategorySchema.optional(), // defaults to "other"
  price: moneyAmountSchema,
  trackStock: z.boolean().optional(),
  stockQuantity: z.number().int().nonnegative().optional(), // only meaningful if trackStock
  status: productStatusSchema.optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const restockProductSchema = z.object({
  quantity: z.number().int().positive().max(100_000),
  reason: z.string().max(255).optional(),
});

export const saleLineInputSchema = z
  .object({
    productId: z.string().min(1).optional(),
    // Required when productId is omitted (an ad-hoc misc line) — ignored
    // and recomputed server-side when productId is present (server-side
    // price authority, see Routes).
    name: z.string().min(1).max(255).optional(),
    unitPrice: moneyAmountSchema.optional(),
    quantity: z.number().int().positive().max(9999).default(1),
  })
  .refine((v) => v.productId || (v.name && v.unitPrice), {
    message: "Either productId, or both name and unitPrice, are required.",
  });

export const saleTenderInputSchema = z.object({
  method: saleTenderMethodSchema,
  amount: moneyAmountSchema,
  referenceNumber: z.string().max(100).optional(),
});

export const checkoutSchema = z
  .object({
    branchId: z.string().min(1),
    memberId: z.string().min(1).optional(), // walk-in when omitted
    customerName: z.string().max(255).optional(), // walk-in receipt label only
    idempotencyKey: z.string().min(1).max(255),
    items: z.array(saleLineInputSchema).min(1),
    payments: z.array(saleTenderInputSchema).min(1),
    voucherCode: z.string().optional(),
    promoCode: z.string().optional(),
  })
  .refine((v) => !(v.voucherCode && v.promoCode), {
    message: "Cannot apply both a voucher and a promo to the same sale.",
    path: ["voucherCode"],
  });
// Note: sum(payments.amount) >= totalAmount is validated in the route, not
// here — totalAmount is only known once productId lines are server-priced
// (client-supplied prices for catalog items are never trusted).
// Note: voucherCode and promoCode are mutually exclusive — discount stacking
// is not supported (developer decision, see loyalty/vouchers/promos Phase 4).

export const refundSaleSchema = z.object({
  reason: z.string().min(1).max(255),
});

export const listProductsQuerySchema = listQuerySchema(["name", "sku", "price", "createdAt"]).extend({
  status: productStatusSchema.optional(),
  category: productCategorySchema.optional(),
});

export const listSalesQuerySchema = listQuerySchema(["createdAt", "totalAmount"]).extend({
  branchId: z.string().optional(),
  status: saleStatusSchema.optional(),
  shiftId: z.string().optional(),
  memberId: z.string().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type RestockProductInput = z.infer<typeof restockProductSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type RefundSaleInput = z.infer<typeof refundSaleSchema>;
export type ProductStatus = z.infer<typeof productStatusSchema>;
export type SaleStatus = z.infer<typeof saleStatusSchema>;
export type SaleTenderMethod = z.infer<typeof saleTenderMethodSchema>;
