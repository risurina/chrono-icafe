import { Hono } from "hono";
import { withTenant, eq, and, asc, desc, count, adminDb, schema as baseSchema } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoInquiry, chronoInquiryMessage } from "./schema";
import {
  assignInquirySchema,
  replyToInquirySchema,
  updateInquiryStatusSchema,
  inquiryListQuerySchema,
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

/** Loads an inquiry scoped to the caller's own tenant, or 404. */
async function requireOwnInquiry(tenantId: string, id: string) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(chronoInquiry)
      .where(and(eq(chronoInquiry.id, id), eq(chronoInquiry.tenantId, tenantId)))
      .limit(1),
  );
  if (!row) throw new HttpError(404, "Inquiry not found.");
  return row;
}

export function inquiryRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get("/", zValidator("query", inquiryListQuerySchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { inquiry: ["read"] });
      const { tenantId } = c.var.tenant;
      const { page, pageSize, sort, order, status, category, assignedToUserId } =
        c.req.valid("query");

      const conds = [];
      if (status) conds.push(eq(chronoInquiry.status, status));
      if (category) conds.push(eq(chronoInquiry.category, category));
      if (assignedToUserId) conds.push(eq(chronoInquiry.assignedToUserId, assignedToUserId));
      const where = conds.length ? and(...conds) : undefined;

      const sortCol = sort === "updatedAt" ? chronoInquiry.updatedAt : chronoInquiry.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(chronoInquiry).where(where);
        const rows = await tx
          .select()
          .from(chronoInquiry)
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

    .get("/:id", async (c) => {
      requirePermission(c.var.tenant.permissions, { inquiry: ["read"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");

      const { inquiry, messages } = await withTenant(tenantId, async (tx) => {
        const [inquiry] = await tx
          .select()
          .from(chronoInquiry)
          .where(and(eq(chronoInquiry.id, id), eq(chronoInquiry.tenantId, tenantId)))
          .limit(1);
        if (!inquiry) throw new HttpError(404, "Inquiry not found.");
        const messages = await tx
          .select()
          .from(chronoInquiryMessage)
          .where(and(eq(chronoInquiryMessage.inquiryId, id), eq(chronoInquiryMessage.tenantId, tenantId)))
          .orderBy(asc(chronoInquiryMessage.createdAt));
        return { inquiry, messages };
      });

      return c.json({ inquiry, messages });
    })

    .post("/:id/assign", zValidator("json", assignInquirySchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { inquiry: ["manage"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");
      const { assignedToUserId } = c.req.valid("json");

      const targetUserId = assignedToUserId ?? userId;
      if (assignedToUserId) {
        const [target] = await adminDb
          .select({ id: baseSchema.member.id })
          .from(baseSchema.member)
          .where(
            and(
              eq(baseSchema.member.organizationId, tenantId),
              eq(baseSchema.member.userId, assignedToUserId),
            ),
          )
          .limit(1);
        if (!target) throw new HttpError(400, "That user is not a member of this tenant.");
      }

      const updated = await withTenant(tenantId, async (tx) => {
        await requireOwnInquiry(tenantId, id);
        const [row] = await tx
          .update(chronoInquiry)
          .set({ assignedToUserId: targetUserId, status: "assigned", updatedAt: new Date() })
          .where(and(eq(chronoInquiry.id, id), eq(chronoInquiry.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoInquiry.assigned",
        targetType: "inquiry",
        targetId: updated?.id,
        metadata: { assignedToUserId: targetUserId },
      });
      return c.json({ inquiry: updated });
    })

    .post("/:id/reply", zValidator("json", replyToInquirySchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { inquiry: ["manage"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");
      const { body } = c.req.valid("json");

      const { inquiry, message } = await withTenant(tenantId, async (tx) => {
        const existing = await requireOwnInquiry(tenantId, id);
        const [message] = await tx
          .insert(chronoInquiryMessage)
          .values({
            id: createId(),
            tenantId,
            inquiryId: id,
            authorType: "staff",
            authorUserId: userId,
            body,
          })
          .returning();
        // A staff reply auto-transitions "new"/"assigned" -> "in_progress" (it
        // never regresses "resolved"/"closed" — those move only via the
        // status route, matching Routes' "no skip-back" note).
        const nextStatus =
          existing.status === "new" || existing.status === "assigned" ? "in_progress" : existing.status;
        const [row] = await tx
          .update(chronoInquiry)
          .set({ status: nextStatus, updatedAt: new Date() })
          .where(and(eq(chronoInquiry.id, id), eq(chronoInquiry.tenantId, tenantId)))
          .returning();
        return { inquiry: row, message };
      });

      await recordStaffAudit(c, {
        action: "chronoInquiry.replied",
        targetType: "inquiry",
        targetId: inquiry?.id,
      });
      return c.json({ inquiry, message }, 201);
    })

    .patch("/:id/status", zValidator("json", updateInquiryStatusSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { inquiry: ["manage"] });
      const { tenantId } = c.var.tenant;
      const id = c.req.param("id");
      const { status: nextStatus } = c.req.valid("json");

      const updated = await withTenant(tenantId, async (tx) => {
        const existing = await requireOwnInquiry(tenantId, id);
        if (existing.status === "closed" && nextStatus !== "closed") {
          throw new HttpError(409, "This inquiry is closed. Reopen it with a reply first.");
        }
        const [row] = await tx
          .update(chronoInquiry)
          .set({
            status: nextStatus,
            closedAt: nextStatus === "closed" ? new Date() : existing.closedAt,
            updatedAt: new Date(),
          })
          .where(and(eq(chronoInquiry.id, id), eq(chronoInquiry.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "chronoInquiry.statusChanged",
        targetType: "inquiry",
        targetId: updated?.id,
        metadata: { status: nextStatus },
      });
      return c.json({ inquiry: updated });
    });
}
