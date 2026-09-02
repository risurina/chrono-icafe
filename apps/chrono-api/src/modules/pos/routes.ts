import { Hono } from "hono";
import { withTenant, schema as base, eq, and, desc, asc, count, ilike } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoProduct, chronoSale, chronoSaleItem, chronoSalePayment } from "./schema";
import { checkout, refundSale } from "./service";
import {
  createProductSchema,
  updateProductSchema,
  restockProductSchema,
  checkoutSchema,
  refundSaleSchema,
  listProductsQuerySchema,
  listSalesQuerySchema,
} from "./contracts";
import { redeemVoucher } from "../voucher/service";
import { lockAndValidatePromo, redeemPromo, computeDiscount as computePromoDiscount } from "../promo/service";
import type { PromoDiscountType } from "../promo/contracts";
import { earnLoyaltyPoints } from "../loyalty/service";

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

/** "Fanta Orange 350ml" -> "fanta-orange-350ml"; collapses/trims non-alnum runs. */
function generateSku(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    startItem: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
    endItem: Math.min(page * pageSize, totalItems),
    sort,
    order,
  };
}

export function posRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get(
      "/pos/products",
      zValidator("query", listProductsQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { pos: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, q, sort, order, status, category } = c.req.valid("query");
        const conds = [eq(chronoProduct.tenantId, tenantId)];
        if (q) conds.push(ilike(chronoProduct.name, `%${q}%`));
        if (status) conds.push(eq(chronoProduct.status, status));
        if (category) conds.push(eq(chronoProduct.category, category));
        const where = and(...conds);
        const sortCol =
          sort === "sku" ? chronoProduct.sku : sort === "price" ? chronoProduct.price : chronoProduct.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx.select({ value: count() }).from(chronoProduct).where(where);
          const rows = await tx
            .select()
            .from(chronoProduct)
            .where(where)
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        return c.json({
          items: rows,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )

    .post("/pos/products", zValidator("json", createProductSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { pos: ["manageProducts"] });
      const { tenantId } = c.var.tenant;
      const input = c.req.valid("json");
      const sku = input.sku?.trim() || generateSku(input.name);

      let created;
      try {
        created = await withTenant(tenantId, (tx) =>
          tx
            .insert(chronoProduct)
            .values({
              tenantId,
              name: input.name,
              sku,
              category: input.category ?? "other",
              price: input.price,
              trackStock: input.trackStock ?? false,
              stockQuantity: input.stockQuantity ?? 0,
              status: input.status ?? "active",
            })
            .returning(),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, `A product with SKU "${sku}" already exists.`);
        }
        throw err;
      }

      await recordStaffAudit(c, {
        action: "chronoPos.productCreated",
        targetType: "product",
        targetId: created[0]!.id,
      });
      return c.json({ product: created[0] }, 201);
    })

    .patch("/pos/products/:id", zValidator("json", updateProductSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { pos: ["manageProducts"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoProduct.id })
          .from(chronoProduct)
          .where(and(eq(chronoProduct.id, id), eq(chronoProduct.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Product not found.");
        }
        const [row] = await tx
          .update(chronoProduct)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(chronoProduct.id, id))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoPos.productUpdated",
        targetType: "product",
        targetId: id,
      });
      return c.json({ product: updated });
    })

    .post(
      "/pos/products/:id/restock",
      zValidator("json", restockProductSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { pos: ["manageProducts"] });
        const { tenantId } = c.var.tenant;
        const id = c.req.param("id");
        const input = c.req.valid("json");

        const updated = await withTenant(tenantId, async (tx) => {
          const [existing] = await tx
            .select()
            .from(chronoProduct)
            .where(and(eq(chronoProduct.id, id), eq(chronoProduct.tenantId, tenantId)))
            .for("update");
          if (!existing) {
            throw new HttpError(404, "Product not found.");
          }
          if (!existing.trackStock) {
            throw new HttpError(400, "This product does not track stock.");
          }
          const [row] = await tx
            .update(chronoProduct)
            .set({ stockQuantity: existing.stockQuantity + input.quantity, updatedAt: new Date() })
            .where(eq(chronoProduct.id, id))
            .returning();
          return row;
        });

        await recordStaffAudit(c, {
          action: "chronoPos.productRestocked",
          targetType: "product",
          targetId: id,
        });
        return c.json({ product: updated });
      },
    )

    .get("/pos/sales", zValidator("query", listSalesQuerySchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { pos: ["read"] });
      const { tenantId } = c.var.tenant;
      const { page, pageSize, sort, order, branchId, status, shiftId, memberId } =
        c.req.valid("query");
      const conds = [eq(chronoSale.tenantId, tenantId)];
      if (branchId) conds.push(eq(chronoSale.branchId, branchId));
      if (status) conds.push(eq(chronoSale.status, status));
      if (shiftId) conds.push(eq(chronoSale.shiftId, shiftId));
      if (memberId) conds.push(eq(chronoSale.memberId, memberId));
      const where = and(...conds);
      const sortCol = sort === "totalAmount" ? chronoSale.totalAmount : chronoSale.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(chronoSale).where(where);
        const rows = await tx
          .select({
            id: chronoSale.id,
            branchId: chronoSale.branchId,
            shiftId: chronoSale.shiftId,
            memberId: chronoSale.memberId,
            memberName: base.tenantMember.name,
            customerName: chronoSale.customerName,
            cashierUserId: chronoSale.cashierUserId,
            cashierName: base.user.name,
            status: chronoSale.status,
            totalAmount: chronoSale.totalAmount,
            amountTendered: chronoSale.amountTendered,
            changeAmount: chronoSale.changeAmount,
            createdAt: chronoSale.createdAt,
          })
          .from(chronoSale)
          .leftJoin(base.tenantMember, eq(chronoSale.memberId, base.tenantMember.id))
          .innerJoin(base.user, eq(chronoSale.cashierUserId, base.user.id))
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });

      return c.json({
        items: rows,
        meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
      });
    })

    .get("/pos/sales/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { pos: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const result = await withTenant(tenantId, async (tx) => {
        const [sale] = await tx
          .select()
          .from(chronoSale)
          .where(and(eq(chronoSale.id, id), eq(chronoSale.tenantId, tenantId)))
          .limit(1);
        if (!sale) {
          throw new HttpError(404, "Sale not found.");
        }
        const [items, payments] = await Promise.all([
          tx.select().from(chronoSaleItem).where(eq(chronoSaleItem.saleId, sale.id)),
          tx.select().from(chronoSalePayment).where(eq(chronoSalePayment.saleId, sale.id)),
        ]);
        return { sale, items, payments };
      });

      return c.json(result);
    })

    .post("/pos/sales", zValidator("json", checkoutSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { pos: ["sell"] });
      const { tenantId, userId } = c.var.tenant;
      const input = c.req.valid("json");

      const wasIdempotentReplay = await withTenant(tenantId, async (tx) => {
        const [branch] = await tx
          .select({ id: chronoBranch.id })
          .from(chronoBranch)
          .where(and(eq(chronoBranch.id, input.branchId), eq(chronoBranch.tenantId, tenantId)))
          .limit(1);
        if (!branch) {
          throw new HttpError(404, "Branch not found.");
        }
        const [existingBefore] = await tx
          .select({ id: chronoSale.id })
          .from(chronoSale)
          .where(
            and(
              eq(chronoSale.tenantId, tenantId),
              eq(chronoSale.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        return Boolean(existingBefore);
      });

      const result = await withTenant(tenantId, async (tx) => {
        const checkoutResult = await checkout(tx, {
          tenantId,
          branchId: input.branchId,
          cashierUserId: userId,
          input,
        });
        // Idempotent replay returns the already-processed sale unchanged —
        // voucher/promo redemption and loyalty earn already happened (or
        // never applied) on the original request; re-running them here would
        // double-redeem/double-earn.
        if (wasIdempotentReplay) return checkoutResult;

        // Discount is applied AFTER the sale row exists (voucher/promo
        // redemption links back to saleId) and adjusted onto the row via a
        // follow-up UPDATE in the same transaction — the discount can only
        // reduce totalAmount, so the payment-sufficiency check already
        // performed inside checkout() against the pre-discount subtotal
        // remains valid a fortiori (change can only increase, never go
        // negative). voucherCode and promoCode are mutually exclusive
        // (enforced at the contract layer, before any DB work).
        let discountAmount = "0.00";
        if (input.voucherCode) {
          const { discountAmount: da } = await redeemVoucher(tx, {
            tenantId,
            code: input.voucherCode,
            memberId: checkoutResult.sale.memberId ?? undefined,
            saleId: checkoutResult.sale.id,
            subtotal: checkoutResult.sale.totalAmount,
          });
          discountAmount = da;
        } else if (input.promoCode) {
          const promo = await lockAndValidatePromo(tx, {
            tenantId,
            code: input.promoCode,
            branchId: input.branchId,
            memberId: checkoutResult.sale.memberId ?? undefined,
            subtotal: checkoutResult.sale.totalAmount,
          });
          if (promo) {
            discountAmount = computePromoDiscount(
              promo.discountType as PromoDiscountType,
              promo.discountValue,
              checkoutResult.sale.totalAmount,
            );
            await redeemPromo(tx, {
              tenantId,
              promoId: promo.id,
              memberId: checkoutResult.sale.memberId ?? undefined,
              saleId: checkoutResult.sale.id,
              discountAmount,
            });
          }
        }

        if (Number(discountAmount) > 0) {
          const newTotal = (Number(checkoutResult.sale.totalAmount) - Number(discountAmount)).toFixed(2);
          const newChange = (Number(checkoutResult.sale.amountTendered) - Number(newTotal)).toFixed(2);
          const [updatedSale] = await tx
            .update(chronoSale)
            .set({ totalAmount: newTotal, changeAmount: newChange, updatedAt: new Date() })
            .where(eq(chronoSale.id, checkoutResult.sale.id))
            .returning();
          checkoutResult.sale = updatedSale!;
        }

        // Auto-earn: only for a member sale (walk-ins earn no points), only
        // on a completed sale, spend base is the FINAL discounted amount
        // actually paid (judgment call — the plan does not explicitly say
        // pre- vs. post-discount).
        if (checkoutResult.sale.memberId) {
          await earnLoyaltyPoints(tx, {
            tenantId,
            memberId: checkoutResult.sale.memberId,
            spendAmount: checkoutResult.sale.totalAmount,
            referenceType: "pos_sale",
            referenceId: checkoutResult.sale.id,
          });
        }

        return checkoutResult;
      });

      if (!wasIdempotentReplay) {
        await recordStaffAudit(c, {
          action: "chronoPos.saleCompleted",
          targetType: "sale",
          targetId: result.sale.id,
        });
      }

      const receiptNumber = result.sale.id.slice(-8).toUpperCase();
      return c.json({ ...result, receiptNumber }, 201);
    })

    .post(
      "/pos/sales/:id/refund",
      zValidator("json", refundSaleSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { pos: ["void"] });
        const { tenantId, userId } = c.var.tenant;
        const id = c.req.param("id");
        const input = c.req.valid("json");

        const sale = await withTenant(tenantId, (tx) =>
          refundSale(tx, {
            tenantId,
            saleId: id,
            reason: input.reason,
            performedByUserId: userId,
          }),
        );

        await recordStaffAudit(c, {
          action: "chronoPos.saleRefunded",
          targetType: "sale",
          targetId: sale.id,
        });
        return c.json({ sale });
      },
    );
}
