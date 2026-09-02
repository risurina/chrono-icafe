import { Hono } from "hono";
import { withTenant, eq, and, ilike, desc, asc, count, type TenantTx } from "agora/db";
import * as base from "agora/db/schema";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoVoucher } from "./schema";
import { chronoPromo } from "../promo/schema";
import { lockAndValidateVoucher, computeDiscount } from "./service";
import {
  issueVoucherSchema,
  cancelVoucherSchema,
  validateVoucherSchema,
  voucherListQuerySchema,
} from "./contracts";
import type { DiscountType } from "./contracts";

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

/** Resolve a promo inside the caller's own tenant, or 404 (never a leaked cross-tenant signal). */
async function requireOwnPromo(tx: TenantTx, tenantId: string, promoId: string) {
  const [promo] = await tx
    .select({ id: chronoPromo.id })
    .from(chronoPromo)
    .where(and(eq(chronoPromo.id, promoId), eq(chronoPromo.tenantId, tenantId)))
    .limit(1);
  if (!promo) {
    throw new HttpError(404, "Promo not found.");
  }
}

/** Resolve a tenant member inside the caller's own tenant, or 404. */
async function requireOwnMember(tx: TenantTx, tenantId: string, memberId: string) {
  const [member] = await tx
    .select({ id: base.tenantMember.id })
    .from(base.tenantMember)
    .where(and(eq(base.tenantMember.id, memberId), eq(base.tenantMember.tenantId, tenantId)))
    .limit(1);
  if (!member) {
    throw new HttpError(404, "Member not found.");
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
function generateCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505";
}

export function voucherRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get("/vouchers", zValidator("query", voucherListQuerySchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { voucher: ["read"] });
      const { tenantId } = c.var.tenant;
      const { page, pageSize, sort, order, status, memberId, code } = c.req.valid("query");

      const conds = [];
      if (status) conds.push(eq(chronoVoucher.status, status));
      if (memberId) conds.push(eq(chronoVoucher.memberId, memberId));
      if (code) conds.push(ilike(chronoVoucher.code, `%${code}%`));
      const where = conds.length ? and(...conds) : undefined;

      const sortCol = sort === "expiresAt" ? chronoVoucher.expiresAt : chronoVoucher.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(chronoVoucher).where(where);
        const rows = await tx
          .select()
          .from(chronoVoucher)
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

    .get("/vouchers/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { voucher: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoVoucher)
          .where(and(eq(chronoVoucher.id, id), eq(chronoVoucher.tenantId, tenantId)))
          .limit(1),
      );
      if (!row) {
        throw new HttpError(404, "Voucher not found.");
      }
      return c.json({ voucher: row });
    })

    .post("/vouchers", zValidator("json", issueVoucherSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { voucher: ["manage"] });
      const { tenantId, userId } = c.var.tenant;
      const input = c.req.valid("json");

      const created = await withTenant(tenantId, async (tx) => {
        if (input.promoId) {
          await requireOwnPromo(tx, tenantId, input.promoId);
        }
        if (input.memberId) {
          await requireOwnMember(tx, tenantId, input.memberId);
        }

        const discountValue = String(input.discountValue);
        const explicitCode = input.code;
        let code = explicitCode ?? generateCode();
        let attempt = 0;
        for (;;) {
          try {
            const [row] = await tx
              .insert(chronoVoucher)
              .values({
                tenantId,
                promoId: input.promoId,
                code,
                discountType: input.discountType,
                discountValue,
                memberId: input.memberId,
                expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
                issuedByUserId: userId,
              })
              .returning();
            return row;
          } catch (err) {
            // Unique-violation on (tenantId, code): only retry when the code
            // was auto-generated — a caller-supplied code colliding is a real
            // 409, not something to silently paper over.
            if (isUniqueViolation(err) && !explicitCode && attempt < 1) {
              attempt++;
              code = generateCode();
              continue;
            }
            if (isUniqueViolation(err) && explicitCode) {
              throw new HttpError(409, "A voucher with that code already exists.");
            }
            throw err;
          }
        }
      });

      await recordStaffAudit(c, {
        action: "chronoVoucher.issued",
        targetType: "voucher",
        targetId: created?.id,
        targetLabel: created?.code,
        metadata: {
          discountType: created?.discountType,
          discountValue: created?.discountValue,
          memberId: created?.memberId,
        },
      });
      return c.json({ voucher: created }, 201);
    })

    .post("/vouchers/:id/cancel", zValidator("json", cancelVoucherSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { voucher: ["manage"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");
      const { reason } = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoVoucher.id, status: chronoVoucher.status })
          .from(chronoVoucher)
          .where(and(eq(chronoVoucher.id, id), eq(chronoVoucher.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Voucher not found.");
        }
        if (existing.status !== "active") {
          throw new HttpError(409, `This voucher is already ${existing.status}.`);
        }
        const [row] = await tx
          .update(chronoVoucher)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelReason: reason,
            updatedAt: new Date(),
          })
          .where(and(eq(chronoVoucher.id, id), eq(chronoVoucher.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoVoucher.cancelled",
        targetType: "voucher",
        targetId: updated?.id,
        targetLabel: updated?.code,
        metadata: { reason },
      });
      return c.json({ voucher: updated });
    })

    // Dry-run preview — the real redemption guard is `redeemVoucher`, called
    // inside pos's own checkout transaction (Phase 4). This route's result
    // can go stale between the check and the real checkout; that's expected,
    // this is UX sugar only.
    .post("/vouchers/validate", zValidator("json", validateVoucherSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { voucher: ["read"] });
      const { tenantId } = c.var.tenant;
      const { code, memberId, subtotal } = c.req.valid("json");

      const result = await withTenant(tenantId, async (tx) => {
        const voucher = await lockAndValidateVoucher(tx, { tenantId, code, memberId });
        const discountAmount = computeDiscount(
          voucher.discountType as DiscountType,
          voucher.discountValue,
          subtotal,
        );
        return { voucher, discountAmount };
      });

      return c.json({
        valid: true,
        voucher: result.voucher,
        discountAmount: result.discountAmount,
      });
    });
}
