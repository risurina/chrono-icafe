import { Hono } from "hono";
import { withTenant, schema as base, eq, and, asc, desc, count } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoShift } from "./schema";
import { openShiftSchema, closeShiftSchema, listShiftsQuerySchema } from "./contracts";
import { calculatePosExpectedCash } from "../pos/service";
import { addMoney, negateMoney } from "../wallet/money";

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

export function shiftRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    // GET /shifts — ungated (a full accountability log, not "my shifts only").
    .get("/shifts", zValidator("query", listShiftsQuerySchema), async (c) => {
      const { tenantId } = c.var.tenant;
      const { page, pageSize, sort, order, branchId, status } = c.req.valid("query");
      const conds = [];
      if (branchId) conds.push(eq(chronoShift.branchId, branchId));
      if (status) conds.push(eq(chronoShift.status, status));
      const where = conds.length ? and(...conds) : undefined;
      const sortCol = sort === "closedAt" ? chronoShift.closedAt : chronoShift.openedAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx
          .select({ value: count() })
          .from(chronoShift)
          .where(where);
        const rows = await tx
          .select({
            id: chronoShift.id,
            tenantId: chronoShift.tenantId,
            branchId: chronoShift.branchId,
            staffUserId: chronoShift.staffUserId,
            staffName: base.user.name,
            staffEmail: base.user.email,
            status: chronoShift.status,
            openingCashAmount: chronoShift.openingCashAmount,
            openedAt: chronoShift.openedAt,
            closedAt: chronoShift.closedAt,
            actualCashAmount: chronoShift.actualCashAmount,
            expectedCashAmount: chronoShift.expectedCashAmount,
            differenceAmount: chronoShift.differenceAmount,
            openNotes: chronoShift.openNotes,
            closeNotes: chronoShift.closeNotes,
            createdAt: chronoShift.createdAt,
            updatedAt: chronoShift.updatedAt,
          })
          .from(chronoShift)
          .innerJoin(base.user, eq(chronoShift.staffUserId, base.user.id))
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

    // GET /shifts/current?branchId= — ungated, self-scoped: the caller's own
    // most recent open shift in that branch, or null.
    .get("/shifts/current", async (c) => {
      const { tenantId, userId } = c.var.tenant;
      const branchId = c.req.query("branchId");
      if (!branchId) {
        throw new HttpError(400, "branchId is required.");
      }

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(chronoShift)
          .where(
            and(
              eq(chronoShift.branchId, branchId),
              eq(chronoShift.staffUserId, userId),
              eq(chronoShift.status, "open"),
            ),
          )
          .orderBy(desc(chronoShift.openedAt))
          .limit(1),
      );

      return c.json({ shift: row ?? null });
    })

    .post("/shifts/open", zValidator("json", openShiftSchema), async (c) => {
      const { tenantId, userId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { shift: ["open"] });
      const input = c.req.valid("json");

      const created = await withTenant(tenantId, async (tx) => {
        const [branch] = await tx
          .select({ id: chronoBranch.id })
          .from(chronoBranch)
          .where(and(eq(chronoBranch.id, input.branchId), eq(chronoBranch.tenantId, tenantId)))
          .limit(1);
        if (!branch) {
          throw new HttpError(404, "Branch not found.");
        }

        const [existing] = await tx
          .select({ id: chronoShift.id })
          .from(chronoShift)
          .where(
            and(
              eq(chronoShift.branchId, input.branchId),
              eq(chronoShift.staffUserId, userId),
              eq(chronoShift.status, "open"),
            ),
          )
          .limit(1);
        if (existing) {
          throw new HttpError(409, "You already have an open shift at this branch.");
        }

        const [row] = await tx
          .insert(chronoShift)
          .values({
            id: createId(),
            tenantId,
            branchId: input.branchId,
            staffUserId: userId,
            status: "open",
            openingCashAmount: input.openingCashAmount,
            openNotes: input.notes,
          })
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "shift.opened",
        targetType: "shift",
        targetId: created?.id,
      });
      return c.json({ shift: created }, 201);
    })

    .post("/shifts/:id/close", zValidator("json", closeShiftSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { shift: ["close"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({
            id: chronoShift.id,
            status: chronoShift.status,
            staffUserId: chronoShift.staffUserId,
            openingCashAmount: chronoShift.openingCashAmount,
          })
          .from(chronoShift)
          .where(and(eq(chronoShift.id, id), eq(chronoShift.tenantId, tenantId)))
          .for("update")
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Shift not found.");
        }
        if (existing.status === "closed") {
          throw new HttpError(409, "This shift is already closed.");
        }
        if (existing.staffUserId !== c.var.tenant.userId) {
          requirePermission(c.var.tenant.permissions, { shift: ["closeAny"] });
        }

        const expectedCashAmount = addMoney(
          existing.openingCashAmount,
          await calculatePosExpectedCash(tx, { tenantId, shiftId: existing.id }),
        );
        const differenceAmount = addMoney(input.actualCashAmount, negateMoney(expectedCashAmount));

        const [row] = await tx
          .update(chronoShift)
          .set({
            status: "closed",
            closedAt: new Date(),
            actualCashAmount: input.actualCashAmount,
            closeNotes: input.notes,
            expectedCashAmount,
            differenceAmount,
            updatedAt: new Date(),
          })
          .where(and(eq(chronoShift.id, id), eq(chronoShift.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "shift.closed",
        targetType: "shift",
        targetId: updated?.id,
      });
      return c.json({ shift: updated });
    });
}
