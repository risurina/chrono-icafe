import { Hono } from "hono";
import { withTenant, eq, desc, asc, count, type TenantTx } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { listQuerySchema } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoPayment } from "./schema";
import { createPayment, markAsPaid, voidPayment, refundPayment } from "./service";
import { publishWalletLowIfCrossed } from "../wallet/service";
import {
  createPaymentSchema,
  payPaymentSchema,
  voidPaymentSchema,
  refundPaymentSchema,
} from "./contracts";

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

function paymentAuditMetadata(payment: {
  id: string;
  amount: string;
  method: string;
  memberId: string | null;
}) {
  return {
    paymentId: payment.id,
    amount: payment.amount,
    method: payment.method,
    memberId: payment.memberId,
  };
}

async function getOwnedPayment(tx: TenantTx, tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(chronoPayment)
    .where(eq(chronoPayment.id, id))
    .limit(1);
  if (!row || row.tenantId !== tenantId) {
    throw new HttpError(404, "Payment not found.");
  }
  return row;
}

export function paymentRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    .get(
      "/payments",
      zValidator("query", listQuerySchema(["createdAt"])),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { payment: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order } = c.req.valid("query");
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx.select({ value: count() }).from(chronoPayment);
          const rows = await tx
            .select()
            .from(chronoPayment)
            .orderBy(sortFn(chronoPayment.createdAt))
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

    .get("/payments/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { payment: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");
      const payment = await withTenant(tenantId, (tx) => getOwnedPayment(tx, tenantId, id));
      return c.json({ payment });
    })

    .post("/payments", zValidator("json", createPaymentSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { payment: ["create"] });
      const { tenantId } = c.var.tenant;
      const input = c.req.valid("json");

      const payment = await withTenant(tenantId, (tx) =>
        createPayment(tx, {
          tenantId,
          memberId: input.memberId,
          sessionId: input.sessionId,
          amount: input.amount,
          currency: input.currency,
          method: input.method,
          providerReference: input.providerReference,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        }),
      );

      await recordStaffAudit(c, {
        action: "chronoPayment.created",
        targetType: "payment",
        targetId: payment.id,
        metadata: paymentAuditMetadata(payment),
      });
      return c.json({ payment }, 201);
    })

    .post("/payments/:id/pay", zValidator("json", payPaymentSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { payment: ["pay"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const { payment, walletLow } = await withTenant(tenantId, (tx) =>
        markAsPaid(tx, {
          tenantId,
          paymentId: id,
          providerReference: input.providerReference,
          performedByUserId: userId,
        }),
      );

      await publishWalletLowIfCrossed(walletLow);

      await recordStaffAudit(c, {
        action: "chronoPayment.paid",
        targetType: "payment",
        targetId: payment.id,
        metadata: paymentAuditMetadata(payment),
      });
      return c.json({ payment });
    })

    .post("/payments/:id/void", zValidator("json", voidPaymentSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { payment: ["void"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");

      const { payment, walletLow } = await withTenant(tenantId, (tx) =>
        voidPayment(tx, { tenantId, paymentId: id, performedByUserId: userId }),
      );

      await publishWalletLowIfCrossed(walletLow);

      await recordStaffAudit(c, {
        action: "chronoPayment.voided",
        targetType: "payment",
        targetId: payment.id,
        metadata: paymentAuditMetadata(payment),
      });
      return c.json({ payment });
    })

    .post("/payments/:id/refund", zValidator("json", refundPaymentSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { payment: ["refund"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");

      const { payment, walletLow } = await withTenant(tenantId, (tx) =>
        refundPayment(tx, { tenantId, paymentId: id, performedByUserId: userId }),
      );

      await publishWalletLowIfCrossed(walletLow);

      await recordStaffAudit(c, {
        action: "chronoPayment.refunded",
        targetType: "payment",
        targetId: payment.id,
        metadata: paymentAuditMetadata(payment),
      });
      return c.json({ payment });
    });
}
