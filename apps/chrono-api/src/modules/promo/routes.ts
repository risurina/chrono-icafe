import { Hono } from "hono";
import { withTenant, eq, and, desc, asc, count, type TenantTx } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { recordStaffAudit } from "agora/audit";
import { chronoPromo } from "./schema";
import { chronoBranch } from "../branch/schema";
import { lockAndValidatePromo, computeDiscount } from "./service";
import {
  createPromoSchema,
  updatePromoSchema,
  promoStatusUpdateSchema,
  validatePromoSchema,
  promoListQuerySchema,
} from "./contracts";
import type { PromoDiscountType } from "./contracts";

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

/** Resolve a branch inside the caller's own tenant, or 404 (never a leaked cross-tenant signal). */
async function requireOwnBranch(tx: TenantTx, tenantId: string, branchId: string) {
  const [branch] = await tx
    .select({ id: chronoBranch.id })
    .from(chronoBranch)
    .where(and(eq(chronoBranch.id, branchId), eq(chronoBranch.tenantId, tenantId)))
    .limit(1);
  if (!branch) {
    throw new HttpError(404, "Branch not found.");
  }
}

export function promoRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get("/promos", zValidator("query", promoListQuerySchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { promo: ["read"] });
      const { tenantId } = c.var.tenant;
      const { page, pageSize, sort, order, status, branchId } = c.req.valid("query");

      const conds = [];
      if (status) conds.push(eq(chronoPromo.status, status));
      if (branchId) conds.push(eq(chronoPromo.branchId, branchId));
      const where = conds.length ? and(...conds) : undefined;

      const sortCol =
        sort === "name"
          ? chronoPromo.name
          : sort === "startsAt"
            ? chronoPromo.startsAt
            : sort === "endsAt"
              ? chronoPromo.endsAt
              : chronoPromo.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(chronoPromo).where(where);
        const rows = await tx
          .select()
          .from(chronoPromo)
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

    .get("/promos/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { promo: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoPromo)
          .where(and(eq(chronoPromo.id, id), eq(chronoPromo.tenantId, tenantId)))
          .limit(1),
      );
      if (!row) {
        throw new HttpError(404, "Promo not found.");
      }
      return c.json({ promo: row });
    })

    .post("/promos", zValidator("json", createPromoSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { promo: ["manage"] });
      const { tenantId } = c.var.tenant;
      const input = c.req.valid("json");

      const created = await withTenant(tenantId, async (tx) => {
        if (input.branchId) {
          await requireOwnBranch(tx, tenantId, input.branchId);
        }
        const [row] = await tx
          .insert(chronoPromo)
          .values({
            tenantId,
            branchId: input.branchId,
            name: input.name,
            code: input.code,
            description: input.description,
            discountType: input.discountType,
            discountValue: input.discountValue,
            minSpend: input.minSpend,
            startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
            endsAt: new Date(input.endsAt),
            maxRedemptions: input.maxRedemptions,
            maxRedemptionsPerMember: input.maxRedemptionsPerMember,
          })
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoPromo.created",
        targetType: "promo",
        targetId: created?.id,
        targetLabel: created?.name,
        metadata: {
          discountType: created?.discountType,
          discountValue: created?.discountValue,
          code: created?.code,
        },
      });
      return c.json({ promo: created }, 201);
    })

    .patch("/promos/:id", zValidator("json", updatePromoSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { promo: ["manage"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoPromo.id })
          .from(chronoPromo)
          .where(and(eq(chronoPromo.id, id), eq(chronoPromo.tenantId, tenantId)))
          .limit(1);
        if (!existing) return null;

        if (input.branchId) {
          await requireOwnBranch(tx, tenantId, input.branchId);
        }

        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (input.branchId !== undefined) patch.branchId = input.branchId;
        if (input.name !== undefined) patch.name = input.name;
        if (input.code !== undefined) patch.code = input.code;
        if (input.description !== undefined) patch.description = input.description;
        if (input.discountType !== undefined) patch.discountType = input.discountType;
        if (input.discountValue !== undefined) patch.discountValue = input.discountValue;
        if (input.minSpend !== undefined) patch.minSpend = input.minSpend;
        if (input.startsAt !== undefined) patch.startsAt = new Date(input.startsAt);
        if (input.endsAt !== undefined) patch.endsAt = new Date(input.endsAt);
        if (input.maxRedemptions !== undefined) patch.maxRedemptions = input.maxRedemptions;
        if (input.maxRedemptionsPerMember !== undefined)
          patch.maxRedemptionsPerMember = input.maxRedemptionsPerMember;

        const [row] = await tx
          .update(chronoPromo)
          .set(patch)
          .where(and(eq(chronoPromo.id, id), eq(chronoPromo.tenantId, tenantId)))
          .returning();
        return row;
      });
      if (!updated) {
        throw new HttpError(404, "Promo not found.");
      }

      await recordStaffAudit(c, {
        action: "chronoPromo.updated",
        targetType: "promo",
        targetId: updated.id,
        targetLabel: updated.name,
      });
      return c.json({ promo: updated });
    })

    // A single status-transition route rather than three separate ones —
    // the only real invariant is "archived is terminal" (409 attempting to
    // transition out of it).
    .post("/promos/:id/status", zValidator("json", promoStatusUpdateSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { promo: ["manage"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");
      const { status } = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoPromo.id, status: chronoPromo.status })
          .from(chronoPromo)
          .where(and(eq(chronoPromo.id, id), eq(chronoPromo.tenantId, tenantId)))
          .limit(1);
        if (!existing) return { notFound: true as const };
        if (existing.status === "archived") {
          return { terminal: true as const };
        }
        const [row] = await tx
          .update(chronoPromo)
          .set({ status, updatedAt: new Date() })
          .where(and(eq(chronoPromo.id, id), eq(chronoPromo.tenantId, tenantId)))
          .returning();
        return { row: row! };
      });
      if ("notFound" in updated) {
        throw new HttpError(404, "Promo not found.");
      }
      if ("terminal" in updated) {
        throw new HttpError(409, "An archived promo cannot change status.");
      }

      await recordStaffAudit(c, {
        action: `chronoPromo.${status}`,
        targetType: "promo",
        targetId: updated.row.id,
        targetLabel: updated.row.name,
      });
      return c.json({ promo: updated.row });
    })

    // Dry-run preview — the real redemption guard is `lockAndValidatePromo`
    // + `redeemPromo`, called inside pos's own checkout transaction
    // (Phase 4). This route's result can go stale between the check and the
    // real checkout; that's expected, this is UX sugar only.
    .post("/promos/validate", zValidator("json", validatePromoSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { promo: ["read"] });
      const { tenantId } = c.var.tenant;
      const { code, branchId, memberId, subtotal } = c.req.valid("json");

      const result = await withTenant(tenantId, async (tx) => {
        const promo = await lockAndValidatePromo(tx, { tenantId, code, branchId, memberId, subtotal });
        if (!promo) {
          return null;
        }
        const discountAmount = computeDiscount(
          promo.discountType as PromoDiscountType,
          promo.discountValue,
          subtotal,
        );
        return { promo, discountAmount };
      });

      if (!result) {
        return c.json({ valid: false, promo: null, discountAmount: null });
      }
      return c.json({
        valid: true,
        promo: result.promo,
        discountAmount: result.discountAmount,
      });
    });
}
