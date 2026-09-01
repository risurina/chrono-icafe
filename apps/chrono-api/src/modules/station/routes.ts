import { Hono } from "hono";
import { withTenant, eq, and, asc, desc, count, ilike, type TenantTx } from "agora/db";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, HttpError, zValidator } from "agora/server";
import { createId } from "agora";
import { recordStaffAudit } from "agora/audit";
import { chronoBranch } from "../branch/schema";
import { chronoStation, chronoStationGroup } from "./schema";
import {
  createStationSchema,
  updateStationSchema,
  createStationGroupSchema,
  updateStationGroupSchema,
  stationListQuerySchema,
  stationGroupListQuerySchema,
} from "./contracts";

/** True if `err` is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err && err.code === "23505"
  );
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

/**
 * Resolve a station group inside the caller's own tenant AND the station's own
 * branch, or 404. `withTenant` already scopes the SELECT to this tenant via
 * RLS, but the explicit `tenantId` filter matches this codebase's existing
 * defense-in-depth pattern (see `requireOwnBranch` above) rather than relying
 * on RLS alone. The `branchId` filter is the actual bug fix: without it, a
 * client could point a station at a group belonging to a different branch (or,
 * before RLS narrows it, a different tenant).
 */
async function requireOwnGroupInBranch(
  tx: TenantTx,
  tenantId: string,
  branchId: string,
  stationGroupId: string,
) {
  const [group] = await tx
    .select({ id: chronoStationGroup.id })
    .from(chronoStationGroup)
    .where(
      and(
        eq(chronoStationGroup.id, stationGroupId),
        eq(chronoStationGroup.tenantId, tenantId),
        eq(chronoStationGroup.branchId, branchId),
      ),
    )
    .limit(1);
  if (!group) {
    throw new HttpError(404, "Station group not found.");
  }
}

export function stationRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    // No own tenantMiddleware() — composed into `rpc`, which already applies
    // it globally before this router is mounted.

    // GET /stations — ungated (staff need this to work the floor).
    .get(
      "/stations",
      zValidator("query", stationListQuerySchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { page, pageSize, q, sort, order, branchId, stationGroupId } =
          c.req.valid("query");
        const conds = [];
        if (q) conds.push(ilike(chronoStation.name, `%${q}%`));
        if (branchId) conds.push(eq(chronoStation.branchId, branchId));
        if (stationGroupId) conds.push(eq(chronoStation.stationGroupId, stationGroupId));
        const where = conds.length ? and(...conds) : undefined;
        const sortCol =
          sort === "name"
            ? chronoStation.name
            : sort === "stationNumber"
              ? chronoStation.stationNumber
              : chronoStation.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoStation)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoStation)
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

    // GET /stations/groups — ungated.
    .get(
      "/stations/groups",
      zValidator("query", stationGroupListQuerySchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        const { page, pageSize, q, sort, order, branchId } = c.req.valid("query");
        const conds = [];
        if (q) conds.push(ilike(chronoStationGroup.name, `%${q}%`));
        if (branchId) conds.push(eq(chronoStationGroup.branchId, branchId));
        const where = conds.length ? and(...conds) : undefined;
        const sortCol =
          sort === "name"
            ? chronoStationGroup.name
            : sort === "code"
              ? chronoStationGroup.code
              : chronoStationGroup.createdAt;
        const sortFn = order === "asc" ? asc : desc;

        const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
          const [total] = await tx
            .select({ value: count() })
            .from(chronoStationGroup)
            .where(where);
          const rows = await tx
            .select()
            .from(chronoStationGroup)
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

    .post(
      "/stations/groups",
      zValidator("json", createStationGroupSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { station: ["create"] });
        const input = c.req.valid("json");

        let created;
        try {
          created = await withTenant(tenantId, async (tx) => {
            await requireOwnBranch(tx, tenantId, input.branchId);
            const [row] = await tx
              .insert(chronoStationGroup)
              .values({
                id: createId(),
                tenantId,
                branchId: input.branchId,
                name: input.name,
                code: input.code,
                description: input.description,
                hourlyRate: input.hourlyRate.toString(),
                memberRate: input.memberRate?.toString(),
              })
              .returning();
            return row;
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "A station group with that code already exists in this branch.");
          }
          throw err;
        }

        await recordStaffAudit(c, {
          action: "stationGroup.created",
          targetType: "stationGroup",
          targetId: created?.id,
          targetLabel: created?.name,
        });
        return c.json({ stationGroup: created }, 201);
      },
    )

    .patch(
      "/stations/groups/:id",
      zValidator("json", updateStationGroupSchema),
      async (c) => {
        const { tenantId } = c.var.tenant;
        requirePermission(c.var.tenant.permissions, { station: ["update"] });
        const id = c.req.param("id");
        const input = c.req.valid("json");

        let updated;
        try {
          [updated] = await withTenant(tenantId, (tx) =>
            tx
              .update(chronoStationGroup)
              .set({
                ...(input.name !== undefined && { name: input.name }),
                ...(input.code !== undefined && { code: input.code }),
                ...(input.description !== undefined && { description: input.description }),
                ...(input.hourlyRate !== undefined && { hourlyRate: input.hourlyRate.toString() }),
                ...(input.memberRate !== undefined && { memberRate: input.memberRate.toString() }),
                updatedAt: new Date(),
              })
              .where(and(eq(chronoStationGroup.id, id), eq(chronoStationGroup.tenantId, tenantId)))
              .returning(),
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HttpError(409, "A station group with that code already exists in this branch.");
          }
          throw err;
        }

        if (!updated) {
          throw new HttpError(404, "Station group not found.");
        }

        await recordStaffAudit(c, {
          action: "stationGroup.updated",
          targetType: "stationGroup",
          targetId: updated.id,
          targetLabel: updated.name,
        });
        return c.json({ stationGroup: updated });
      },
    )

    .delete("/stations/groups/:id", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["delete"] });
      const id = c.req.param("id");

      const deleted = await withTenant(tenantId, async (tx) => {
        const [inUse] = await tx
          .select({ id: chronoStation.id })
          .from(chronoStation)
          .where(eq(chronoStation.stationGroupId, id))
          .limit(1);
        if (inUse) {
          throw new HttpError(409, "This station group still has stations assigned to it.");
        }
        return tx
          .delete(chronoStationGroup)
          .where(and(eq(chronoStationGroup.id, id), eq(chronoStationGroup.tenantId, tenantId)))
          .returning();
      });

      if (deleted.length === 0) {
        throw new HttpError(404, "Station group not found.");
      }

      await recordStaffAudit(c, {
        action: "stationGroup.deleted",
        targetType: "stationGroup",
        targetId: id,
        targetLabel: deleted[0]?.name,
      });
      return c.json({ ok: true });
    })

    .post("/stations", zValidator("json", createStationSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["create"] });
      const input = c.req.valid("json");

      let created;
      try {
        created = await withTenant(tenantId, async (tx) => {
          await requireOwnBranch(tx, tenantId, input.branchId);
          if (input.stationGroupId) {
            await requireOwnGroupInBranch(tx, tenantId, input.branchId, input.stationGroupId);
          }
          const [row] = await tx
            .insert(chronoStation)
            .values({
              id: createId(),
              tenantId,
              branchId: input.branchId,
              stationGroupId: input.stationGroupId,
              name: input.name,
              stationNumber: input.stationNumber,
              stationType: input.stationType,
              status: input.status,
              locationZone: input.locationZone,
              specs: input.specs ?? null,
            })
            .returning();
          return row;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, "A station with that number already exists in this branch.");
        }
        throw err;
      }

      await recordStaffAudit(c, {
        action: "station.created",
        targetType: "station",
        targetId: created?.id,
        targetLabel: created?.name,
      });
      return c.json({ station: created }, 201);
    })

    .patch("/stations/:id", zValidator("json", updateStationSchema), async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["update"] });
      const id = c.req.param("id");
      const input = c.req.valid("json");

      let updated;
      try {
        [updated] = await withTenant(tenantId, async (tx) => {
          if (input.stationGroupId !== undefined) {
            const [station] = await tx
              .select({ branchId: chronoStation.branchId })
              .from(chronoStation)
              .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
              .limit(1);
            if (!station) {
              throw new HttpError(404, "Station not found.");
            }
            await requireOwnGroupInBranch(tx, tenantId, station.branchId, input.stationGroupId);
          }
          return tx
            .update(chronoStation)
            .set({
              ...(input.stationGroupId !== undefined && { stationGroupId: input.stationGroupId }),
              ...(input.name !== undefined && { name: input.name }),
              ...(input.stationNumber !== undefined && { stationNumber: input.stationNumber }),
              ...(input.stationType !== undefined && { stationType: input.stationType }),
              ...(input.status !== undefined && { status: input.status }),
              ...(input.locationZone !== undefined && { locationZone: input.locationZone }),
              ...(input.specs !== undefined && { specs: input.specs }),
              updatedAt: new Date(),
            })
            .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
            .returning();
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, "A station with that number already exists in this branch.");
        }
        throw err;
      }

      if (!updated) {
        throw new HttpError(404, "Station not found.");
      }

      await recordStaffAudit(c, {
        action: "station.updated",
        targetType: "station",
        targetId: updated.id,
        targetLabel: updated.name,
      });
      return c.json({ station: updated });
    })

    .delete("/stations/:id", async (c) => {
      const { tenantId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { station: ["delete"] });
      const id = c.req.param("id");

      const deleted = await withTenant(tenantId, (tx) =>
        tx
          .delete(chronoStation)
          .where(and(eq(chronoStation.id, id), eq(chronoStation.tenantId, tenantId)))
          .returning(),
      );

      if (deleted.length === 0) {
        throw new HttpError(404, "Station not found.");
      }

      await recordStaffAudit(c, {
        action: "station.deleted",
        targetType: "station",
        targetId: id,
        targetLabel: deleted[0]?.name,
      });
      return c.json({ ok: true });
    });
}
