import { Hono } from "hono";
import { withTenant, schema as base, eq, count, asc, desc } from "agora/db";
import { requirePermission } from "agora/auth";
import {
  type TenantVars,
  HttpError,
  zValidator,
} from "agora/server";
import { listQuerySchema, type PaginationMeta } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoMemberProfile } from "./schema";
import { updateMemberProfileSchema } from "./contracts";

/** Shared `{page, pageSize, ...}` → `PaginationMeta` builder, mirroring
 * apps/chrono-api/src/routes/rpc.ts's own helper — duplicated locally (not
 * imported from there) to avoid a circular import, since rpc.ts composes
 * this module's routes via `.route("/members", memberProfileRoutes())`. */
function buildPaginationMeta(
  page: number,
  pageSize: number,
  totalItems: number,
  sort?: string,
  order?: "asc" | "desc",
): PaginationMeta {
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

/** Wire shape for a staff-facing member-profile row (identity + venue fields
 * joined in one row) — never the raw Drizzle join result. */
type MemberProfileListItem = {
  id: string;
  memberId: string;
  tenantId: string;
  name: string;
  email: string;
  phone: string | null;
  applicationStatus: string;
  appliedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
};

/**
 * Staff-facing venue-membership workflow — a Chrono-owned extension of the
 * foundation's `customer` (tenant_member) identity, reusing the existing
 * `customer` permission resource (this is a read/update over the same
 * underlying rows the `/rpc/customers` routes already manage — see the
 * module plan's "Permission vocabulary" section). Composed into
 * apps/chrono-api/src/routes/rpc.ts via `.route("/members", memberProfileRoutes())`.
 */
export function memberProfileRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    .get(
      "/",
      zValidator("query", listQuerySchema(["appliedAt", "createdAt"])),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { customer: ["read"] });
        const { page, pageSize, sort, order } = c.req.valid("query");
        const sortCol =
          sort === "appliedAt"
            ? chronoMemberProfile.appliedAt
            : chronoMemberProfile.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoMemberProfile)
            .innerJoin(
              base.tenantMember,
              eq(chronoMemberProfile.memberId, base.tenantMember.id),
            );
          const rows = await tx
            .select({
              id: chronoMemberProfile.id,
              memberId: chronoMemberProfile.memberId,
              tenantId: chronoMemberProfile.tenantId,
              name: base.tenantMember.name,
              email: base.tenantMember.email,
              phone: chronoMemberProfile.phone,
              applicationStatus: chronoMemberProfile.applicationStatus,
              appliedAt: chronoMemberProfile.appliedAt,
              approvedAt: chronoMemberProfile.approvedAt,
              rejectedAt: chronoMemberProfile.rejectedAt,
              createdAt: chronoMemberProfile.createdAt,
            })
            .from(chronoMemberProfile)
            .innerJoin(
              base.tenantMember,
              eq(chronoMemberProfile.memberId, base.tenantMember.id),
            )
            .orderBy(sortFn(sortCol))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
          return { rows, totalItems: total?.value ?? 0 };
        });

        const items: MemberProfileListItem[] = rows.map((r) => ({
          id: r.id,
          memberId: r.memberId,
          tenantId: r.tenantId,
          name: r.name,
          email: r.email,
          phone: r.phone,
          applicationStatus: r.applicationStatus,
          appliedAt: r.appliedAt.toISOString(),
          approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
          rejectedAt: r.rejectedAt ? r.rejectedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        }));

        return c.json({
          items,
          meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
        });
      },
    )
    .patch(
      "/:memberId",
      zValidator("json", updateMemberProfileSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { customer: ["update"] });
        const memberId = c.req.param("memberId");
        const input = c.req.valid("json");

        const [row] = await withTenant(tenantId, (tx) =>
          tx
            .update(chronoMemberProfile)
            .set({
              ...(input.phone !== undefined ? { phone: input.phone } : {}),
              updatedAt: new Date(),
            })
            .where(eq(chronoMemberProfile.memberId, memberId))
            .returning(),
        );
        if (!row) throw new HttpError(404, "Member profile not found.");

        await recordStaffAudit(c, {
          action: "chronoMemberProfile.updated",
          targetType: "chronoMemberProfile",
          targetId: row.id,
          targetLabel: row.memberId,
        });
        return c.json({ profile: row });
      },
    )
    .post("/:memberId/approve", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { customer: ["approve"] });
      const memberId = c.req.param("memberId");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .update(chronoMemberProfile)
          .set({
            applicationStatus: "approved",
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chronoMemberProfile.memberId, memberId))
          .returning(),
      );
      if (!row) throw new HttpError(404, "Member profile not found.");

      await recordStaffAudit(c, {
        action: "chronoMemberProfile.approved",
        targetType: "chronoMemberProfile",
        targetId: row.id,
        targetLabel: row.memberId,
      });
      return c.json({ profile: row });
    })
    .post("/:memberId/reject", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { customer: ["reject"] });
      const memberId = c.req.param("memberId");

      const [row] = await withTenant(tenantId, (tx) =>
        tx
          .update(chronoMemberProfile)
          .set({
            applicationStatus: "rejected",
            rejectedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chronoMemberProfile.memberId, memberId))
          .returning(),
      );
      if (!row) throw new HttpError(404, "Member profile not found.");

      await recordStaffAudit(c, {
        action: "chronoMemberProfile.rejected",
        targetType: "chronoMemberProfile",
        targetId: row.id,
        targetLabel: row.memberId,
      });
      return c.json({ profile: row });
    });
}
