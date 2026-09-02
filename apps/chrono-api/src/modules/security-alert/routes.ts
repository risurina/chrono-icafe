import { Hono } from "hono";
import { withTenant, eq, and, asc, desc, count, type TenantTx } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { chronoSecurityAlert } from "./schema";
import {
  reportSecurityAlertSchema,
  resolveSecurityAlertSchema,
  securityAlertListQuerySchema,
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

/** Resolve a station inside the caller's own tenant AND the given branch, or 404. */
async function requireOwnStationInBranch(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  stationId: string,
) {
  const [station] = await tx
    .select({ id: chronoStation.id, branchId: chronoStation.branchId })
    .from(chronoStation)
    .where(and(eq(chronoStation.id, stationId), eq(chronoStation.tenantId, tenantId)))
    .limit(1);
  if (!station) {
    throw new HttpError(404, "Station not found.");
  }
  if (station.branchId !== branchId) {
    throw new HttpError(400, "This station does not belong to the given branch.");
  }
}

export function securityAlertRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    .get(
      "/",
      zValidator("query", securityAlertListQuerySchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { securityAlert: ["read"] });
        const { tenantId } = c.var.tenant;
        const { page, pageSize, sort, order, branchId, status, severity } =
          c.req.valid("query");

        const conds = [];
        if (branchId) conds.push(eq(chronoSecurityAlert.branchId, branchId));
        if (status) conds.push(eq(chronoSecurityAlert.status, status));
        if (severity) conds.push(eq(chronoSecurityAlert.severity, severity));
        const where = conds.length ? and(...conds) : undefined;

        const sortCol =
          sort === "severity" ? chronoSecurityAlert.severity : chronoSecurityAlert.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoSecurityAlert)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoSecurityAlert)
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

    // Manual staff report — raisedBy is always "staff" here; the device-
    // reporting path (raisedBy: "device") is a separate, device-bearer-gated
    // surface (Phase 5), not this route.
    .post("/", zValidator("json", reportSecurityAlertSchema), async (c) => {
      requirePermission(c.var.tenant.permissions, { securityAlert: ["manage"] });
      const { tenantId, userId } = c.var.tenant;
      const input = c.req.valid("json");

      const created = await withTenant(tenantId, async (tx) => {
        await requireOwnBranch(tx, tenantId, input.branchId);
        if (input.stationId) {
          await requireOwnStationInBranch(tx, tenantId, input.branchId, input.stationId);
        }
        const [row] = await tx
          .insert(chronoSecurityAlert)
          .values({
            id: createId(),
            tenantId,
            branchId: input.branchId,
            stationId: input.stationId,
            raisedBy: "staff",
            reportedByUserId: userId,
            severity: input.severity,
            type: input.type,
            message: input.message,
            metadata: input.metadata ?? null,
          })
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "securityAlert.reported",
        targetType: "securityAlert",
        targetId: created?.id,
        targetLabel: created?.type,
        metadata: { branchId: created?.branchId, severity: created?.severity },
      });
      return c.json({ securityAlert: created }, 201);
    })

    .post("/:id/acknowledge", async (c) => {
      requirePermission(c.var.tenant.permissions, { securityAlert: ["manage"] });
      const { tenantId, userId } = c.var.tenant;
      const id = c.req.param("id");

      const updated = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoSecurityAlert.id, status: chronoSecurityAlert.status })
          .from(chronoSecurityAlert)
          .where(and(eq(chronoSecurityAlert.id, id), eq(chronoSecurityAlert.tenantId, tenantId)))
          .limit(1);
        if (!existing) {
          throw new HttpError(404, "Security alert not found.");
        }
        if (existing.status !== "open") {
          throw new HttpError(409, "Only an open security alert can be acknowledged.");
        }
        const [row] = await tx
          .update(chronoSecurityAlert)
          .set({
            status: "acknowledged",
            acknowledgedByUserId: userId,
            acknowledgedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(chronoSecurityAlert.id, id), eq(chronoSecurityAlert.tenantId, tenantId)))
          .returning();
        return row;
      });

      await recordStaffAudit(c, {
        action: "securityAlert.acknowledged",
        targetType: "securityAlert",
        targetId: updated?.id,
      });
      return c.json({ securityAlert: updated });
    })

    .post(
      "/:id/resolve",
      zValidator("json", resolveSecurityAlertSchema),
      async (c) => {
        requirePermission(c.var.tenant.permissions, { securityAlert: ["manage"] });
        const { tenantId, userId } = c.var.tenant;
        const id = c.req.param("id");
        const { resolutionNote } = c.req.valid("json");

        const updated = await withTenant(tenantId, async (tx) => {
          const [existing] = await tx
            .select({ id: chronoSecurityAlert.id, status: chronoSecurityAlert.status })
            .from(chronoSecurityAlert)
            .where(and(eq(chronoSecurityAlert.id, id), eq(chronoSecurityAlert.tenantId, tenantId)))
            .limit(1);
          if (!existing) {
            throw new HttpError(404, "Security alert not found.");
          }
          // Plan's exact state machine (Phase 3 "Routes"): resolve is blocked
          // only once the alert is already resolved — it may be resolved
          // directly from "open" or from "acknowledged" (acknowledging first
          // is encouraged, not required).
          if (existing.status === "resolved") {
            throw new HttpError(409, "This security alert has already been resolved.");
          }
          const [row] = await tx
            .update(chronoSecurityAlert)
            .set({
              status: "resolved",
              resolvedByUserId: userId,
              resolvedAt: new Date(),
              resolutionNote,
              updatedAt: new Date(),
            })
            .where(and(eq(chronoSecurityAlert.id, id), eq(chronoSecurityAlert.tenantId, tenantId)))
            .returning();
          return row;
        });

        await recordStaffAudit(c, {
          action: "securityAlert.resolved",
          targetType: "securityAlert",
          targetId: updated?.id,
          metadata: { resolutionNote },
        });
        return c.json({ securityAlert: updated });
      },
    );
}
